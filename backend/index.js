
;
// veFaaS Serverless 函数入口
// 旅行攻略生成器：飞书知识库 + DeepSeek + .doc 输出 + 邮件发送

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { /* nodemailer 可选，没装也不影响核心功能 */ }

// ---------- 安全层：临时一次性生成令牌（order 成功页调用 POST / 时用）----------
// key: token 随机串, value: { expireAt: ms, used: false }
const TEMP_TOKEN_TTL_MS = 3 * 60 * 1000; // 3 分钟内一次性有效
const tempTokens = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tempTokens.entries()) {
    if (now > v.expireAt) tempTokens.delete(k);
  }
}, 60 * 1000).unref(); // 每 1 分钟清理一次，unref 不阻塞进程退出

// ---------- 订单存储模块（JSON 文件持久化，保留30天）----------
const ORDERS_FILE = path.join(os.tmpdir(), 'ctg-orders.json');
const ORDERS_MAX_COUNT = 500;
const ORDERS_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30天

function loadOrders() {
  try {
    if (!fs.existsSync(ORDERS_FILE)) return [];
    const raw = fs.readFileSync(ORDERS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    return Array.isArray(data.orders) ? data.orders : [];
  } catch (e) {
    console.warn('[ORDERS] 读取订单文件失败:', e.message);
    return [];
  }
}

function saveOrder(order) {
  try {
    let orders = loadOrders();
    // 清理30天前的订单
    const now = Date.now();
    orders = orders.filter(o => {
      const t = new Date(o.paidAt).getTime();
      return Number.isFinite(t) && (now - t) < ORDERS_TTL_MS;
    });
    orders.unshift(order); // 最新的排最前
    // 超过上限删最早的
    if (orders.length > ORDERS_MAX_COUNT) orders = orders.slice(0, ORDERS_MAX_COUNT);
    fs.writeFileSync(ORDERS_FILE, JSON.stringify({ orders, lastCleanup: now }), 'utf-8');
    console.log(`[ORDERS] 订单已保存: ${order.orderId}，当前共 ${orders.length} 条`);
  } catch (e) {
    console.error('[ORDERS] 保存订单失败:', e.message);
  }
}

function updateOrderStatus(orderId, patch) {
  try {
    let orders = loadOrders();
    const idx = orders.findIndex(o => o.orderId === orderId);
    if (idx >= 0) {
      Object.assign(orders[idx], patch);
      fs.writeFileSync(ORDERS_FILE, JSON.stringify({ orders, lastCleanup: Date.now() }), 'utf-8');
      console.log(`[ORDERS] 订单 ${orderId} 状态已更新:`, JSON.stringify(patch));
    }
  } catch (e) {
    console.error('[ORDERS] 更新订单状态失败:', e.message);
  }
}

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
// 把 "Name <email@x.com>" 格式解析成 SendGrid 需要的 { email, name }
function parseFromAddress(fromStr) {
  if (!fromStr) return { email: '18501498873qzj@gmail.com' };
  const match = fromStr.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) {
    const name = match[1].trim();
    return name ? { email: match[2].trim(), name } : { email: match[2].trim() };
  }
  return { email: fromStr.trim() };
}

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
async function getTransporter() {
  if (_transporterCache) return _transporterCache;
  const cfg = getSmtpConfig();
  if (!cfg || !nodemailer) return null;

  // 尝试多个端口，提高连接成功率
  const portOptions = [
    { port: cfg.port, secure: cfg.secure },      // 用户配置的
    { port: 465, secure: true },                // Gmail SSL 端口
    { port: 587, secure: false }                // Gmail TLS 端口
  ];

  for (const opt of portOptions) {
    console.log(`[SMTP] 尝试连接 ${cfg.host}:${opt.port} (secure=${opt.secure})`);
    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: opt.port,
      secure: opt.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      connectionTimeout: 10000,
      greetingTimeout: 5000,
      socketTimeout: 10000,
      pool: true,
      maxConnections: 1
    });
    try {
      await transporter.verify();
      console.log(`[SMTP] 连接成功: ${cfg.host}:${opt.port}`);
      _transporterCache = transporter;
      // 记录实际使用的端口
      transporter._actualPort = opt.port;
      return transporter;
    } catch (err) {
      console.warn(`[SMTP] 端口 ${opt.port} 连接失败: ${err.message}`);
    }
  }
  return null;
}

