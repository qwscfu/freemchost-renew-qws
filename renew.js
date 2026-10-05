const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Telegram 消息与截图推送
async function sendTG(botToken, chatId, text, photoPath) {
  if (!botToken || !chatId) return;
  try {
    if (photoPath && fs.existsSync(photoPath)) {
      try {
        const fileBuffer = fs.readFileSync(photoPath);
        const blob = new Blob([fileBuffer], { type: 'image/png' });
        const formData = new FormData();
        formData.append('chat_id', chatId);
        formData.append('caption', text.substring(0, 1024));
        formData.append('parse_mode', 'HTML');
        formData.append('photo', blob, path.basename(photoPath));

        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
          method: 'POST',
          body: formData
        });

        if (res.ok) {
          console.log('📨 Telegram 截图与图文报告推送成功！');
          return;
        }
      } catch (err) {
        console.log(`⚠️ 发送图片异常 (${err.message})，回退到纯文本...`);
      }
    }

    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
    console.log('📨 Telegram 纯文本推送成功');
  } catch (e) {
    console.log('⚠️ Telegram 推送失败:', e.message);
  }
}

// 清除遮挡弹窗
async function cleanPopup(page) {
  try {
    const selectors = [
      'text="Maybe later"',
      'button:has-text("Maybe later")',
      'button:has-text("Accept")',
      'button:has-text("I understand")',
      'button:has-text("Dismiss")'
    ];
    for (const sel of selectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 150 }).catch(() => false)) {
        await el.click({ force: true }).catch(() => {});
        console.log(`🧹 顺手关闭遮挡弹窗: ${sel}`);
        await page.waitForTimeout(200);
      }
    }
  } catch (e) {}
}

// 登录模块
async function doLogin(page, email, password) {
  console.log('🔑 正在登录 FreeMCHost...');
  await page.goto('https://freemchost.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1500);
  await cleanPopup(page);

  if (!page.url().includes('/login')) {
    console.log('✅ 已处于登录状态');
    return;
  }

  const emailInput = page.locator('input[type="email"]').first();
  await emailInput.waitFor({ state: 'visible', timeout: 15000 });
  await emailInput.fill(email);

  const passInput = page.locator('input[type="password"]').first();
  await passInput.fill(password);
  await page.waitForTimeout(300);

  const signInBtn = page.locator('button[type="submit"]:has-text("Sign in")').first();
  await signInBtn.click();

  let loggedIn = false;
  for (let wait = 0; wait < 20; wait++) {
    await page.waitForTimeout(1000);
    if (!page.url().includes('/login')) {
      loggedIn = true;
      break;
    }
    await cleanPopup(page);
  }

  if (!loggedIn) {
    throw new Error('登录未成功跳转，请检查账号密码');
  }
  console.log('🎉 登录成功！');
}

// 检查服务器是否开启（同时识别页面存在 connect 和 running 字样）
async function ensureServerRunning(page) {
  console.log('🔍 正在检测服务器运行状态...');
  
  // 确保处于 Console 控制台
  try {
    const consoleTab = page.locator('[role="tab"]:has-text("Console"), button:has-text("Console"), a:has-text("Console")').first();
    if (await consoleTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await consoleTab.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1000);
    }
  } catch (e) {}

  await cleanPopup(page);

  const checkStatus = async () => {
    return await page.evaluate(() => {
      const text = (document.body ? document.body.innerText : '').toLowerCase();
      const hasConnect = text.includes('connect');
      const hasRunning = text.includes('running');
      return hasConnect && hasRunning;
    });
  };

  let isRunning = await checkStatus();
  if (isRunning) {
    console.log('✅ 服务器当前已处于运行状态 (Connected & Running)');
    return true;
  }

  console.log('⚠️ 服务器当前未完全开启，尝试寻找并点击 Start 三角开机按钮...');
  
  // 匹配三角启动按钮：优先匹配带 play 图标/start 属性/start 文本的按钮
  const startLocators = [
    page.locator('button:has(svg.fa-play)'),
    page.locator('button:has(svg[data-icon="play"])'),
    page.locator('button[aria-label*="start" i]'),
    page.locator('button:has-text("Start")'),
    page.locator('div[role="button"]:has-text("Start")')
  ];

  let clicked = false;
  for (const loc of startLocators) {
    const btn = loc.first();
    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ force: true }).catch(() => {});
      clicked = true;
      console.log('⚡ 已成功触发开机启动按钮！');
      break;
    }
  }

  if (!clicked) {
    console.log('⚠️ 未能定位到明确的 Start 按钮，尝试通过 SVG 图标穿透匹配...');
    clicked = await page.evaluate(() => {
      const svgs = Array.from(document.querySelectorAll('button svg, a svg'));
      for (const svg of svgs) {
        const p = svg.closest('button') || svg.closest('a');
        if (p && (svg.innerHTML.includes('polygon') || svg.innerHTML.includes('path'))) {
          p.click();
          return true;
        }
      }
      return false;
    });
  }

  // 点击后等待启动渲染并再次核查
  console.log('⏳ 正在等待服务器启动完毕...');
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(2000);
    await cleanPopup(page);
    isRunning = await checkStatus();
    if (isRunning) {
      console.log(`🎉 服务器已成功启动进入运行状态！(耗时约 ${(i + 1) * 2}s)`);
      return true;
    }
  }

  console.log('⚠️ 超时未能检测到 Connected & Running 标识，继续进行后续检测...');
  return isRunning;
}

