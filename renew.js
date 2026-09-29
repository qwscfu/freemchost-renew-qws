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
    if (await later.isVisible({ timeout: 300 })) {
      await later.click();
      console.log('🛡️ 顺手关闭了 Maybe later 弹窗');
      await page.waitForTimeout(300);
    }
  } catch (e) {}
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
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
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
    await cleanPopup(page);

    await page.locator('input[type="email"]').fill(email);
    await page.locator('input[type="password"]').fill(password);
    await Promise.all([
      page.waitForURL(url => !url.href.includes('/login'), { timeout: 30000 }),
      page.locator('button:has-text("Sign in")').click()
    ]);
    console.log('✅ 登录成功！');

    for (let i = 0; i < serverUrls.length; i++) {
      const url = serverUrls[i];
      const sIndex = i + 1;
      console.log(`\n================= 正在处理服务器 [${sIndex}/${serverUrls.length}] =================`);

      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      await cleanPopup(page);

      // 点 PLAN Billing 标签页
      console.log('👉 切换至 Billing 页面...');
      const billingTab = page.locator('button, a, div[role="tab"]').filter({ hasText: /Billing/i }).first();
      await billingTab.click();
      await page.waitForTimeout(1500);
      await cleanPopup(page);

      // 读取当前时间
      const beforeTime = await page.evaluate(() => {
        const m = (document.body.innerText || '').match(/(\d{1,3})\s*D\s*(\d{1,2})\s*H\s*(\d{1,2})\s*M/i);
        return m ? `${m[1]}天${m[2]}小时${m[3]}分` : '未知';
      });
      console.log(`⏱️ 操作前剩余时长: ${beforeTime}`);

      // 点击 Renew now 打开弹窗
      console.log('👉 点击 [Renew now]...');
      const renewNowBtn = page.locator('button:has-text("Renew now")').first();
      await renewNowBtn.click();
      await page.waitForTimeout(1500);
      await cleanPopup(page);

      // 简单、纯粹地模拟真人点击 60 hours 卡片
      console.log('👉 模拟真人点击 [60 hours] 选项框...');
      const card = page.locator('div, button').filter({ hasText: '60 hours' }).last();
      await card.hover();
      await page.waitForTimeout(300);
      await card.click();
      console.log('👆 已完成点击！');

      // 等待 3 秒让网络通信完成
      await page.waitForTimeout(3000);
      await cleanPopup(page);

      // 刷新页面查看最终结果
      console.log('🔄 刷新页面核对结果...');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);
      await cleanPopup(page);
      await page.locator('button, a, div[role="tab"]').filter({ hasText: /Billing/i }).first().click().catch(() => {});
      await page.waitForTimeout(1000);

      const afterTime = await page.evaluate(() => {
        const m = (document.body.innerText || '').match(/(\d{1,3})\s*D\s*(\d{1,2})\s*H\s*(\d{1,2})\s*M/i);
        return m ? `${m[1]}天${m[2]}小时${m[3]}分` : '未知';
      });
      console.log(`⏱️ 最终时长: ${afterTime}`);

      reports.push(`🖥️ <b>服务器 ${sIndex}</b>: ${beforeTime} ➔ <b>${afterTime}</b>`);
    }

    const summary = `🤖 <b>FreeMCHost 巡检结果</b>\n\n${reports.join('\n')}\n\n<b>时间:</b> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    await sendTG(tgToken, tgChatId, summary);

  } catch (err) {
    console.error('❌ 执行异常:', err.message);
  } finally {
    await browser.close();
    console.log('🏁 完成并关闭浏览器。');
  }
})();
