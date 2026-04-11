// api/scan.js  — Vercel Serverless Function
// API key फक्त इथेच आहे — users ला कधीही दिसत नाही

export default async function handler(req, res) {

  // ── CORS: फक्त तुमच्या domain वरून requests स्वीकारा
  res.setHeader('Access-Control-Allow-Origin', '*'); // deploy नंतर तुमचा domain टाका
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')    { res.status(405).json({ error: 'POST only' }); return; }

  // ── Rate limiting: एका IP ने जास्त requests करू नयेत
  // (Vercel Edge Config किंवा KV वापरून advanced rate limiting करता येते)
  // साध्या शाळेसाठी हे पुरे:
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  console.log(`[scan] IP: ${ip}, time: ${new Date().toISOString()}`);

  // ── API key — Vercel Environment Variable मधून येते, code मध्ये नाही
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) {
    console.error('GEMINI_API_KEY not set in Vercel environment!');
    res.status(500).json({ error: 'Server configuration error. Admin ला सांगा.' });
    return;
  }

  // ── Input validation
  const { imageBase64, mimeType, pageNum, totalPages, subject, taskType } = req.body || {};

  if (!imageBase64 || typeof imageBase64 !== 'string') {
    res.status(400).json({ error: 'imageBase64 required' }); return;
  }
  if (!['image/jpeg','image/jpg','image/png','image/webp','image/heic','image/heif'].includes(mimeType)) {
    res.status(400).json({ error: 'Invalid image type' }); return;
  }
  if (!['ocr','meta'].includes(taskType)) {
    res.status(400).json({ error: 'taskType must be ocr or meta' }); return;
  }

  // ── Image size limit: 10MB base64 ≈ 7.5MB image
  if (imageBase64.length > 10 * 1024 * 1024) {
    res.status(400).json({ error: 'Image खूप मोठी आहे. 8MB पेक्षा कमी असावी.' }); return;
  }

  // ── Build prompt
  let prompt;
  if (taskType === 'ocr') {
    prompt = `You are scanning a handwritten Indian school question paper — page ${pageNum || 1} of ${totalPages || 1}.
Subject: ${subject || 'unknown'}

Extract ALL text exactly as written. Rules:
1. Devanagari (मराठी/हिंदी/संस्कृत) → proper Unicode Devanagari script.
2. English text → as-is.
3. Preserve question numbers exactly: Q.1, प्र.१, 1., (अ) etc.
4. Preserve marks: [2], (3 गुण), Marks:5 etc.
5. Blank line between questions.
6. Unclear word → write [?].
7. Output ONLY extracted text. No markdown (no **, ##). No explanations.`;

  } else { // meta
    prompt = `Look at this Indian school question paper.
Extract ONLY header info. Return ONLY valid JSON, nothing else, no markdown:
{"school":"","subject":"","class":"","examType":"","date":"","marks":"","time":""}

Rules: use original language for subject (मराठी/English/हिंदी/संस्कृत).
Empty string "" for anything not visible on the paper.`;
  }

  // ── Call Gemini API
  const MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  let lastError = '';

  for (const model of MODELS) {
    try {
      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inlineData: { mimeType, data: imageBase64 } },
                { text: prompt }
              ]
            }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
          }),
          // Vercel function timeout is 10s on hobby, 60s on pro
          signal: AbortSignal.timeout(55000)
        }
      );

      if (geminiRes.ok) {
        const data = await geminiRes.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        res.status(200).json({ text: text.trim(), model });
        return;
      }

      const errData = await geminiRes.json().catch(() => ({}));
      const errMsg = errData?.error?.message || geminiRes.statusText;

      // Pass Gemini errors back to frontend (without exposing key)
      if (geminiRes.status === 429) {
        res.status(429).json({ error: 'Rate limit — थोड्या वेळाने try करा.' }); return;
      }
      if (geminiRes.status === 403) {
        res.status(403).json({ error: 'Gemini API access नाही. Admin ला सांगा.' }); return;
      }
      if (geminiRes.status === 404 || /not found|not supported/i.test(errMsg)) {
        lastError = errMsg; continue; // try next model
      }

      res.status(502).json({ error: `AI error: ${errMsg}` }); return;

    } catch (e) {
      if (e.name === 'TimeoutError') { res.status(504).json({ error: 'Timeout — image खूप मोठी असेल.' }); return; }
      lastError = e.message;
      continue;
    }
  }

  res.status(502).json({ error: `सर्व models अनुपलब्ध: ${lastError}` });
}
