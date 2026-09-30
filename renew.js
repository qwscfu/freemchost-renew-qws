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

// 在列表页直接读取真实时长（避开单页内的乐观假缓存）
async function getRealListTimes(page) {
  return await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('div')).filter(d => 
      (d.innerText || '').includes('EXPIRES IN') && (d.innerText || '').includes('fmc')
    );
    const map = {};
    cards.forEach(c => {
      const txt = c.innerText || '';
      const nameMatch = txt.match(/fmc\d+/i);
      const timeMatch = txt.match(/EXPIRES IN\s*([\dd\s:hm]+)/i);
      if (nameMatch && timeMatch) {
        // 清洗提取文本内的换行符
        const cleanVal = timeMatch[1].replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
        map[nameMatch[0].toLowerCase()] = cleanVal;
      }
    });
    return map;
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
      console.log(`\n================= 正在处理服务器 [${sIndex}/${serverUrls.length}] =================`);

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
      const beforeTimeRaw = await page.evaluate(() => {
        const m = (document.body.innerText || '').match(/(\d{1,3})\s*D\s*(\d{1,2})\s*H\s*(\d{1,2})\s*M/i);
        return m ? `${m[1]}天${m[2]}小时${m[3]}分` : '未知';
      });
      const beforeTime = formatTimeString(beforeTimeRaw);
      console.log(`⏱️ 操作前剩余时长: ${beforeTime}`);

      // 点击 Renew now 打开弹窗
      console.log('👉 点击 [Renew now]...');
      const renewNowBtn = page.locator('button:has-text("Renew now")').first();
      await renewNowBtn.waitFor({ state: 'visible', timeout: 10000 });
      await renewNowBtn.click({ force: true });
      await page.waitForTimeout(1500);
      await cleanPopup(page);

      // 检查 [60 hours] 选项
      console.log('👉 检查 [60 hours] 选项框...');
      const card = page.locator('div, button').filter({ hasText: '60 hours' }).last();

      const canClick = await card.isEnabled({ timeout: 2000 }).catch(() => false);
      const isLocked = await page.evaluate(() => {
        const text = document.body.innerText || '';
        return text.toLowerCase().includes('come back later');
      });

      if (canClick && !isLocked) {
        console.log('✅ 选项已解锁，模拟真人点击...');
        await card.hover();
        await page.waitForTimeout(300);
        await card.click({ force: true });
        console.log('👆 已完成点击！');

        console.log('⏳ 等待后端数据库提交事务 (6 秒)...');
        await page.waitForTimeout(6000);
        await cleanPopup(page);

        // 返回总览列表页（/app/servers），读取真实入库时间
        console.log('🔍 返回服务器列表页核实最终真实时长...');
        await page.goto('https://freemchost.com/app/servers', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
        await cleanPopup(page);

        const realList = await getRealListTimes(page);
        console.log('📋 当前列表页各服务器最新真实时间:', JSON.stringify(realList));

        // 格式化当前服务器对应的最新时间
        const serverKey = `fmc0${sIndex}`.toLowerCase();
        const afterTime = realList[serverKey] || '已刷新入账';

        if (i < serverUrls.length - 1) {
          console.log('☕ 避免同账号连续请求触发后端并发锁，安全冷却 8 秒...');
          await page.waitForTimeout(8000);
        }

        reports.push(`🟢 <b>服务器 ${sIndex}</b>: 成功续期 (+60h)\n     └ 状态: ${beforeTime} ➔ <b>${afterTime}</b>`);
      } else {
        console.log(`⏳ 选项处于置灰状态（剩余 ${beforeTime} > 46h），无需点击。`);
        await page.locator('button:has-text("✕"), [aria-label="Close"], button:has-text("Close")').first().click().catch(() => {});
        reports.push(`⚪ <b>服务器 ${sIndex}</b>: 剩余 <b>${beforeTime}</b> (安全充足，保持等待)`);
      }
    }

    // 格式化 Telegram 报告输出
    const summary = `🤖 <b>FreeMCHost 巡检报告</b>\n\n${reports.join('\n\n')}\n\n<b>检查策略:</b> 剩余低于 46h 时自动激活 +60h 续期\n<b>更新时间:</b> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    await sendTG(tgToken, tgChatId, summary);

  } catch (err) {
    console.error('❌ 执行异常:', err.message);
  } finally {
    await browser.close();
    console.log('🏁 完成并关闭浏览器。');
  }
})();
