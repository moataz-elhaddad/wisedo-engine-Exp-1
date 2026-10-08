// Experiment B pipeline, up to the ephemeral snapshot:
//
//   final NeedProfile -> every provider in parallel (independent calls, hard per-provider deadline)
//     -> normalise each answer (malformed output dropped, never thrown) -> conservative consolidation
//     -> URL verification -> in-memory CatalogSnapshot
//
// One failed provider never fails the request; zero usable providers returns ok:false with every reason.
// Observability per provider: latency, ok/error, candidates, tokens, web searches, estimated cost.
import { buildDiscoveryRequest } from './discovery-prompt.js';
import { normalizeProviderOutput } from './normalize.js';
import { consolidate } from './consolidate.js';
import { verifyCandidates } from './verify.js';
import { buildEphemeralSnapshot } from './ephemeral-snapshot.js';
import { estimateCost, DEFAULT_TIMEOUT_MS } from './providers.js';

const withDeadline = (promise, ms, label) => {
  let timer;
  const t = new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, error: `${label}: deadline ${ms} ms exceeded`, attempts: [] }), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
};

/**
 * Call one provider and normalise its answer. Never throws.
 * @param {any} provider  adapter from providers.js
 * @param {any} request   buildDiscoveryRequest output
 * @param {number} deadlineMs
 * @param {() => number} clock
 */
export async function runProvider(provider, request, deadlineMs, clock = Date.now) {
  const t0 = clock();
  let res;
  try {
    res = await withDeadline(Promise.resolve().then(() => provider.discover(request)), deadlineMs, provider.name);
  } catch (e) {
    res = { ok: false, error: `${provider.name}: ${String((e && e.message) || e).slice(0, 200)}` };
  }
  const latency_ms = clock() - t0;
  const usage = res && res.usage ? res.usage : null;
  const cost = estimateCost(provider.model, usage, provider.priceOverride);
  const base = { provider: provider.name, model: (res && res.model) || provider.model, latency_ms, usage, cost_usd: cost.usd, cost_basis: cost.basis, variant: res && res.variant, attempts: (res && res.attempts) || [] };
  if (!res || !res.ok) return { ...base, ok: false, error: (res && res.error) || 'no result', candidates: [], rejected: [] };
  const norm = normalizeProviderOutput(res.output, provider.name);
  if (norm.error) return { ...base, ok: false, error: `${provider.name}: ${norm.error}`, candidates: [], rejected: norm.rejected };
  return { ...base, ok: norm.candidates.length > 0, ...(norm.candidates.length ? {} : { error: `${provider.name}: no valid candidates` }), candidates: norm.candidates, rejected: norm.rejected };
}

/**
 * @param {{profile: any, config: any, configs: Record<string, any>, now: any, providers: any[], missing?: any[],
 *          fetch?: typeof fetch, verify?: {enabled?: boolean, maxUrls?: number, timeoutMs?: number},
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
  const verification = await verifyCandidates(products, { fetch: args.fetch, ...(args.verify || {}) });
  const built = buildEphemeralSnapshot(products, { configs: args.configs, category: args.config.id, now: args.now, requestId: args.requestId });
  const total_cost = runs.reduce((s, r) => s + (typeof r.cost_usd === 'number' ? r.cost_usd : 0), 0);
  return {
    ok: okRuns.length > 0,
    error: okRuns.length ? null : 'no provider returned usable candidates',
    request: { version: request.version, need: request.user },
    providers: runs.map(({ candidates, ...r }) => ({ ...r, candidate_count: candidates.length })),
    providers_missing: args.missing || [],
    raw_candidates: allCandidates,
    consolidated: products,
    snapshot: built.snapshot,
    index: built.index,
    unrankable: built.unrankable,
    metrics: {
      providers_called: runs.length,
      providers_ok: okRuns.length,
      raw_candidates: allCandidates.length,
      consolidated: products.length,
      rankable: built.snapshot.products.length,
      urls_checked: verification.checked,
      discovery_ms: tDiscovery - t0,
      verification_ms: verification.ms,
      estimated_cost_usd: Math.round(total_cost * 10000) / 10000,
    },
  };
}
