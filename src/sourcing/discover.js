// Experiment B pipeline, up to the ephemeral snapshot:
//
//   final NeedProfile
//     phase 1  every provider in parallel, each with a hard deadline:
//                LLM providers      -> candidate products (structured JSON)
//                web / shopping     -> listings for the need (pages, shop listings, EGP prices)
//     normalise LLM answers (malformed output dropped, never thrown); listings with a full configuration and an
//     EGP price also become candidates; consolidate conservatively
//     phase 2  exact model / MPN searches in Egypt for the top candidates (shopping/web providers)
//     offers.js: listings and LLM URLs classified (url-classify.js); evidence kept apart from offers; direct Egyptian
//     product pages checked; VERIFIED offers only (direct URL + EGP price + exact variant + Egyptian retailer)
//     -> in-memory CatalogSnapshot of verified offers only; everything else is reported as discovered_unverified
//
// One failed provider never fails the request; zero usable providers returns ok:false with every reason.
import { buildDiscoveryRequest } from './discovery-prompt.js';
import { normalizeProviderOutput } from './normalize.js';
import { consolidate, sameProduct } from './consolidate.js';
import { buildEphemeralSnapshot } from './ephemeral-snapshot.js';
import { estimateCost, DEFAULT_TIMEOUT_MS } from './providers.js';
import { SEARCH_PRICES } from './search-providers.js';
import { parseListing, listingCandidate } from './listings.js';
import { collectOffers, verifyOffers, candidateReport, exclusionCounts } from './offers.js';
import { match } from '../layer2/index.js';

const withDeadline = (promise, ms, label) => {
  let timer;
  const t = new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, error: `${label}: deadline ${ms} ms exceeded`, attempts: [] }), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
};

function costOf(provider, usage, model) {
  if (provider.role === 'llm') return estimateCost(model || provider.model, usage, provider.priceOverride);
  const p = provider.priceOverride || SEARCH_PRICES[provider.name];
  if (!p || !usage) return { usd: null, basis: 'no price' };
  return { usd: Math.round((usage.credits || usage.search_calls || 0) * (p.per_call ?? p.per_search ?? 0) * 10000) / 10000, basis: p.basis };
}

/**
 * Call one provider (phase 1) and normalise its answer. Never throws.
 * LLM providers yield candidates; web/shopping providers yield listings (and candidates for full listings).
 */
export async function runProvider(provider, request, deadlineMs, clock = Date.now) {
  const t0 = clock();
  const nowIso = new Date(t0).toISOString();
  let res;
  try {
    res = await withDeadline(Promise.resolve().then(() => provider.discover(request)), deadlineMs, provider.name);
  } catch (e) {
    res = { ok: false, error: `${provider.name}: ${String((e && e.message) || e).slice(0, 200)}` };
  }
  const latency_ms = clock() - t0;
  const usage = res && res.usage ? res.usage : null;
  const cost = costOf(provider, usage, res && res.model);
  const base = { provider: provider.name, role: provider.role || 'llm', model: (res && res.model) || provider.model, latency_ms, usage, cost_usd: cost.usd, cost_basis: cost.basis, variant: res && res.variant, attempts: (res && res.attempts) || [], ...(res && res.model_attempts ? { model_attempts: res.model_attempts } : {}), ...(res && res.warnings ? { warnings: res.warnings } : {}) };
  if (!res || !res.ok) return { ...base, ok: false, error: (res && res.error) || 'no result', candidates: [], listings: [], rejected: [] };
  if (Array.isArray(res.listings)) {
    const listings = res.listings.filter((l) => l && l.url);
    const candidates = listings.map((l) => listingCandidate(parseListing(l), nowIso)).filter(Boolean);
    return { ...base, ok: listings.length > 0, ...(listings.length ? {} : { error: `${provider.name}: no results` }), candidates, listings, rejected: [] };
  }
  const norm = normalizeProviderOutput(res.output, provider.name, nowIso);
  if (norm.error) return { ...base, ok: false, error: `${provider.name}: ${norm.error}`, candidates: [], listings: [], rejected: norm.rejected };
  return { ...base, ok: norm.candidates.length > 0, ...(norm.candidates.length ? {} : { error: `${provider.name}: no valid candidates` }), candidates: norm.candidates, listings: [], rejected: norm.rejected, raw_output: res.output };
}

