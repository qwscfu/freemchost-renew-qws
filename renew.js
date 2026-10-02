const { chromium } = require('playwright');

// Telegram 通知
async function sendTG(botToken, chatId, text) {
  if (!botToken || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
  } catch (e) {}
}

// 顺手关掉可能出现的打分弹窗
async function cleanPopup(page) {
  try {
    const later = page.locator('text="Maybe later"').first();
    if (await later.isVisible({ timeout: 200 })) {
      await later.click();
      console.log('🛡️ 顺手关闭了 Maybe later 弹窗');
      await page.waitForTimeout(300);
    }
  } catch (e) {}
}

// 格式化时长字符串，清洗掉多余的换行与空格
function formatTimeString(raw) {
  if (!raw) return '未知';
  return raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// 从当前页面精确提取倒计时（优先从专用容器提取）
async function extractExpiryTime(page) {
  return await page.evaluate(() => {
    // 方案 1: 从 TIME UNTIL EXPIRY 下方卡片精准提取
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

    // 方案 2: 全局正则兜底匹配
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

(async () => {
  const email = (process.env.FREE_EMAIL || '').trim();
  const password = process.env.FREE_PASSWORD || '';
  const rawUrls = (process.env.SERVER_PAGE_URL || '').trim();
  const proxyUrl = (process.env.PROXY_URL || '').trim();
  const tgToken = (process.env.TG_BOT_TOKEN || '').trim();
  const tgChatId = (process.env.TG_CHAT_ID || '').trim();

  const serverUrls = rawUrls.split(/[\r\n,]+/).map(u => u.trim()).filter(u => u.startsWith('http'));
  if (!email || !password || serverUrls.length === 0) {
    console.error('❌ 缺失账号、密码或服务器地址！');
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    proxy: proxyUrl ? { server: proxyUrl } : undefined
  });

  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  let reports = [];

  try {
    console.log('🚀 正在登录...');
    await page.goto('https://freemchost.com/login', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await cleanPopup(page);

    const emailInput = page.locator('input[type="email"]').first();
    await emailInput.click();
    await emailInput.fill(email);

    const passInput = page.locator('input[type="password"]').first();
    await passInput.click();
    await passInput.fill(password);
    await page.waitForTimeout(300);

    const signInBtn = page.locator('button[type="submit"]:has-text("Sign in")').first();
    await signInBtn.click();

    let loggedIn = false;
    for (let wait = 0; wait < 15; wait++) {
      await page.waitForTimeout(1000);
      const curUrl = page.url();
      if (!curUrl.includes('/login')) {
        loggedIn = true;
        break;
      }
      await cleanPopup(page);
    }

    if (!loggedIn) {
      throw new Error('登录未跳转，可能密码错误或被验证码拦截');
    }
    console.log('✅ 登录成功！');

    for (let i = 0; i < serverUrls.length; i++) {
      const url = serverUrls[i];
      const sIndex = i + 1;
      console.log(`\n================= 正在巡检服务器 [${sIndex}/${serverUrls.length}] =================`);

      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      await cleanPopup(page);

      // 精准定位 PLAN Billing 标签页
      console.log('👉 切换至 PLAN Billing 页面...');
      const billingTab = page.locator('[role="tab"]:has-text("Billing"), button:has-text("PLAN")').last();
      await billingTab.scrollIntoViewIfNeeded().catch(() => {});
      await billingTab.click({ force: true });
      await page.waitForTimeout(2000);
      await cleanPopup(page);

      // 读取当前时间
      const timeData = await extractExpiryTime(page);
      const beforeTime = timeData ? timeData.raw : '未获取到';
      const remainHours = timeData ? timeData.totalHours : 99;
      console.log(`⏱️ 操作前剩余时长: ${beforeTime} (约 ${remainHours.toFixed(1)}h)`);

      // 只有剩余时长 < 46h 时才触发续期
      if (remainHours < 46) {
        console.log('🎯 剩余时长 < 46 小时，打开续期弹窗...');
        const renewNowBtn = page.locator('button:has-text("Renew now")').first();
        await renewNowBtn.waitFor({ state: 'visible', timeout: 10000 });
        await renewNowBtn.click({ force: true });
        await page.waitForTimeout(1500);
        await cleanPopup(page);

        // 核心延迟缓冲：保持弹窗停留 8 秒，生成防刷签名与 dwell_ms
        console.log('⏳ 保持弹窗停留 8 秒，累积交互计时与签名生成...');
        for (let sec = 0; sec < 8; sec++) {
          await cleanPopup(page);
          await page.mouse.move(960 + sec * 5, 540 + sec * 3);
          await page.waitForTimeout(1000);
        }

        console.log('👉 检查 [60 hours] 选项框...');
        const card = page.locator('div, button').filter({ hasText: '60 hours' }).last();
        const canClick = await card.isEnabled({ timeout: 2000 }).catch(() => false);

        if (canClick) {
          console.log('✅ 选项已就绪，执行物理点击...');
          await card.hover();
          await page.waitForTimeout(400);
          await card.click({ force: true });
          console.log('👆 点击完成！');

          console.log('⏳ 等待后端入库事务处理 (8 秒)...');
          await page.waitForTimeout(8000);
          await cleanPopup(page);

          // 刷新当前页面查看真实加时状态
          console.log('🔄 刷新页面核对最新时长...');
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(2000);
          await cleanPopup(page);
          await page.locator('[role="tab"]:has-text("Billing"), button:has-text("PLAN")').last().click({ force: true }).catch(() => {});
          await page.waitForTimeout(1500);

          const afterTimeData = await extractExpiryTime(page);
          const afterTime = afterTimeData ? afterTimeData.raw : '已完成加时';

          reports.push(`🟢 <b>服务器 ${sIndex}</b>: 成功续期 (+60h)\n     └ 状态: ${beforeTime} ➔ <b>${afterTime}</b>`);
        } else {
          console.log('⏳ 选项未解锁，无需点击。');
          await page.locator('button:has-text("✕"), [aria-label="Close"], button:has-text("Close")').first().click().catch(() => {});
          reports.push(`⚪ <b>服务器 ${sIndex}</b>: 剩余 <b>${beforeTime}</b> (未到门槛，保持等待)`);
        }
      } else {
        console.log(`⏳ 剩余时长 ${beforeTime} (${remainHours.toFixed(1)}h > 46h)，安全充足，无需操作。`);
        reports.push(`⚪ <b>服务器 ${sIndex}</b>: 剩余 <b>${beforeTime}</b> (安全充足，保持等待)`);
      }
    }

    // 格式化输出简洁干净的通知
    const summary = `🤖 <b>FreeMCHost 巡检报告</b>\n\n${reports.join('\n\n')}\n\n<b>检查规则:</b> 低于 46h 门槛时自动激活续期\n<b>更新时间:</b> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    await sendTG(tgToken, tgChatId, summary);

  } catch (err) {
    console.error('❌ 执行异常:', err.message);
  } finally {
    await browser.close();
    console.log('🏁 完成并关闭浏览器。');
  }
})();
