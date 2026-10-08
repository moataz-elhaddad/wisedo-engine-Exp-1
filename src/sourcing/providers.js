// Experiment B: product-discovery provider adapters. One interface for every provider:
//
//   adapter = { name, model, discover(request) -> Promise<ProviderResult> }
//   ProviderResult = { ok, output?, error?, stopReason, model, usage: {input_tokens, output_tokens, web_searches}, variant, attempts }
//
// Each adapter uses the provider's REST API through an injected fetch (tests use recorded responses), with the
// provider's own web search tool switched on so it can look at Egyptian shops, and structured JSON output.
// Requests that a provider rejects (HTTP 400, e.g. a tool + schema combination it does not support) are retried
// with a simpler variant: the schema then travels in the prompt only. Keys are read from env by the caller and
// never appear in results or errors. Add a provider by writing one more create*Provider and listing it in
// providersFromEnv.

import { postJson, ProviderError } from './http.js';
import { createTavilyProvider, createSerperProvider } from './search-providers.js';

export const DEFAULT_MODELS = {
  // Lists = model fallback order (404 / 429 move on). Chosen from the models the live keys can use (/api/expb/diagnose).
  gemini: 'gemini-3.5-flash,gemini-3.7-flash,gemini-3.1-flash-lite',
  groq: 'openai/gpt-oss-120b,qwen/qwen3.8-27b',
  cohere: 'command-a-plus-05-2026',
  openai: 'gpt-5',
  anthropic: 'claude-opus-5-5',
};

/** Default experiment mix: three LLM families (two of them web-grounded), one web search, one shopping search. */
export const DEFAULT_PROVIDER_MIX = 'gemini,groq,cohere,tavily,serper';
export const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * List prices used for the cost ESTIMATE (USD). Anthropic rates are the published list prices; OpenAI and Gemini
 * rates are assumptions to confirm on the providers' pricing pages (override with the *_PRICE vars, "in,out,search").
 * per_search is USD per web search / grounded request.
 */
export const PRICES = {
  'claude-opus-5-5': { in: 4, out: 20, per_search: 0.01, basis: 'Anthropic list price' },
  'claude-sonnet-5-5': { in: 2, out: 10, per_search: 0.01, basis: 'Anthropic list price' },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, per_search: 0.01, basis: 'Anthropic list price' },
  'gpt-5': { in: 1.25, out: 10, per_search: 0.01, basis: 'assumption (check OpenAI pricing)' },
  'gpt-5-mini': { in: 0.25, out: 2, per_search: 0.01, basis: 'assumption (check OpenAI pricing)' },
  'gemini-3.8-flash': { in: 0.3, out: 2.5, per_search: 0.035, basis: 'paid-equivalent assumption; $0 on the AI Studio free tier' },
  'groq/compound': { in: 0.15, out: 0.6, per_search: 0.008, basis: 'paid-equivalent assumption; $0 on the Groq free tier' },
  'groq/compound-mini': { in: 0.15, out: 0.6, per_search: 0.008, basis: 'paid-equivalent assumption; $0 on the Groq free tier' },
  'openai/gpt-oss-120b': { in: 0.15, out: 0.6, per_search: 0.005, basis: 'paid-equivalent assumption; $0 on the Groq free tier' },
  'qwen/qwen3.8-27b': { in: 0.3, out: 0.6, per_search: 0, basis: 'paid-equivalent assumption; $0 on the Groq free tier' },
  'gemini-3.7-flash': { in: 0.3, out: 2.5, per_search: 0.035, basis: 'paid-equivalent assumption; $0 on the AI Studio free tier' },
  'gemini-3.5-flash': { in: 0.3, out: 2.5, per_search: 0.035, basis: 'paid-equivalent assumption; $0 on the AI Studio free tier' },
  'gemini-3.1-flash-lite': { in: 0.1, out: 0.4, per_search: 0.035, basis: 'paid-equivalent assumption; $0 on the AI Studio free tier' },
  'gemini-2.5-flash': { in: 0.3, out: 2.5, per_search: 0.035, basis: 'paid-equivalent assumption; $0 on the AI Studio free tier' },
  'gemini-3.8-flash-lite': { in: 0.1, out: 0.4, per_search: 0.035, basis: 'paid-equivalent assumption; $0 on the AI Studio free tier' },
  'command-a-plus-05-2026': { in: 2.5, out: 10, per_search: 0, basis: 'paid-equivalent assumption (Command A list price); $0 on a Cohere trial key (1,000 calls/month)' },
};

