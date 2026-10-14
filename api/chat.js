// دالة الخادم: تخفي مفتاح الذكاء الاصطناعي عن التطبيق وتمرّر الرسائل.
// تدعم مزوّدين، وتختار تلقائياً حسب المتغيرات الموجودة في Vercel:
//   1) GEMINI_API_KEY  -> Google Gemini (يوجد له مستوى مجاني)
//   2) ANTHROPIC_API_KEY -> Claude (مدفوع)
// وأيضاً: APP_CODE (رمز سري يحمي تطبيقك من الغرباء، موصى به).
// اختياري: GEMINI_MODEL و GEMINI_MODEL_SMART لتغيير اسم النموذج إن تغيّر.

var hits = new Map(); // حد بسيط للطلبات لكل IP

async function askGemini(key, messages, smart) {
  var model = smart
    ? (process.env.GEMINI_MODEL_SMART || 'gemini-2.5-flash')
    : (process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite');
  var contents = messages.map(function (m) {
    return { role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] };
  });
  var r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: contents, generationConfig: { maxOutputTokens: 1500, temperature: 0.9 } })
  });
  var data = await r.json();
  if (!r.ok) return { status: r.status === 429 ? 429 : 502, error: (data && data.error && data.error.message) || 'upstream' };
  var cand = data.candidates && data.candidates[0];
  var parts = (cand && cand.content && cand.content.parts) || [];
  var text = parts.map(function (p) { return p.text || ''; }).join('');
  return { text: text };
}

async function askClaude(key, messages, smart) {
  var model = smart ? 'claude-sonnet-5-5' : 'claude-haiku-5-5';
  var r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: model, max_tokens: 700, messages: messages })
  });
  var data = await r.json();
  if (!r.ok) return { status: r.status === 429 ? 429 : 502, error: (data && data.error && data.error.message) || 'upstream' };
  var text = (data.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
  return { text: text };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method' }); return; }

  var appCode = process.env.APP_CODE;
  if (appCode && req.headers['x-app-code'] !== appCode) { res.status(401).json({ error: 'code' }); return; }

  var geminiKey = process.env.GEMINI_API_KEY;
  var claudeKey = process.env.ANTHROPIC_API_KEY;
  if (!geminiKey && !claudeKey) { res.status(500).json({ error: 'no_key' }); return; }

  var ip = (req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
  var now = Date.now();
  var arr = (hits.get(ip) || []).filter(function (t) { return now - t < 60000; });
  if (arr.length >= 30) { res.status(429).json({ error: 'rate' }); return; }
  arr.push(now); hits.set(ip, arr);

  var body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  var messages = body && body.messages;
  if (!Array.isArray(messages) || !messages.length || messages.length > 40) { res.status(400).json({ error: 'bad_request' }); return; }

  var total = 0;
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') { res.status(400).json({ error: 'bad_request' }); return; }
    total += m.content.length;
  }
  if (total > 60000) { res.status(413).json({ error: 'too_large' }); return; }

  try {
    var smart = body.tier === 'smart';
    var out = geminiKey ? await askGemini(geminiKey, messages, smart) : await askClaude(claudeKey, messages, smart);
    if (out.error) { res.status(out.status).json({ error: out.error }); return; }
    res.status(200).json({ text: out.text });
  } catch (e) {
    res.status(502).json({ error: 'upstream' });
  }
};
