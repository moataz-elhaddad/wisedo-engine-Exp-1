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
import { consolidate, sameProduct, cpuToken } from './consolidate.js';
import { buildEphemeralSnapshot } from './ephemeral-snapshot.js';
import { estimateCost, DEFAULT_TIMEOUT_MS } from './providers.js';
import { SEARCH_PRICES } from './search-providers.js';
import { parseListing, listingCandidate, listingMatches } from './listings.js';
import { familyName } from './search-plan.js';
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
  const ranked = order.map((k) => byKey.get(k)).filter(Boolean);
  for (const p of products) if (!ranked.includes(p)) ranked.push(p);
  // Engine order (fit + claimed price as a search-order hint only), nudged up for an exact MPN and for consensus,
  // and at most two candidates per product family before the others get a turn (result diversity).
  const score = (p, i) => i - (p.mpn ? 2 : 0) - ((p.provider_count || 1) > 1 ? 1 : 0);
  const sorted = ranked.filter((p) => p.signature).map((p, i) => ({ p, s: score(p, i), i })).sort((a, b) => a.s - b.s || a.i - b.i).map((x) => x.p);
  const fam = new Map();
  const first = [], rest = [];
  for (const p of sorted) {
    const f = familyName(p).toLowerCase();
    (fam.get(f) || 0) < 2 ? first.push(p) : rest.push(p);
    fam.set(f, (fam.get(f) || 0) + 1);
  }
  return [...first, ...rest].slice(0, max);
}

async function runEvidence(providers, products, opts, deadlineMs, clock, args) {
  const top = args ? evidenceTargets(products, args, opts.maxCandidates ?? 6) : products.filter((p) => p.signature).slice(0, opts.maxCandidates ?? 6);
  if (!top.length) return [];
  return Promise.all(providers.filter((p) => typeof p.evidence === 'function' && (opts.providers || ['serper', 'tavily']).includes(p.name)).map(async (p) => {
    const t0 = clock();
    let res;
    try { res = await withDeadline(p.evidence(top, { maxQueries: opts.maxQueries, maxPerCandidate: opts.maxPerCandidate }), deadlineMs, `${p.name} evidence`); } catch (e) { res = { ok: false, error: String((e && e.message) || e).slice(0, 200) }; }
    const cost = costOf(p, res && res.usage);
    return { provider: p.name, phase: 'evidence', ok: !!(res && res.ok), error: res && res.ok ? null : (res && res.error) || 'failed', latency_ms: clock() - t0, usage: (res && res.usage) || null, cost_usd: cost.usd, listings: (res && res.listings) || [], candidates_searched: top.map((c) => c.key),
      search_diagnostics: (res && res.search_diagnostics) || null, by_stage: (res && res.by_stage) || null, warnings: (res && res.warnings) || null };
  }));
}

/** Run-level search and link counters (report and UI). */
export function searchMetrics(evidenceRuns, products) {
  const st = {};
  for (const r of evidenceRuns) for (const [k, v] of Object.entries(r.by_stage || {})) st[k] = (st[k] || 0) + v;
  const sum = (k) => products.reduce((n, p) => n + ((p.link_counts && p.link_counts[k]) || 0), 0);
  return {
    searches_by_stage: st,
    exact_model_searches: (st.exact || 0) + (st.tavily_exact || 0),
    retailer_specific_searches: (st.retailer_model || 0) + (st.retailer_mpn || 0),
    family_searches: st.family || 0,
    direct_urls_found: sum('direct_urls_found'),
    direct_urls_checked: sum('direct_urls_checked'),
    direct_urls_blocked: sum('direct_urls_blocked'),
    direct_urls_page_verified: sum('direct_urls_verified'),
    candidates_with_blocked_exact_url: products.filter((p) => p.status === 'direct_url_found_blocked').length,
  };
}

/**
 * Keep discovery broad: an evidence search for one candidate often returns real Egyptian product pages for other
 * configurations (the variant actually on sale). A full configuration on an Egyptian product page with an EGP price
 * becomes a candidate of its own (unless it is already one); it still has to pass the same offer verification.
 */
