// Wisedo engine demo: Cloudflare Worker.
//
// Serves the try-out page and the SKU page (static assets) and a JSON API over one tenant's own catalog in D1,
// B2B style: the tenant manages its SKUs, and the engine (Layer 1 + Layer 2) recommends from them.
//
// Public (no token):  GET /api/health, /api/categories, /api/snapshot, /api/skus, /api/skus/:id, /api/retailers,
//                     /api/plans, /api/export.csv; POST /api/session, /api/parse
// Admin (token):      POST/PUT/DELETE /api/skus[/:id], /api/offers[/:id]; POST /api/import, /api/admin/reset
// The admin token is the WISEDO_ADMIN_TOKEN secret, sent as `Authorization: Bearer <token>` or `X-Admin-Token`.
import { step } from '../src/layer1/session.js';
import { ENGINE_VERSION } from '../src/layer2/constants.js';
import { CONFIGS } from './bundle.js';
import * as store from './store.js';
import { exportCsv, importCsv, slug } from './csv.js';
import { llmFor, llmProviders, allowLlmCall, checkProviders } from './llm.js';
import { buildExtractionRequest } from '../src/layer1/u2-extract.js';
import { buildCategoryRequest } from '../src/layer1/u1-category.js';
import { MAX_TEXT_LENGTH } from '../src/layer1/session.js';
import { expbRoute } from './expb.js';

const DEFAULT_TENANT = 'demo-b2b';
const MAX_BODY = 2_000_000;

class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, x-admin-token',
};

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS } });

function tokenOk(env, request) {
  const want = String(env.WISEDO_ADMIN_TOKEN || '').trim();
  if (want.length < 24) return false; // writes stay off until a real token is set
  const auth = request.headers.get('authorization') || '';
  const got = (auth.startsWith('Bearer ') ? auth.slice(7) : request.headers.get('x-admin-token') || '').trim();
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

function requireAdmin(env, request) {
  if (!tokenOk(env, request)) throw new HttpError(401, 'admin token required');
}

async function readJson(request) {
  const text = await readText(request);
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'body must be JSON'); }
}

async function readText(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) throw new HttpError(413, 'body too large');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, 'body too large');
  return text;
}

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

function categoryOrThrow(id) {
  if (!CONFIGS[id]) throw new HttpError(400, `unknown category "${id}"`, { categories: Object.keys(CONFIGS) });
  return CONFIGS[id];
}

/** Category list with the attribute definitions the SKU page needs to build its form. */
function categories() {
  return Object.values(CONFIGS).map((c) => ({
    id: c.id,
    label: c.label,
    attributes: c.attributes.map((a) => ({ id: a.id, label: a.label, type: a.type, unit: a.unit || null, basis: a.basis || null, values: a.values || null })),
    zones: c.zones ? c.zones.ids : [],
  }));
}

// ---------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------

async function upsertProduct(env, tenant, body, id, isCreate) {
  if (!isObj(body)) throw new HttpError(400, 'product must be a JSON object');
  const prev = id ? await store.getProduct(env, tenant, id) : null;
  if (!isCreate && !prev) throw new HttpError(404, `product ${id} not found`);
  const category = (prev && prev.category) || body.category;
  categoryOrThrow(category);
  const pid = id || body.id || slug(`${category}-${body.brand || ''}-${body.name || ''}`);
  if (isCreate && (await store.getProduct(env, tenant, pid))) throw new HttpError(409, `product ${pid} already exists`);
  const now = await store.dataNow(env, tenant);
  const p = {
    ...(prev || { aliases: [], popular: false, attrs: {} }),
    ...body,
    id: pid, tenant_id: tenant, category,
    source: body.source || (prev ? prev.source : 'manual'),
    checked_at: now,
  };
  if (isObj(body.attrs)) p.attrs = Object.fromEntries(Object.entries(body.attrs).filter(([, v]) => v !== null && v !== ''));
  for (const k of ['offer_count', 'min_price_egp', 'in_stock_offers']) delete p[k];
  const errors = store.checkProduct(p);
  if (errors.length) throw new HttpError(422, 'invalid product', errors);
  await store.writeRows(env, tenant, { products: [p] });
  return p;
}

