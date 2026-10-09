// Experiment B: live product-page resolution. Search like a person looking for one exact laptop in Egypt.
//
// For every shortlisted candidate, a staged plan of exact queries (searchPlan) is run through a search function
// (Serper, batched), and later stages run ONLY for candidates the earlier stages did not resolve:
//
//   1 exact          "MPN" Egypt · brand model MPN Egypt · brand model Egypt · brand model CPU RAM storage Egypt
//   2 retailer_model "brand model" site:<store>   for each priority Egyptian store
//   3 retailer_mpn   "MPN" site:<store>           for each priority Egyptian store (candidates with an MPN)
//   4 family         brand family laptop price EGP (site:... OR ...)   last resort
//
// "Resolved" = a direct product page on an Egyptian store matching the exact variant (MPN, or model + CPU + specs).
// Category pages, search pages and family-only matches do not resolve a candidate, so the search goes on.
// Nothing here verifies an offer: the URLs found are leads for offers.js (page check, EGP price, variant, stock).
import { parseListing, listingMatches } from './listings.js';
import { classifyUrl, canonicalUrl } from './url-classify.js';

/** Common Egyptian sources, searched one by one (other Egyptian stores found by search are still accepted). */
export const PRIORITY_RETAILERS = [
  { site: 'amazon.eg', name: 'Amazon Egypt' },
  { site: 'noon.com/egypt-en', name: 'Noon Egypt' },
  { site: 'btech.com', name: 'B.TECH' },
  { site: 'cairosales.com', name: 'Cairo Sales' },
  { site: 'dream2000.com', name: 'Dream 2000' },
  { site: '2b.com.eg', name: '2B' },
  { site: 'rayashop.com', name: 'Raya Shop' },
  { site: 'compumarts.com', name: 'Compumarts' },
];

export const STAGES = ['exact', 'retailer_model', 'retailer_mpn', 'family'];

