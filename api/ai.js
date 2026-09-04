// api/ai.js — Vercel serverless function
// Три провайдера: Gemini, Cerebras, Groq. Каждый со своей ротацией ключей.
// priority: "quality" — сначала Gemini, потом Cerebras, потом Groq (для генерации теста)
// priority: "speed"   — сначала Groq, потом Cerebras, потом Gemini (для проверки ответов ученика в реальном времени)

// Base64-аудіо для транскрипції (Whisper) важче, ніж звичайний JSON з
// текстом — дефолтний ліміт Vercel body parser (1mb) занадто малий для
// довшої диктовки. Піднімаємо до 10mb (~7 хвилин webm/opus аудіо).
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

function loadKeys(prefix) {
  const keys = [];
  for (let i = 1; i <= 30; i++) {
    const k = process.env[prefix + '_' + i];
    if (k) keys.push(k);
  }
  return keys;
}

// Жоден provider раніше не мав таймауту на fetch — якщо провайдер завис
// (не відповів ні успіхом, ні помилкою), сервер чекав НЕСКІНЧЕННО довго,
// поки Vercel сам не вб'є функцію. Звідси "крутиться кружечок 2+ хвилини
// і нічого". PROVIDER_TIMEOUT_MS обмежує очікування одного провайдера —
// якщо не встиг, вважаємо це помилкою цього провайдера і йдемо до
// наступного в ланцюжку, а не висимо назавжди.
const PROVIDER_TIMEOUT_MS = 15000;

async function fetchWithTimeout(url, options, timeoutMs = PROVIDER_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function tryGroq(body, keys) {
  let lastError = null, lastStatus = null;
  for (let i = 0; i < keys.length; i++) {
    try {
      const response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + keys[i] },
        // response_format:json_object примушує модель віддавати СИНТАКСИЧНО
        // валідний JSON (правильне екранування лапок тощо) — без цього
        // модель іноді забуває заескейпити " всередині тексту питання, і
        // JSON.parse на фронті падає з "Expected ':' after property name".
        body: JSON.stringify({ ...body, response_format: { type: 'json_object' } }),
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
      lastError = 'Groq network error on key #' + (i + 1) + (e.name === 'AbortError' ? ' (timeout > ' + PROVIDER_TIMEOUT_MS + 'ms)' : ': ' + e.message);
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
      const response = await fetchWithTimeout('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + keys[i] },
        body: JSON.stringify({ ...body, model: 'llama-3.3-70b', response_format: { type: 'json_object' } }),
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
      lastError = 'Cerebras network error on key #' + (i + 1) + (e.name === 'AbortError' ? ' (timeout > ' + PROVIDER_TIMEOUT_MS + 'ms)' : ': ' + e.message);
      continue;
    }
  }
  return { ok: false, error: lastError, status: lastStatus };
}

// ⚠️ ВАЖНО: у Google модели периодически "умирают" (deprecation).
// Если тут снова начнёт сыпаться "no longer available" / 404 — поменяйте
// GEMINI_MODEL ниже на актуальное имя из https://ai.google.dev/gemini-api/docs/models
const GEMINI_MODEL = 'gemini-3.5-flash-lite';

async function tryGemini(body, keys) {
  const geminiMessages = body.messages || [];
  const systemMsg = geminiMessages.find(m => m.role === 'system')?.content || '';
  const userMsgs = geminiMessages.filter(m => m.role !== 'system');
  // Algebra Pack шлёт body.images — масив base64 (без data: префіксу) +
  // mime_type. Це фото зошита учня і/або сторінки підручника. Вкладаємо
  // їх inline_data в ОСТАННЄ user-повідомлення, бо саме там просимо
  // порівняти фото з еталоном.
  const images = Array.isArray(body.images) ? body.images : [];
  const contents = userMsgs.map((m, idx) => {
    const parts = [{ text: m.content }];
    if (idx === userMsgs.length - 1 && images.length) {
      for (const img of images) {
        if (img && img.data) {
          parts.push({ inline_data: { mime_type: img.mime_type || 'image/jpeg', data: img.data } });
        }
      }
    }
    return {
      role: m.role === 'assistant' ? 'model' : 'user',
      parts
    };
  });

  let lastError = null, lastStatus = null;
  for (let i = 0; i < keys.length; i++) {
    try {
      const gRes = await fetchWithTimeout(
        'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + keys[i],
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: systemMsg ? { parts: [{ text: systemMsg }] } : undefined,
            contents,
            generationConfig: {
              temperature: body.temperature ?? 0.5,
              maxOutputTokens: body.max_tokens ?? 1000,
              responseMimeType: 'application/json'
            }
          })
        }
      );

      const gData = await gRes.json().catch(() => null);
      const text = gData?.candidates?.[0]?.content?.parts?.[0]?.text;
      const rawMsg = gData?.error?.message || '';
      const modelDead = gRes.status === 404 && /no longer available|not found|not supported/i.test(rawMsg);

      if (gRes.status === 429 || gRes.status >= 500) {
        lastError = 'Gemini HTTP ' + gRes.status + ' on key #' + (i + 1);
        lastStatus = gRes.status;
        continue;
      }

      // Модель отключена Google — это не проблема ключа, нет смысла
      // перебирать остальные ключи этим же мёртвым именем модели.
      if (modelDead) {
        lastError = 'Gemini model "' + GEMINI_MODEL + '" is deprecated by Google: ' + rawMsg.slice(0, 200);
        lastStatus = 502; // не пробрасываем чужой 404 как свой — это не "роут не найден"
        break;
      }

      if (!gRes.ok || !text) {
        lastError = 'Gemini HTTP ' + gRes.status + ' on key #' + (i + 1) + ': ' + JSON.stringify(gData).slice(0, 200);
        // Любую прочую ошибку тоже не отдаём клиенту как есть, если это 4xx
        // не из нашего собственного роутинга — переводим в 502.
        lastStatus = gRes.status >= 400 && gRes.status < 500 ? 502 : gRes.status;
        continue;
      }

      return {
        ok: true,
        data: { choices: [{ message: { content: text } }] },
        providerUsed: 'gemini',
        keyIndex: i + 1
      };
    } catch (e) {
      lastError = 'Gemini network error on key #' + (i + 1) + (e.name === 'AbortError' ? ' (timeout > ' + PROVIDER_TIMEOUT_MS + 'ms)' : ': ' + e.message);
      lastStatus = 502;
      continue;
    }
  }
  return { ok: false, error: lastError, status: lastStatus };
}