export function evidenceCandidates(products, evidenceRuns, nowIso, providersAsked, max = 20) {
  const withMpn = products.filter((p) => p.mpn);
  const cands = evidenceRuns.flatMap((r) => r.listings).map((l) => {
    const pl = parseListing(l);
    const c = listingCandidate(pl, nowIso);
    if (!c) return null;
    // The listing's own part number when it is a sibling of a candidate's MPN ("mpn differs (83er00beed)"), so the
    // store's SKU becomes its own candidate instead of being folded into the LLM's.
    for (const p of withMpn) {
      const m = /mpn differs \(([a-z0-9]+)\)/.exec(listingMatches(p, pl).why || '');
      if (m) { c.mpn = m[1].toUpperCase(); break; }
    }
    return c;
  }).filter(Boolean).filter((c) => !products.some((p) => sameProduct(p, c).same));
  // Store listings of the same model as a discovered candidate come first (often the real SKU on sale when the LLM's
  // MPN exists nowhere: live, "83ER00ABED" vs the stores' 83ER00BEED with the same CPU / RAM / storage).
  const fams = new Map(products.map((p) => [familyName(p).toLowerCase(), p]));
  const rel = (c) => {
    const twin = products.find((p) => familyName(p).toLowerCase() === familyName(c).toLowerCase() && p.ram_gb === c.ram_gb && p.storage_gb === c.storage_gb && cpuToken(p.cpu) && cpuToken(p.cpu) === cpuToken(c.cpu));
    return twin ? 0 : fams.has(familyName(c).toLowerCase()) ? 1 : 2;
  };
  const merged = consolidate(cands, providersAsked).map((p, i) => ({ p, w: rel(p), i })).sort((a, b) => a.w - b.w || a.i - b.i).slice(0, max);
  return merged.map(({ p }, i) => {
    const twin = products.find((q) => familyName(q).toLowerCase() === familyName(p).toLowerCase() && q.ram_gb === p.ram_gb && q.storage_gb === p.storage_gb && cpuToken(q.cpu) && cpuToken(q.cpu) === cpuToken(p.cpu));
    return { ...p, key: `e${i + 1}`, found_via: 'evidence_search', ...(twin ? { same_specs_as: twin.key, same_specs_note: `same model and specs as ${twin.brand} ${twin.model}${twin.mpn ? ` (${twin.mpn})` : ''}; stores list ${p.mpn || 'another part number'} — kept as a separate variant` } : {}) };
  });
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
  const evidenceRuns = args.evidence && args.evidence.enabled === false ? [] : await runEvidence(args.providers, products, args.evidence || {}, Math.min(deadline, 45_000), clock, args);
  const listings = [...okRuns.flatMap((r) => r.listings), ...evidenceRuns.flatMap((r) => r.listings)];
  const fromEvidence = evidenceCandidates(products, evidenceRuns, new Date(t0).toISOString(), okRuns.map((r) => r.provider));
  products.push(...fromEvidence);
  collectOffers(products, listings);
  // Per-candidate search diagnostics (queries per stage, stores searched) from every evidence provider.
  for (const p of products) {
    const s = { queries: 0, by_stage: {}, retailers_searched: [], providers: [], resolved_at: null };
    for (const r of evidenceRuns) {
      const d = r.search_diagnostics && r.search_diagnostics[p.key];
      if (!d) continue;
      s.queries += d.queries;
      for (const [k, v] of Object.entries(d.by_stage || {})) s.by_stage[k] = (s.by_stage[k] || 0) + v;
      for (const x of d.retailers_searched || []) if (!s.retailers_searched.includes(x)) s.retailers_searched.push(x);
      s.providers.push(r.provider);
      s.resolved_at = s.resolved_at || d.resolved_at || null;
    }
    p.search = s;
  }
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
      ...searchMetrics(evidenceRuns, products),
      evidence_searches: evidenceRuns.reduce((s, r) => s + ((r.usage && r.usage.search_calls) || 0), 0),
      discovery_ms: tDiscovery - t0,
      evidence_ms: tEvidence - tDiscovery,
      verification_ms: verification.ms,
      estimated_cost_usd: Math.round(total_cost * 10000) / 10000,
    },
  };
}
