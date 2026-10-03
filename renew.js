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

// 格式化时长字符串
function formatTimeString(raw) {
  if (!raw) return '未知';
  return raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// 从当前页面精确提取倒计时
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

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();
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

      if (remainHours < 46) {
        console.log('🎯 剩余时长 < 46 小时，打开续期弹窗...');
        const renewNowBtn = page.locator('button:has-text("Renew now")').first();
        await renewNowBtn.waitFor({ state: 'visible', timeout: 10000 });
        await renewNowBtn.click({ force: true });
        await page.waitForTimeout(1500);
        await cleanPopup(page);

        // 核心延迟防线：等待 8 秒
        console.log('⏳ 保持弹窗停留 8 秒，累积交互计时与签名生成...');
        for (let sec = 0; sec < 8; sec++) {
          await cleanPopup(page);
          await page.mouse.move(960 + sec * 5, 540 + sec * 3);
          await page.waitForTimeout(1000);
        }

        // 关键防护：在即将点击前，做最后一次弹窗清理，并强制点击续期弹窗头部重获焦点
        await cleanPopup(page);
        const renewModal = page.locator('div').filter({ hasText: 'Keep your server online' }).last();
        await renewModal.click({ position: { x: 50, y: 20 } }).catch(() => {});
        await page.waitForTimeout(300);

        console.log('👉 检查并锁定 [60 hours] 选项框...');
        const card = renewModal.locator('div, button').filter({ hasText: '60 hours' }).last();

        // 核心网络响应硬拦截：必须抓到真实的写库 RPC 请求
        let writePacketSent = false;
        page.on('response', res => {
          const u = res.url();
          if (u.includes('_serverFn') && res.status() === 200 && !u.includes('feedback')) {
            // 抓取到真正的 action 触发
            writePacketSent = true;
          }
        });

        // 最多尝试 3 次针对性打击，直到网络层真正发出了请求
        for (let attempt = 1; attempt <= 3; attempt++) {
          console.log(`🖱️ 发起物理击发序列 #${attempt}...`);
          await card.scrollIntoViewIfNeeded().catch(() => {});
          await card.hover();
          await page.waitForTimeout(200);
          await card.click({ delay: 100 });
          await page.keyboard.press('Enter');

          // 观察 2 秒是否抓到发包
          await page.waitForTimeout(2000);
          if (writePacketSent) {
            console.log('📡 确认捕捉到真实加时发包离开浏览器！');
            break;
          }
          console.log('⚠️ 尚未捕捉到写库包，重新聚焦并补刀...');
          await renewModal.click({ position: { x: 100, y: 50 } }).catch(() => {});
          await cleanPopup(page);
        }

        console.log('⏳ 等待后端入库事务完全提交 (8 秒)...');
        await page.waitForTimeout(8000);
        await cleanPopup(page);

        // 彻底杜绝本地内存假缓存：创建完全干净的隔离上下文核验最终真实数据
        console.log('🔍 启动全新独立上下文读取真实数据库时间...');
        const verifyCtx = await browser.newContext({
          viewport: { width: 1920, height: 1080 },
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        });
        const vPage = await verifyCtx.newPage();
        await vPage.goto('https://freemchost.com/login', { waitUntil: 'domcontentloaded' });
        await vPage.locator('input[type="email"]').first().fill(email);
        await vPage.locator('input[type="password"]').first().fill(password);
        await vPage.locator('button[type="submit"]:has-text("Sign in")').first().click();
        await vPage.waitForTimeout(2500);

        await vPage.goto(url, { waitUntil: 'domcontentloaded' });
        await vPage.waitForTimeout(2000);
        await vPage.locator('[role="tab"]:has-text("Billing"), button:has-text("PLAN")').last().click({ force: true }).catch(() => {});
        await vPage.waitForTimeout(1500);

        const realTimeData = await extractExpiryTime(vPage);
        const finalTime = realTimeData ? realTimeData.raw : '未获取到';
        const finalHours = realTimeData ? realTimeData.totalHours : remainHours;
        await verifyCtx.close();

        console.log(`⏱️ 终审核验结果: 前序 ${beforeTime} ➔ 数据库实际存留: ${finalTime}`);

        // 只有数据库真真实实增加了 20 小时以上才发成功报告
        if (finalHours > remainHours + 20) {
          reports.push(`🟢 <b>服务器 ${sIndex}</b>: 成功续期 (+60h)\n     └ 状态: ${beforeTime} ➔ <b>${finalTime}</b>`);
        } else {
          reports.push(`🔴 <b>服务器 ${sIndex}</b>: 本次点击未入账 (当前: ${finalTime})\n     └ 机制: 下个周期自动重试`);
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
