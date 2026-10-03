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
    const later = page.locator('button, a, span').filter({ hasText: /^Maybe later$/i }).first();
    if (await later.isVisible({ timeout: 200 })) {
      await later.click({ force: true });
      console.log('🛡️ 顺手关闭了 Maybe later 弹窗');
      await page.waitForTimeout(300);
    }
  } catch (e) {}
}

// 格式化时长字符串
function formatTimeString(raw) {
  if (!raw) return '未知';
  return raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// 精确提取倒计时，带轮询重试
async function extractExpiryTime(page, maxTries = 5) {
  for (let i = 0; i < maxTries; i++) {
    const res = await page.evaluate(() => {
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

    if (res) return res;
    await page.waitForTimeout(1000);
  }
  return null;
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

    await page.locator('input[type="email"]').first().fill(email);
    await page.locator('input[type="password"]').first().fill(password);
    await page.locator('button[type="submit"]:has-text("Sign in")').first().click();

    let loggedIn = false;
    for (let wait = 0; wait < 15; wait++) {
      await page.waitForTimeout(1000);
      if (!page.url().includes('/login')) {
        loggedIn = true;
        break;
      }
      await cleanPopup(page);
    }

    if (!loggedIn) throw new Error('登录未跳转，可能密码错误或被拦截');
    console.log('✅ 登录成功！');

    for (let i = 0; i < serverUrls.length; i++) {
      const url = serverUrls[i];
      const sIndex = i + 1;
      console.log(`\n================= 正在巡检服务器 [${sIndex}/${serverUrls.length}] =================`);

      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      await cleanPopup(page);

      console.log('👉 切换至 PLAN Billing 页面...');
      const billingTab = page.locator('[role="tab"]:has-text("Billing"), button:has-text("PLAN")').last();
      await billingTab.scrollIntoViewIfNeeded().catch(() => {});
      await billingTab.click({ force: true });
      await page.waitForTimeout(2000);
      await cleanPopup(page);

      const timeData = await extractExpiryTime(page);
      const beforeTime = timeData ? timeData.raw : '未获取到';
      const remainHours = timeData ? timeData.totalHours : 99;
      console.log(`⏱ 操作前剩余时长: ${beforeTime} (约 ${remainHours.toFixed(1)}h)`);

      if (remainHours < 46) {
        console.log('🎯 剩余时长 < 46 小时，打开续期弹窗...');
        const renewNowBtn = page.locator('button:has-text("Renew now")').first();
        await renewNowBtn.click({ force: true });
        await page.waitForTimeout(1500);
        await cleanPopup(page);

        // 积累人机交互防刷时间
        console.log('⏳ 弹窗停留缓冲 8 秒...');
        for (let sec = 0; sec < 8; sec++) {
          await cleanPopup(page);
          await page.mouse.move(960 + sec * 5, 540 + sec * 3);
          await page.waitForTimeout(1000);
        }

        // 确保弹窗仍在显示，不在则重新点开
        const isModalVisible = await page.locator('text="Keep your server online"').isVisible().catch(() => false);
        if (!isModalVisible) {
          console.log('⚠️ 弹窗曾被异常关闭，重新拉起 Renew now...');
          await renewNowBtn.click({ force: true });
          await page.waitForTimeout(1500);
        }

        console.log('👉 定位并点击 [60 hours] 选项...');
        const targetOption = page.locator('div, button').filter({ hasText: /^60 hours/i }).last();
        await targetOption.waitFor({ state: 'visible', timeout: 8000 });
        
        await targetOption.hover();
        await page.waitForTimeout(300);
        await targetOption.click({ force: true });
        console.log('👆 已完成点击！');

        console.log('⏳ 等待后端入库事务完全提交并落库 (10 秒)...');
        await page.waitForTimeout(10000);
        await cleanPopup(page);

        // 原生硬刷新并重新抓取最新真实数据
        console.log('🔄 硬刷新当前服务器详情页核对最终时长...');
        await page.reload({ waitUntil: 'networkidle' }).catch(async () => {
          await page.reload({ waitUntil: 'domcontentloaded' });
        });
        await page.waitForTimeout(3000);
        await cleanPopup(page);

        const tabRecheck = page.locator('[role="tab"]:has-text("Billing"), button:has-text("PLAN")').last();
        await tabRecheck.scrollIntoViewIfNeeded().catch(() => {});
        await tabRecheck.click({ force: true }).catch(() => {});
        await page.waitForTimeout(2000);

        const finalTimeData = await extractExpiryTime(page, 5);
        const finalTime = finalTimeData ? finalTimeData.raw : '未获取到';
        const finalHours = finalTimeData ? finalTimeData.totalHours : remainHours;

        console.log(`⏱️ 终审核验结果: 前序 ${beforeTime} ➔ 最新实际存留: ${finalTime}`);

        if (finalHours > remainHours + 20) {
          reports.push(`🟢 <b>服务器 ${sIndex}</b>: 成功续期 (+60h)\n     └ 状态: ${beforeTime} ➔ <b>${finalTime}</b>`);
        } else {
          reports.push(`🔴 <b>服务器 ${sIndex}</b>: 触发点击未增加时间 (当前: ${finalTime})\n     └ 状态: 下个定时周期自动复查`);
        }
      } else {
        console.log(`⏳ 剩余时长 ${beforeTime} (${remainHours.toFixed(1)}h > 46h)，安全充足，无需操作。`);
        reports.push(`⚪ <b>服务器 ${sIndex}</b>: 剩余 <b>${beforeTime}</b> (安全充足，保持等待)`);
      }
    }

    const summary = `🤖 <b>FreeMCHost 巡检报告</b>\n\n${reports.join('\n\n')}\n\n<b>检查规则:</b> 低于 46h 门槛时自动激活续期\n<b>更新时间:</b> ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    await sendTG(tgToken, tgChatId, summary);

  } catch (err) {
    console.error('❌ 执行异常:', err.message);
  } finally {
    await browser.close();
    console.log('🏁 完成并关闭浏览器。');
  }
})();
