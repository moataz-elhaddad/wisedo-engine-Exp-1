// Experiment B: web-search and shopping-search providers. Same module contract as the LLM adapters
// (providers.js): {name, role, model, discover(request, ctx)}, plus evidence(candidates, ctx) for phase 2.
//
//   tavily  role web_search  "what current pages support these products?"   POST api.tavily.com/search
//   serper  role shopping    "what listings, merchants and EGP prices exist?" POST google.serper.dev/shopping, /search
//
// They return listings ({provider, kind, title, url, snippet, price_text, source}); listings.js turns them into
// facts. They never invent anything: a listing is exactly what the search API returned.
import { postJson, ProviderError } from './http.js';
import { EGYPT_HOSTS } from './listings.js';
import { resolveCandidates, familyName, modelName, PRIORITY_RETAILERS } from './search-plan.js';

export const SEARCH_PRICES = {
  tavily: { per_call: 0.008, basis: 'Tavily pay-as-you-go $0.008/credit; free plan 1,000 credits/month' },
  serper: { per_call: 0.001, basis: 'Serper ~$1 per 1,000 queries; 2,500 free queries at signup' },
};

/** Egyptian storefronts searched for exact products (Google site: operators; noon only on its Egypt path). */
export const EGYPT_SITE_FILTERS = ['btech.com', '2b.com.eg', 'amazon.eg', 'noon.com/egypt-en', 'compumarts.com', 'rayashop.com', 'cairosales.com', 'dream2000.com', 'jumia.com.eg'];
/** Hosts for Tavily's include_domains (no paths). */
export const EGYPT_DOMAINS = ['btech.com', '2b.com.eg', 'amazon.eg', 'noon.com', 'compumarts.com', 'rayashop.com', 'cairosales.com', 'dream2000.com', 'jumia.com.eg', 'dubaiphone.net', 'elbadrgroupeg.store', 'sigma-computer.com'];

/** Short spec string for a candidate query: "Lenovo IdeaPad Slim 3 15IAH8 i5-12450H 16GB 512GB". */
export function candidateQuery(c) {
  const cpu = c.cpu ? String(c.cpu).replace(/intel|amd|core|®|™|processor/gi, '').replace(/\s+/g, ' ').trim() : '';
  return [c.brand, c.model, c.mpn, cpu, c.ram_gb && `${c.ram_gb}GB`, c.storage_gb && (c.storage_gb >= 1024 ? `${c.storage_gb / 1024}TB` : `${c.storage_gb}GB`)].filter(Boolean).join(' ');
}

/**
 * Exact-product queries in Egypt for one candidate: brand + model + MPN, restricted to Egyptian storefronts, plus an
 * "Egypt EGP price" query. The exact model / MPN search is the main verification path (offers.js).
 */
export { familyName, modelName };

