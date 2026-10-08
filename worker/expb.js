// Experiment B routes (Exp-1 Worker only).
//
//   GET  /api/expb/status        which discovery providers are configured (names only) and which secrets are missing
//   POST /api/expb/run           body {profile}: the FINAL NeedProfile from the existing Layer 1 session (result screen)
//                                -> multi-LLM discovery -> consolidation -> verification -> ephemeral snapshot
//                                -> existing Recommendation Engine (match, rank) -> Top 3, plus the catalog Top 3
//                                for the same profile (comparison only)
//   GET  /api/expb/runs          recent run logs (admin)
//
// Access: /run spends API money, so it needs the admin token unless EXPB_PUBLIC = "1"; plus a per-IP limit.
// Nothing discovered is written to the catalog tables; only a run log row (metrics + Top 3) goes to expb_runs.
import { validateNeedProfile } from '../src/contracts.js';
import { providersFromEnv } from '../src/sourcing/providers.js';
import { diagnoseProviders } from '../src/sourcing/diagnose.js';
import { LLMProductDiscoverySource, ExistingCatalogProductSource, recommendWith } from '../src/sourcing/product-source.js';
import { CONFIGS } from './bundle.js';
import * as store from './store.js';
import { allowLlmCall } from './llm.js';

export const EXPB_CATEGORIES = ['laptop'];

const pickRow = (pick, index) => {
  const meta = index ? index[pick.product.id] : null;
  return {
    rank: pick.rank ?? null,
    role: pick.role,
    product: pick.product,
    score: pick.score,
    fit: pick.fit,
    affordability: pick.affordability,
    price: pick.quote && pick.quote.price,
    effCost: pick.quote && pick.quote.effCost,
    retailer: pick.quote && pick.quote.retailerName,
    url: pick.quote && pick.quote.url,
    reasons: pick.reasons,
    notListed: pick.notListed,
    warnings: pick.warnings,
    ...(meta ? { discovery: meta } : {}),
  };
};

/**
 * Top 3 = the engine's role picks, continued down the engine's own ranked list ("others") when it named fewer than
 * three roles. The order is entirely Layer 2's; this only reads rows it already produced.
 */
export function topThree(result, snapshot, index) {
  const rows = (result.picks || []).map((p) => pickRow(p, index));
  const offers = new Map((snapshot.offers || []).map((o) => [o.id, o]));
  const shops = new Map((snapshot.retailers || []).map((r) => [r.id, r]));
  for (const o of result.others || []) {
    if (rows.length >= 3) break;
    const offer = offers.get(o.offerId);
    const meta = index ? index[o.product.id] : null;
    rows.push({
      role: 'ranked', product: o.product, score: o.score, fit: o.fit, affordability: o.affordability,
      price: offer ? offer.price_egp : null, effCost: o.effCost, retailer: shops.get(o.retailerId) ? shops.get(o.retailerId).name : o.retailerId,
      url: offer ? offer.url : null, reasons: [], notListed: [], warnings: [], ...(meta ? { discovery: meta } : {}),
    });
  }
  return rows.slice(0, 3).map((r, i) => ({ ...r, rank: i + 1 }));
}

function rateKey(request) { return 'expb:' + (request.headers.get('cf-connecting-ip') || 'local'); }

/**
 * @param {any} env
 * @param {Request} request
 * @param {{tenant: string, tokenOk: (env: any, req: Request) => boolean, readJson: (req: Request) => Promise<any>, json: Function, HttpError: any}} h
 * @param {string} b  sub-route
 */
export async function expbRoute(env, request, h, b) {
  const m = request.method;
  if (m === 'GET' && b === 'status') {
    const { available, missing } = providersFromEnv(env);
    return h.json({
      ok: true, experiment: 'B', categories: EXPB_CATEGORIES,
      providers: available.map((p) => ({ name: p.name, role: p.role, model: p.model })), missing,
      experiment: env.EXPERIMENT || null,
      web_search: String(env.DISCOVERY_WEB_SEARCH || '1') !== '0',
      access: String(env.EXPB_PUBLIC || '') === '1' ? 'public' : 'admin_token',
    });
  }
  if (m === 'GET' && b === 'runs') {
    if (!h.tokenOk(env, request)) throw new h.HttpError(401, 'admin token required');
    const rows = await env.DB.prepare('SELECT * FROM expb_runs ORDER BY created_at DESC LIMIT 50').all();
    return h.json(rows.results.map((r) => ({ ...r, profile: JSON.parse(r.profile), providers: JSON.parse(r.providers), top3: JSON.parse(r.top3), catalog_top3: JSON.parse(r.catalog_top3) })));
  }
  if (m === 'GET' && b === 'diagnose') {
    if (!h.tokenOk(env, request)) throw new h.HttpError(401, 'admin token required');
    return h.json({ ok: true, providers: await diagnoseProviders(env) });
  }
  if (m === 'POST' && b === 'run') return runHandler(env, request, h);
  throw new h.HttpError(404, `no route ${m} /api/expb/${b || ''}`);
}

