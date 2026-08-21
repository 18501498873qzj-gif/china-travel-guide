// veFaaS Serverless 函数入口
// 旅行攻略生成器：飞书知识库 + DeepSeek + .doc 输出 + 邮件发送

const fs = require('fs');
const path = require('path');
const os = require('os');
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { /* nodemailer 可选，没装也不影响核心功能 */ }

// 本地开发：加载 .env 文件（无需 dotenv 依赖）
if (process.env.NODE_ENV !== 'production') {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    });
  }
}

const { fetchKnowledgeBase } = require('./feishu');
const { generateGuide } = require('./deepseek');
const { generateDoc } = require('./docgen');
const { SYSTEM_PROMPT, buildUserPrompt, buildLocalizedFileInfo } = require('./prompt');
const currency = require('./currency');

// ---------- 邮件发送 ----------
function getSmtpConfig() {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT) || 587;
  const secure = String(process.env.SMTP_SECURE || (port === 465 ? 'true' : 'false')) === 'true';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  if (!user || !pass) return null;
  return { host, port, secure, user, pass, from };
}

let _transporterCache = null;
function getTransporter() {
  if (_transporterCache) return _transporterCache;
  const cfg = getSmtpConfig();
  if (!cfg || !nodemailer) return null;
  _transporterCache = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass }
  });
  return _transporterCache;
}

async function sendGuideEmail(to, fileName, docBuffer, preferences) {
  try {
    const transporter = getTransporter();
    const cfg = getSmtpConfig();
    if (!cfg) {
      return { ok: false, reason: 'SMTP 未配置（缺少 SMTP_USER / SMTP_PASS）' };
    }
    if (!nodemailer) {
      return { ok: false, reason: 'nodemailer 未加载（npm install 可能失败，请检查 Render 构建日志）' };
    }
    if (!transporter) {
      return { ok: false, reason: 'SMTP transporter 创建失败，请检查 SMTP_HOST/PORT/SECURE 配置' };
    }
    const cities = Array.isArray(preferences.cities) ? preferences.cities.join(' · ') : String(preferences.cities);
    const { emailSubject: localizedSubject } = buildLocalizedFileInfo(preferences);
    const defaultSubject = `Your ${preferences.days}-Day ${cities} China Travel Guide is ready 🧭`;
    const subject = localizedSubject || defaultSubject;
    const isZh = !!(preferences.language && String(preferences.language).includes('中文'));
    const mail = {
      from: `"China Travel Guide" <${cfg.from}>`,
      to,
      subject,
      html: `
        <div style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;max-width:640px;margin:0 auto;background:#faf6f0;padding:24px;border-radius:12px;color:#2c3e50;">
          <div style="background:linear-gradient(135deg,#c0392b,#922b21);color:white;padding:20px 24px;border-radius:10px;text-align:center;">
            <h2 style="margin:0;">${isZh ? '🧭 您的旅行攻略已生成' : '🧭 Your travel guide is ready'}</h2>
            <p style="margin:8px 0 0;opacity:0.92;font-size:14px;">祝您旅途愉快！Have a wonderful trip!</p>
          </div>
          <div style="padding:20px 24px;background:white;border-radius:10px;margin-top:16px;">
            <h3 style="margin:0 0 12px;color:#c0392b;">📋 ${isZh ? '行程概览' : 'Trip Overview'}</h3>
            <table style="width:100%;border-collapse:collapse;font-size:14px;">
              <tr><td style="padding:6px 0;color:#7f8c8d;width:40%;">${isZh ? '目的地' : 'Destinations'}</td><td style="padding:6px 0;"><b>${cities}</b></td></tr>
              <tr><td style="padding:6px 0;color:#7f8c8d;">${isZh ? '行程天数' : 'Days'}</td><td style="padding:6px 0;"><b>${preferences.days} ${isZh ? '天' : 'days'}</b></td></tr>
              <tr><td style="padding:6px 0;color:#7f8c8d;">${isZh ? '人数' : 'Travelers'}</td><td style="padding:6px 0;">${preferences.travelers || '-'}</td></tr>
              <tr><td style="padding:6px 0;color:#7f8c8d;">${isZh ? '出发日期' : 'Arrival'}</td><td style="padding:6px 0;">${preferences.arrivalDate || '-'}</td></tr>
              <tr><td style="padding:6px 0;color:#7f8c8d;">${isZh ? '攻略语言' : 'Language'}</td><td style="padding:6px 0;">${preferences.language || '-'}</td></tr>
              <tr><td style="padding:6px 0;color:#7f8c8d;">${isZh ? '住宿偏好' : 'Hotel'}</td><td style="padding:6px 0;">${preferences.hotelPref || '-'}</td></tr>
              <tr><td style="padding:6px 0;color:#7f8c8d;">${isZh ? '交通偏好' : 'Transport'}</td><td style="padding:6px 0;">${preferences.transportPref || '-'}</td></tr>
              <tr><td style="padding:6px 0;color:#7f8c8d;">${isZh ? '预算等级' : 'Budget'}</td><td style="padding:6px 0;">${preferences.budget || '-'}</td></tr>
              ${preferences.interests?.length ? `<tr><td style="padding:6px 0;color:#7f8c8d;">${isZh ? '兴趣方向' : 'Interests'}</td><td style="padding:6px 0;">${Array.isArray(preferences.interests) ? preferences.interests.join('、') : preferences.interests}</td></tr>` : ''}
            </table>
            <p style="margin-top:20px;padding:12px 14px;background:#fff6e5;border-radius:8px;font-size:13px;color:#926b21;">
              📎 ${isZh ? '攻略文档（.doc）在附件中，可直接用 Word / WPS / Google Docs 打开。' : 'Your guide (.doc) is attached — open with Word / WPS / Google Docs.'}
            </p>
          </div>
          <div style="text-align:center;font-size:12px;color:#7f8c8d;margin-top:16px;">
            ${isZh ? '由 China Travel Guide Generator 自动发送 · Render 免费云部署' : 'Auto-sent by China Travel Guide Generator · Render free cloud deploy'}
          </div>
        </div>
      `,
      attachments: [{
        filename: fileName,
        content: docBuffer,
        contentType: 'application/msword'
      }]
    };
    const info = await transporter.sendMail(mail);
    console.log(`[EMAIL] 发送成功: ${to} -> ${info.messageId || 'ok'}`);
    return { ok: true, info: info.messageId };
  } catch (err) {
    console.error(`[EMAIL] 发送失败 (${to}):`, err.message);
    return { ok: false, reason: err.message };
  }
}

