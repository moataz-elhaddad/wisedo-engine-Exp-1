// Experiment B: provider diagnostics for the admin route. Which models does each key see, and does a tiny request on
// each configured model answer? Returns model names, HTTP codes and short error texts only, never keys.
const short = (s) => String(s ?? '').replace(/\s+/g, ' ').slice(0, 200);

async function getJson(doFetch, url, headers, timeoutMs = 10_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { headers, signal: ctl.signal });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
  } catch (e) {
    return { status: 0, data: null, error: short(e && e.message) };
  } finally { clearTimeout(t); }
}

async function postJson(doFetch, url, headers, body, timeoutMs = 20_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    const err = data && (data.error || data.message);
    return { status: res.status, ...(res.ok ? {} : { error: short(typeof err === 'string' ? err : err && (err.message || JSON.stringify(err))) }) };
  } catch (e) {
    return { status: 0, error: short(e && e.message) };
  } finally { clearTimeout(t); }
}

const list = (v, d) => String(v || d).split(',').map((x) => x.trim()).filter(Boolean);

/** @param {Record<string, any>} env @param {{fetch?: typeof fetch}} [opts] */
export async function diagnoseProviders(env, opts = {}) {
  const f = opts.fetch || ((...a) => fetch(...a));
  const out = {};
  const g = String(env.GEMINI_API_KEY || '').trim();
  if (g) {
    const h = { 'x-goog-api-key': g };
    const models = await getJson(f, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', h);
    const names = ((models.data && models.data.models) || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => String(m.name).replace(/^models\//, ''));
    const tries = {};
    for (const m of list(env.GEMINI_DISCOVERY_MODEL || env.GEMINI_MODEL, 'gemini-3.8-flash')) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`;
      tries[m] = {
        plain: await postJson(f, url, h, { contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }], generationConfig: { maxOutputTokens: 5 } }),
        search: await postJson(f, url, h, { contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }], tools: [{ google_search: {} }], generationConfig: { maxOutputTokens: 5 } }),
      };
    }
    out.gemini = { list_status: models.status, models: names.filter((n) => /flash|gemini-3|gemma/.test(n)).slice(0, 40), tries };
  }
  const q = String(env.GROQ_API_KEY || '').trim();
  if (q) {
    const h = { authorization: `Bearer ${q}` };
    const models = await getJson(f, 'https://api.groq.com/openai/v1/models', h);
    const tries = {};
    for (const m of list(env.GROQ_DISCOVERY_MODEL, 'groq/compound')) {
      tries[m] = await postJson(f, 'https://api.groq.com/openai/v1/chat/completions', h, { model: m, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 5 });
    }
    out.groq = { list_status: models.status, models: ((models.data && models.data.data) || []).map((m) => m.id).slice(0, 60), tries };
  }
  const c = String(env.COHERE_API_KEY || '').trim();
  if (c) {
    const h = { authorization: `Bearer ${c}` };
    const models = await getJson(f, 'https://api.cohere.com/v1/models?endpoint=chat&page_size=100', h);
    const tries = {};
    for (const m of list(env.COHERE_DISCOVERY_MODEL, 'command-a-plus-05-2026')) {
      tries[m] = await postJson(f, 'https://api.cohere.com/v2/chat', h, { model: m, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 5 });
    }
    out.cohere = { list_status: models.status, models: ((models.data && models.data.models) || []).map((m) => m.name).slice(0, 60), tries };
  }
  return out;
}