async function upsertOffer(env, tenant, body, id, isCreate) {
  if (!isObj(body)) throw new HttpError(400, 'offer must be a JSON object');
  const prev = id ? await store.getOffer(env, tenant, id) : null;
  if (!isCreate && !prev) throw new HttpError(404, `offer ${id} not found`);
  const productId = (prev && prev.product_id) || body.product_id;
  const retailerId = body.retailer_id || (prev && prev.retailer_id);
  const oid = id || body.id || `o-${productId}-${retailerId}`;
  if (isCreate && (await store.getOffer(env, tenant, oid))) throw new HttpError(409, `offer ${oid} already exists`);
  const now = await store.dataNow(env, tenant);
  const zones = store.ZONE_IDS;
  const o = {
    ...(prev || { in_stock: true, official: true, extras: [], delivery: Object.fromEntries(zones.map((z) => [z, { fee: 0, days: 3 }])) }),
    ...body,
    id: oid, tenant_id: tenant, product_id: productId, retailer_id: retailerId,
    source: body.source || (prev ? prev.source : 'manual'),
    checked_at: now,
  };
  if (body.extras !== undefined) o.extras_checked_at = now;
  const errors = store.checkOffer(o, await store.idSets(env, tenant));
  if (errors.length) throw new HttpError(422, 'invalid offer', errors);
  await store.writeRows(env, tenant, { offers: [o] });
  return o;
}

async function importHandler(env, tenant, request, url) {
  const config = categoryOrThrow(url.searchParams.get('category'));
  const dry = url.searchParams.get('dry_run') === '1';
  const text = await readText(request);
  const snap = await store.loadSnapshot(env, tenant);
  const existingProducts = new Map(snap.products.map((p) => [p.id, p]));
  const existingOffers = new Map(snap.offers.map((o) => [o.id, o]));
  const res = importCsv(text, { config, tenant, now: snap.now, existingProducts, existingOffers });
  const errors = [...res.errors];
  if (!errors.length) {
    for (const p of res.products) errors.push(...store.checkProduct(p));
    const productIds = new Set([...existingProducts.keys(), ...res.products.map((p) => p.id)]);
    const ids = { productIds, retailerIds: new Set(snap.retailers.map((r) => r.id)), planIds: new Set(snap.plans.map((p) => p.id)) };
    for (const o of res.offers) errors.push(...store.checkOffer(o, ids));
  }
  const summary = {
    rows: res.rows,
    products: { created: res.products.filter((p) => !existingProducts.has(p.id)).length, updated: res.products.filter((p) => existingProducts.has(p.id)).length },
    offers: { created: res.offers.filter((o) => !existingOffers.has(o.id)).length, updated: res.offers.filter((o) => existingOffers.has(o.id)).length },
  };
  if (errors.length) return json({ ok: false, applied: false, errors: errors.slice(0, 200), error_count: errors.length, ...summary }, 422);
  if (!dry) await store.writeRows(env, tenant, { products: res.products, offers: res.offers });
  return json({ ok: true, applied: !dry, ...summary });
}

// The free LLM chain (Gemini, then Workers AI), limited per client IP. Null when no provider is configured.
// When it is null or fails, Layer 1 reads free text with its keyword rules.
function llmForRequest(env, request) {
  const chain = llmFor(env);
  if (!chain) return null;
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  return async (req) => {
    if (!allowLlmCall(ip, Number(env.LLM_RATE_PER_MIN) || 20)) throw new Error('rate_limited');
    return chain(req);
  };
}
const LLM_TIMEOUT_MS = 13_000; // the whole chain: two providers at up to 6 s each

async function sessionHandler(env, tenant, request) {
  const body = await readJson(request);
  if (!isObj(body) || !isObj(body.event)) throw new HttpError(400, 'body must be {state, event}');
  const snapshot = await store.loadSnapshot(env, tenant);
  const llm = llmForRequest(env, request);
  const out = await step(body.state || null, body.event, { snapshot, now: snapshot.now, ...(llm ? { llm, llmTimeoutMs: LLM_TIMEOUT_MS } : {}) });
  return json({ ...out, snapshot_id: snapshot.snapshot_id });
}

// The parser for a browser-run engine (the try-out page): the server builds the prompt itself from
// {kind, category, text}, so this is not an open LLM proxy. 503 when no provider answers; the page then uses the rules.
async function parseHandler(env, tenant, request) {
  const body = await readJson(request);
  if (!isObj(body) || typeof body.text !== 'string' || !body.text.trim()) throw new HttpError(400, 'body must be {kind, category, text}');
  const text = body.text.slice(0, MAX_TEXT_LENGTH);
  let req;
  if (body.kind === 'category') req = buildCategoryRequest(text);
  else if (body.kind === 'extract') {
    const config = categoryOrThrow(body.category);
    req = buildExtractionRequest(config, text, { retailers: await store.listRetailers(env, tenant) });
  } else throw new HttpError(400, 'kind must be "extract" or "category"');
  const llm = llmForRequest(env, request);
  if (!llm) return json({ ok: false, error: 'no_llm' }, 503);
  try {
    const res = await llm(req);
    return json({ ok: true, stopReason: res.stopReason, output: res.output, model: res.model });
  } catch (e) {
    const msg = e && e.message ? String(e.message) : 'error';
    return json({ ok: false, error: msg === 'rate_limited' ? 'rate_limited' : 'llm_failed', detail: msg.slice(0, 300) }, msg === 'rate_limited' ? 429 : 503);
  }
}

