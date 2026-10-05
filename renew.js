const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Telegram 消息与截图推送
async function sendTG(botToken, chatId, text, photoPath) {
  if (!botToken || !chatId) return;
  try {
    // 优先尝试发送图片（带文字标题 Caption）
    if (photoPath && fs.existsSync(photoPath)) {
      try {
        const fileBuffer = fs.readFileSync(photoPath);
        const blob = new Blob([fileBuffer], { type: 'image/png' });
        const formData = new FormData();
        formData.append('chat_id', chatId);
        formData.append('caption', text.substring(0, 1024)); // Telegram caption 最多 1024 字符
        formData.append('parse_mode', 'HTML');
        formData.append('photo', blob, path.basename(photoPath));

        const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
          method: 'POST',
          body: formData
        });

        if (res.ok) {
          console.log('📨 Telegram 截图与图文报告推送成功！');
          return;
        } else {
          const errData = await res.text();
          console.log(`⚠️ sendPhoto 接口返回错误 (${errData})，自动回退到纯文本推送...`);
        }
      } catch (err) {
        console.log(`⚠️️ 发送图片过程异常 (${err.message})，自动回退到纯文本推送...`);
      }
    }

    // 回退到纯文本发送
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

// 顺手关闭可能会遮挡点击的弹窗与横幅（加入多变体匹配与强力穿透）
async function cleanPopup(page) {
  try {
    const selectors = [
      'text="Maybe later"',
      'button:has-text("Maybe later")',
      'div:has-text("Maybe later")',
      'button:has-text("Accept")',
      'button:has-text("I understand")',
      'button:has-text("Dismiss")',
      'button:has-text("Close")',
      '[aria-label="Close"]'
    ];
    for (const sel of selectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 120 }).catch(() => false)) {
        await el.click({ force: true }).catch(() => {});
        console.log(`🧹 顺手关闭遮挡弹窗: ${sel}`);
        await page.waitForTimeout(150);
      }
    }
  } catch (e) {}
}

// 唤醒处于休眠/关机状态的服务器（如果是 Offline 状态自动点 Start）
async function checkAndWakeServer(page) {
  try {
    const startBtn = page.locator('button:has-text("Start"), div[role="button"]:has-text("Start")').first();
    if (await startBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      console.log('⚡ 检测到服务器处于离线状态，正在点击【Start】唤醒服务器...');
      await startBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(5000);
      await cleanPopup(page);
      console.log('🚀 已触发开机唤醒');
      return true;
    }
  } catch (e) {}
  return false;
}

// 时间分秒转秒数辅助函数
function parseMinutesSeconds(str) {
  if (!str) return 0;
  const parts = str.split(':').map(Number);
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
    return parts[0] * 60 + parts[1];
  }
  return 0;
}