// Qwen2.5-VL-72B через OpenRouter (безкоштовний тір) — навмисно ІНШИЙ
// провайдер, не Gemini вдруге. Використовується як другий незалежний
// прохід у dual-pass верифікації Algebra Pack: якщо ОБИДВА проходи на
// Gemini синхронно помиляються в одному й тому ж місці (систематична
// помилка читання конкретного почерку), Gemini+Gemini не зловить
// розбіжність. Різний провайдер має інші "сліпі плями" — не гарантія,
// але знижує шанс саме синхронної помилки. OpenAI-сумісний API, тому
// формат запиту схожий на Groq/Cerebras, а не на Gemini.
async function tryQwenVision(body, keys) {
  const qMessages = body.messages || [];
  const images = Array.isArray(body.images) ? body.images : [];
  const openaiMessages = qMessages.map((m, idx) => {
    const isLastUser = m.role !== 'system' && idx === qMessages.length - 1;
    if (isLastUser && images.length) {
      const content = [{ type: 'text', text: m.content }];
      for (const img of images) {
        if (img && img.data) {
          content.push({ type: 'image_url', image_url: { url: `data:${img.mime_type || 'image/jpeg'};base64,${img.data}` } });
        }
      }
      return { role: m.role, content };
    }
    return { role: m.role, content: m.content };
  });

  let lastError = null, lastStatus = null;
  for (let i = 0; i < keys.length; i++) {
    try {
      const qRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + keys[i],
        },
        body: JSON.stringify({
          model: 'qwen/qwen2.5-vl-72b-instruct:free',
          messages: openaiMessages,
          max_tokens: body.max_tokens ?? 1000,
          temperature: body.temperature ?? 0.5,
        }),
      });

      const qData = await qRes.json().catch(() => null);
      const text = qData?.choices?.[0]?.message?.content;

      if (qRes.status === 429 || qRes.status >= 500) {
        lastError = 'Qwen HTTP ' + qRes.status + ' on key #' + (i + 1);
        lastStatus = qRes.status;
        continue;
      }
      if (!qRes.ok || !text) {
        lastError = 'Qwen HTTP ' + qRes.status + ' on key #' + (i + 1) + ': ' + JSON.stringify(qData).slice(0, 200);
        lastStatus = qRes.status >= 400 && qRes.status < 500 ? 502 : qRes.status;
        continue;
      }

      return {
        ok: true,
        data: { choices: [{ message: { content: text } }] },
        providerUsed: 'qwen',
        keyIndex: i + 1
      };
    } catch (e) {
      lastError = 'Qwen network error on key #' + (i + 1) + ': ' + e.message;
      lastStatus = 502;
      continue;
    }
  }
  return { ok: false, error: lastError, status: lastStatus };
}

