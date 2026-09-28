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

// 🛡️ 稳健清理干扰弹窗（彻底防空指针崩溃）
async function forceDismissPopups(page) {
  try {
    const cookieBtn = page.locator('button:has-text("Accept all"), button:has-text("Reject all")').first();
    if (await cookieBtn.isVisible({ timeout: 400 })) {
      await cookieBtn.click();
    }
  } catch (e) {}

  for (let i = 0; i < 2; i++) {
    try {
      const maybeLater = page.locator('button, a, span, div').filter({ hasText: /^Maybe later$/i }).first();
      if (await maybeLater.isVisible({ timeout: 400 })) {
        await maybeLater.click({ force: true });
        console.log('🛡️ 已点击 [Maybe later] 关闭干扰弹窗');
        await page.waitForTimeout(300);
      }
    } catch (e) {}
  }

  try {
    await page.evaluate(() => {
      const allEls = Array.from(document.querySelectorAll('*'));
      const noiseHeaders = allEls.filter(el => {
        const txt = el?.textContent || '';
        return (
          txt.includes('How would you rate FreeMCHost') ||
          txt.includes('Your feedback') ||
          txt.includes('Got an idea to make FreeMCHost better') ||
          txt.includes('Get Free+ (2GB)') ||
          txt.includes('Upgrade to Free+') ||
          txt.includes('Join the FreeMCHost community')
        );
      });

      noiseHeaders.forEach(header => {
        let container = header;
        for (let i = 0; i < 7; i++) {
          if (container && container.parentElement && container.parentElement !== document.body) {
            const pText = container.parentElement.innerText || '';
            if (pText.includes('Keep your server online')) {
              return;
            }
            container = container.parentElement;
          }
        }
        if (container && container !== document.body) {
          const cText = container.innerText || '';
          if (!cText.includes('Keep your server online')) {
            container.remove();
          }
        }
      });

      const backdrops = allEls.filter(el => 
        el?.classList && el.classList.contains('fixed') && el.classList.contains('inset-0') && el.getAttribute('data-state') === 'open'
      );
      backdrops.forEach(b => {
        if (!b?.innerText?.includes('Keep your server online')) {
          b.remove();
        }
      });
    });
  } catch (e) {}

  await page.waitForTimeout(200);
}

// 模拟真实用户输入
async function safeFill(page, locator, value, label) {
  await locator.waitFor({ state: 'visible', timeout: 15000 });
  await locator.click();
  await locator.focus();
  await locator.fill(value);
  await page.waitForTimeout(300);

  const actualVal = await locator.inputValue().catch(() => '');
  if (!actualVal) {
    console.log(`⚠️ 检测到 ${label} 输入框为空，尝试键盘逐字写入...`);
    await locator.click();
    await locator.pressSequentially(value, { delay: 30 });
  }
}

// 强制切换至 PLAN Billing 标签页
async function switchToBillingTab(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await forceDismissPopups(page);
    
    const tabCandidates = page.locator('button, a, div[role="tab"]').filter({ hasText: /Billing/i });
    const count = await tabCandidates.count();
    
    for (let idx = 0; idx < count; idx++) {
      const item = tabCandidates.nth(idx);
      if (await item.isVisible().catch(() => false)) {
        const txt = await item.innerText().catch(() => '');
        if (!txt.includes('Total') && (txt.includes('Billing') || txt.includes('PLAN'))) {
          await item.click({ force: true });
          console.log(`👉 已点击标签: [${txt.replace(/\n/g, ' ')}] (尝试 ${attempt + 1})`);
          break;
        }
      }
    }

    await page.waitForTimeout(2000);
    await forceDismissPopups(page);

    const hasBillingContent = await page.evaluate(() => {
      const text = document.body.innerText || '';
      return text.includes('Plan & lifecycle') || text.includes('TIME UNTIL EXPIRY') || text.includes('Renew now');
    });

    if (hasBillingContent) {
      console.log('✅ 成功确认已切换至 PLAN Billing 界面！');
      return;
    }
    console.log('⚠️ 尚未检测到 Billing 面板内容，准备重试点击...');
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
  } catch (e) {
    console.log(`⚠️ 截图跳过: ${e.message}`);
  }
}