// ---------- 邮件发送（支持 Resend API + SMTP 双模式） ----------
async function sendGuideEmail(to, fileName, docBuffer, preferences) {
  const cities = Array.isArray(preferences.cities) ? preferences.cities.join(' · ') : String(preferences.cities);
  const { emailSubject: localizedSubject } = buildLocalizedFileInfo(preferences);
  const defaultSubject = `Your ${preferences.days}-Day ${cities} China Travel Guide is ready 🧭`;
  const subject = localizedSubject || defaultSubject;
  const isZh = !!(preferences.language && String(preferences.language).includes('中文'));
  const cfg = getSmtpConfig();
  const fromEmail = process.env.RESEND_FROM || (cfg ? cfg.from : process.env.SMTP_FROM || '"China Travel Guide" <18501498873qzj@gmail.com>');

  const emailHtml = `
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
        ${isZh ? '由 China Travel Guide Generator 自动发送' : 'Auto-sent by China Travel Guide Generator'}
      </div>
    </div>
  `;

  // 🥇 优先使用 Brevo (Sendinblue) API — 免费 300 封/天，支持单邮箱验证无需域名
  const brevoKey = process.env.BREVO_API_KEY;
  if (brevoKey) {
    try {
      const fileBase64 = docBuffer.toString('base64');
      const brevoFrom = parseFromAddress(process.env.BREVO_FROM || '"China Travel Guide" <18501498873qzj@gmail.com>');
      const sender = { email: brevoFrom.email };
      if (brevoFrom.name) sender.name = brevoFrom.name;
      const body = JSON.stringify({
        sender: sender,
        to: [{ email: to }],
        subject: subject,
        htmlContent: emailHtml,
        attachment: [{
          name: fileName,
          content: fileBase64
        }]
      });

      const reqOptions = {
        hostname: 'api.brevo.com',
        path: '/v3/smtp/email',
        method: 'POST',
        headers: {
          'api-key': brevoKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 20000
      };

      const emailResult = await new Promise((resolve, reject) => {
        const req = https.request(reqOptions, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const parsed = data ? JSON.parse(data) : {};
              if (res.statusCode >= 200 && res.statusCode < 300) {
                resolve({ ok: true, provider: 'brevo', messageId: parsed.messageId });
              } else {
                reject(new Error(`Brevo API error (${res.statusCode}): ${JSON.stringify(parsed)}`));
              }
            } catch (e) {
              reject(new Error(`Brevo response parse error (${res.statusCode}): ${data}`));
            }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('Brevo API timeout (20s)')));
        req.write(body);
        req.end();
      });

      console.log(`[EMAIL] Brevo 发送成功: ${to}`);
      return { ok: true, provider: 'brevo', info: emailResult.messageId };
    } catch (err) {
      console.warn(`[EMAIL] Brevo 发送失败: ${err.message}`);
      return {
        ok: false,
        provider: 'brevo',
        reason: `Brevo 发送失败: ${err.message}`,
        suggestion: '检查 BREVO_API_KEY 是否正确，或 18501498873qzj@gmail.com 是否已在 Brevo 做 Senders 验证'
      };
    }
  }

  // 🥈 使用 SendGrid API（HTTP 方式，支持单邮箱验证 → 无需域名即可发给任意用户）
  const sendgridKey = process.env.SENDGRID_API_KEY;
  if (sendgridKey) {
    try {
      const fileBase64 = docBuffer.toString('base64');
      const sendgridFrom = process.env.SENDGRID_FROM || '"China Travel Guide" <18501498873qzj@gmail.com>';
      const body = JSON.stringify({
        personalizations: [{
          to: [{ email: to }],
          subject: subject
        }],
        from: parseFromAddress(sendgridFrom),
        content: [{
          type: 'text/html',
          value: emailHtml
        }],
        attachments: [{
          filename: fileName,
          content: fileBase64,
          type: 'application/msword',
          disposition: 'attachment'
        }]
      });

      const reqOptions = {
        hostname: 'api.sendgrid.com',
        path: '/v3/mail/send',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${sendgridKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 20000
      };

      const emailResult = await new Promise((resolve, reject) => {
        const req = https.request(reqOptions, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ ok: true, provider: 'sendgrid', statusCode: res.statusCode, xMessageId: res.headers['x-message-id'] });
            } else {
              reject(new Error(`SendGrid API error (${res.statusCode}): ${data || 'empty body'}`));
            }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('SendGrid API timeout (20s)')));
        req.write(body);
        req.end();
      });

      console.log(`[EMAIL] SendGrid 发送成功: ${to}`);
      return { ok: true, provider: 'sendgrid', info: emailResult.xMessageId };
    } catch (err) {
      console.warn(`[EMAIL] SendGrid 发送失败: ${err.message}`);
      return {
        ok: false,
        provider: 'sendgrid',
        reason: `SendGrid 发送失败: ${err.message}`,
        suggestion: '检查 SENDGRID_API_KEY 是否正确，或确认 18501498873qzj@gmail.com 是否已在 SendGrid 里做 Single Sender Verification'
      };
    }
  }

  // 🥈 降级使用 Resend API（HTTP 方式，不受 SMTP 端口限制）
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    try {
      const boundary = '----ResendBoundary' + Date.now();
      const fileBase64 = docBuffer.toString('base64');
      const attachmentsPart = `--${boundary}\r\nContent-Disposition: attachment; filename="${fileName}"\r\nContent-Type: application/msword\r\nContent-Transfer-Encoding: base64\r\n\r\n${fileBase64}\r\n`;
      
      const body = JSON.stringify({
        from: fromEmail,
        to: [to],
        subject,
        html: emailHtml,
        attachments: [{
          filename: fileName,
          content: fileBase64,
          type: 'application/msword'
        }]
      });

      const reqOptions = {
        hostname: 'api.resend.com',
        path: '/emails',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 15000
      };

      const emailResult = await new Promise((resolve, reject) => {
        const req = https.request(reqOptions, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (res.statusCode >= 200 && res.statusCode < 300) {
                resolve({ ok: true, provider: 'resend', id: parsed.id, messageId: parsed.id });
              } else {
                reject(new Error(`Resend API error (${res.statusCode}): ${JSON.stringify(parsed)}`));
              }
            } catch (e) {
              reject(new Error(`Resend response parse error: ${data}`));
            }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('Resend API timeout (15s)')));
        req.write(body);
        req.end();
      });

      console.log(`[EMAIL] Resend 发送成功: ${to}`);
      return { ok: true, provider: 'resend', info: emailResult.id };
    } catch (err) {
      console.warn(`[EMAIL] Resend 发送失败: ${err.message}`);
      // Resend 失败直接返回错误，不再降级 SMTP（因为已知 Render 上 SMTP 会被阻断）
      return {
        ok: false,
        provider: 'resend',
        reason: `Resend 发送失败: ${err.message}`,
        suggestion: '检查 RESEND_API_KEY 是否正确，或发件地址 RESEND_FROM 是否被 Resend 允许'
      };
    }
  }

  // 无 Resend Key 时才使用 SMTP
  try {
    if (!cfg) {
      return { ok: false, reason: '未配置邮件发送，请先配置 RESEND_API_KEY' };
    }
    if (!nodemailer) {
      return { ok: false, reason: 'nodemailer 未加载（npm install 可能失败）' };
    }
    const transporter = await getTransporter();
    if (!transporter) {
      return { ok: false, reason: 'SMTP 连接超时或被阻断，建议配置 RESEND_API_KEY 使用 HTTP API 发送' };
    }
    const mail = {
      from: `"China Travel Guide" <${cfg.from}>`,
      to,
      subject,
      html: emailHtml,
      attachments: [{
        filename: fileName,
        content: docBuffer,
        contentType: 'application/msword'
      }]
    };
    const info = await transporter.sendMail(mail);
    console.log(`[EMAIL] SMTP 发送成功: ${to}`);
    return { ok: true, provider: 'smtp', info: info.messageId };
  } catch (err) {
    console.error(`[EMAIL] 发送失败 (${to}):`, err.message);
    return {
      ok: false,
      reason: err.message,
      suggestion: '建议配置 RESEND_API_KEY 使用 HTTP API 发送，避免 SMTP 端口被阻断'
    };
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
    const { preferences, format = 'doc', admin_secret = null, generate_token = null } = body;

    // 🔒 访问控制：必须满足以下任一条件才能生成攻略（否则 403）
    const allowAdmin = process.env.ADMIN_GENERATE_KEY
      && typeof admin_secret === 'string'
      && admin_secret.length > 0
      && admin_secret === process.env.ADMIN_GENERATE_KEY;

    let allowPaidToken = false;
    if (typeof generate_token === 'string' && generate_token.length > 0) {
      const rec = tempTokens.get(generate_token);
      if (rec && !rec.used && Date.now() < rec.expireAt) {
        rec.used = true; // 一次性，用完作废
        tempTokens.set(generate_token, rec);
        allowPaidToken = true;
      }
    }

    if (!allowAdmin && !allowPaidToken) {
      console.warn('[SECURITY] 未付费/未授权访问 POST / 已拦截。是否带 admin_secret 或 generate_token？');
      return jsonRes(403, {
        error: 'Payment required. Please purchase through /order first.',
        hint_zh: '必须先在 /order 页面完成支付，才能生成攻略。管理员可设置 ADMIN_GENERATE_KEY 环境变量并传入 admin_secret 参数。'
      });
    }

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
      // Health check + SMTP/Resend 诊断
      if (req.url === '/health' || req.url === '/healthz' || req.url === '/diagnose') {
        const cfg = getSmtpConfig();
        const hasNodemailer = !!nodemailer;
        const hasUser = !!process.env.SMTP_USER;
        const hasPass = !!process.env.SMTP_PASS;
        const hasResendKey = !!process.env.RESEND_API_KEY;
        const hasSendgridKey = !!process.env.SENDGRID_API_KEY;
        const hasBrevoKey = !!process.env.BREVO_API_KEY;
        let smtpStatus;
        if (!hasNodemailer) {
          smtpStatus = { ok: false, reason: 'nodemailer 未加载', level: 'error' };
        } else if (!cfg) {
          smtpStatus = { ok: false, reason: `SMTP 变量缺失`, level: 'error' };
        } else {
          smtpStatus = { ok: true, host: cfg.host, port: cfg.port, user: cfg.user, from: cfg.from, nodemailer: true, level: 'ok' };
        }
        let emailStatus;
        if (hasBrevoKey) {
          emailStatus = { ok: true, provider: 'Brevo (Sendinblue) HTTP API', from: process.env.BREVO_FROM || '"China Travel Guide" <18501498873qzj@gmail.com>', level: 'ok', note: '✅ 最佳！免费300封/天，无需域名，单邮箱验证即可发给任意用户' };
        } else if (hasSendgridKey) {
          emailStatus = { ok: true, provider: 'SendGrid (HTTP API)', from: process.env.SENDGRID_FROM || '"China Travel Guide" <18501498873qzj@gmail.com>', level: 'ok', note: '无需域名，单邮箱验证即可发给任意用户' };
        } else if (hasResendKey) {
          emailStatus = { ok: true, provider: 'Resend (HTTP API)', from: process.env.RESEND_FROM || 'onboarding@resend.dev', level: 'ok', note: '需验证域名才能发任意邮箱' };
        } else if (smtpStatus.ok) {
          emailStatus = { ok: true, provider: 'SMTP', level: 'ok', note: '可能存在端口被阻断风险' };
        } else {
          emailStatus = { ok: false, provider: '未配置', level: 'error', note: '建议配置 BREVO_API_KEY（免费300封/天，无需域名）' };
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          status: 'ok',
          uptime: process.uptime(),
          smtp: smtpStatus,
          email: emailStatus,
          env: {
            NODE_ENV: process.env.NODE_ENV || 'development',
            BREVO_API_KEY: hasBrevoKey ? '✅ 已配置' : '❌ 未配置（⭐ 推荐！免费300封/天，无需域名）',
            BREVO_FROM: process.env.BREVO_FROM ? process.env.BREVO_FROM : '"China Travel Guide" <18501498873qzj@gmail.com>（默认）',
            SENDGRID_API_KEY: hasSendgridKey ? '✅ 已配置' : '❌ 未配置',
            SENDGRID_FROM: process.env.SENDGRID_FROM ? process.env.SENDGRID_FROM : '"China Travel Guide" <18501498873qzj@gmail.com>（默认）',
            RESEND_API_KEY: hasResendKey ? '✅ 已配置' : '❌ 未配置',
            RESEND_FROM: process.env.RESEND_FROM ? process.env.RESEND_FROM : 'onboarding@resend.dev（默认）',
            DEEPSEEK_KEY: process.env.DEEPSEEK_API_KEY ? '✅ 已配置' : '❌ 未配置',
            FEISHU_APP_ID: process.env.FEISHU_APP_ID ? '✅ 已配置' : '❌ 未配置',
            FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET ? '✅ 已配置' : '❌ 未配置',
            FEISHU_APP_TOKEN: process.env.FEISHU_APP_TOKEN ? '✅ 已配置' : '❌ 未配置',
            FEISHU_TABLE_ID: process.env.FEISHU_TABLE_ID ? '✅ 已配置' : '❌ 未配置',
            PADDLE_WEBHOOK_SECRET: process.env.PADDLE_WEBHOOK_SECRET ? `✅ 已配置（长度: ${process.env.PADDLE_WEBHOOK_SECRET.length} 字符，Webhook 签名校验已启用）` : '❌ 未配置（⭐ 必做！防止伪造 Webhook 请求）',
            PADDLE_CLIENT_TOKEN: process.env.PADDLE_CLIENT_TOKEN ? '✅ 已配置' : '❌ 未配置',
            ADMIN_PAGE_KEY: process.env.ADMIN_PAGE_KEY ? `✅ 已配置（访问 /?admin_key=xxx 可打开管理员内测表单，长度: ${process.env.ADMIN_PAGE_KEY.length}）` : '❌ 未配置（普通访客 / 直接 302 跳 /order，建议配置以支持管理员内测）',
            ADMIN_GENERATE_KEY: process.env.ADMIN_GENERATE_KEY ? `✅ 已配置（POST / 时传 admin_secret=xxx 可免费生成，长度: ${process.env.ADMIN_GENERATE_KEY.length}）` : '❌ 未配置（未授权 POST / 将返回 403，请配置以支持管理员手动调 API）'
          }
        }, null, 2));
        return;
      }
      // SMTP 深度诊断：实际测试连接
      if (req.url === '/smtp-check') {
        const cfg = getSmtpConfig();
        let result = {
          timestamp: new Date().toISOString(),
          nodemailerLoaded: !!nodemailer,
          config: cfg ? { host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user, from: cfg.from } : null
        };
        if (!nodemailer) {
          result.error = 'nodemailer 未加载，请检查 npm install 是否成功';
        } else if (!cfg) {
          result.error = 'SMTP 配置缺失';
        } else {
          const transporter = await getTransporter();
          if (!transporter) {
            result.error = 'transporter 创建失败（所有端口均连接超时或被阻断）';
          } else {
            result.connectionTest = 'pending';
            try {
              const verifyResult = await transporter.verify();
              result.connectionTest = 'success';
              result.actualPort = transporter._actualPort;
              result.verifyResult = verifyResult;
            } catch (err) {
              result.connectionTest = 'failed';
              result.connectionError = {
                message: err.message,
                code: err.code,
                command: err.command,
                response: err.response,
                responseCode: err.responseCode
              };
            }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result, null, 2));
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
      // 管理员订单 API — 返回 JSON
      if (req.method === 'GET' && req.url.startsWith('/admin/orders/api')) {
        const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const key = urlObj.searchParams.get('key');
        const adminKey = process.env.ADMIN_PAGE_KEY;
        if (!adminKey || key !== adminKey) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        const orders = loadOrders();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ orders, total: orders.length }));
        return;
      }
      // 管理员订单页面 — 返回 HTML
      if (req.method === 'GET' && (req.url === '/admin/orders' || req.url.startsWith('/admin/orders?'))) {
        const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const key = urlObj.searchParams.get('key');
        const adminKey = process.env.ADMIN_PAGE_KEY;
        if (!adminKey || key !== adminKey) {
          res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h1>403 Forbidden</h1><p>Access denied. Please provide a valid admin key.</p>');
          return;
        }
        try {
          const html = fs.readFileSync(path.join(__dirname, 'admin-orders.html'), 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`Admin orders page load failed: ${err.message}`);
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
      // 首页：普通访客 302 跳转到付费订单页；仅管理员携带 ?admin_key=ADMIN_PAGE_KEY 时才返回原免费表单（方便内部测试）
      if (req.url === '/' || req.url.startsWith('/?') || req.url === '/index.html') {
        try {
          const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
          const adminKey = urlObj.searchParams.get('admin_key');
          const requireAdminKey = process.env.ADMIN_PAGE_KEY && process.env.ADMIN_PAGE_KEY.length > 0;

          const isAdmin = requireAdminKey && adminKey && adminKey === process.env.ADMIN_PAGE_KEY;

          if (isAdmin) {
            // 管理员：返回旧免费表单
            const html = fs.readFileSync(FRONTEND_PATH, 'utf-8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
          } else {
            // 普通访客：强制 302 跳 /order，避免未付费直接生成
            res.writeHead(302, { Location: '/order' });
            res.end();
          }
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`首页处理失败: ${err.message}`);
        }
        return;
      }
      // GET 兜底：未匹配路由
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Not Found', path: req.url, method: req.method }));
      return;
    }

    // POST /request-generate-token — 仅在支付成功页面发放临时一次性生成令牌（3分钟有效）
    if (req.method === 'POST' && req.url === '/request-generate-token') {
      try {
        // 随机 32 字节 token
        const token = crypto.randomBytes(24).toString('hex');
        tempTokens.set(token, { expireAt: Date.now() + TEMP_TOKEN_TTL_MS, used: false });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS });
        res.end(JSON.stringify({ ok: true, token, ttl_seconds: Math.floor(TEMP_TOKEN_TTL_MS / 1000) }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Failed to issue generate token: ' + err.message }));
      }
      return;
    }

    // POST /webhook — Paddle 支付通知（交易完成时自动触发）
    if (req.method === 'POST' && req.url === '/webhook') {
      let chunks = '';
      req.on('data', c => chunks += c);
      req.on('end', async () => {
        try {
          // 🔒 Paddle Webhook 签名校验（Paddle-Signature: ts=xxx;h1=xxx）
          const sigHeader = (req.headers['paddle-signature'] || req.headers['Paddle-Signature'] || '');
          const webhookSecret = process.env.PADDLE_WEBHOOK_SECRET || '';
          if (webhookSecret && webhookSecret.length > 0 && sigHeader.length > 0) {
            const tsMatch = sigHeader.match(/ts=([^;]+)/);
            const h1Match = sigHeader.match(/h1=([a-fA-F0-9]+)/);
            if (!tsMatch || !h1Match) {
              console.warn('[WEBHOOK] 签名格式不合法，丢弃请求');
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ received: false, error: 'invalid signature format' }));
              return;
            }
            const [, tsStr] = tsMatch;
            const [, claimedH1] = h1Match;
            const payloadToSign = `${tsStr}:${chunks}`;
            const expectedH1 = crypto
              .createHmac('sha256', webhookSecret)
              .update(payloadToSign, 'utf8')
              .digest('hex');
            // 防止时序攻击，用 timingSafeEqual
            const a = Buffer.from(expectedH1, 'hex');
            const b = Buffer.from(claimedH1, 'hex');
            const sigOk = a.length === b.length && crypto.timingSafeEqual(a, b);
            // 可选：ts 时间戳和本地差超过 5 分钟拒绝（防止重放）
            const tsMs = Number(tsStr) * 1000;
            const freshOk = Number.isFinite(tsMs) && Math.abs(Date.now() - tsMs) < 5 * 60 * 1000;
            if (!sigOk || !freshOk) {
              console.warn(`[WEBHOOK] 签名验证失败，丢弃请求。sigOk=${sigOk} freshOk=${freshOk}`);
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ received: false, error: 'signature mismatch or replay' }));
              return;
            }
            console.log('[WEBHOOK] ✅ Paddle 签名验证通过');
          } else if (webhookSecret && webhookSecret.length > 0) {
            console.warn('[WEBHOOK] 已配置 PADDLE_WEBHOOK_SECRET，但请求未带 Paddle-Signature 头。拒绝。');
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ received: false, error: 'missing paddle-signature header' }));
            return;
          }

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

              // 保存订单信息到持久化存储
              const orderId = customData.orderId || `CTG-${Date.now()}`;
              const txnAmount = transaction.amount || {};
              saveOrder({
                orderId,
                transactionId: transaction.id || '',
                email,
                paidAt: transaction.completed_at || new Date().toISOString(),
                amount: txnAmount.amount ? (Number(txnAmount.amount) / 100) : 9.90,
                currency: txnAmount.currency || 'USD',
                formData: {
                  cities: preferences.cities || [],
                  days: preferences.days || 0,
                  travelers: preferences.travelers || '',
                  arrivalDate: preferences.arrivalDate || '',
                  budget: preferences.budget || '',
                  hotelPref: preferences.hotelPref || '',
                  transportPref: preferences.transportPref || '',
                  travelStyle: preferences.travelStyle || '',
                  interests: preferences.interests || [],
                  language: preferences.language || 'English',
                  currency: preferences.currency || 'USD',
                  dietary: preferences.dietary || '',
                  notes: preferences.notes || ''
                },
                guideGenerated: false,
                emailSent: false
              });

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

              // 更新订单状态：攻略已生成
              updateOrderStatus(orderId, { guideGenerated: true });

              // Send email with .doc attachment
              try {
                const docBuffer = fs.readFileSync(filePath);
                const emailResult = await sendGuideEmail(email, fileName, docBuffer, preferences);
                if (emailResult.ok) {
                  console.log(`[WEBHOOK] ✅ 邮件已发送至 ${email}`);
                  updateOrderStatus(orderId, { emailSent: true });
                } else {
                  console.warn(`[WEBHOOK] ⚠️ 邮件发送失败: ${emailResult.reason}`);
                  updateOrderStatus(orderId, { emailSent: false, emailError: emailResult.reason });
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
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Method Not Allowed', method: req.method, path: req.url, hint: 'Use GET for pages/debug, POST for API/webhook' }));
    }
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`[本地开发] 攻略生成服务运行在 http://localhost:${PORT}`);
    console.log(`[本地开发] 在浏览器打开 http://localhost:${PORT} 即可使用`);
  });
}
