const { chromium } = require('playwright');
const fs = require('fs');

if (!fs.existsSync('screenshots')) {
  fs.mkdirSync('screenshots');
}

// Telegram 通知工具
async function sendTelegramMessage(botToken, chatId, text) {
  if (!botToken || !chatId) {
    console.log('⚠️ 未配置 TG_BOT_TOKEN 或 TG_CHAT_ID，跳过通知。');
    return;
  }
  
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        chat_id: chatId, 
        text: text, 
        parse_mode: 'HTML',
        disable_web_page_preview: true 
      })
    });
    
    const result = await res.json();
    if (result.ok) {
      console.log('📢 TG 通知已成功送达！');
    } else {
      console.error('⚠️ TG 接口拒收:', result.description);
      if (result.description && result.description.includes("can't parse entities")) {
        console.log('🔄 检测到 HTML 实体冲突，正在以纯文本重新补发...');
        const plainText = text.replace(/<[^>]+>/g, '');
        const retryRes = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: plainText })
        });
        const retryResult = await retryRes.json();
        if (retryResult.ok) console.log('📢 TG 纯文本通知补发成功！');
      }
    }
  } catch (err) {
    console.error('❌ TG 网络请求异常:', err.message);
  }
}

// 🛡️ 优先秒杀 Maybe later 及干扰弹窗
async function priorityDismissPopups(page) {
  try {
    const maybeLater = page.locator('button, a, span, div').filter({ hasText: /^Maybe later$/i });
    const count = await maybeLater.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const btn = maybeLater.nth(i);
      if (await btn.isVisible({ timeout: 150 }).catch(() => false)) {
        await btn.click({ force: true }).catch(() => {});
        console.log('🛡️ [优先拦截] 已清除干扰打分弹窗！');
      }
    }
  } catch (e) {}

  try {
    const cookieBtn = page.locator('button:has-text("Accept all"), button:has-text("Reject all")').first();
    if (await cookieBtn.isVisible({ timeout: 150 }).catch(() => false)) {
      await cookieBtn.click().catch(() => {});
    }
  } catch (e) {}

  try {
    await page.evaluate(() => {
      const allEls = Array.from(document.querySelectorAll('*'));
      const noise = allEls.filter(el => {
        const txt = el?.textContent || '';
        return (
          txt.includes('How would you rate FreeMCHost') ||
          txt.includes('Your feedback') ||
          txt.includes('Got an idea to make FreeMCHost better')
        );
      });

      noise.forEach(header => {
        let container = header;
        for (let i = 0; i < 7; i++) {
          if (container && container.parentElement && container.parentElement !== document.body) {
            if ((container.parentElement.innerText || '').includes('Keep your server online')) return;
            container = container.parentElement;
          }
        }
        if (container && container !== document.body && !(container.innerText || '').includes('Keep your server online')) {
          container.remove();
        }
      });

      document.body.style.pointerEvents = 'auto';
      const backdrops = allEls.filter(el => 
        el?.classList && el.classList.contains('fixed') && el.classList.contains('inset-0') && el.getAttribute('data-state') === 'open'
      );
      backdrops.forEach(b => {
        if (!b?.innerText?.includes('Keep your server online')) b.remove();
      });
    });
  } catch (e) {}
}

// 模拟真实用户输入
async function safeFill(page, locator, value, label) {
  await locator.waitFor({ state: 'visible', timeout: 15000 });
  await priorityDismissPopups(page);
  await locator.click();
  await locator.fill(value);
  await page.waitForTimeout(200);

  const actualVal = await locator.inputValue().catch(() => '');
  if (!actualVal) {
    await locator.click();
    await locator.pressSequentially(value, { delay: 30 });
  }
}