// Pixtral (Mistral) — ПРЯМИЙ API, не через посередника типу OpenRouter.
// На відміну від безкоштовних моделей через OpenRouter (де training/logging
// треба явно вмикати навіть щоб просто скористатись безкоштовною моделлю),
// у Mistral є СПРАВЖНІЙ перемикач "не навчайся на моїх даних" у налаштуваннях
// консолі (console.mistral.ai → Privacy), який реально можна вимкнути, не
// втрачаючи доступ до безкоштовного тіру. Використовується як другий,
// ІНШИЙ від Gemini, незалежний прохід верифікації в Algebra Pack.
async function tryMistralVision(body, keys) {
  const mMessages = body.messages || [];
  const images = Array.isArray(body.images) ? body.images : [];
  const openaiMessages = mMessages.map((m, idx) => {
    const isLastUser = m.role !== 'system' && idx === mMessages.length - 1;
    if (isLastUser && images.length) {
      const content = [{ type: 'text', text: m.content }];
      for (const img of images) {
        if (img && img.data) {
          content.push({ type: 'image_url', image_url: `data:${img.mime_type || 'image/jpeg'};base64,${img.data}` });
        }
      }
      return { role: m.role, content };
    }
    return { role: m.role, content: m.content };
  });

  let lastError = null, lastStatus = null;
  for (let i = 0; i < keys.length; i++) {
    try {
      const mRes = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + keys[i],
        },
        body: JSON.stringify({
          // ВАЖЛИВО: перевір актуальну назву vision-моделі в console.mistral.ai
          // перед деплоєм — Mistral перейменовує/об'єднує моделі (Pixtral →
          // Small 4 з березня 2026). 'pixtral-large-latest' — задокументований
          // alias на момент написання, але міг змінитись.
          model: process.env.MISTRAL_VISION_MODEL || 'pixtral-large-latest',
          messages: openaiMessages,
          max_tokens: body.max_tokens ?? 1000,
          temperature: body.temperature ?? 0.5,
        }),
      });

      const mData = await mRes.json().catch(() => null);
      const text = mData?.choices?.[0]?.message?.content;

      if (mRes.status === 429 || mRes.status >= 500) {
        lastError = 'Mistral HTTP ' + mRes.status + ' on key #' + (i + 1);
        lastStatus = mRes.status;
        continue;
      }
      if (!mRes.ok || !text) {
        lastError = 'Mistral HTTP ' + mRes.status + ' on key #' + (i + 1) + ': ' + JSON.stringify(mData).slice(0, 200);
        lastStatus = mRes.status >= 400 && mRes.status < 500 ? 502 : mRes.status;
        continue;
      }

      return {
        ok: true,
        data: { choices: [{ message: { content: text } }] },
        providerUsed: 'mistral',
        keyIndex: i + 1
      };
    } catch (e) {
      lastError = 'Mistral network error on key #' + (i + 1) + ': ' + e.message;
      lastStatus = 502;
      continue;
    }
  }
  return { ok: false, error: lastError, status: lastStatus };
}