// 核心功能：维持在线计时器，点击控制台上方 Reset 按钮
async function resetOnlineTimer(page) {
  console.log('🔍 正在检测控制台在线倒计时状态...');

  // 1. 深度清理弹窗并切入 Console
  for (let i = 0; i < 3; i++) {
    await cleanPopup(page);
    await page.waitForTimeout(200);
  }

  try {
    const consoleTab = page.locator('[role="tab"]:has-text("Console"), button:has-text("Console"), a:has-text("Console")').first();
    if (await consoleTab.isVisible({ timeout: 2500 }).catch(() => false)) {
      await consoleTab.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1000);
    }
  } catch (e) {}

  await cleanPopup(page);
  await checkAndWakeServer(page);

  // 2. 轮询等待渲染：多正则宽容匹配，同时循环清理随时弹出的 "Maybe later" 遮罩
  console.log('⏳ 等待控制台 WebSocket 连通与 Online 状态渲染（最长等待 45 秒）...');
  let beforeTimeStr = null;
  const startTime = Date.now();

  const timeRegexes = [
    /Online\s*[:：]?\s*(\d{1,2}:\d{2})/i,
    /(\d{1,2}:\d{2})\s*(?:remaining|left)/i,
    /Online[\s\S]{0,30}?(\d{1,2}:\d{2})/i
  ];

  while (Date.now() - startTime < 45000) {
    // 持续清理可能阻挡渲染的模态框
    await cleanPopup(page);

    beforeTimeStr = await page.evaluate((patterns) => {
      const text = document.body ? (document.body.innerText || '') : '';
      for (const p of patterns) {
        const regex = new RegExp(p.source, p.flags);
        const match = text.match(regex);
        if (match && match[1]) return match[1];
      }
      return null;
    }, timeRegexes.map(r => ({ source: r.source, flags: r.flags })));

    if (beforeTimeStr) {
      console.log(`✨ 在第 ${Math.round((Date.now() - startTime) / 1000)} 秒成功抓取到在线倒计时: ${beforeTimeStr}`);
      break;
    }
    await page.waitForTimeout(1500);
  }

  beforeTimeStr = beforeTimeStr || '未识别到具体剩余';
  const beforeSeconds = parseMinutesSeconds(beforeTimeStr);
  console.log(`⏱️ 操作前在线倒计时: ${beforeTimeStr} (${beforeSeconds}秒)`);

  // 3. 定位 Reset 按钮并执行点击
  let resetClicked = false;

  // 策略 A: 精确文本与角色定位
  const resetLocators = [
    page.getByRole('button', { name: /^reset$/i }),
    page.getByText(/^reset$/i),
    page.locator('button:has-text("Reset")'),
    page.locator('a:has-text("Reset")'),
    page.locator('[role="button"]:has-text("Reset")')
  ];

  for (const loc of resetLocators) {
    try {
      const target = loc.first();
      if (await target.isVisible({ timeout: 1200 }).catch(() => false)) {
        await target.scrollIntoViewIfNeeded().catch(() => {});
        await target.hover().catch(() => {});
        await page.waitForTimeout(200);
        await target.click({ force: true });
        resetClicked = true;
        console.log('👆 已成功触发 Reset 按钮点击！');
        break;
      }
    } catch (e) {}
  }

  // 策略 B: 深度 DOM 穿透查找可点击的 Reset 节点
  if (!resetClicked) {
    console.log('🔄 尝试通过 DOM 树结构深度定位并触发 Reset 点击...');
    const clickedByEval = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('button, a, div[role="button"], span, div'));
      for (const el of all) {
        const text = (el.innerText || el.textContent || '').trim();
        if (/^reset$/i.test(text)) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            el.click();
            return true;
          }
        }
      }
      return false;
    });

    if (clickedByEval) {
      resetClicked = true;
      console.log('👆 通过 DOM 深度定位成功执行 Reset 点击！');
    }
  }

  // 4. 等待重置后时间刷新确认
  let afterTimeStr = null;
  console.log('⏳ 正在等待在线倒计时刷新确认...');
  for (let round = 0; round < 8; round++) {
    await page.waitForTimeout(1000);
    afterTimeStr = await page.evaluate((patterns) => {
      const text = document.body ? (document.body.innerText || '') : '';
      for (const p of patterns) {
        const regex = new RegExp(p.source, p.flags);
        const match = text.match(regex);
        if (match && match[1]) return match[1];
      }
      return null;
    }, timeRegexes.map(r => ({ source: r.source, flags: r.flags })));

    const afterSec = parseMinutesSeconds(afterTimeStr);
    if (afterSec > beforeSeconds && afterSec >= 35 * 60) {
      console.log(`🎉 倒计时已成功变更为满额重置时间: ${afterTimeStr}`);
      resetClicked = true;
      break;
    }
  }

  afterTimeStr = afterTimeStr || (resetClicked ? '45:00' : beforeTimeStr);
  console.log(`✅ 在线状态重置流程完成: [${beforeTimeStr}] ➔ [${afterTimeStr}] (${resetClicked ? '成功' : '未触发'})`);

  // 保存凭据截图
  let savedScreenshot = null;
  try {
    fs.mkdirSync('screenshots', { recursive: true });
    savedScreenshot = path.join('screenshots', `reset-${Date.now()}.png`);
    await page.screenshot({ path: savedScreenshot, fullPage: false });
    console.log(`📸 已保存控制台凭据截图: ${savedScreenshot}`);
  } catch (e) {
    console.log('⚠️ 截图保存异常:', e.message);
  }

  return {
    success: resetClicked,
    before: beforeTimeStr,
    after: afterTimeStr,
    screenshot: savedScreenshot
  };
}

