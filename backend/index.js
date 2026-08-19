// veFaaS Serverless 函数入口
// 旅行攻略生成器：飞书知识库 + DeepSeek + .doc 输出

const fs = require('fs');
const path = require('path');

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
const { SYSTEM_PROMPT, buildUserPrompt } = require('./prompt');
const currency = require('./currency');

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
      // 继续走 .doc 生成流程
      const docContent = generateDoc(patchedContent, `${preferences.cities.join('·')} 旅行攻略`);
      const fileName = `${preferences.cities.join('-')}-旅行攻略-不完整.doc`;
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/msword; charset=utf-8',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
          ...CORS_HEADERS
        },
        body: docContent
      };
    }

    // 3. 根据格式要求输出
    if (format === 'markdown') {
      return jsonRes(200, { success: true, format: 'markdown', content: markdownContent });
    }

    // 默认生成 .doc
    const docContent = generateDoc(markdownContent, `${preferences.cities.join('·')} 旅行攻略`);
    const fileName = `${preferences.cities.join('-')}-旅行攻略.doc`;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/msword; charset=utf-8',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
        ...CORS_HEADERS
      },
      body: docContent
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

    // GET / 或 /index.html → 返回前端页面
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
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