/** Phase 2: evidence searches for the top candidates, on every provider that offers evidence(). */
/**
 * Which candidates deserve the (limited) evidence searches: the ones the unchanged Recommendation Engine would rank
 * highest on a provisional snapshot (read-only use of match(); the final ranking is computed again afterwards, on the
 * evidence-enriched snapshot). Falls back to consensus order when the engine ranks nothing.
 */
export function evidenceTargets(products, args, max) {
  const order = [];
  try {
    const prov = buildEphemeralSnapshot(products, { configs: args.configs, category: args.config.id, now: args.now, mode: 'provisional' });
    if (prov.snapshot.products.length) {
      const r = match(args.profile, prov.snapshot, args.now, 'rank', { maxList: Math.max(max, 10) });
      for (const id of [...r.picks.map((x) => x.product.id), ...r.others.map((x) => x.product.id)]) {
        const key = prov.index[id] && prov.index[id].key;
        if (key && !order.includes(key)) order.push(key);
      }
    }
  } catch { /* fall back to consensus order */ }
  const byKey = new Map(products.map((p) => [p.key, p]));
  const chosen = order.map((k) => byKey.get(k)).filter(Boolean);
  for (const p of products) if (!chosen.includes(p)) chosen.push(p);
  return chosen.filter((p) => p.signature).slice(0, max);
}

async function runEvidence(providers, products, opts, deadlineMs, clock, args) {
  const top = args ? evidenceTargets(products, args, opts.maxCandidates ?? 6) : products.filter((p) => p.signature).slice(0, opts.maxCandidates ?? 6);
  if (!top.length) return [];
  return Promise.all(providers.filter((p) => typeof p.evidence === 'function' && (opts.providers || ['serper', 'tavily']).includes(p.name)).map(async (p) => {
    const t0 = clock();
    let res;
    try { res = await withDeadline(p.evidence(top), deadlineMs, `${p.name} evidence`); } catch (e) { res = { ok: false, error: String((e && e.message) || e).slice(0, 200) }; }
    const cost = costOf(p, res && res.usage);
    return { provider: p.name, phase: 'evidence', ok: !!(res && res.ok), error: res && res.ok ? null : (res && res.error) || 'failed', latency_ms: clock() - t0, usage: (res && res.usage) || null, cost_usd: cost.usd, listings: (res && res.listings) || [], candidates_searched: top.map((c) => c.key) };
  }));
}

/**
 * Keep discovery broad: an evidence search for one candidate often returns real Egyptian product pages for other
 * configurations (the variant actually on sale). A full configuration on an Egyptian product page with an EGP price
 * becomes a candidate of its own (unless it is already one); it still has to pass the same offer verification.
 */
export function evidenceCandidates(products, evidenceRuns, nowIso, providersAsked, max = 12) {
  const cands = evidenceRuns.flatMap((r) => r.listings).map((l) => listingCandidate(parseListing(l), nowIso)).filter(Boolean)
    .filter((c) => !products.some((p) => sameProduct(p, c).same));
  return consolidate(cands, providersAsked).slice(0, max).map((p, i) => ({ ...p, key: `e${i + 1}`, found_via: 'evidence_search' }));
}

/**
 * @param {{profile: any, config: any, configs: Record<string, any>, now: any, providers: any[], missing?: any[],
 *          fetch?: typeof fetch, verify?: {enabled?: boolean, maxUrls?: number, timeoutMs?: number},
 *          evidence?: {enabled?: boolean, maxCandidates?: number, providers?: string[]},
 *          deadlineMs?: number, requestId?: string, clock?: () => number}} args
 */