/** Estimated USD cost of one call. */
export function estimateCost(model, usage, override) {
  const p = override || PRICES[model];
  if (!p || !usage) return { usd: null, basis: 'no price for this model' };
  const usd = ((usage.input_tokens || 0) * p.in + (usage.output_tokens || 0) * p.out) / 1e6 + (usage.web_searches || 0) * (p.per_search || 0);
  return { usd: Math.round(usd * 10000) / 10000, basis: p.basis || 'override' };
}

/** "in,out,search" -> price row. */
export function parsePriceOverride(s) {
  if (!s) return null;
  const [a, b, c] = String(s).split(',').map(Number);
  return Number.isFinite(a) && Number.isFinite(b) ? { in: a, out: b, per_search: Number.isFinite(c) ? c : 0, basis: 'override' } : null;
}

/** Parse a model's text answer as a JSON object (tolerates a code fence or prose around it). */
export function parseJsonObject(text) {
  if (text && typeof text === 'object') return text;
  const s = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(s); } catch { /* try the outermost braces */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* fall through */ } }
  return null;
}

const schemaNote = (req) => `\n\nReply with ONLY one JSON object matching this JSON schema. No prose, no code fence.\n${JSON.stringify(req.schema)}`;

/** Deep copy of a schema without keywords some strict validators reject. */
export function stripKeywords(schema, keys) {
  if (Array.isArray(schema)) return schema.map((x) => stripKeywords(x, keys));
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema).filter(([k]) => !keys.includes(k)).map(([k, v]) => [k, stripKeywords(v, keys)]));
}

/** Try request variants in order; move to the next only when the provider rejects the request shape (HTTP 400). */
async function runVariants(variants, call, retryOn = (e) => e instanceof ProviderError && e.status === 400) {
  const attempts = [];
  let lastErr = null;
  // Tokens spent by failed attempts (e.g. a runaway answer) still cost money: add them to the reported usage.
  const spent = { input_tokens: 0, output_tokens: 0, web_searches: 0 };
  const add = (u) => { if (u) for (const k of Object.keys(spent)) spent[k] += u[k] || 0; };
  const merged = (u) => (spent.input_tokens || spent.output_tokens ? { ...(u || {}), input_tokens: ((u && u.input_tokens) || 0) + spent.input_tokens, output_tokens: ((u && u.output_tokens) || 0) + spent.output_tokens, web_searches: ((u && u.web_searches) || 0) + spent.web_searches } : u);
  for (const v of variants) {
    try {
      const r = await call(v);
      attempts.push({ variant: v.name, ok: true });
      return { ...r, usage: merged(r.usage), variant: v.name, attempts };
    } catch (e) {
      attempts.push({ variant: v.name, ok: false, error: String(e.message).slice(0, 200) });
      add(e.usage);
      lastErr = e;
      if (!retryOn(e)) break;
    }
  }
  return { ok: false, error: lastErr ? String(lastErr.message) : 'no variant', attempts, ...(spent.output_tokens ? { usage: merged(null) } : {}) };
}

/**
 * Model fallback: a provider configured with "model-a,model-b" tries model-a first and moves to model-b only when
 * the provider says the model does not exist for this key (404), its quota is used up (429) or it is overloaded (503).
 * Each attempt is kept.
 * @param {string[]} models
 * @param {(model: string) => any} make  adapter factory for one model
 */
