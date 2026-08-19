// DeepSeek API 封装
// 兼容 OpenAI 格式，用于生成旅行攻略

const DEEPSEEK_API = 'https://api.deepseek.com/v1/chat/completions';

// 调用 DeepSeek 生成攻略
// 如果输出被 max_tokens 截断（finish_reason=length），自动用续写补全
async function generateGuide(apiKey, systemPrompt, userPrompt) {
  if (!apiKey) {
    throw new Error('DeepSeek API key 未配置');
  }

  let fullContent = '';
  let continuationCount = 0;
  const MAX_CONTINUATIONS = 3;  // 最多续写 3 次，防止死循环

  // 首次请求
  let messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];

  while (continuationCount <= MAX_CONTINUATIONS) {
    const res = await fetch(DEEPSEEK_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages,
        temperature: 0.75,
        max_tokens: 8192,
        stream: false
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`DeepSeek API 错误 (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    const chunk = choice?.message?.content || '';
    const finishReason = choice?.finish_reason;

    fullContent += chunk;
    console.log(`[INFO] DeepSeek 第 ${continuationCount + 1} 次调用，本次 ${chunk.length} 字，finish_reason=${finishReason}`);

    // 如果正常结束，直接返回
    if (finishReason === 'stop' || !finishReason) {
      return fullContent;
    }

    // 如果是 length 截断（达到 max_tokens 但内容没写完），自动续写
    if (finishReason === 'length') {
      continuationCount++;
      if (continuationCount > MAX_CONTINUATIONS) {
        console.warn('[WARN] 已达续写上限，返回当前内容（可能不完整）');
        return fullContent;
      }
      console.log(`[INFO] 检测到截断，启动第 ${continuationCount} 次续写...`);
      // 续写：把已有内容作为 assistant 消息，让 AI 从断点继续
      messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: fullContent },
        { role: 'user', content: '请从上文断点处继续，不要重复已写内容，直接接着写。如果还有未完成的 Day，请补全到完整的 N 天。' }
      ];
      continue;
    }

    // 其他情况直接返回
    return fullContent;
  }

  return fullContent;
}

module.exports = { generateGuide };