async function runHandler(env, request, h) {
  if (String(env.EXPB_PUBLIC || '') !== '1' && !h.tokenOk(env, request)) throw new h.HttpError(401, 'admin token required for discovery runs (they cost API money)');
  const t0 = Date.now();
  const body = await h.readJson(request);
  const profile = body && body.profile;
  if (!profile || typeof profile !== 'object') throw new h.HttpError(400, 'body must be {profile}: the NeedProfile from the session result screen');
  const config = CONFIGS[profile.category];
  if (!config || !EXPB_CATEGORIES.includes(config.id)) throw new h.HttpError(400, `Experiment B supports ${EXPB_CATEGORIES.join(', ')} only`);
  const v = validateNeedProfile(profile, config);
  if (!v.ok) throw new h.HttpError(422, 'invalid NeedProfile', v.errors.slice(0, 20));
  if (!allowLlmCall(rateKey(request), Number(env.EXPB_RATE_PER_MIN) || 4)) throw new h.HttpError(429, 'too many discovery runs; wait a minute');

  const catalog = await store.loadSnapshot(env, h.tenant);
  const now = catalog.now; // same clock as the catalog path, so the two results are comparable
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const { available, missing } = providersFromEnv(env);

  const llmSource = new LLMProductDiscoverySource({
    providers: available, missing, configs: CONFIGS, requestId,
    verify: { enabled: String(env.DISCOVERY_VERIFY || '1') !== '0', maxUrls: Number(env.DISCOVERY_VERIFY_MAX_URLS) || 12, timeoutMs: Number(env.DISCOVERY_VERIFY_TIMEOUT_MS) || 5000 },
    evidence: { enabled: String(env.DISCOVERY_EVIDENCE || '1') !== '0', maxCandidates: Number(env.DISCOVERY_EVIDENCE_MAX) || 5, providers: String(env.DISCOVERY_EVIDENCE_PROVIDERS || 'serper').split(',').map((x) => x.trim()) },
  });
  const [llm, cat] = await Promise.all([
    recommendWith(llmSource, profile, now),
    recommendWith(new ExistingCatalogProductSource(catalog), profile, now),
  ]);
  const meta = llm.meta;
  const result = llm.result;
  const top3 = topThree(result, llm.snapshot, meta.index);
  const catalogTop3 = topThree(cat.result, catalog, null);
  const total_ms = Date.now() - t0;
  const status = !meta.ok ? 'no_providers' : result.status;
  const out = {
    ok: meta.ok,
    request_id: requestId,
    status,
    error: meta.error,
    need: meta.request.need,
    providers: meta.providers,
    providers_missing: missing,
    evidence_runs: meta.evidence_runs,
    raw: meta.raw,
    queries: meta.request.queries,
    consolidated: meta.consolidated.map((c) => ({
      key: c.key, brand: c.brand, model: c.model, mpn: c.mpn, cpu: c.cpu, ram_gb: c.ram_gb, storage_gb: c.storage_gb, gpu: c.gpu, display: c.display,
      price_egp: c.price_egp, price_range: c.price_range, providers: c.providers, provider_count: c.provider_count, provider_consensus_score: c.provider_consensus_score,
      verification_status: c.verification_status, evidence_confidence: c.evidence_confidence, verification: c.verification,
      offers: c.offers, evidence_urls: c.evidence_urls, evidence_providers: c.evidence_providers, listing_evidence: c.listing_evidence, found_at: c.found_at, possible_duplicates: c.possible_duplicates, merged_because: c.merged_because, fit_reasons: c.fit_reasons,
      product_id: Object.keys(meta.index).find((id) => meta.index[id].key === c.key) || null,
    })),
    unrankable: meta.unrankable,
    top3,
    result: { status: result.status, others: result.others, warnings: result.warnings, gaveUp: result.gaveUp, nothingFits: result.nothingFits, counts: result.counts, assumptions: result.assumptions, trace: result.trace },
    catalog: { snapshot_id: catalog.snapshot_id, status: cat.result.status, top3: catalogTop3, note: 'Same NeedProfile, same engine, synthetic demo catalog (comparison only).' },
    notes: [
      'Provider consensus, evidence confidence and verification are metadata; the ranking is the unchanged Recommendation Engine (customer fit, price fit).',
      'LLM offers assume nationwide delivery (fee 0, 3 days) and carry no installment plans; card/finance buyers therefore get no LLM-sourced plan quotes.',
      'Nothing discovered here was saved to any catalog.',
    ],
    metrics: { ...meta.metrics, total_ms, providers_missing: missing.map((x) => x.name) },
  };
  console.log(JSON.stringify({ expb_run: requestId, status, metrics: out.metrics, providers: meta.providers.map((p) => ({ provider: p.provider, ok: p.ok, ms: p.latency_ms, n: p.candidate_count, usage: p.usage, cost_usd: p.cost_usd, error: p.error })) }));
  try {
    await env.DB.prepare('INSERT INTO expb_runs (id, created_at, category, status, providers_ok, providers_called, consolidated, total_ms, cost_usd, profile, providers, top3, catalog_top3) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(requestId, new Date().toISOString(), config.id, status, meta.metrics.providers_ok, meta.metrics.providers_called, meta.metrics.consolidated, total_ms, meta.metrics.estimated_cost_usd,
        JSON.stringify(profile), JSON.stringify(meta.providers.map(({ attempts, ...p }) => p)), JSON.stringify(top3.map((p) => ({ product: p.product, score: p.score, price: p.price, providers: p.discovery && p.discovery.providers }))), JSON.stringify(catalogTop3.map((p) => ({ product: p.product, score: p.score, price: p.price }))))
      .run();
  } catch (e) {
    out.metrics.log_error = String((e && e.message) || e).slice(0, 120); // the run log is best effort
  }
  return h.json(out, meta.ok ? 200 : 502);
}