// 预算等级 → 每日人民币中位数（与前端保持一致）
const BUDGET_CNY_PER_DAY = {
  'Backpacker (under ¥200/day)': 200,
  'Economy (¥200-500/day)': 350,
  'Comfort (¥500-1000/day)': 750,
  'Luxury (over ¥1000/day)': 1500,
  '穷游（日均200元以内）': 200,
  '经济（日均200-500元）': 350,
  '舒适（日均500-1000元）': 750,
  '豪华（日均1000元以上）': 1500
};

// CORS 头
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function jsonRes(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
    body: JSON.stringify(body)
  };
}

// 主处理函数（veFaaS 标准入口）
exports.handler = async (event, context) => {
  // 处理 CORS 预检
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return jsonRes(405, { error: '仅支持 POST 请求' });
  }

  try {
    // 解析请求体
    let body = event.body;
    if (typeof body === 'string') {
      body = JSON.parse(body);
    }
    const { preferences, format = 'doc' } = body;

    if (!preferences || !preferences.cities || !preferences.days) {
      return jsonRes(400, { error: '缺少必要参数：cities, days' });
    }
    const userEmail = preferences.email ? String(preferences.email).trim() : null;
    if (userEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(userEmail)) {
      return jsonRes(400, { error: '邮箱格式不正确' });
    }

    // 1. 读取飞书知识库（从环境变量获取配置）
    const feishuConfig = {
      appId: process.env.FEISHU_APP_ID,
      appSecret: process.env.FEISHU_APP_SECRET,
      appToken: process.env.FEISHU_APP_TOKEN,  // Base token
      tableId: process.env.FEISHU_TABLE_ID
    };

    let knowledgeBase = [];
    try {
      knowledgeBase = await fetchKnowledgeBase(feishuConfig);
      console.log(`[INFO] 读取飞书知识库成功，共 ${knowledgeBase.length} 条记录`);
    } catch (err) {
      console.warn(`[WARN] 读取飞书知识库失败（将仅用 AI 生成）: ${err.message}`);
    }

    // 1.5. 构建货币上下文：预算等级(人民币) → 用户货币换算
    const currencyCode = preferences.currency || currency.getDefaultCurrencyForLanguage(preferences.language) || 'USD';
    const days = Number(preferences.days) || 1;
    const cnyPerDay = BUDGET_CNY_PER_DAY[preferences.budget] || 350;
    const cnyTotal = cnyPerDay * days;
    const budgetInCurrency = currency.convert(cnyTotal, 'CNY', currencyCode);
    const budgetRangeStr = currency.format(budgetInCurrency, currencyCode);

    console.log(`[INFO] 预算：¥${cnyTotal} CNY ≈ ${budgetRangeStr} ${currencyCode}`);

    // 2. 构建提示词并调用 DeepSeek
    const currencyContext = {
      currency: currencyCode,
      budgetInCurrency,
      budgetRange: budgetRangeStr
    };
    const userPrompt = buildUserPrompt(preferences, knowledgeBase, currencyContext);
    const apiKey = process.env.DEEPSEEK_API_KEY;
    const markdownContent = await generateGuide(apiKey, SYSTEM_PROMPT, userPrompt);
    console.log(`[INFO] DeepSeek 攻略生成完成，总长 ${markdownContent.length} 字`);

    // 2.5. 天数完整性校验
    const dayMatches = markdownContent.match(/^##\s+Day\s+\d+/gm) || [];
    const expectedDays = Number(preferences.days);
    console.log(`[INFO] 天数校验：期望 ${expectedDays} 天，实际输出 ${dayMatches.length} 个 Day 标题`);
    if (dayMatches.length < expectedDays) {
      console.warn(`[WARN] 天数不足！期望 ${expectedDays}，实际 ${dayMatches.length}。返回内容并在末尾追加提示。`);
      // 不报错，但在文档末尾追加明显提示
      const missingDays = expectedDays - dayMatches.length;
      const notice = `\n\n---\n⚠️ **生成提示**：本次因 AI 输出长度限制，实际生成 ${dayMatches.length} 天，缺少 ${missingDays} 天。建议重新生成，或减少天数/城市后重试。`;
      const patchedContent = markdownContent + notice;
      // 继续走 .doc 生成流程（使用本地化文件名+文档标题）
      const { fileName: localizedFile, docTitleInner: localizedTitle } = buildLocalizedFileInfo(preferences);
      const docContent = generateDoc(patchedContent, localizedTitle);
      const docBuf = Buffer.isBuffer(docContent) ? docContent : Buffer.from(docContent, 'utf-8');
      const fileName = localizedFile.replace(/\.doc$/, `-不完整${Date.now()}.doc`);
      let emailResult = null;
      if (userEmail) {
        emailResult = await sendGuideEmail(userEmail, fileName, docBuf, preferences);
      }
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          ...CORS_HEADERS
        },
        body: JSON.stringify({
          success: true,
          format: 'doc',
          fileName,
          docBase64: docBuf.toString('base64'),
          daysGenerated: dayMatches.length,
          daysExpected: expectedDays,
          warning: `天数不足：实际 ${dayMatches.length} / 期望 ${expectedDays}，建议重新生成`,
          email: userEmail ? { to: userEmail, ...emailResult } : null
        })
      };
    }

    // 3. 根据格式要求输出
    if (format === 'markdown') {
      return jsonRes(200, { success: true, format: 'markdown', content: markdownContent });
    }

    // 默认生成 .doc（使用本地化文件名+文档标题）
    const { fileName: localizedFile, docTitleInner: localizedTitle } = buildLocalizedFileInfo(preferences);
    const docContent = generateDoc(markdownContent, localizedTitle);
    const docBuf = Buffer.isBuffer(docContent) ? docContent : Buffer.from(docContent, 'utf-8');
    const fileName = localizedFile;
    let emailResult = null;
    if (userEmail) {
      emailResult = await sendGuideEmail(userEmail, fileName, docBuf, preferences);
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...CORS_HEADERS
      },
      body: JSON.stringify({
        success: true,
        format: 'doc',
        fileName,
        docBase64: docBuf.toString('base64'),
        daysGenerated: dayMatches.length,
        daysExpected: expectedDays,
        email: userEmail ? { to: userEmail, ...emailResult } : null
      })
    };

  } catch (err) {
    console.error('[ERROR]', err);
    return jsonRes(500, { error: `生成失败: ${err.message}` });
  }
};

