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
        console.log(`⚠️️ 发送图片异常 (${err.message})，回退到纯文本...`);
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

// 清理阻挡点击的 Modal 弹窗
async function cleanPopup(page) {
  try {
    const popups = [
      'button:has-text("Maybe later")',
      'div[role="dialog"] button:has-text("Maybe later")',
      'text="Maybe later"',
      'button:has-text("Accept")',
      'button:has-text("I understand")',
      'button:has-text("Dismiss")',
      'button:has-text("Close")',
      '[aria-label="Close"]'
    ];
    for (const sel of popups) {
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
  await passInput.click();
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

// 执行开机：直接点击三角启动按钮，再点击 Standard start 二级确认
async function triggerStartServer(page) {
  console.log('⚡ 开始执行开机指令...');
  
  // 确保处于 Console 控制台标签
  try {
    const consoleTab = page.locator('[role="tab"]:has-text("Console"), button:has-text("Console"), a:has-text("Console")').first();
    if (await consoleTab.isVisible({ timeout: 2500 }).catch(() => false)) {
      await consoleTab.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1200);
    }
  } catch (e) {}

  await cleanPopup(page);

  // 1. 定位并点击图 1 的三角开机按钮
  const playButtonSelectors = [
    'button:has(svg.lucide-play)',
    'button:has(svg[data-icon="play"])',
    'button:has(svg.fa-play)',
    'button[aria-label*="start" i]'
  ];

  let startClicked = false;
  for (const sel of playButtonSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ force: true });
      startClicked = true;
      console.log(`👆 已点击控制台主开机三角按钮: ${sel}`);
      break;
    }
  }

  if (!startClicked) {
    console.log('🔄 备用策略：深度遍历 SVG 三角图元并触发点击...');
    startClicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      for (const b of btns) {
        const svg = b.querySelector('svg');
        if (svg) {
          const html = svg.innerHTML.toLowerCase();
          if (html.includes('polygon') || svg.classList.contains('lucide-play') || b.getAttribute('aria-label') === 'Start') {
            b.click();
            return true;
          }
        }
      }
      return false;
    });
  }

  await page.waitForTimeout(1500);

  // 2. 点击图 2 弹出的 "Standard start" 卡片按钮
  const standardStartSelectors = [
    'button:has-text("Standard start")',
    'div:has-text("Standard start")',
    '[role="button"]:has-text("Standard start")'
  ];

  let standardClicked = false;
  for (const sel of standardStartSelectors) {
    const standardBtn = page.locator(sel).last();
    if (await standardBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await standardBtn.click({ force: true });
      standardClicked = true;
      console.log(`👆 已成功点击【Standard start】按钮启动服务器！`);
      break;
    }
  }

  if (!standardClicked) {
    console.log('ℹ️ 未检测到 Standard start 确认弹窗，可能已直接处于运行状态或已进入开机序列');
  }

  await page.waitForTimeout(3000);
  await cleanPopup(page);
}

// 提取 Plan Billing 页面到期时间
async function extractExpiryTime(page) {
  return await page.evaluate(() => {
    const allEls = Array.from(document.querySelectorAll('*'));
    const header = allEls.find(el => el && el.textContent && el.textContent.trim().toUpperCase().includes('TIME UNTIL EXPIRY'));
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

// 核对并处理 Plan 租期，精准裁剪 TIME UNTIL EXPIRY 倒计时小卡片
async function handleBillingRenew(page) {
  let savedScreenshot = null;
  try {
    console.log('👉 切换至 PLAN Billing 页面核对租期...');
    const billingTab = page.locator('[role="tab"]:has-text("Billing"), button:has-text("PLAN")').last();
    if (await billingTab.isVisible({ timeout: 5000 }).catch(() => false)) {
      await billingTab.click({ force: true });
      await page.waitForTimeout(2500);
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

      // 健壮截取：锁定 TIME UNTIL EXPIRY 及其子圆角数字方块
      try {
        fs.mkdirSync('screenshots', { recursive: true });
        savedScreenshot = path.join('screenshots', `billing-${Date.now()}.png`);

        const cardBox = await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('*'));
          const target = els.find(el => (el.textContent || '').trim().toUpperCase().includes('TIME UNTIL EXPIRY') && el.children.length === 0);
          if (!target) return null;

          let p = target.parentElement;
          for (let i = 0; i < 4 && p; i++) {
            const txt = p.innerText || '';
            if (txt.includes('TIME UNTIL EXPIRY') && (txt.includes('Renews on demand') || txt.includes('D'))) {
              const r = p.getBoundingClientRect();
              if (r.width > 100 && r.height > 40) {
                return { x: r.x, y: r.y, width: Math.min(r.width, 275), height: r.height };
              }
            }
            p = p.parentElement;
          }
          const rect = target.getBoundingClientRect();
          return { x: rect.x - 5, y: rect.y - 5, width: 260, height: 110 };
        });

        if (cardBox && cardBox.width > 0 && cardBox.height > 0) {
          await page.screenshot({
            path: savedScreenshot,
            clip: {
              x: Math.max(0, cardBox.x),
              y: Math.max(0, cardBox.y),
              width: cardBox.width + 12,
              height: cardBox.height + 8
            }
          });
          console.log(`📸 已成功截取精准倒计时小卡片: ${savedScreenshot}`);
        } else {
          await page.screenshot({ path: savedScreenshot, fullPage: false });
        }
      } catch (err) {
        console.log('⚠️ 截取倒计时卡片异常:', err.message);
      }

      return { status: renewStatus, screenshot: savedScreenshot };
    }
  } catch (e) {
    console.log(`⚠️ 租期核对异常: ${e.message}`);
  }
  return { status: '核对未完成', screenshot: savedScreenshot };
}

// 主任务入口
async function runOnce() {
  const email = (process.env.FREE_EMAIL || 'yuxiaojie0322@gmail.com').trim();
  const password = process.env.FREE_PASSWORD || 'YxJ223512@';
  const rawUrls = (process.env.SERVER_PAGE_URL || 'https://freemchost.com/app/servers/c63915c5-59b1-446a-8b77-9b2ea7bff9f2').trim();
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

      // 1. 直接触发开机指令（点击主三角键 + 二级 Standard start）
      await triggerStartServer(page);

      // 2. 切换至 Billing 执行加时续期及精准截取倒计时小卡片
      const billRes = await handleBillingRenew(page);
      if (billRes.screenshot) {
        finalScreenshot = billRes.screenshot;
      }

      reports.push(
        `🖥️ <b>服务器 ${sIndex}</b>:\n` +
        `   ⚡ <b>开机维护</b>: 已触发开机指令 (Standard Start)\n` +
        `   📅 <b>长效租期</b>: ${billRes.status}`
      );
    }

    const nowStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const summary =
      `🤖 <b>FreeMCHost 巡检完成</b>\n\n` +
      reports.join('\n\n') + '\n\n' +
      `<b>策略:</b> 开机指令维持 + 46h门槛自动续期\n` +
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

(async () => {
  await runOnce();
})();