// 提取 Plan Billing 页面到期时间
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
    const m = bodyText.match(/(\d{1,3})\s*D\s*(\d{1,2})\s*H\s*(\d{1,2})\s*M/i);
    if (m) {
      const d = parseInt(m[1], 10);
      const h = parseInt(m[2], 10);
      const min = parseInt(m[3], 10);
      return { totalHours: d * 24 + h + min / 60, raw: `${d}天${h}小时${min}分` };
    }
    return null;
  });
}

// 检查并执行 Plan 租期续期，只对剩余时间横条进行精准截图
async function handleBillingRenew(page) {
  let savedScreenshot = null;
  try {
    console.log('👉 切换至 PLAN Billing 页面核对租期...');
    const billingTab = page.locator('[role="tab"]:has-text("Billing"), button:has-text("PLAN")').last();
    if (await billingTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await billingTab.click({ force: true });
      await page.waitForTimeout(2000);
      await cleanPopup(page);

      const timeData = await extractExpiryTime(page);
      const beforeTime = timeData ? timeData.raw : '未获取到';
      const remainHours = timeData ? timeData.totalHours : 99;
      console.log(`⏱️ 租期剩余时长: ${beforeTime} (约 ${remainHours.toFixed(1)}h)`);

      let renewStatus = `剩余 ${beforeTime} (租期充足无需加时)`;

      if (remainHours < 46) {
        console.log('🎯 租期 < 46 小时，执行 60h 加时续期...');
        const renewNowBtn = page.locator('button:has-text("Renew now")').first();
        if (await renewNowBtn.isVisible({ timeout: 5000 })) {
          await renewNowBtn.click({ force: true });
          await page.waitForTimeout(1500);
          await cleanPopup(page);

          console.log('⏳ 停留 8 秒生成防刷签名 dwell_ms...');
          for (let sec = 0; sec < 8; sec++) {
            await cleanPopup(page);
            await page.mouse.move(960 + sec * 5, 540 + sec * 3);
            await page.waitForTimeout(1000);
          }

          const card = page.locator('div, button').filter({ hasText: '60 hours' }).last();
          if (await card.isEnabled({ timeout: 3000 }).catch(() => false)) {
            await card.hover();
            await page.waitForTimeout(300);
            await card.click({ force: true });
            console.log('👆 60h 租期续期成功！');
            await page.waitForTimeout(4000);
            await cleanPopup(page);
            renewStatus = '已成功加时 (+60h)';
          }
        }
      }

      // 精确截取最新剩余续期时长模块
      try {
        fs.mkdirSync('screenshots', { recursive: true });
        savedScreenshot = path.join('screenshots', `billing-${Date.now()}.png`);

        // 优先定位 TIME UNTIL EXPIRY 的父容器卡片
        const expiryHeader = page.locator('text="TIME UNTIL EXPIRY"').first();
        let clipped = false;

        if (await expiryHeader.isVisible({ timeout: 2000 }).catch(() => false)) {
          const cardBox = await expiryHeader.evaluate(el => {
            let p = el.parentElement;
            for (let i = 0; i < 3 && p; i++) {
              const r = p.getBoundingClientRect();
              if (r.width > 150 && r.height > 60) {
                return { x: r.x, y: r.y, width: r.width, height: r.height };
              }
              p = p.parentElement;
            }
            return null;
          });

          if (cardBox && cardBox.width > 0 && cardBox.height > 0) {
            await page.screenshot({
              path: savedScreenshot,
              clip: {
                x: Math.max(0, cardBox.x - 10),
                y: Math.max(0, cardBox.y - 10),
                width: cardBox.width + 20,
                height: cardBox.height + 20
              }
            });
            clipped = true;
            console.log(`📸 已成功截取租期时长小卡片: ${savedScreenshot}`);
          }
        }

        if (!clipped) {
          await page.screenshot({ path: savedScreenshot, fullPage: false });
        }
      } catch (err) {
        console.log('⚠️ 截取时长卡片异常:', err.message);
      }

      return { status: renewStatus, screenshot: savedScreenshot };
    }
  } catch (e) {
    console.log(`⚠️ 租期核对异常: ${e.message}`);
  }
  return { status: '核对未完成', screenshot: savedScreenshot };
}