export function exactQueries(c) {
  const name = [c.brand, c.model].filter(Boolean).join(' ');
  const id = c.mpn ? `"${c.mpn}"` : [c.ram_gb && `${c.ram_gb}GB`, c.storage_gb && (c.storage_gb >= 1024 ? `${c.storage_gb / 1024}TB` : `${c.storage_gb}GB`)].filter(Boolean).join(' ');
  return {
    sites: `${name} ${id} (${EGYPT_SITE_FILTERS.map((x) => `site:${x}`).join(' OR ')})`.replace(/\s+/g, ' ').trim(),
    price: `${name} ${c.mpn || ''} Egypt price EGP`.replace(/\s+/g, ' ').trim(),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Tavily (web search)
// ---------------------------------------------------------------------------------------------------------------

/** @param {{apiKey: string, fetch?: typeof fetch, timeoutMs?: number, depth?: 'basic'|'advanced', maxResults?: number}} opts */
export function createTavilyProvider(opts) {
  const doFetch = opts.fetch || ((...a) => fetch(...a));
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const depth = opts.depth || 'basic';
  const call = async (query, extra = {}) => {
    const data = await postJson(doFetch, 'https://api.tavily.com/search', { authorization: `Bearer ${opts.apiKey}` }, {
      query, search_depth: depth, max_results: opts.maxResults || 10, topic: 'general', country: 'egypt', include_answer: false, ...extra,
    }, timeoutMs, 'tavily');
    const results = Array.isArray(data.results) ? data.results : [];
    return results.map((r) => ({ provider: 'tavily', kind: 'web', title: String(r.title || ''), url: String(r.url || ''), snippet: String(r.content || '').slice(0, 600), score: r.score ?? null }));
  };
  const credits = depth === 'advanced' ? 2 : 1;
  return {
    name: 'tavily', role: 'web_search', model: `tavily-search:${depth}`,
    async discover(request) {
      const listings = await call(request.queries.web);
      return { ok: true, listings, usage: { search_calls: 1, credits }, model: `tavily-search:${depth}` };
    },
    async evidence(allCands) {
      // Tavily credits cost ~8x Serper's: only the first candidates (engine order) get a Tavily search, an exact
      // model (+ MPN) query restricted to Egyptian store domains.
      const cands = allCands.slice(0, opts.maxEvidence ?? 3);
      const all = (await Promise.all(cands.map(async (c) => (await call(`${modelName(c)} ${c.mpn || ''} price Egypt`.replace(/\s+/g, ' ').trim(), { max_results: 8, include_domains: EGYPT_DOMAINS }))
        .map((l) => ({ ...l, for_key: c.key, search_kind: 'tavily_exact' }))))).flat();
      const search_diagnostics = Object.fromEntries(cands.map((c) => [c.key, { queries: 1, by_stage: { tavily_exact: 1 }, retailers_searched: [], direct_urls_found: 0 }]));
      return { ok: true, listings: all, search_diagnostics, by_stage: { tavily_exact: cands.length }, usage: { search_calls: cands.length, credits: cands.length * credits } };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Serper (Google Shopping + Google web results restricted to Egyptian retailers)
// ---------------------------------------------------------------------------------------------------------------

/** @param {{apiKey: string, fetch?: typeof fetch, timeoutMs?: number}} opts */
export function createSerperProvider(opts) {
  const doFetch = opts.fetch || ((...a) => fetch(...a));
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const headers = { 'x-api-key': opts.apiKey };
  const shopping = async (q) => {
    const d = await postJson(doFetch, 'https://google.serper.dev/shopping', headers, { q, gl: 'eg', hl: 'en', num: 20 }, timeoutMs, 'serper');
    return (Array.isArray(d.shopping) ? d.shopping : []).map((r) => ({ provider: 'serper', kind: 'shopping', title: String(r.title || ''), url: String(r.link || ''), price_text: r.price != null ? String(r.price) : '', source: r.source || null, snippet: [r.delivery, r.rating && `rating ${r.rating}`].filter(Boolean).join(' · ') }));
  };
  const search = async (q, num = 10) => {
    const d = await postJson(doFetch, 'https://google.serper.dev/search', headers, { q, gl: 'eg', hl: 'en', num }, timeoutMs, 'serper');
    return (Array.isArray(d.organic) ? d.organic : []).map((r) => ({
      provider: 'serper', kind: 'web', title: String(r.title || ''), url: String(r.link || ''),
      snippet: [r.snippet, r.price != null ? `price ${r.currency || ''} ${r.price}` : '', r.attributes ? Object.entries(r.attributes).map(([k, v]) => `${k}: ${v}`).join(' ') : ''].filter(Boolean).join(' ').slice(0, 600),
      price_text: r.price != null ? `${r.currency || ''} ${r.price}` : '',
    }));
  };
  const organic = (d) => (Array.isArray(d && d.organic) ? d.organic : []).map((r) => ({
    provider: 'serper', kind: 'web', title: String(r.title || ''), url: String(r.link || ''),
    snippet: [r.snippet, r.price != null ? `price ${r.currency || ''} ${r.price}` : '', r.attributes ? Object.entries(r.attributes).map(([k, v]) => `${k}: ${v}`).join(' ') : ''].filter(Boolean).join(' ').slice(0, 600),
    price_text: r.price != null ? `${r.currency || ''} ${r.price}` : '',
  }));
  /**
   * Many queries in one HTTP request (Serper batch: a JSON array body, one result object per query). One request per
   * stage keeps a run under the Worker's subrequest limit; credits are still one per query.
   */
  const searchBatch = async (queries) => {
    const out = [];
    for (let i = 0; i < queries.length; i += 50) {
      const chunk = queries.slice(i, i + 50);
      let d;
      try { d = await postJson(doFetch, 'https://google.serper.dev/search', headers, chunk.map((q) => ({ q, gl: 'eg', hl: 'en', num: 10 })), timeoutMs, 'serper'); } catch (e) { d = { batch_error: e }; }
      if (Array.isArray(d)) { out.push(...chunk.map((_, k) => organic(d[k]))); continue; }
      if (chunk.length === 1 && !d.batch_error) { out.push(organic(d)); continue; }
      // Batch refused: the first 20 queries one by one (subrequest budget), the rest stay unsearched.
      if (d.batch_error && /HTTP 40[13]/.test(String(d.batch_error.message))) throw d.batch_error;
      const single = await Promise.all(chunk.map((q, k) => (k < 20 ? search(q, 10).catch(() => []) : Promise.resolve([]))));
      out.push(...single);
    }
    return out;
  };
  return {
    name: 'serper', role: 'shopping', model: 'serper:google-shopping+search',
    async discover(request) {
      const sites = EGYPT_SITE_FILTERS.map((x) => `site:${x}`).join(' OR ');
      // Google Shopping is thin for gl=eg; Egyptian retailers' own product pages (organic, site-filtered) carry the
      // real listings, so two organic queries go there (all Egyptian stores, then the two largest catalogs).
      const all = await Promise.allSettled([
        shopping(`${request.queries.shopping} Egypt`),
        search(`${request.queries.shopping} price EGP (${sites})`),
        search(`${request.queries.shopping} (site:amazon.eg OR site:noon.com/egypt-en OR site:btech.com)`),
      ]);
      if (all.every((x) => x.status === 'rejected')) throw all[0].reason;
      const listings = all.flatMap((x) => (x.status === 'fulfilled' ? x.value : []));
      const errors = all.filter((x) => x.status === 'rejected').map((x) => String(x.reason && x.reason.message).slice(0, 160));
      return { ok: true, listings, usage: { search_calls: 3, credits: 3 }, model: 'serper:google-shopping+search', ...(errors.length ? { warnings: errors } : {}) };
    },
    /**
     * Exact product-page resolution (search-plan.js): staged exact / retailer / MPN / family queries per candidate,
     * later stages only for candidates not yet resolved, at most `maxQueries` queries per run.
     */
    async evidence(cands, opts2 = {}) {
      const r = await resolveCandidates(cands, searchBatch, { maxQueries: opts2.maxQueries ?? opts.maxQueries ?? 60, maxPerCandidate: opts2.maxPerCandidate ?? opts.maxPerCandidate ?? 20, uncheckable: opts2.uncheckable || ['noon.com', 'jumia.com.eg'], retailers: PRIORITY_RETAILERS });
      if (r.queries && r.errors.length >= Object.keys(r.by_stage).length && !r.listings.length) return { ok: false, error: r.errors.join('; ') };
      return { ok: true, listings: r.listings, search_diagnostics: r.diagnostics, by_stage: r.by_stage, usage: { search_calls: r.queries, credits: r.queries }, ...(r.errors.length ? { warnings: r.errors } : {}) };
    },
  };
}

export { EGYPT_HOSTS, ProviderError };
