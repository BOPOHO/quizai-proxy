// api/groq.js — Vercel serverless function
// 5 ключей по очереди: если один упал (429 rate limit, 5xx, network error) — пробуем следующий

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const keys = [
    process.env.GROQ_KEY_1,
    process.env.GROQ_KEY_2,
    process.env.GROQ_KEY_3,
    process.env.GROQ_KEY_4,
    process.env.GROQ_KEY_5,
  ].filter(Boolean);

  if (keys.length === 0) {
    res.status(500).json({ error: 'No GROQ keys configured on server' });
    return;
  }

  let lastError = null;
  let lastStatus = null;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify(req.body),
      });

      // 429 rate limit или 5xx серверная ошибка у Groq — пробуем следующий ключ
      if (response.status === 429 || response.status >= 500) {
        lastError = 'HTTP ' + response.status + ' on key #' + (i + 1);
        lastStatus = response.status;
        continue;
      }

      const data = await response.json();

      // 4xx кроме 429 (например 401 — невалидный ключ) — тоже пробуем следующий,
      // потому что это может значить, что именно этот ключ отозван/неверный
      if (!response.ok) {
        lastError = 'HTTP ' + response.status + ' on key #' + (i + 1) + ': ' + JSON.stringify(data).slice(0, 200);
        lastStatus = response.status;
        continue;
      }

      // Успех — отдаём ответ, в заголовке помечаем каким ключом по счёту сработало (для дебага)
      res.setHeader('X-Groq-Key-Index', String(i + 1));
      return res.status(200).json(data);

    } catch (e) {
      // network error / timeout — тоже пробуем следующий ключ
      lastError = 'Network error on key #' + (i + 1) + ': ' + e.message;
      continue;
    }
  }

  // Все ключи отказали
  res.status(lastStatus || 500).json({
    error: 'All ' + keys.length + ' keys failed. Last error: ' + lastError,
  });
}