export function withModelFallback(models, make) {
  const list = models.filter(Boolean);
  const first = make(list[0]);
  if (list.length < 2) return first;
  return {
    ...first,
    models: list,
    async discover(req) {
      const tried = [];
      let res;
      for (const m of list) {
        res = await make(m).discover(req);
        tried.push({ model: m, ok: !!res.ok, ...(res.ok ? {} : { error: String(res.error || '').slice(0, 160) }) });
        if (res.ok || !/HTTP (404|429|503)|does not exist|not found|RESOURCE_EXHAUSTED|UNAVAILABLE|high demand|quota/i.test(String(res.error || ''))) break;
      }
      return { ...res, model_attempts: tried, model: res.model || tried[tried.length - 1].model };
    },
  };
}

const modelList = (v, dflt) => String(v || dflt).split(',').map((x) => x.trim()).filter(Boolean);

// ---------------------------------------------------------------------------------------------------------------
// Anthropic (Messages API, web_search server tool, structured output via output_config.format)
// ---------------------------------------------------------------------------------------------------------------

/**
 * @param {{apiKey: string, model?: string, fetch?: typeof fetch, timeoutMs?: number, webSearch?: boolean, effort?: string}} opts
 */
export function createAnthropicProvider(opts) {
  const model = opts.model || DEFAULT_MODELS.anthropic;
  const doFetch = opts.fetch || ((...a) => fetch(...a));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const search = opts.webSearch !== false;
  const tool = { type: 'web_search_20260209', name: 'web_search', max_uses: 5, user_location: { type: 'approximate', country: 'EG', timezone: 'Africa/Cairo' } };
  const variants = [
    ...(search ? [{ name: 'search+schema', search: true, schema: true, fallback: true }, { name: 'search', search: true, schema: false, fallback: true }] : []),
    { name: 'schema', search: false, schema: true, fallback: true },
    { name: 'plain', search: false, schema: false, fallback: false },
  ];
  return {
    name: 'anthropic', role: 'llm',
    model,
    async discover(req) {
      return runVariants(variants, async (v) => {
        const headers = { 'x-api-key': opts.apiKey, 'anthropic-version': '2023-06-01', ...(v.fallback ? { 'anthropic-beta': 'server-side-fallback-2026-07-01' } : {}) };
        const messages = [{ role: 'user', content: req.user + (v.schema ? '' : schemaNote(req)) }];
        const usage = { input_tokens: 0, output_tokens: 0, web_searches: 0 };
        let data;
        // pause_turn: a long server-tool turn can pause; send the partial assistant turn back to let it continue.
        for (let turn = 0; turn < 3; turn++) {
          data = await postJson(doFetch, 'https://api.anthropic.com/v1/messages', headers, {
            model,
            max_tokens: req.maxTokens || 8000,
            system: req.system,
            messages,
            ...(v.search ? { tools: [tool] } : {}),
            output_config: { effort: opts.effort || 'low', ...(v.schema ? { format: { type: 'json_schema', schema: req.schema } } : {}) },
            ...(v.fallback ? { fallbacks: 'default' } : {}),
          }, timeoutMs, 'anthropic');
          const u = data.usage || {};
          usage.input_tokens += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
          usage.output_tokens += u.output_tokens || 0;
          usage.web_searches += (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
          if (data.stop_reason !== 'pause_turn') break;
          messages.push({ role: 'assistant', content: data.content });
        }
        if (data.stop_reason === 'refusal') return { ok: false, error: `anthropic: refusal ${(data.stop_details && data.stop_details.category) || ''}`.trim(), stopReason: 'refusal', model: data.model || model, usage };
        if (data.stop_reason === 'max_tokens') return { ok: false, error: 'anthropic: max_tokens', stopReason: 'max_tokens', model: data.model || model, usage };
        const texts = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text);
        // With web search the answer may come in several text blocks; the JSON object is normally the last one.
        const output = parseJsonObject(texts.join('')) ?? parseJsonObject(texts[texts.length - 1] || '');
        if (!output) return { ok: false, error: 'anthropic: answer is not JSON', stopReason: data.stop_reason, model: data.model || model, usage };
        return { ok: true, output, stopReason: data.stop_reason, model: data.model || model, usage };
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// OpenAI (Responses API, web_search tool, structured output via text.format json_schema)
// ---------------------------------------------------------------------------------------------------------------

/**
 * @param {{apiKey: string, model?: string, fetch?: typeof fetch, timeoutMs?: number, webSearch?: boolean}} opts
 */
export function createOpenAiProvider(opts) {
  const model = opts.model || DEFAULT_MODELS.openai;
  const doFetch = opts.fetch || ((...a) => fetch(...a));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const search = opts.webSearch !== false;
  const variants = [
    ...(search ? [{ name: 'search+schema', search: true, schema: 'strict' }, { name: 'search+schema-loose', search: true, schema: 'loose' }, { name: 'search', search: true, schema: null }] : []),
    { name: 'schema', search: false, schema: 'loose' },
    { name: 'plain', search: false, schema: null },
  ];
  return {
    name: 'openai', role: 'llm',
    model,
    async discover(req) {
      return runVariants(variants, async (v) => {
        const schema = stripKeywords(req.schema, ['maxItems']);
        const data = await postJson(doFetch, 'https://api.openai.com/v1/responses', { authorization: `Bearer ${opts.apiKey}` }, {
          model,
          instructions: req.system,
          input: req.user + (v.schema ? '' : schemaNote(req)),
          ...(v.search ? { tools: [{ type: 'web_search', user_location: { type: 'approximate', country: 'EG' } }] } : {}),
          ...(v.schema ? { text: { format: { type: 'json_schema', name: 'laptop_candidates', schema, strict: v.schema === 'strict' } } } : {}),
          max_output_tokens: 16000,
        }, timeoutMs, 'openai');
        const out = Array.isArray(data.output) ? data.output : [];
        const usage = {
          input_tokens: (data.usage && data.usage.input_tokens) || 0,
          output_tokens: (data.usage && data.usage.output_tokens) || 0,
          web_searches: out.filter((o) => o.type === 'web_search_call').length,
        };
        if (data.status === 'incomplete') return { ok: false, error: `openai: incomplete (${(data.incomplete_details && data.incomplete_details.reason) || 'unknown'})`, stopReason: 'max_tokens', model: data.model || model, usage };
        const parts = out.filter((o) => o.type === 'message').flatMap((o) => o.content || []);
        const refusal = parts.find((c) => c.type === 'refusal');
        if (refusal) return { ok: false, error: 'openai: refusal', stopReason: 'refusal', model: data.model || model, usage };
        const text = typeof data.output_text === 'string' ? data.output_text : parts.filter((c) => c.type === 'output_text').map((c) => c.text).join('');
        const output = parseJsonObject(text);
        if (!output) return { ok: false, error: 'openai: answer is not JSON', stopReason: 'end_turn', model: data.model || model, usage };
        return { ok: true, output, stopReason: 'end_turn', model: data.model || model, usage };
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Google Gemini (generateContent, google_search grounding, responseJsonSchema)
// ---------------------------------------------------------------------------------------------------------------

/**
 * @param {{apiKey: string, model?: string, fetch?: typeof fetch, timeoutMs?: number, webSearch?: boolean}} opts
 */
export function createGeminiProvider(opts) {
  const model = opts.model || DEFAULT_MODELS.gemini.split(',')[0];
  const doFetch = opts.fetch || ((...a) => fetch(...a));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const search = opts.webSearch !== false;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const variants = [
    ...(search ? [{ name: 'search+schema', search: true, schema: true }, { name: 'search', search: true, schema: false }] : []),
    { name: 'schema', search: false, schema: true },
    { name: 'plain', search: false, schema: false },
  ];
  return {
    name: 'gemini', role: 'llm',
    model,
    async discover(req) {
      return runVariants(variants, async (v) => {
        const data = await postJson(doFetch, url, { 'x-goog-api-key': opts.apiKey }, {
          systemInstruction: { parts: [{ text: req.system }] },
          contents: [{ role: 'user', parts: [{ text: req.user + (v.schema ? '' : schemaNote(req)) }] }],
          ...(v.search ? { tools: [{ google_search: {} }] } : {}),
          generationConfig: {
            maxOutputTokens: 16000,
            temperature: 0,
            ...(v.schema ? { responseMimeType: 'application/json', responseJsonSchema: stripKeywords(req.schema, ['maxItems']) } : {}),
          },
        }, timeoutMs, 'gemini');
        const um = data.usageMetadata || {};
        const cand = data.candidates && data.candidates[0];
        const gm = cand && cand.groundingMetadata;
        const usage = {
          input_tokens: um.promptTokenCount || 0,
          output_tokens: (um.candidatesTokenCount || 0) + (um.thoughtsTokenCount || 0),
          web_searches: gm && Array.isArray(gm.webSearchQueries) && gm.webSearchQueries.length ? 1 : 0,
        };
        if (!cand) return { ok: false, error: `gemini: no candidates${data.promptFeedback && data.promptFeedback.blockReason ? ' (' + data.promptFeedback.blockReason + ')' : ''}`, stopReason: 'refusal', model, usage };
        if (cand.finishReason === 'MAX_TOKENS') return { ok: false, error: 'gemini: max_tokens', stopReason: 'max_tokens', model, usage };
        if (cand.finishReason === 'SAFETY' || cand.finishReason === 'PROHIBITED_CONTENT') return { ok: false, error: `gemini: ${cand.finishReason}`, stopReason: 'refusal', model, usage };
        const text = ((cand.content && cand.content.parts) || []).map((p) => p.text || '').join('');
        const output = parseJsonObject(text);
        if (!output) return { ok: false, error: 'gemini: answer is not JSON', stopReason: 'end_turn', model, usage };
        return { ok: true, output, stopReason: 'end_turn', model: `${model}`, usage };
      }, (e) => e instanceof ProviderError && (e.status === 400 || e.status === 429));
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Cohere (v2 chat, JSON mode with a JSON schema). Knowledge only: no web tool. A different model family from the others.
// ---------------------------------------------------------------------------------------------------------------

/** OpenAI-compatible chat answer -> {text, usage}. */
function chatAnswer(data) {
  const ch = data && data.choices && data.choices[0];
  const msg = (ch && ch.message) || {};
  const text = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map((c) => c.text || '').join('') : '';
  const u = data.usage || {};
  return { text, finish: ch && ch.finish_reason, msg, usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 } };
}

/** Cohere v2 chat answer -> {text, finish (lower case), usage}. */
function cohereAnswer(data) {
  const content = data && data.message && data.message.content;
  const text = Array.isArray(content) ? content.filter((c) => !c.type || c.type === 'text').map((c) => c.text || '').join('') : typeof content === 'string' ? content : '';
  const u = (data && data.usage) || {};
  const t = u.billed_units || u.tokens || {};
  return { text, finish: String((data && data.finish_reason) || '').toLowerCase(), usage: { input_tokens: t.input_tokens || 0, output_tokens: t.output_tokens || 0 } };
}

/**
 * @param {{apiKey: string, model?: string, fetch?: typeof fetch, timeoutMs?: number}} opts
 */
export function createCohereProvider(opts) {
  const model = opts.model || DEFAULT_MODELS.cohere;
  const doFetch = opts.fetch || ((...a) => fetch(...a));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // JSON mode with the schema in the prompt first (schema-constrained mode produced runaway output in the live
  // check); then strict schema mode, then plain text. A rejected request (400) or a runaway answer (max_tokens)
  // moves on to the next format.
  // Live runs: with the model's default thinking and a 12k budget, JSON mode answers (~7k tokens incl. thinking);
  // with thinking disabled it ran away. Thinking-disabled and schema variants remain as fallbacks.
  const variants = [
    { name: 'json_object', format: 'object' },
    { name: 'json_object+no_thinking', format: 'object', noThink: true },
    { name: 'json_schema', format: 'schema' },
    { name: 'plain', format: null },
  ];
  return {
    name: 'cohere', role: 'llm', model,
    async discover(req) {
      return runVariants(variants, async (v) => {
        const data = await postJson(doFetch, 'https://api.cohere.com/v2/chat', { authorization: `Bearer ${opts.apiKey}` }, {
          model,
          messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user + (v.format === 'schema' ? '\n\nAnswer with the JSON object only.' : schemaNote(req)) }],
          temperature: 0.2,
          max_tokens: 12000,
          ...(v.noThink ? { thinking: { type: 'disabled' } } : {}),
          ...(v.format === 'schema' ? { response_format: { type: 'json_object', json_schema: stripKeywords(req.schema, ['maxItems', 'description']) } } : {}),
          ...(v.format === 'object' ? { response_format: { type: 'json_object' } } : {}),
        }, timeoutMs, 'cohere');
        const a = cohereAnswer(data);
        const usage = { ...a.usage, web_searches: 0 };
        if (a.finish === 'max_tokens') throw Object.assign(new ProviderError('cohere: max_tokens (runaway output)', 0), { runaway: true, usage });
        if (a.finish === 'error' || a.finish === 'timeout') return { ok: false, error: `cohere: finish_reason ${a.finish}`, stopReason: a.finish, model, usage };
        const output = parseJsonObject(a.text);
        if (!output) return { ok: false, error: 'cohere: answer is not JSON', stopReason: 'end_turn', model, usage };
        return { ok: true, output, stopReason: 'end_turn', model, usage };
      }, (e) => e instanceof ProviderError && (e.status === 400 || e.runaway === true));
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Groq Compound (OpenAI-compatible chat; the system runs its own web search). JSON is asked in the prompt.
// ---------------------------------------------------------------------------------------------------------------

/**
 * @param {{apiKey: string, model?: string, fetch?: typeof fetch, timeoutMs?: number, webSearch?: boolean}} opts
 */
export function createGroqProvider(opts) {
  const model = opts.model || DEFAULT_MODELS.groq.split(',')[0];
  const doFetch = opts.fetch || ((...a) => fetch(...a));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const search = opts.webSearch !== false;
  // GPT-OSS models carry Groq's built-in browser_search tool (not combinable with structured output, so the schema
  // goes in the prompt); Compound systems search on their own; other models answer from knowledge in JSON mode.
  const variants = /^openai\/gpt-oss/.test(model)
    // reasoning_effort low keeps browsing short (the first live run read ~600k tokens of pages at the default).
    ? [...(search ? [{ name: 'browser_search', tools: [{ type: 'browser_search' }], effort: 'low' }, { name: 'browser_search+default', tools: [{ type: 'browser_search' }] }] : []), { name: 'json_object', json: true }, { name: 'plain' }]
    : /compound/.test(model)
      ? [{ name: 'search_settings', settings: true }, { name: 'plain' }]
      : [{ name: 'json_object', json: true }, { name: 'plain' }];
  return {
    name: 'groq', role: 'llm', model,
    async discover(req) {
      return runVariants(variants, async (v) => {
        const data = await postJson(doFetch, 'https://api.groq.com/openai/v1/chat/completions', { authorization: `Bearer ${opts.apiKey}` }, {
          model,
          messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user + schemaNote(req) }],
          temperature: 0.2,
          max_tokens: 8000,
          ...(v.tools ? { tools: v.tools, tool_choice: 'auto' } : {}),
          ...(v.effort ? { reasoning_effort: v.effort } : {}),
          ...(v.json ? { response_format: { type: 'json_object' } } : {}),
          ...(v.settings && search ? { search_settings: { country: 'egypt' } } : {}),
        }, timeoutMs, 'groq');
        const a = chatAnswer(data);
        const tools = Array.isArray(a.msg.executed_tools) ? a.msg.executed_tools : [];
        const usage = { ...a.usage, web_searches: tools.filter((t) => /search|browser|visit/i.test(String(t.type || t.name || ''))).length };
        if (a.finish === 'length') return { ok: false, error: 'groq: max_tokens', stopReason: 'max_tokens', model: data.model || model, usage };
        const output = parseJsonObject(a.text);
        if (!output) return { ok: false, error: 'groq: answer is not JSON', stopReason: 'end_turn', model: data.model || model, usage };
        return { ok: true, output, stopReason: 'end_turn', model: data.model || model, usage };
      });
    },
  };
}

/** Every provider this module can build: role, secret, factory. Add a provider by adding one row. */
export const PROVIDER_REGISTRY = {
  gemini: { role: 'llm', secret: 'GEMINI_API_KEY', make: (o, env) => withModelFallback(modelList(env.GEMINI_DISCOVERY_MODEL || env.GEMINI_MODEL, DEFAULT_MODELS.gemini), (m) => createGeminiProvider({ ...o, model: m })) },
  groq: { role: 'llm', secret: 'GROQ_API_KEY', make: (o, env) => withModelFallback(modelList(env.GROQ_DISCOVERY_MODEL, DEFAULT_MODELS.groq), (m) => createGroqProvider({ ...o, model: m })) },
  cohere: { role: 'llm', secret: 'COHERE_API_KEY', make: (o, env) => withModelFallback(modelList(env.COHERE_DISCOVERY_MODEL, DEFAULT_MODELS.cohere), (m) => createCohereProvider({ ...o, model: m })) },
  tavily: { role: 'web_search', secret: 'TAVILY_API_KEY', make: (o) => createTavilyProvider({ ...o, timeoutMs: Math.min(o.timeoutMs, 25_000) }) },
  serper: { role: 'shopping', secret: 'SERPER_API_KEY', make: (o) => createSerperProvider({ ...o, timeoutMs: Math.min(o.timeoutMs, 25_000) }) },
  openai: { role: 'llm', secret: 'OPENAI_API_KEY', make: (o, env) => createOpenAiProvider({ ...o, model: env.OPENAI_DISCOVERY_MODEL }) },
  anthropic: { role: 'llm', secret: 'ANTHROPIC_API_KEY', make: (o, env) => createAnthropicProvider({ ...o, model: env.ANTHROPIC_DISCOVERY_MODEL }) },
};

/**
 * The discovery providers this environment can use, in DISCOVERY_PROVIDERS order. A provider without its secret is
 * listed in `missing` (name and secret name only, never a value) and skipped.
 * @param {Record<string, any>} env
 * @param {{fetch?: typeof fetch}} [opts]
 * @returns {{available: any[], missing: {name: string, role: string, secret: string}[], unknown: string[]}}
 */
export function providersFromEnv(env, opts = {}) {
  const order = String(env.DISCOVERY_PROVIDERS || DEFAULT_PROVIDER_MIX).split(',').map((s) => s.trim()).filter(Boolean);
  const timeoutMs = Number(env.DISCOVERY_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const webSearch = String(env.DISCOVERY_WEB_SEARCH || '1') !== '0';
  const available = [], missing = [], unknown = [];
  for (const name of order) {
    const reg = PROVIDER_REGISTRY[name];
    if (!reg) { unknown.push(name); continue; }
    const apiKey = String(env[reg.secret] || '').trim();
    if (!apiKey) { missing.push({ name, role: reg.role, secret: reg.secret }); continue; }
    const p = reg.make({ apiKey, fetch: opts.fetch, timeoutMs, webSearch }, env);
    p.role = p.role || reg.role;
    p.priceOverride = parsePriceOverride(env[`${name.toUpperCase()}_PRICE`]);
    available.push(p);
  }
  return { available, missing, unknown };
}