// 强制切换至 PLAN Billing 标签页
async function switchToBillingTab(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await priorityDismissPopups(page);
    
    const tabCandidates = page.locator('button, a, div[role="tab"]').filter({ hasText: /Billing/i });
    const count = await tabCandidates.count();
    
    for (let idx = 0; idx < count; idx++) {
      const item = tabCandidates.nth(idx);
      if (await item.isVisible().catch(() => false)) {
        const txt = await item.innerText().catch(() => '');
        if (!txt.includes('Total') && (txt.includes('Billing') || txt.includes('PLAN'))) {
          await item.click({ force: true });
          console.log(`👉 已点击标签: [${txt.replace(/\n/g, ' ')}]`);
          break;
        }
      }
    }

    await page.waitForTimeout(1500);
    await priorityDismissPopups(page);

    const hasBillingContent = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return text.includes('Plan & lifecycle') || text.includes('TIME UNTIL EXPIRY') || text.includes('Renew now');
    });

    if (hasBillingContent) return;
  }
}

// 倒计时提取器
async function extractExpiryTime(page) {
  return await page.evaluate(() => {
    const allEls = Array.from(document.querySelectorAll('*'));
    const header = allEls.find(el => el && el.textContent && el.textContent.trim().toUpperCase() === 'TIME UNTIL EXPIRY');

    if (header) {
      let container = header.parentElement;
      for (let k = 0; k < 4; k++) {
        if (container) {
          const txt = container.innerText || '';
          const m = txt.match(/(\d{1,3})\s*\n?\s*D[\s\S]*?(\d{1,2})\s*\n?\s*H[\s\S]*?(\d{1,2})\s*\n?\s*M/i);
          if (m) {
            const d = parseInt(m[1], 10);
            const h = parseInt(m[2], 10);
            const min = parseInt(m[3], 10);
            return { totalHours: d * 24 + h + min / 60, raw: `${d}天${h}小时${min}分` };
          }
          container = container.parentElement;
        }
      }
    }

    const bodyText = document.body.innerText || '';
    const fallbackMatch = bodyText.match(/(\d{1,3})\s*\n?\s*D\s*\n?\s*(\d{1,2})\s*\n?\s*H\s*\n?\s*(\d{1,2})\s*\n?\s*M/i);
    if (fallbackMatch) {
      const d = parseInt(fallbackMatch[1], 10);
      const h = parseInt(fallbackMatch[2], 10);
      const min = parseInt(fallbackMatch[3], 10);
      return { totalHours: d * 24 + h + min / 60, raw: `${d}天${h}小时${min}分` };
    }

    return null;
  });
}

async function safeScreenshot(page, filePath) {
  try {
    await page.screenshot({ path: filePath, fullPage: false, timeout: 5000 });
  } catch (e) {}
}