// 提取 Plan Billing 页面中的到期时间（天/时/分）
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

// 兼顾原有的 Plan 租期检查（每当 < 46h 顺便续期 60 小时，双重保活）
async function checkAndRenewBilling(page) {
  try {
    console.log('👉 顺便切换至 PLAN Billing 核对长效租期...');
    const billingTab = page.locator('[role="tab"]:has-text("Billing"), button:has-text("PLAN")').last();
    if (await billingTab.isVisible({ timeout: 2500 }).catch(() => false)) {
      await billingTab.scrollIntoViewIfNeeded().catch(() => {});
      await billingTab.click({ force: true });
      await page.waitForTimeout(2000);
      await cleanPopup(page);

      const timeData = await extractExpiryTime(page);
      const beforeTime = timeData ? timeData.raw : '未获取到';
      const remainHours = timeData ? timeData.totalHours : 99;
      console.log(`⏱️ 租期剩余时长: ${beforeTime} (约 ${remainHours.toFixed(1)}h)`);

      if (remainHours < 46) {
        console.log('🎯 租期 < 46 小时，执行 60h 长效免费续期...');
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
            await page.waitForTimeout(5000);
            return { executed: true, status: '已成功加时 (+60h)' };
          }
        }
      } else {
        return { executed: false, status: `剩余 ${beforeTime} (租期充足无需加时)` };
      }
    }
  } catch (e) {
    console.log(`⚠️ 租期检查过程跳过: ${e.message}`);
  }
  return { executed: false, status: '已跳过租期检查' };
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
  await emailInput.click();
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
    const curUrl = page.url();
    if (!curUrl.includes('/login')) {
      loggedIn = true;
      break;
    }
    await cleanPopup(page);
  }

  if (!loggedIn) {
    throw new Error('登录未成功跳转，请检查账号密码或是否有验证码拦截');
  }
  console.log('🎉 登录成功！');
}

// 执行单次巡检与保活
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
      console.log(`\n================= 正在执行第 [${sIndex}/${serverUrls.length}] 台服务器保活 =================`);

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2500);
      await cleanPopup(page);

      // 1. 核心任务：Reset 在线保活
      const resetRes = await resetOnlineTimer(page);
      if (resetRes.screenshot) {
        finalScreenshot = resetRes.screenshot;
      }

      // 2. 辅助任务：Plan 租期核对
      const billRes = await checkAndRenewBilling(page);

      reports.push(
        `🖥️ <b>服务器 ${sIndex}</b>:\n` +
        `   ⌛ <b>在线重置</b>: ${resetRes.before} ➔ <b>${resetRes.after}</b> (${resetRes.success ? '成功' : '未触发'})\n` +
        `   📅 <b>长效租期</b>: ${billRes.status}`
      );
    }

    // 格式化输出推送报告
    const nowStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const summary =
      `🤖 <b>FreeMCHost 在线保活巡检完成</b>\n\n` +
      reports.join('\n\n') + '\n\n' +
      `<b>策略:</b> 40分钟周期在线 Reset + 46h门槛自动续期\n` +
      `<b>完成时间:</b> ` + nowStr;

    // 发送包含精简截图的图文报告
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
    console.log('🏁 本轮保活任务结束\n');
  }
}

// 主入口：支持单次执行（GitHub Actions/Cron）和常驻循环挂机（40分钟/次）
(async () => {
  const isLoop = process.env.LOOP_MODE === 'true' || process.argv.includes('--loop');
  const intervalMinutes = parseInt(process.env.INTERVAL_MINUTES || '40', 10);

  if (isLoop) {
    console.log(`🔄 已开启常驻挂机模式：每隔 ${intervalMinutes} 分钟自动执行一次 Reset...`);
    while (true) {
      console.log(`\n[${new Date().toLocaleTimeString()}] 开始执行巡检...`);
      await runOnce();
      console.log(`⏳ 本轮完成，挂机休眠 ${intervalMinutes} 分钟...`);
      await new Promise(r => setTimeout(r, intervalMinutes * 60 * 1000));
    }
  } else {
    await runOnce();
  }
})();
