// api/ai.js — Vercel serverless function
// Три провайдера: Gemini, Cerebras, Groq. Каждый со своей ротацией ключей.
// priority: "quality" — сначала Gemini, потом Cerebras, потом Groq (для генерации теста)
// priority: "speed"   — сначала Groq, потом Cerebras, потом Gemini (для проверки ответов ученика в реальном времени)

function loadKeys(prefix) {
  const keys = [];
  for (let i = 1; i <= 30; i++) {
    const k = process.env[prefix + '_' + i];
    if (k) keys.push(k);
  }
  return keys;
}

async function tryGroq(body, keys) {
  let lastError = null, lastStatus = null;
  for (let i = 0; i < keys.length; i++) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + keys[i] },
        body: JSON.stringify(body),
      });
      if (response.status === 429 || response.status >= 500) {
        lastError = 'Groq HTTP ' + response.status + ' on key #' + (i + 1);
        lastStatus = response.status;
        continue;
      }
      const data = await response.json();
      if (!response.ok) {
        lastError = 'Groq HTTP ' + response.status + ' on key #' + (i + 1) + ': ' + JSON.stringify(data).slice(0, 200);
        lastStatus = response.status;
        continue;
      }
      return { ok: true, data, providerUsed: 'groq', keyIndex: i + 1 };
    } catch (e) {
      lastError = 'Groq network error on key #' + (i + 1) + ': ' + e.message;
      continue;
    }
  }
  return { ok: false, error: lastError, status: lastStatus };
}

// Cerebras — OpenAI-совместимый формат, как Groq. Бесплатный тариф:
// 1 млн токенов/день, без карты. Модель llama-3.3-70b (не -versatile, у Cerebras своё имя).
async function tryCerebras(body, keys) {
  let lastError = null, lastStatus = null;
  for (let i = 0; i < keys.length; i++) {
    try {
      const response = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + keys[i] },
        body: JSON.stringify({ ...body, model: 'llama-3.3-70b' }),
      });
      if (response.status === 429 || response.status >= 500) {
        lastError = 'Cerebras HTTP ' + response.status + ' on key #' + (i + 1);
        lastStatus = response.status;
        continue;
      }
      const data = await response.json();
      if (!response.ok) {
        lastError = 'Cerebras HTTP ' + response.status + ' on key #' + (i + 1) + ': ' + JSON.stringify(data).slice(0, 200);
        lastStatus = response.status;
        continue;
      }
      return { ok: true, data, providerUsed: 'cerebras', keyIndex: i + 1 };
    } catch (e) {
      lastError = 'Cerebras network error on key #' + (i + 1) + ': ' + e.message;
      continue;
    }
  }
  return { ok: false, error: lastError, status: lastStatus };
}

async function tryGemini(body, keys) {
  const geminiMessages = body.messages || [];
  const systemMsg = geminiMessages.find(m => m.role === 'system')?.content || '';
  const userMsgs = geminiMessages.filter(m => m.role !== 'system');
  const contents = userMsgs.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  let lastError = null, lastStatus = null;
  for (let i = 0; i < keys.length; i++) {
    try {
      // gemini-2.0-flash отключена Google 1 июня 2026 — используем актуальную замену
      const gRes = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + keys[i],
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: systemMsg ? { parts: [{ text: systemMsg }] } : undefined,
            contents,
            generationConfig: {
              temperature: body.temperature ?? 0.5,
              maxOutputTokens: body.max_tokens ?? 1000
            }
          })
        }
      );
      if (gRes.status === 429 || gRes.status >= 500) {
        lastError = 'Gemini HTTP ' + gRes.status + ' on key #' + (i + 1);
        lastStatus = gRes.status;
        continue;
      }
      const gData = await gRes.json();
      const text = gData.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!gRes.ok || !text) {
        lastError = 'Gemini HTTP ' + gRes.status + ' on key #' + (i + 1) + ': ' + JSON.stringify(gData).slice(0, 200);
        lastStatus = gRes.status;
        continue;
      }
      return {
        ok: true,
        data: { choices: [{ message: { content: text } }] },
        providerUsed: 'gemini',
        keyIndex: i + 1
      };
    } catch (e) {
      lastError = 'Gemini network error on key #' + (i + 1) + ': ' + e.message;
      continue;
    }
  }
  return { ok: false, error: lastError, status: lastStatus };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  // Всё оборачиваем в try/catch, чтобы вместо "тихого" сбоя платформы
  // (который клиент видит как непонятный 404) всегда возвращался
  // осмысленный JSON с текстом ошибки.
  try {
    let parsedBody = req.body;
    // На некоторых рантаймах req.body может прийти как сырая строка —
    // подстрахуемся и распарсим вручную.
    if (typeof parsedBody === 'string') {
      try {
        parsedBody = JSON.parse(parsedBody);
      } catch (e) {
        res.status(400).json({ error: 'Invalid JSON body: ' + e.message });
        return;
      }
    }
    if (!parsedBody || typeof parsedBody !== 'object') {
      res.status(400).json({ error: 'Missing or invalid JSON body' });
      return;
    }

    const groqKeys = loadKeys('GROQ_KEY');
    const geminiKeys = loadKeys('GEMINI_KEY').length ? loadKeys('GEMINI_KEY') : (process.env.GEMINI_API_KEY ? [process.env.GEMINI_API_KEY] : []);
    const cerebrasKeys = loadKeys('CEREBRAS_KEY').length ? loadKeys('CEREBRAS_KEY') : (process.env.CEREBRAS_API_KEY ? [process.env.CEREBRAS_API_KEY] : []);

    console.log('[ai.js] keys loaded — groq:', groqKeys.length, 'gemini:', geminiKeys.length, 'cerebras:', cerebrasKeys.length);

    if (groqKeys.length === 0 && geminiKeys.length === 0 && cerebrasKeys.length === 0) {
      res.status(500).json({ error: 'No AI provider keys configured on server' });
      return;
    }

    const priority = parsedBody.priority === 'quality' ? 'quality' : 'speed';
    const { priority: _drop, ...bodyForProviders } = parsedBody;

    const providers = priority === 'quality'
      ? [{ name: 'gemini', fn: tryGemini, keys: geminiKeys }, { name: 'cerebras', fn: tryCerebras, keys: cerebrasKeys }, { name: 'groq', fn: tryGroq, keys: groqKeys }]
      : [{ name: 'groq', fn: tryGroq, keys: groqKeys }, { name: 'cerebras', fn: tryCerebras, keys: cerebrasKeys }, { name: 'gemini', fn: tryGemini, keys: geminiKeys }];

    let lastResult = null;
    for (const p of providers) {
      if (!p.keys.length) continue;
      console.log('[ai.js] trying provider:', p.name);
      const result = await p.fn(bodyForProviders, p.keys);
      if (result.ok) {
        res.setHeader('X-Provider-Used', result.providerUsed);
        res.setHeader('X-Key-Index', String(result.keyIndex));
        res.status(200).json(result.data);
        return;
      }
      console.log('[ai.js] provider failed:', p.name, result.error);
      lastResult = result;
    }

    res.status(lastResult?.status || 500).json({
      error: 'All providers failed. Last error: ' + (lastResult?.error || 'unknown'),
    });
  } catch (e) {
    console.error('[ai.js] UNCAUGHT ERROR:', e);
    res.status(500).json({ error: 'Unhandled server error: ' + (e?.message || String(e)) });
  }
}