(async () => {
  const email = (process.env.FREE_EMAIL || '').trim();
  const password = process.env.FREE_PASSWORD || '';
  const rawUrls = (process.env.SERVER_PAGE_URL || '').trim();
  const proxyUrl = (process.env.PROXY_URL || '').trim();
  const tgToken = (process.env.TG_BOT_TOKEN || '').trim();
  const tgChatId = (process.env.TG_CHAT_ID || '').trim();

  const serverUrls = rawUrls
    .split(/[\r\n,]+/)
    .map(u => u.trim())
    .filter(u => u.startsWith('http'));

  if (!email || !password || serverUrls.length === 0) {
    console.error('❌ 缺失账号、密码或有效的 SERVER_PAGE_URL 地址！');
    process.exit(1);
  }

  console.log(`📋 检测到 ${serverUrls.length} 个独立服务器地址待巡检...`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080'
    ],
    proxy: proxyUrl ? { server: proxyUrl } : undefined
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'en-US'
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  let reports = [];

  try {
    console.log('🚀 正在打开 FreeMCHost 登录页...');
    await page.goto('https://freemchost.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);
    await priorityDismissPopups(page);

    console.log('📝 正在输入账号密码...');
    const emailLocator = page.locator('input[type="email"], input[name="email"]').first();
    const passLocator = page.locator('input[type="password"], input[name="password"]').first();

    await safeFill(page, emailLocator, email, 'Email');
    await safeFill(page, passLocator, password, 'Password');

    console.log('🔐 正在触发登录...');
    const signInBtn = page.locator('button:has-text("Sign in"), button[type="submit"]').first();
    await Promise.all([
      page.waitForURL(url => !url.href.includes('/login'), { timeout: 45000 }),
      signInBtn.click()
    ]);
    console.log('✅ 登录成功！');

    for (let i = 0; i < serverUrls.length; i++) {
      const currentUrl = serverUrls[i];
      const sIndex = i + 1;
      console.log(`\n================= 正在执行服务器 [${sIndex}/${serverUrls.length}] 强制点按续期 =================`);
      console.log(`🔗 目标地址: ${currentUrl}`);

      try {
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2500);
        await priorityDismissPopups(page);

        console.log('🗂️ 正在定位并点击 [PLAN Billing] 标签页...');
        await switchToBillingTab(page);

        const timeData = await extractExpiryTime(page);
        const remainHours = timeData ? timeData.totalHours : 99;
        const remainStr = timeData ? timeData.raw : '未读取到';
        console.log(`⏱️ 服务器 [${sIndex}] 当前显示剩余时长: ${remainStr} (约 ${remainHours.toFixed(1)} 小时)`);

        console.log(`🔥 打开续期弹窗...`);
        const renewBtn = page.locator('button:has-text("Renew now")').first();
        await renewBtn.waitFor({ state: 'visible', timeout: 15000 });
        await priorityDismissPopups(page);
        await renewBtn.click({ force: true });
        await page.waitForTimeout(1500);

        const renewModal = page.locator('div').filter({ hasText: 'Keep your server online' }).last();
        await renewModal.waitFor({ state: 'visible', timeout: 10000 });

        // 积累有效 dwell_ms
        console.log('⏳ 在弹窗内持续停留 6 秒，积累行为计时...');
        for (let dwell = 0; dwell < 6; dwell++) {
          await priorityDismissPopups(page);
          await page.mouse.move(960 + dwell * 5, 540 + dwell * 5);
          await page.waitForTimeout(1000);
        }

        await priorityDismissPopups(page);

        // 监听并实时打印发包情况
        let rpcTriggered = false;
        const rpcListener = async res => {
          const url = res.url();
          if (url.includes('_serverFn')) {
            try {
              const text = await res.text();
              if (!text.includes('feedback') && !text.includes('rating')) {
                rpcTriggered = true;
                console.log(`📡 抓取到关键 RPC: ${url.substring(0, 60)} -> 状态: ${res.status()} -> 内容: ${text.substring(0, 100)}`);
              }
            } catch (e) {}
          }
        };
        page.on('response', rpcListener);

        console.log('👉 发起【选中单选框 + 触发提交】组合操作...');

        // 1. 滚动弹窗内部，确保 60 hours 完全进入视口并精准定位单选框
        const card = renewModal.locator('div, button, label').filter({ hasText: '60 hours' }).last();
        await card.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(300);

        // 点击卡片及其内部所有可能的点击目标 (单选圆圈、图标、文本)
        try {
          const box = await card.boundingBox();
          if (box) {
            // 点击左侧圆圈区域 (左侧 25px 处通常是单选按钮)
            await page.mouse.click(box.x + 25, box.y + box.height / 2);
            await page.waitForTimeout(200);
            // 点击中心
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          }
        } catch (e) {}

        await card.click({ force: true }).catch(() => {});
        await page.waitForTimeout(500);

        // 2. 深入模态框底部寻找独立的“提交/确认”按钮
        console.log('🔍 正在寻找并击发弹窗底部提交按钮...');
        await page.evaluate(() => {
          // 找到 Keep your server online 模态框
          const modals = Array.from(document.querySelectorAll('div')).filter(d => (d.innerText || '').includes('Keep your server online'));
          const currentModal = modals[modals.length - 1];
          if (!currentModal) return;

          // 滚动模态框到底部
          currentModal.scrollTop = currentModal.scrollHeight;

          // 检索所有可提交或激活的元素
          const candidates = Array.from(currentModal.querySelectorAll('button, [role="button"], [type="submit"], input[type="submit"]'));
          candidates.forEach(btn => {
            const txt = (btn.textContent || '').trim().toLowerCase();
            // 排除关闭、取消、打分
            if (!txt.includes('maybe later') && !txt.includes('cancel') && !txt.includes('close') && txt.length > 0) {
              btn.click();
            }
          });
        });

        // 3. 键盘回车与空格兜底提交
        await page.keyboard.press('Enter');
        await page.keyboard.press('Space');

        // 等待 3 秒观察网络发包
        await page.waitForTimeout(3000);
        page.off('response', rpcListener);

        // 会话保温 15 秒
        console.log('☕ 会话保温中：保持在线 15 秒等待后端写入...');
        for (let warm = 0; warm < 3; warm++) {
          await page.waitForTimeout(5000);
          await priorityDismissPopups(page);
        }

        console.log('🔄 正在当前页面刷新以验证持久化状态...');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);
        await priorityDismissPopups(page);
        await switchToBillingTab(page);

        // 独立沙盒硬核验
        console.log('🔍 正在启动【独立会话沙盒】硬核验...');
        const freshContext = await browser.newContext({
          viewport: { width: 1920, height: 1080 },
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        });
        const verifyPage = await freshContext.newPage();
        
        await verifyPage.goto('https://freemchost.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await priorityDismissPopups(verifyPage);
        await safeFill(verifyPage, verifyPage.locator('input[type="email"], input[name="email"]').first(), email, 'Email');
        await safeFill(verifyPage, verifyPage.locator('input[type="password"], input[name="password"]').first(), password, 'Password');
        await Promise.all([
          verifyPage.waitForURL(url => !url.href.includes('/login'), { timeout: 30000 }),
          verifyPage.locator('button:has-text("Sign in"), button[type="submit"]').first().click()
        ]);

        await verifyPage.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await verifyPage.waitForTimeout(2000);
        await priorityDismissPopups(verifyPage);
        await switchToBillingTab(verifyPage);

        const finalTimeData = await extractExpiryTime(verifyPage);
        const finalHours = finalTimeData ? finalTimeData.totalHours : remainHours;
        const finalStr = finalTimeData ? finalTimeData.raw : '未获取到';
        await safeScreenshot(verifyPage, `screenshots/server-${sIndex}-real-verified.png`);
        
        await freshContext.close();

        console.log(`⏱️ 终审核验结果: 前序 ${remainHours.toFixed(1)}h ➔ 最终真实数据库时间: ${finalHours.toFixed(1)}h (${finalStr})`);

        if (finalHours > remainHours + 20) {
          console.log('🎉 终审通过：后端数据库已稳定入账！');
          reports.push(`🟢 <b>服务器 ${sIndex}</b>: 成功满血续期 (+60h)\n     └ 状态: ${remainStr} ➔ <b>${finalStr}</b>`);
        } else {
          console.log('⚠️ 时间暂未变动。');
          reports.push(`🟡 <b>服务器 ${sIndex}</b>: 已强制发起点击 (当前: ${finalStr})\n     └ 状态: 持续监测下个周期`);
        }

      } catch (innerErr) {
        console.error(`❌ 服务器 [${sIndex}] 处理异常:`, innerErr.message);
        reports.push(`🔴 <b>服务器 ${sIndex}</b>: 巡检失败 (${innerErr.message.substring(0, 30)})`);
        await safeScreenshot(page, `screenshots/error-server-${sIndex}.png`);
      }
    }

    // 汇总推送 Telegram 报告
    const summaryMsg = `🤖 <b>FreeMCHost 强制巡检报告</b>\n\n${reports.join('\n')}\n\n<b>时间:</b> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    await sendTelegramMessage(tgToken, tgChatId, summaryMsg);

  } catch (error) {
    console.error('❌ 全局致命错误:', error.message);
    await safeScreenshot(page, 'screenshots/renew_fatal.png');
    await sendTelegramMessage(tgToken, tgChatId, `🚨 <b>Freemchost 运行崩溃:</b> <code>${error.message}</code>`);
    process.exitCode = 1;
  } finally {
    await browser.close();
    console.log('🏁 任务完成，浏览器已关闭。');
  }
})();