async function tryGroqWhisper(audioBuffer, mimeType, keys, language) {
  let lastError = null, lastStatus = null;
  const ext = mimeType.includes('webm') ? 'webm'
    : mimeType.includes('mp4') ? 'mp4'
    : mimeType.includes('ogg') ? 'ogg'
    : mimeType.includes('wav') ? 'wav'
    : 'webm';
  for (let i = 0; i < keys.length; i++) {
    try {
      const form = new FormData();
      form.append('file', new Blob([audioBuffer], { type: mimeType }), 'audio.' + ext);
      form.append('model', 'whisper-large-v3-turbo');
      if (language) form.append('language', language);
      const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + keys[i] },
        body: form,
      });
      if (response.status === 429 || response.status >= 500) {
        lastError = 'Groq Whisper HTTP ' + response.status + ' on key #' + (i + 1);
        lastStatus = response.status;
        continue;
      }
      const data = await response.json();
      if (!response.ok) {
        lastError = 'Groq Whisper HTTP ' + response.status + ' on key #' + (i + 1) + ': ' + JSON.stringify(data).slice(0, 200);
        lastStatus = response.status;
        continue;
      }
      return { ok: true, text: data.text || '', keyIndex: i + 1 };
    } catch (e) {
      lastError = 'Groq Whisper network error on key #' + (i + 1) + ': ' + e.message;
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

    // Транскрипція диктовки (Groq Whisper) — окрема гілка, не chat-completion.
    // Фронтенд шле base64-аудіо замість messages, коли учень натиснув "стоп"
    // на мікрофоні: живий Web Speech API вже показав текст одразу, а тут ми
    // підмінюємо його на точнішу версію від Whisper.
    if (parsedBody.audio_base64) {
      const groqKeys = loadKeys('GROQ_KEY');
      if (!groqKeys.length) {
        res.status(500).json({ error: 'No Groq keys configured for transcription' });
        return;
      }
      let audioBuffer;
      try {
        audioBuffer = Buffer.from(parsedBody.audio_base64, 'base64');
      } catch (e) {
        res.status(400).json({ error: 'Invalid audio_base64' });
        return;
      }
      if (!audioBuffer.length) {
        res.status(400).json({ error: 'Empty audio' });
        return;
      }
      const mimeType = parsedBody.mime_type || 'audio/webm';
      const language = parsedBody.language || undefined;
      const result = await tryGroqWhisper(audioBuffer, mimeType, groqKeys, language);
      if (result.ok) {
        res.status(200).json({ text: result.text });
        return;
      }
      let statusToClient = result.status || 500;
      if (statusToClient === 404) statusToClient = 502;
      res.status(statusToClient).json({ error: 'Transcription failed: ' + (result.error || 'unknown') });
      return;
    }

    const groqKeys = loadKeys('GROQ_KEY');
    const geminiKeys = loadKeys('GEMINI_KEY').length ? loadKeys('GEMINI_KEY') : (process.env.GEMINI_API_KEY ? [process.env.GEMINI_API_KEY] : []);
    const cerebrasKeys = loadKeys('CEREBRAS_KEY').length ? loadKeys('CEREBRAS_KEY') : (process.env.CEREBRAS_API_KEY ? [process.env.CEREBRAS_API_KEY] : []);
    const openrouterKeys = loadKeys('OPENROUTER_KEY').length ? loadKeys('OPENROUTER_KEY') : (process.env.OPENROUTER_API_KEY ? [process.env.OPENROUTER_API_KEY] : []);
    const mistralKeys = loadKeys('MISTRAL_KEY').length ? loadKeys('MISTRAL_KEY') : (process.env.MISTRAL_API_KEY ? [process.env.MISTRAL_API_KEY] : []);

    console.log('[ai.js] keys loaded — groq:', groqKeys.length, 'gemini:', geminiKeys.length, 'cerebras:', cerebrasKeys.length, 'openrouter:', openrouterKeys.length, 'mistral:', mistralKeys.length);

    if (groqKeys.length === 0 && geminiKeys.length === 0 && cerebrasKeys.length === 0) {
      res.status(500).json({ error: 'No AI provider keys configured on server' });
      return;
    }

    const priority = parsedBody.priority === 'quality' ? 'quality' : 'speed';
    const { priority: _drop, ...bodyForProviders } = parsedBody;

    // Groq (llama/gpt-oss) і Cerebras тут не приймають зображення — якщо
    // прийшли images, немає сенсу спочатку бити в них і чекати provider
    // fail, одразу йдемо в Gemini. Якщо в Gemini немає ключів — чесна
    // помилка, а не мовчазна текстова "перевірка" без фото.
    const hasImages = Array.isArray(bodyForProviders.images) && bodyForProviders.images.length > 0;
    if (hasImages && geminiKeys.length === 0 && openrouterKeys.length === 0 && mistralKeys.length === 0) {
      res.status(500).json({ error: 'Image input requires Gemini, Mistral or OpenRouter API key, none configured on server' });
      return;
    }

    // model: 'mistral-vision' — явний запит на ІНШОГО провайдера для vision,
    // не Gemini. Algebra Pack шле це саме для другого (верифікаційного)
    // проходу — щоб не звіряти Gemini сама з собою, а мати справді
    // незалежну думку з іншої моделі (у Mistral є чесний перемикач
    // "не навчатись на моїх даних", на відміну від безкоштовних моделей
    // через OpenRouter). Fallback на Gemini, якщо в Mistral немає ключів.
    // model: 'qwen-vision' лишається доступним про запас, якщо колись
    // знадобиться повернутись до нього.
    const providers = bodyForProviders.model === 'mistral-vision'
      ? [{ name: 'mistral', fn: tryMistralVision, keys: mistralKeys }, { name: 'gemini', fn: tryGemini, keys: geminiKeys }]
      : bodyForProviders.model === 'qwen-vision'
      ? [{ name: 'qwen', fn: tryQwenVision, keys: openrouterKeys }, { name: 'gemini', fn: tryGemini, keys: geminiKeys }]
      : hasImages
      ? [{ name: 'gemini', fn: tryGemini, keys: geminiKeys }, { name: 'mistral', fn: tryMistralVision, keys: mistralKeys }]
      // ТИМЧАСОВО (4 вер. 2026, після масового збою Gemini API 3 вер.):
      // "quality" тепер НЕ ставить Gemini першим. Навіть з таймаутом він
      // забирає до хвилини на запит, поки Google не стабілізується — це
      // множиться на 3 послідовні виклики (generate+factCheck+autofix) і
      // робить продукт непридатним для використання. Groq зараз стабільно
      // швидкий (2-3с). Коли Gemini відновиться — поверніть його першим.
      : priority === 'quality'
      ? [{ name: 'groq', fn: tryGroq, keys: groqKeys }, { name: 'cerebras', fn: tryCerebras, keys: cerebrasKeys }, { name: 'gemini', fn: tryGemini, keys: geminiKeys }]
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

    // ВАЖНО: НИКОГДА не пробрасываем 404 клиенту как есть — на нашем
    // роуте 404 означает ровно одно: "такого пути не существует". Если
    // последний провайдер вернул 404 (например, модель у него отключена),
    // это чужая ошибка, а не наша — превращаем в 502, чтобы не путать
    // с "роут не найден" на фронте.
    let statusToClient = lastResult?.status || 500;
    if (statusToClient === 404) statusToClient = 502;

    res.status(statusToClient).json({
      error: 'All providers failed. Last error: ' + (lastResult?.error || 'unknown'),
    });
  } catch (e) {
    console.error('[ai.js] UNCAUGHT ERROR:', e);
    res.status(500).json({ error: 'Unhandled server error: ' + (e?.message || String(e)) });
  }
}