(async () => {
  const email = (process.env.FREE_EMAIL || '').trim();
  const password = (process.env.FREE_PASSWORD || '').trim();
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
    await page.waitForTimeout(2000);
    await forceDismissPopups(page);

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
      console.log(`\n================= 正在巡检服务器 [${sIndex}/${serverUrls.length}] =================`);
      console.log(`🔗 目标地址: ${currentUrl}`);

      try {
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);
        await forceDismissPopups(page);

        console.log('🗂️ 正在定位并点击 [PLAN Billing] 标签页...');
        await switchToBillingTab(page);

        const renewBtn = page.locator('button:has-text("Renew now")').first();
        await renewBtn.waitFor({ state: 'visible', timeout: 15000 });
        await page.waitForTimeout(1000);
        await forceDismissPopups(page);

        // 提取初始真实时间
        const timeData = await extractExpiryTime(page);
        const remainHours = timeData ? timeData.totalHours : 99;
        const remainStr = timeData ? timeData.raw : '未读取到';
        console.log(`⏱️ 服务器 [${sIndex}] 实际剩余时长: ${remainStr} (约 ${remainHours.toFixed(1)} 小时)`);

        if (remainHours < 46) {
          console.log(`🎯 剩余时长 < 46 小时，打开续期弹窗...`);
          await renewBtn.click();
          await page.waitForTimeout(1500);
          await forceDismissPopups(page);

          console.log('⏳ 等待 [60 hours] 选项解锁 (等待 3-5 秒后端校验)...');
          const renewModal = page.locator('div').filter({ hasText: 'Keep your server online' }).last();
          await renewModal.waitFor({ state: 'visible', timeout: 10000 });

          for (let poll = 0; poll < 10; poll++) {
            const isReady = await page.evaluate(() => {
              const text = document.body.innerText || '';
              return !text.toLowerCase().includes('come back later');
            });

            if (isReady && poll >= 3) {
              console.log(`✅ [60 hours] 选项状态已解锁！`);
              break;
            }
            await page.waitForTimeout(1200);
          }

          // 点击前再次扫除可能置顶的干扰弹窗
          console.log('🛡️ 正在扫除遮挡续期选项的置顶评分/反馈弹窗...');
          await forceDismissPopups(page);
          await page.waitForTimeout(500);

          console.log('👉 准备发起高成功率多阶真实交互点击 [60 hours]...');

          // 布设全域网络响应监听器，等待真实的 _serverFn / renew 响应
          let rpcTriggered = false;
          const rpcPromise = page.waitForResponse(res => {
            const req = res.request();
            const url = res.url();
            return req.method() === 'POST' && (url.includes('_serverFn') || url.includes('/renew'));
          }, { timeout: 10000 }).then(() => {
            rpcTriggered = true;
          }).catch(() => null);

          // 方式 1：直接定位包含 60 hours 且带有边框或圆角的交互卡片
          const card = page.locator('div, button, a').filter({ hasText: /^60 hours/i, hasNotText: '14 days' }).last();
          
          try {
            await card.hover({ timeout: 2000 });
            await card.click({ force: true, delay: 100 });
            console.log('🖱️ 阶梯点击 1: 直接对卡片触发 hover + click 完成！');
          } catch (e) {
            console.log('⚠️ 阶梯 1 跳过，尝试文本直接点击...');
          }

          // 方式 2：如果 2 秒内未触发发包，直接命中文字节点本身
          await page.waitForTimeout(1500);
          if (!rpcTriggered) {
            try {
              const textNode = page.getByText('60 hours', { exact: false }).first();
              await textNode.click({ force: true, delay: 80 });
              console.log('🖱️ 阶梯点击 2: 对文字节点触发强制物理点击完成！');
            } catch (e) {}
          }

          // 方式 3：键盘激活兜底 (聚焦并按空格和回车)
          await page.waitForTimeout(1000);
          if (!rpcTriggered) {
            try {
              await page.keyboard.press('Tab');
              await page.keyboard.press('Space');
              await page.keyboard.press('Enter');
              console.log('⌨️ 阶梯点击 3: 触发键盘快捷聚焦与激活！');
            } catch (e) {}
          }

          console.log('⏳ 等待服务端真实响应 (等待 _serverFn RPC 返回)...');
          await rpcPromise;
          if (rpcTriggered) {
            console.log('📡 核心 RPC 接口已成功响应！');
          } else {
            console.log('⚠️ 未拦截到显式 RPC 响应，继续执行深层隔离硬核验...');
          }

          await page.waitForTimeout(6000);
          await forceDismissPopups(page);

          // 核心加固：创建完全独立的全新隔离 Context 进行真实数据库核验，杜绝前端内存污染
          console.log('🔍 正在启动【独立会话沙盒 (完全独立 Context)】硬核验，核查真实数据库倒计时...');
          const freshContext = await browser.newContext({
            viewport: { width: 1920, height: 1080 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
          });
          const verifyPage = await freshContext.newPage();
          
          // 新会话先完成认证登录，确保获取完全纯净的服务端渲染数据
          await verifyPage.goto('https://freemchost.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
          await forceDismissPopups(verifyPage);
          await safeFill(verifyPage, verifyPage.locator('input[type="email"], input[name="email"]').first(), email, 'Email');
          await safeFill(verifyPage, verifyPage.locator('input[type="password"], input[name="password"]').first(), password, 'Password');
          await Promise.all([
            verifyPage.waitForURL(url => !url.href.includes('/login'), { timeout: 30000 }),
            verifyPage.locator('button:has-text("Sign in"), button[type="submit"]').first().click()
          ]);

          // 进入目标服务器读取未污染的真实数据库时间
          await verifyPage.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await verifyPage.waitForTimeout(2000);
          await forceDismissPopups(verifyPage);
          await switchToBillingTab(verifyPage);

          const finalTimeData = await extractExpiryTime(verifyPage);
          const finalHours = finalTimeData ? finalTimeData.totalHours : remainHours;
          const finalStr = finalTimeData ? finalTimeData.raw : '未获取到';
          await safeScreenshot(verifyPage, `screenshots/server-${sIndex}-real-verified.png`);
          
          // 关闭隔离上下文
          await freshContext.close();

          console.log(`⏱️ 独立沙盒真实入库核验结果: 前序 ${remainHours.toFixed(1)}h ➔ 真实数据库时间: ${finalHours.toFixed(1)}h (${finalStr})`);

          // 只有真实数据增加了 20 小时以上才算入库
          if (finalHours > remainHours + 20) {
            console.log('🎉 验证通过：后端数据库已确认落盘！');
            reports.push(`🟢 <b>服务器 ${sIndex}</b>: 成功满血续期 (+60h)\n     └ 状态: ${remainStr} ➔ <b>${finalStr}</b>`);
          } else {
            console.error('❌ 验证失败：后端数据未真正更新！');
            reports.push(`🔴 <b>服务器 ${sIndex}</b>: 续期指令下发但后端未入账 (当前真实时间: ${finalStr})\n     └ 机制: 下个周期将自动重试`);
          }

        } else {
          console.log(`⏳ 服务器 [${sIndex}] 距离 46h 开放还差约 ${(remainHours - 46).toFixed(1)} 小时，保持等待。`);
          reports.push(`⚪ <b>服务器 ${sIndex}</b>: 剩余 ${remainStr} (未达 46h)`);
        }

      } catch (innerErr) {
        console.error(`❌ 服务器 [${sIndex}] 处理异常:`, innerErr.message);
        reports.push(`🔴 <b>服务器 ${sIndex}</b>: 巡检失败 (${innerErr.message.substring(0, 30)})`);
        await safeScreenshot(page, `screenshots/error-server-${sIndex}.png`);
      }
    }

    // 汇总推送 Telegram 报告
    const summaryMsg = `🤖 <b>FreeMCHost 巡检报告</b>\n\n${reports.join('\n')}\n\n<b>检查周期:</b> 每 12 小时自动巡检\n<b>规则:</b> 触发低于 46h 门槛时自动加满 60h\n<b>时间:</b> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
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
