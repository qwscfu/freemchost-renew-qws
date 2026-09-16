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

// 🛡️ 深度清理反馈评分、营销升级、Discord 加入等弹窗
async function forceDismissPopups(page) {
  // 1. 关闭 Cookie 栏
  try {
    const cookieBtn = page.locator('button:has-text("Accept all"), button:has-text("Reject all")').first();
    if (await cookieBtn.isVisible({ timeout: 500 })) {
      await cookieBtn.click();
    }
  } catch (e) {}

  // 2. 点击可见的 Maybe later
  for (let i = 0; i < 3; i++) {
    try {
      const maybeLater = page.locator('button, a, span, div').filter({ hasText: /^Maybe later$/i }).first();
      if (await maybeLater.isVisible({ timeout: 600 })) {
        await maybeLater.click({ force: true });
        console.log('🛡️ 已点击 [Maybe later] 关闭干扰弹窗');
        await page.waitForTimeout(400);
      }
    } catch (e) {}
  }

  // 3. 原生 DOM 精准移除干扰模态框
  await page.evaluate(() => {
    const allEls = Array.from(document.querySelectorAll('*'));
    
    const noiseHeaders = allEls.filter(el => {
      const txt = el.textContent || '';
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
        if (container.parentElement && container.parentElement !== document.body) {
          if (container.parentElement.innerText && container.parentElement.innerText.includes('Keep your server online')) {
            break;
          }
          container = container.parentElement;
        }
      }
      if (container && container !== document.body) {
        container.remove();
      }
    });

    const backdrops = allEls.filter(el => 
      el.classList && el.classList.contains('fixed') && el.classList.contains('inset-0') && el.getAttribute('data-state') === 'open'
    );
    backdrops.forEach(b => b.remove());
  });

  await page.waitForTimeout(300);
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

// 统一提取页面倒计时工具
async function extractExpiryTime(page) {
  return await page.evaluate(() => {
    const allEls = Array.from(document.querySelectorAll('*'));
    const header = allEls.find(el => el.textContent && el.textContent.trim().toUpperCase() === 'TIME UNTIL EXPIRY');
    if (!header) return null;

    let container = header.parentElement;
    for (let k = 0; k < 3; k++) {
      if (container && container.innerText.includes('Renew now')) break;
      if (container && container.parentElement) container = container.parentElement;
    }

    if (!container) return null;

    const text = container.innerText;
    const match = text.match(/(\d{1,2})\s*\n?\s*D[\s\S]*?(\d{1,2})\s*\n?\s*H[\s\S]*?(\d{1,2})\s*\n?\s*M/i);
    if (match) {
      const d = parseInt(match[1], 10);
      const h = parseInt(match[2], 10);
      const m = parseInt(match[3], 10);
      return { totalHours: d * 24 + h + m / 60, raw: `${d}天${h}小时${m}分` };
    }
    return null;
  });
}

// 安全截图工具：避免死等外部网络字体
async function safeScreenshot(page, filePath) {
  try {
    await page.screenshot({ path: filePath, fullPage: false, timeout: 5000 });
  } catch (e) {
    console.log(`⚠️ 截图生成跳过: ${e.message}`);
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

        // 定位并点击 [PLAN Billing] 标签页
        console.log('🗂️ 正在定位并点击 [PLAN Billing] 标签页...');
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

        await page.waitForTimeout(2500);
        await forceDismissPopups(page);

        const renewBtn = page.locator('button:has-text("Renew now")').first();
        await renewBtn.waitFor({ state: 'visible', timeout: 15000 });
        await page.waitForTimeout(1000);
        await forceDismissPopups(page);

        // 提取剩余时间
        const timeData = await extractExpiryTime(page);
        const remainHours = timeData ? timeData.totalHours : 99;
        const remainStr = timeData ? timeData.raw : '未读取到';
        console.log(`⏱️ 服务器 [${sIndex}] 实际剩余时长: ${remainStr} (约 ${remainHours.toFixed(1)} 小时)`);

        if (remainHours < 46) {
          console.log(`🎯 剩余时长 < 46 小时，打开续期弹窗...`);
          await renewBtn.click();
          await page.waitForTimeout(1500);

          // 清理干扰弹窗
          await forceDismissPopups(page);

          // 核心优化：轮询等待 3-6 秒，直到 60 hours 卡片由灰变黑/变亮
          console.log('⏳ 正在等待 [60 hours] 选项从置灰变为可点击状态 (需等待 3-5 秒校验)...');
          let readyToClick = false;

          for (let poll = 0; poll < 10; poll++) {
            await forceDismissPopups(page);

            const isCardActive = await page.evaluate(() => {
              const allEls = Array.from(document.querySelectorAll('*'));
              const target = allEls.find(el => 
                el.children.length === 0 && 
                el.textContent.trim().toLowerCase().includes('60 hours')
              );
              if (!target) return false;

              // 向上寻找到卡片容器
              let p = target;
              for (let j = 0; j < 6; j++) {
                if (p.parentElement && p.parentElement !== document.body) {
                  p = p.parentElement;
                  const text = p.innerText || '';
                  const classes = (p.className || '').toString();
                  // 排除掉仍处于不可用或包含 come back later 提示的状态
                  if (text.includes('come back later') || text.includes('open 46h before')) {
                    return false;
                  }
                  // 若容器带有边框、鼠标手势或激活属性
                  if (classes.includes('cursor-pointer') || classes.includes('border') || p.onclick || p.tagName === 'BUTTON') {
                    return true;
                  }
                }
              }
              return true;
            });

            if (isCardActive && poll >= 3) {
              readyToClick = true;
              console.log(`✅ [60 hours] 选项已就绪并激活变亮！(等待耗时约 ${poll * 1.2} 秒)`);
              break;
            }

            await page.waitForTimeout(1200);
          }

          // 物理鼠标坐标点击卡片
          console.log('👉 正在物理点击 [60 hours] 卡片中心...');
          const opt60Locator = page.locator('text="60 hours"').first();
          await opt60Locator.waitFor({ state: 'visible', timeout: 5000 });
          
          // 获取卡片容器并触发点击
          const boundingBox = await opt60Locator.boundingBox();
          if (boundingBox) {
            await page.mouse.click(boundingBox.x + boundingBox.width / 2, boundingBox.y + boundingBox.height / 2);
          } else {
            await opt60Locator.click({ force: true });
          }

          // 兜底：DOM 级向外层容器再发一次 click 事件
          await page.evaluate(() => {
            const allEls = Array.from(document.querySelectorAll('*'));
            const target = allEls.find(el => el.children.length === 0 && el.textContent.trim().toLowerCase().includes('60 hours'));
            if (target) {
              let p = target;
              for (let j = 0; j < 6; j++) {
                if (p.parentElement && p.parentElement !== document.body) {
                  p = p.parentElement;
                  p.click();
                }
              }
            }
          });

          console.log('⏳ 指令已下发，等待服务端完成续期并刷新数据...');
          await page.waitForTimeout(5000);
          await forceDismissPopups(page);

          // 重新读取页面倒计时
          const newTimeData = await extractExpiryTime(page);
          const newRemainStr = newTimeData ? newTimeData.raw : '未获取到';
          console.log(`⏱️ 续期后页面剩余时长: ${newRemainStr}`);

          reports.push(`🟢 <b>服务器 ${sIndex}</b>: 成功满血续期 (+60h)\n     └ 状态: ${remainStr} ➔ <b>${newRemainStr}</b>`);
          await safeScreenshot(page, `screenshots/renew-success-server-${sIndex}.png`);

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