// 本地开发模式：node index.js 启动服务器（同时托管前端页面，避免跨域）
if (require.main === module) {
  const http = require('http');
  const fs = require('fs');
  const path = require('path');

  // 兼容两种部署结构：同目录(打包) / 上级 frontend(本地开发)
  const FRONTEND_PATH = fs.existsSync(path.join(__dirname, 'index.html'))
    ? path.join(__dirname, 'index.html')
    : path.join(__dirname, '..', 'frontend', 'index.html');

  const server = http.createServer(async (req, res) => {
    // CORS（保留，方便外部调试）
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // 处理 CORS 预检
    if (req.method === 'OPTIONS') {
      res.writeHead(204); res.end(); return;
    }

      // GET 路由
    if (req.method === 'GET') {
      // Health check + SMTP 诊断
      if (req.url === '/health' || req.url === '/healthz' || req.url === '/diagnose') {
        const cfg = getSmtpConfig();
        const hasNodemailer = !!nodemailer;
        const hasUser = !!process.env.SMTP_USER;
        const hasPass = !!process.env.SMTP_PASS;
        let smtpStatus;
        if (!hasNodemailer) {
          smtpStatus = { ok: false, reason: 'nodemailer 未加载！npm install 可能失败或未执行，请检查 Render 构建日志', level: 'error' };
        } else if (!cfg) {
          smtpStatus = { ok: false, reason: `SMTP 变量缺失：SMTP_USER=${hasUser ? '✅' : '❌'}, SMTP_PASS=${hasPass ? '✅' : '❌'}`, level: 'error' };
        } else {
          smtpStatus = {
            ok: true,
            host: cfg.host,
            port: cfg.port,
            user: cfg.user,
            from: cfg.from,
            nodemailer: true,
            level: 'ok'
          };
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          status: 'ok',
          uptime: process.uptime(),
          smtp: smtpStatus,
          env: {
            NODE_ENV: process.env.NODE_ENV || 'development',
            DEEPSEEK_KEY: process.env.DEEPSEEK_API_KEY ? '✅ 已配置' : '❌ 未配置',
            FEISHU_APP_ID: process.env.FEISHU_APP_ID ? '✅ 已配置' : '❌ 未配置',
            FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET ? '✅ 已配置' : '❌ 未配置',
            FEISHU_APP_TOKEN: process.env.FEISHU_APP_TOKEN ? '✅ 已配置' : '❌ 未配置',
            FEISHU_TABLE_ID: process.env.FEISHU_TABLE_ID ? '✅ 已配置' : '❌ 未配置'
          }
        }, null, 2));
        return;
      }
      // Paddle SDK 本地托管（避免 CDN 在国内被 DNS 污染）
      if (req.url === '/paddle.js' || req.url === '/v2/paddle.js') {
        try {
          const js = fs.readFileSync(path.join(__dirname, 'paddle.js'), 'utf-8');
          res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
          res.end(js);
        } catch (err) {
          res.writeHead(404); res.end('not found');
        }
        return;
      }
      // 订单页面
      if (req.url === '/order' || req.url === '/order.html' || req.url.startsWith('/order?')) {
        try {
          const html = fs.readFileSync(path.join(__dirname, 'order.html'), 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`Order page load failed: ${err.message}`);
        }
        return;
      }
      // 定价页面
      if (req.url === '/pricing' || req.url === '/pricing.html') {
        try {
          const html = fs.readFileSync(path.join(__dirname, 'pricing.html'), 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`Pricing page load failed: ${err.message}`);
        }
        return;
      }
      // 退款政策页面
      if (req.url === '/refund' || req.url === '/refund.html') {
        try {
          const html = fs.readFileSync(path.join(__dirname, 'refund.html'), 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`Refund page load failed: ${err.message}`);
        }
        return;
      }
      // 服务条款页面
      if (req.url === '/terms' || req.url === '/terms.html') {
        try {
          const html = fs.readFileSync(path.join(__dirname, 'terms.html'), 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`Terms page load failed: ${err.message}`);
        }
        return;
      }
      // 隐私政策页面
      if (req.url === '/privacy' || req.url === '/privacy.html') {
        try {
          const html = fs.readFileSync(path.join(__dirname, 'privacy.html'), 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`Privacy page load failed: ${err.message}`);
        }
        return;
      }
      // 首页
      if (req.url === '/' || req.url === '/index.html') {
        try {
          const html = fs.readFileSync(FRONTEND_PATH, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`前端页面读取失败: ${err.message}`);
        }
        return;
      }
    }

    // POST /webhook — Paddle 支付通知（交易完成时自动触发）
    if (req.method === 'POST' && req.url === '/webhook') {
      let chunks = '';
      req.on('data', c => chunks += c);
      req.on('end', async () => {
        try {
          const event = JSON.parse(chunks);
          const eventType = event.event_type;
          console.log(`[WEBHOOK] 收到事件: ${eventType}`);
          if (eventType === 'transaction.completed') {
            const transaction = event.data || {};
            const customData = transaction.custom_data || {};
            const email = customData.email || (transaction.customer && transaction.customer.email);
            let preferences = null;
            if (customData.preferences) {
              try { preferences = JSON.parse(customData.preferences); } catch(e) { preferences = null; }
            }
            if (email && preferences) {
              console.log(`[WEBHOOK] 开始为 ${email} 生成攻略`);
              
              const { fetchKnowledgeBase } = require('./feishu');
              const { generateGuide } = require('./deepseek');
              const { generateDoc } = require('./docgen');
              const { SYSTEM_PROMPT, buildUserPrompt } = require('./prompt');
              let knowledgeBase = [];
              try {
                knowledgeBase = await fetchKnowledgeBase({
                  appId: process.env.FEISHU_APP_ID,
                  appSecret: process.env.FEISHU_APP_SECRET,
                  appToken: process.env.FEISHU_APP_TOKEN,
                  tableId: process.env.FEISHU_TABLE_ID
                });
              } catch (err) {
                console.warn(`[WEBHOOK] 知识库读取失败: ${err.message}`);
              }
              const userPrompt = buildUserPrompt(preferences, knowledgeBase, {});
              const apiKey = process.env.DEEPSEEK_API_KEY;
              const markdown = await generateGuide(apiKey, SYSTEM_PROMPT, userPrompt);
              const cityName = (preferences.cities || ['China']).join('·');
              const docContent = generateDoc(markdown, `${cityName} Travel Guide`);
              const fileName = `guide-${Date.now()}.doc`;
              const filePath = path.join(os.tmpdir(), fileName);
              fs.writeFileSync(filePath, docContent);
              console.log(`[WEBHOOK] ✅ 攻略已生成: ${filePath}，需发送至 ${email}`);

              // Send email with .doc attachment
              try {
                const docBuffer = fs.readFileSync(filePath);
                const emailResult = await sendGuideEmail(email, fileName, docBuffer, preferences);
                if (emailResult.ok) {
                  console.log(`[WEBHOOK] ✅ 邮件已发送至 ${email}`);
                } else {
                  console.warn(`[WEBHOOK] ⚠️ 邮件发送失败: ${emailResult.reason}`);
                }
              } catch (mailErr) {
                console.warn(`[WEBHOOK] ⚠️ 邮件发送异常: ${mailErr.message}`);
              }
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: true }));
        } catch (err) {
          console.error('[WEBHOOK ERROR]', err);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ received: true }));
        }
      });
      return;
    }

    // POST /test-email — SMTP 测试端点
    if (req.method === 'POST' && req.url === '/test-email') {
      let chunks = '';
      req.on('data', c => chunks += c);
      req.on('end', async () => {
        let body = {};
        try { body = JSON.parse(chunks); } catch(e) {}
        const to = body.to || body.email;
        if (!to) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: '缺少收件人邮箱 (to)' }));
          return;
        }
        try {
          const result = await sendGuideEmail(to, 'smtp-test.doc', Buffer.from('test'), {
            days: 7, cities: ['Beijing'], language: 'English', travelers: '2',
            arrivalDate: new Date().toISOString().split('T')[0], hotelPref: '-',
            transportPref: '-', budget: 'Economy', interests: ['Culture']
          });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch(err) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // POST / → 生成攻略
    if (req.method === 'POST') {
      let chunks = '';
      req.on('data', c => chunks += c);
      req.on('end', async () => {
        const event = { httpMethod: 'POST', body: chunks };
        const result = await exports.handler(event, {});
        res.writeHead(result.statusCode, result.headers);
        res.end(result.body);
      });
    } else {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
    }
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`[本地开发] 攻略生成服务运行在 http://localhost:${PORT}`);
    console.log(`[本地开发] 在浏览器打开 http://localhost:${PORT} 即可使用`);
  });
}