export async function discoverProducts(args) {
  const clock = args.clock || Date.now;
  const t0 = clock();
  const request = buildDiscoveryRequest(args.profile, args.config);
  const deadline = args.deadlineMs ?? DEFAULT_TIMEOUT_MS + 15_000;
  const runs = await Promise.all(args.providers.map((p) => runProvider(p, request, deadline, clock)));
  const okRuns = runs.filter((r) => r.ok);
  const tDiscovery = clock();
  const allCandidates = okRuns.flatMap((r) => r.candidates);
  const products = consolidate(allCandidates, okRuns.map((r) => r.provider));
  const evidenceRuns = args.evidence && args.evidence.enabled === false ? [] : await runEvidence(args.providers, products, args.evidence || {}, Math.min(deadline, 30_000), clock, args);
  const listings = [...okRuns.flatMap((r) => r.listings), ...evidenceRuns.flatMap((r) => r.listings)];
  const fromEvidence = evidenceCandidates(products, evidenceRuns, new Date(t0).toISOString(), okRuns.map((r) => r.provider));
  products.push(...fromEvidence);
  collectOffers(products, listings);
  const tEvidence = clock();
  const budget = (args.profile.derived && args.profile.derived.maxPrice) || (args.profile.money && args.profile.money.budget) || null;
  const verification = await verifyOffers(products, { fetch: args.fetch, budget, ...(args.verify || {}) });
  const built = buildEphemeralSnapshot(products, { configs: args.configs, category: args.config.id, now: args.now, requestId: args.requestId });
  const costs = [...runs, ...evidenceRuns].map((r) => (typeof r.cost_usd === 'number' ? r.cost_usd : 0));
  const total_cost = costs.reduce((a, b) => a + b, 0);
  return {
    ok: okRuns.length > 0,
    error: okRuns.length ? null : 'no provider returned usable results',
    request: { version: request.version, need: request.user, queries: request.queries },
    providers: runs.map(({ candidates, listings: ls, raw_output, ...r }) => ({ ...r, candidate_count: candidates.length, listing_count: ls.length })),
    evidence_runs: evidenceRuns.map(({ listings: ls, ...r }) => ({ ...r, listing_count: ls.length })),
    providers_missing: args.missing || [],
    raw: runs.map((r) => ({ provider: r.provider, role: r.role, ok: r.ok, candidates: r.candidates, listings: r.listings.slice(0, 25), raw_output: r.raw_output ?? null })),
    raw_candidates: allCandidates,
    consolidated: products,
    snapshot: built.snapshot,
    index: built.index,
    unrankable: built.unrankable,
    candidates_report: products.map((p) => candidateReport(p, Object.keys(built.index).find((id) => built.index[id].key === p.key))),
    metrics: {
      providers_called: runs.length,
      providers_ok: okRuns.length,
      raw_candidates: allCandidates.length,
      listings: listings.length,
      consolidated: products.length,
      rankable: built.snapshot.products.length,
      verified_products: products.filter((p) => p.status === 'verified').length,
      verified_offers: products.reduce((n, p) => n + (p.verified_offers || []).length, 0),
      excluded_by_reason: exclusionCounts(products),
      urls_checked: verification.checked,
      evidence_candidates: Math.max(0, ...evidenceRuns.map((r) => r.candidates_searched.length)),
      evidence_listing_candidates: fromEvidence.length,
      evidence_searches: evidenceRuns.reduce((s, r) => s + ((r.usage && r.usage.search_calls) || 0), 0),
      discovery_ms: tDiscovery - t0,
      evidence_ms: tEvidence - tDiscovery,
      verification_ms: verification.ms,
      estimated_cost_usd: Math.round(total_cost * 10000) / 10000,
    },
  };
}