// Parentheses usually hold the configuration code ("TUF Gaming A15 (FA506II)"): keep it, drop the brackets and years.
const clean = (s) => String(s || '').replace(/\(([^)]*)\)/g, ' $1 ').replace(/[“”"]/g, '').replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim();
const storage = (gb) => (gb ? (gb >= 1024 ? `${Math.round(gb / 1024)}TB` : `${gb}GB`) : '');
const cpuShort = (cpu) => {
  const m = String(cpu || '').match(/(?:i[3579]|ultra\s*[579]|ryzen\s*(?:ai\s*)?[3579])[\s-]*(?:hx\s*)?\d{3,5}[a-z]{0,3}/i);
  return m ? m[0].replace(/\s+/g, ' ').replace(/^(i[3579])\s/i, '$1-') : '';
};

/** "Lenovo IdeaPad Slim 3 15IAH8" (brand once, parentheses dropped). */
export function modelName(c) {
  const brand = clean(c.brand);
  const model = clean(c.model).replace(new RegExp(`^${brand}\\s+`, 'i'), '');
  return `${brand} ${model}`.trim();
}

/** The family without configuration codes: "TUF Gaming A15 (FA506II)" -> "Asus TUF Gaming A15". */
export function familyName(c) {
  const m = clean(c.model).split(/\s+/).filter((w) => w && !/^[A-Z]{1,3}\d{3,}[A-Z0-9-]*$/i.test(w) && !/^\d{4}$/.test(w) && !/^\d{2}[A-Z]{3}\d$/i.test(w) && !/^(?=.*\d)(?=.*[A-Z])[A-Z0-9-]{8,}$/i.test(w)).slice(0, 4).join(' ');
  return `${clean(c.brand)} ${m.replace(new RegExp(`^${clean(c.brand)}\\s+`, 'i'), '')}`.replace(/\s+/g, ' ').trim();
}

/**
 * Every query for one candidate, in fallback order. Each query: {q, stage, kind, retailer}.
 * @param {any} c candidate (brand, model, mpn, cpu, ram_gb, storage_gb, gpu)
 * @param {{retailers?: {site: string, name: string}[]}} [opts]
 */
export function searchPlan(c, opts = {}) {
  const retailers = opts.retailers || PRIORITY_RETAILERS;
  const name = modelName(c);
  const mpn = c.mpn ? clean(c.mpn) : null;
  const specs = [cpuShort(c.cpu), c.ram_gb && `${c.ram_gb}GB`, storage(c.storage_gb), /rtx|gtx|rx\s*\d/i.test(c.gpu || '') ? String(c.gpu).match(/(?:rtx|gtx|rx)\s*\d{3,4}(?:\s*ti)?/i)[0] : ''].filter(Boolean).join(' ');
  const out = [];
  const add = (q, stage, kind, retailer = null) => { if (!out.some((x) => x.q === q)) out.push({ q: q.replace(/\s+/g, ' ').trim(), stage, kind, retailer }); };
  if (mpn) add(`"${mpn}" Egypt`, 'exact', 'mpn');
  if (mpn) add(`${name} ${mpn} Egypt`, 'exact', 'model_mpn');
  add(`${name} Egypt`, 'exact', 'model');
  if (specs) add(`${name} ${specs} Egypt`, 'exact', 'model_specs');
  for (const r of retailers) add(`"${name}" site:${r.site}`, 'retailer_model', 'retailer_model', r.name);
  if (mpn) for (const r of retailers) add(`"${mpn}" site:${r.site}`, 'retailer_mpn', 'retailer_mpn', r.name);
  const fam = familyName(c);
  if (fam.split(' ').length >= 2) add(`${fam} laptop price EGP (${retailers.map((r) => `site:${r.site}`).join(' OR ')})`, 'family', 'family');
  return out;
}

/** Does this listing resolve the candidate (an Egyptian direct product page of the exact variant)? */
export function resolves(cand, listing) {
  const cls = classifyUrl(listing.url);
  if (cls.type !== 'direct_product' || !cls.egypt) return false;
  const l = parseListing(listing);
  if (l.accessory) return false;
  const m = listingMatches(cand, l);
  return m.match && (m.strength === 'mpn' || m.strength === 'model+specs');
}

/**
 * Run the staged plan for the shortlisted candidates.
 * @param {any[]} cands shortlisted candidates, most promising first
 * @param {(queries: string[]) => Promise<any[][]>} searchBatch one listing array per query, same order
 * @param {{maxQueries?: number, maxPerCandidate?: number, retailers?: any[]}} [opts]
 * @returns {Promise<{listings: any[], diagnostics: Record<string, any>, queries: number, by_stage: Record<string, number>, errors: string[]}>}
 */
export async function resolveCandidates(cands, searchBatch, opts = {}) {
  const maxQueries = opts.maxQueries ?? 60;
  const maxPer = opts.maxPerCandidate ?? 20;
  const plans = new Map(cands.map((c) => [c.key, searchPlan(c, opts)]));
  const diag = Object.fromEntries(cands.map((c) => [c.key, { queries: 0, by_stage: {}, retailers_searched: [], direct_urls_found: 0, exact_urls_found: 0, resolved_at: null }]));
  const listings = [];
  const errors = [];
  const byStage = {};
  let used = 0;
  const done = new Set();
  const seenUrl = new Map(cands.map((c) => [c.key, new Set()]));
  const exact = new Map(cands.map((c) => [c.key, []]));
  // Resolved = exact pages on three stores, or on two stores of which one the Worker can check. One exact page is
  // not enough (live: a single Vodafone eShop hit ended the search and the store searches never ran; it then blocked).
  const settle = (c, url, stage) => {
    if (done.has(c.key) || exact.get(c.key).some((x) => x.url === url)) return;
    const h = classifyUrl(url).host || '';
    exact.get(c.key).push({ url, host: h, checkable: !(opts.uncheckable || []).some((x) => h === x || h.endsWith('.' + x)) });
    const stores = new Set(exact.get(c.key).map((x) => x.host));
    diag[c.key].exact_urls_found = exact.get(c.key).length;
    diag[c.key].exact_stores = [...stores];
    if (stores.size >= 3 || (stores.size >= 2 && exact.get(c.key).some((x) => x.checkable))) { done.add(c.key); diag[c.key].resolved_at = stage; }
  };
  for (const stage of STAGES) {
    // Round-robin across the still-unresolved candidates so a few candidates cannot take the whole budget.
    const queues = cands.filter((c) => !done.has(c.key)).map((c) => ({ c, qs: plans.get(c.key).filter((x) => x.stage === stage) }));
    const jobs = [];
    for (let i = 0; queues.some((x) => x.qs[i]); i++) {
      for (const { c, qs } of queues) {
        if (!qs[i] || used + jobs.length >= maxQueries || diag[c.key].queries + jobs.filter((j) => j.c === c).length >= maxPer) continue;
        jobs.push({ c, ...qs[i] });
      }
    }
    if (!jobs.length) continue;
    used += jobs.length;
    let results;
    try { results = await searchBatch(jobs.map((j) => j.q)); } catch (e) { errors.push(`${stage}: ${String((e && e.message) || e).slice(0, 160)}`); results = jobs.map(() => []); }
    jobs.forEach((j, i) => {
      const d = diag[j.c.key];
      d.queries++;
      d.by_stage[stage] = (d.by_stage[stage] || 0) + 1;
      byStage[stage] = (byStage[stage] || 0) + 1;
      if (j.retailer && !d.retailers_searched.includes(j.retailer)) d.retailers_searched.push(j.retailer);
      for (const raw of results[i] || []) {
        const l = { ...raw, url: canonicalUrl(raw.url) };
        // Family results are shared (any candidate may match them); exact results belong to their candidate.
        listings.push(stage === 'family' ? { ...l, family_search: j.q, search_kind: j.kind } : { ...l, for_key: j.c.key, search_kind: j.kind, search_query: j.q });
        const cls = classifyUrl(l.url);
        if (cls.type === 'direct_product' && cls.egypt && !seenUrl.get(j.c.key).has(l.url)) { seenUrl.get(j.c.key).add(l.url); d.direct_urls_found++; }
        if (!done.has(j.c.key) && resolves(j.c, l)) settle(j.c, l.url, stage);
      }
    });
  }
  return { listings, diagnostics: diag, queries: used, by_stage: byStage, errors };
}