// 主任务流程
async function runOnce() {
  const email = (process.env.FREE_EMAIL || 'yuxiaojie0322@gmail.com').trim();
  const password = process.env.FREE_PASSWORD || 'YxJ223512@';
  const rawUrls = (process.env.SERVER_PAGE_URL || 'https://freemchost.com/app/servers/1df49f71-bb1b-454c-9cd1-70a46422a4f6').trim();
  const proxyUrl = (process.env.PROXY_URL || '').trim();
  const tgToken = (process.env.TG_BOT_TOKEN || '').trim();
  const tgChatId = (process.env.TG_CHAT_ID || '').trim();

  const serverUrls = rawUrls.split(/[\r\n,]+/).map(u => u.trim()).filter(u => u.startsWith('http'));
  if (!email || !password || serverUrls.length === 0) {
    console.error('❌ 缺失必要的账号或服务器地址配置');
    return;
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    proxy: proxyUrl ? { server: proxyUrl } : undefined
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();
  let reports = [];
  let finalScreenshot = null;

  try {
    await doLogin(page, email, password);

    for (let i = 0; i < serverUrls.length; i++) {
      const url = serverUrls[i];
      const sIndex = i + 1;
      console.log(`\n================= 处理第 [${sIndex}/${serverUrls.length}] 台服务器 =================`);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2500);
      await cleanPopup(page);

      // 步骤 1：确认开机状态，如果未开启则触发 Start 三角键
      const isRunning = await ensureServerRunning(page);

      // 步骤 2：确定状态后切换至 Billing 执行加时续期与截取时长
      const billRes = await handleBillingRenew(page);
      if (billRes.screenshot) {
        finalScreenshot = billRes.screenshot;
      }

      reports.push(
        `🖥️ <b>服务器 ${sIndex}</b>:\n` +
        `   ⚡ <b>运行状态</b>: ${isRunning ? '正常运行中 (Connected & Running)' : '未完全运行'}\n` +
        `   📅 <b>长效租期</b>: ${billRes.status}`
      );
    }

    const nowStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const summary =
      `🤖 <b>FreeMCHost 巡检完成</b>\n\n` +
      reports.join('\n\n') + '\n\n' +
      `<b>策略:</b> 运行状态维持 + 46h门槛自动续期\n` +
      `<b>完成时间:</b> ` + nowStr;

    await sendTG(tgToken, tgChatId, summary, finalScreenshot);

  } catch (err) {
    console.error('❌ 执行异常:', err.message);
    try {
      fs.mkdirSync('screenshots', { recursive: true });
      const errShot = path.join('screenshots', `error-${Date.now()}.png`);
      await page.screenshot({ path: errShot });
      await sendTG(tgToken, tgChatId, `⚠️ <b>FreeMCHost 巡检异常</b>:\n${err.message}`, errShot);
    } catch (_) {}
  } finally {
    await browser.close();
    console.log('🏁 任务顺利完成\n');
  }
}

// 执行入口
(async () => {
  await runOnce();
})();
