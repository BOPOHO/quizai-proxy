export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  try {
    const { messages, max_tokens, temperature } = req.body;
    const prompt = messages.map(m => m.content).join('\n');
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + process.env.GEMINI_API_KEY,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: temperature || 0.7,
            maxOutputTokens: max_tokens || 4000,
            responseMimeType: 'application/json'
          }
        })
      }
    );
    const data = await response.json();
    let text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    text = text.replace(/```json|```/g, '').trim();
    // НЕ робимо JSON.parse тут — просто повертаємо текст
    res.status(200).json({
      choices: [{ message: { content: text } }]
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