async function route(request, env, url) {
  const tenant = env.TENANT || DEFAULT_TENANT;
  const m = request.method;
  const path = url.pathname.replace(/\/+$/, '');
  const parts = path.split('/').filter(Boolean).slice(1); // after "api"
  const [a, b] = parts.map(decodeURIComponent);

  if (m === 'GET' && a === 'health') {
    return json({ ok: true, tenant, engine: ENGINE_VERSION, clock: env.CLOCK === 'real' ? 'real' : 'demo', data_now: await store.dataNow(env, tenant), llm: llmProviders(env).map((p) => p.name), text_rules: true, writes: String(env.WISEDO_ADMIN_TOKEN || '').trim().length >= 24, counts: await store.counts(env, tenant) });
  }
  if (m === 'GET' && a === 'categories') return json(categories());
  if (m === 'GET' && a === 'snapshot') {
    const snap = await store.loadSnapshot(env, tenant);
    if (url.searchParams.get('configs') !== '1') delete snap.configs;
    return json(snap);
  }
  if (m === 'GET' && a === 'retailers') return json(await store.listRetailers(env, tenant));
  if (m === 'GET' && a === 'plans') return json(await store.listPlans(env, tenant));
  if (m === 'POST' && a === 'session') return sessionHandler(env, tenant, request);
  if (m === 'POST' && a === 'parse') return parseHandler(env, tenant, request);
  if (m === 'GET' && a === 'export.csv') {
    const config = categoryOrThrow(url.searchParams.get('category'));
    const snap = await store.loadSnapshot(env, tenant);
    const products = snap.products.filter((p) => p.category === config.id).sort((x, y) => (x.brand + x.name).localeCompare(y.brand + y.name));
    return new Response(exportCsv(config, products, snap.offers), {
      headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="wisedo-${tenant}-${config.id}-skus.csv"`, ...CORS },
    });
  }

  if (a === 'skus') {
    if (m === 'GET' && !b) {
      const cat = url.searchParams.get('category');
      if (cat) categoryOrThrow(cat);
      return json(await store.listSkus(env, tenant, cat));
    }
    if (m === 'GET') {
      const p = await store.getProduct(env, tenant, b);
      if (!p) throw new HttpError(404, `product ${b} not found`);
      return json({ product: p, offers: await store.offersOf(env, tenant, b) });
    }
    requireAdmin(env, request);
    if (m === 'POST' && !b) return json(await upsertProduct(env, tenant, await readJson(request), null, true), 201);
    if (m === 'PUT' && b) return json(await upsertProduct(env, tenant, await readJson(request), b, false));
    if (m === 'DELETE' && b) {
      const r = await store.deleteProduct(env, tenant, b);
      if (!r.products) throw new HttpError(404, `product ${b} not found`);
      return json({ ok: true, deleted: r });
    }
  }
  if (a === 'offers') {
    requireAdmin(env, request);
    if (m === 'POST' && !b) return json(await upsertOffer(env, tenant, await readJson(request), null, true), 201);
    if (m === 'PUT' && b) return json(await upsertOffer(env, tenant, await readJson(request), b, false));
    if (m === 'DELETE' && b) {
      const r = await store.deleteOffer(env, tenant, b);
      if (!r.offers) throw new HttpError(404, `offer ${b} not found`);
      return json({ ok: true, deleted: r });
    }
  }
  if (m === 'POST' && a === 'import') { requireAdmin(env, request); return importHandler(env, tenant, request, url); }
  if (m === 'POST' && a === 'admin' && b === 'reset') { requireAdmin(env, request); return json({ ok: true, loaded: await store.resetToSample(env, tenant) }); }
  if (m === 'GET' && a === 'admin' && b === 'check') { requireAdmin(env, request); return json({ ok: true }); }
  if (m === 'GET' && a === 'admin' && b === 'llm-check') {
    requireAdmin(env, request);
    const extractReq = buildExtractionRequest(CONFIGS.laptop, 'عايز لابتوب للبرمجة في حدود 40 ألف كاش في القاهرة', { retailers: await store.listRetailers(env, tenant) });
    return json({ ok: true, category: await checkProviders(env, buildCategoryRequest('عايز لابتوب للمذاكرة')), extract: await checkProviders(env, extractReq) });
  }

  // Experiment B (multi-LLM product sourcing): worker/expb.js
  if (a === 'expb') return expbRoute(env, request, { tenant, tokenOk, readJson, json, HttpError }, b);

  throw new HttpError(404, `no route ${m} ${url.pathname}`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      return await route(request, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ ok: false, error: e.message, details: e.details }, e.status);
      console.error(e);
      return json({ ok: false, error: 'internal error' }, 500);
    }
  },
};
