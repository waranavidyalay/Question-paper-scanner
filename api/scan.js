// api/scan.js — Vercel Serverless Function
// Fix 1: Clear error when API key missing
// Fix 2: OCR returns all pages text, then frontend does smart merge

const ipWindows = new Map();
function checkRate(ip) {
  const now = Date.now(), win60 = 60*60*1000, max = 60;
  let w = ipWindows.get(ip);
  if (!w || now > w.r) { w = { c: 0, r: now + win60 }; ipWindows.set(ip, w); }
  w.c++;
  if (ipWindows.size > 300) for (const [k,v] of ipWindows) if (now > v.r) ipWindows.delete(k);
  return w.c <= max;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')   { res.status(405).json({ error: 'POST only' }); return; }

  // ── Rate limit
  const ip = (req.headers['x-forwarded-for']||'').split(',')[0].trim() || 'unknown';
  if (!checkRate(ip)) {
    res.status(429).json({ error: 'खूप जास्त requests. 1 तासाने try करा.' }); return;
  }

  // ── API Key check — clear message for admin
  const KEY = process.env.CLAUDE_API_KEY || process.env.GEMINI_API_KEY;
  const keyType = process.env.CLAUDE_API_KEY ? 'claude' : process.env.GEMINI_API_KEY ? 'gemini' : null;

  if (!KEY) {
    console.error('ERROR: No API key found in environment variables!');
    console.error('Please set CLAUDE_API_KEY or GEMINI_API_KEY in Vercel → Settings → Environment Variables');
    res.status(500).json({
      error: 'API Key सेट नाही! Vercel Dashboard → Settings → Environment Variables मध्ये CLAUDE_API_KEY टाका, मग Redeploy करा.',
      fix: 'vercel_env_missing'
    });
    return;
  }

  // ── Validate input
  const { imageBase64, mimeType, pageNum, totalPages, taskType } = req.body || {};
  if (!imageBase64) { res.status(400).json({ error: 'imageBase64 required' }); return; }
  if (!['ocr','meta'].includes(taskType)) { res.status(400).json({ error: 'invalid taskType' }); return; }
  if (imageBase64.length > 12*1024*1024) { res.status(400).json({ error: 'Image खूप मोठी. 8MB पेक्षा कमी असावी.' }); return; }

  const validMimes = ['image/jpeg','image/jpg','image/png','image/webp','image/gif'];
  if (!validMimes.includes(mimeType)) { res.status(400).json({ error: `Invalid mime: ${mimeType}` }); return; }

  // ── Build prompt
  let prompt;
  if (taskType === 'ocr') {
    prompt = `You are scanning handwritten Indian school question paper — page ${pageNum} of ${totalPages}.

CRITICAL RULES:
1. Extract ALL text EXACTLY as written on the paper.
2. Devanagari script (मराठी/हिंदी/संस्कृत) → proper Unicode. English → as-is.
3. Preserve question numbers EXACTLY: Q.1, Q.2, प्र.१, प्र.२, 1., 2., (अ), (ब), i), ii) etc.
4. Preserve marks EXACTLY: [2], (3 गुण), (Marks: 5), 5M etc.
5. Keep sub-questions indented under their parent.
6. If a word is illegible, write [?].
7. Output ONLY the extracted text. Zero markdown (no **, ##, --). No explanations.`;
  } else {
    prompt = `Examine this Indian school question paper image carefully.
Extract ONLY the header/top section info. Return ONLY this JSON, nothing else:
{"school":"","subject":"","class":"","examType":"","date":"","marks":"","time":""}
Use original language. Empty string for anything not clearly visible.`;
  }

  // ── Call appropriate API
  try {
    let text = '';
    if (keyType === 'claude') {
      text = await callClaude(KEY, imageBase64, mimeType, prompt);
    } else {
      text = await callGemini(KEY, imageBase64, mimeType, prompt);
    }
    console.log(`[scan] ip:${ip} task:${taskType} pg:${pageNum}/${totalPages} api:${keyType}`);
    res.status(200).json({ text: text.trim(), api: keyType });
  } catch(e) {
    console.error('API call failed:', e.message);
    if (e.message.includes('401') || e.message.includes('Invalid API')) {
      res.status(401).json({ error: 'API Key चुकीची आहे! Vercel Environment Variables तपासा.' });
    } else if (e.message.includes('429')) {
      res.status(429).json({ error: 'API rate limit. थोड्या वेळाने try करा.' });
    } else if (e.name === 'TimeoutError') {
      res.status(504).json({ error: 'Timeout. Image compress करून try करा.' });
    } else {
      res.status(502).json({ error: e.message });
    }
  }
}

async function callClaude(key, b64, mime, prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-api-key':key, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{ role:'user', content: [
        { type:'image', source:{ type:'base64', media_type:mime, data:b64 } },
        { type:'text', text:prompt }
      ]}]
    }),
    signal: AbortSignal.timeout(55000)
  });
  if (!r.ok) {
    const e = await r.json().catch(()=>({}));
    throw new Error(e?.error?.message || `Claude HTTP ${r.status}`);
  }
  const d = await r.json();
  return d?.content?.[0]?.text || '';
}

async function callGemini(key, b64, mime, prompt) {
  const models = ['gemini-2.5-flash','gemini-2.0-flash','gemini-1.5-flash'];
  for (const model of models) {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ contents:[{ parts:[{ inlineData:{mimeType:mime,data:b64} },{ text:prompt }] }],
          generationConfig:{ temperature:0.1, maxOutputTokens:4096 } }),
        signal: AbortSignal.timeout(55000) }
    );
    if (r.ok) { const d=await r.json(); return d?.candidates?.[0]?.content?.parts?.[0]?.text||''; }
    const e=await r.json().catch(()=>({}));
    const msg=e?.error?.message||'';
    if (r.status===404||/not found|not supported/i.test(msg)) continue;
    throw new Error(msg||`Gemini HTTP ${r.status}`);
  }
  throw new Error('Gemini: सर्व models अनुपलब्ध');
}
