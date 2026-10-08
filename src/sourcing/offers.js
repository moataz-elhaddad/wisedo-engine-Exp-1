// Experiment B: discovery candidate -> evidence -> VERIFIED OFFER.
//
// Three concepts, kept apart:
//   discovery candidate  what an LLM (or a shop listing) proposed. LLM prices, retailers, stock and warranty are
//                        CLAIMS: kept for research (llm_claims), never trusted.
//   evidence             pages that support facts about the product (manufacturer specs, articles, foreign stores,
//                        category pages, listings without a price...). Evidence never makes a product buyable.
//   verified offer       the only thing the ephemeral CatalogSnapshot may contain:
//                          - a direct product page (url-classify.js: direct_product)
//                          - on an Egyptian storefront (never UAE / Saudi / global stores)
//                          - an EGP price read from the listing or the page (never from an LLM)
//                          - the exact variant: MPN match, or model + specs agreeing (or a page check that does)
//                          - an identifiable retailer, not a classifieds or comparison site
//                          - not unreachable / not out of stock when the page could be checked
// A candidate without a verified offer is "discovered_unverified": reported with its exclusion reason, never ranked.
import { parseListing, listingMatches, MIN_LAPTOP_PRICE_EGP, MAX_LAPTOP_PRICE_EGP } from './listings.js';
import { classifyUrl } from './url-classify.js';
import { verifyUrl } from './verify.js';

/** Exclusion reasons, most informative first (the first one present becomes the candidate's exclusion_reason). */
export const EXCLUSION_PRIORITY = [
  'variant_mismatch', 'out_of_stock', 'unreachable', 'no_egyptian_price', 'implausible_price', 'weak_evidence', 'wrong_country',
  'classified_listing', 'comparison_site', 'manufacturer_evidence_only', 'article_evidence_only', 'category_or_search_page', 'no_direct_url',
];

const TYPE_REASON = {
  manufacturer_specs: 'manufacturer_evidence_only', article: 'article_evidence_only', category: 'category_or_search_page',
  search_results: 'category_or_search_page', homepage: 'category_or_search_page', classified: 'classified_listing',
  comparison: 'comparison_site', foreign_store: 'wrong_country', unknown: 'no_direct_url',
};
const STRONG = new Set(['mpn', 'model+specs']);

/**
 * Collect evidence and potential offers for every candidate (no network).
 * @param {any[]} products consolidated candidates (mutated: llm_claims, evidence_sources, _potential, rejections)
 * @param {any[]} listings raw listings from every search/shopping provider
 * @param {{allowUsed?: boolean}} [opts]
 */
export function collectOffers(products, listings, opts = {}) {
  // Accessories ("battery for TUF F15") are neither evidence nor offers.
  const parsed = listings.filter((l) => l && l.url).map((l) => ({ ...parseListing(l), cls: classifyUrl(l.url) })).filter((l) => !l.accessory);
  for (const p of products) {
    p.llm_claims = (p.offers || []).filter((o) => o.source !== 'listing').map((o) => ({
      provider: o.provider, retailer: o.retailer || null, url: o.url || null, price_egp: o.price_egp ?? null,
      url_class: o.url ? classifyUrl(o.url).type : null,
    }));
    p.llm_claimed_price = p.price_egp ?? null;
    p.llm_claimed_retailer = (p.llm_claims.find((c) => c.retailer) || {}).retailer || null;
    p.evidence_sources = [];
    p.rejections = [];
    const potential = new Map();
    const reject = (reason, url, detail) => p.rejections.push({ reason, url: url || null, ...(detail ? { detail } : {}) });

    // A candidate made from a listing owns that listing's URL, even when the search was run for another candidate.
    const ownUrls = new Set((p.offers || []).filter((o) => o.source === 'listing' && o.url).map((o) => o.url));
    for (const l of parsed) {
      const mine = l.for_key === p.key || ownUrls.has(l.url);
      if (l.for_key && !mine) continue;
      const m = listingMatches(p, l);
      if (!m.match) {
        // A conflicting variant is only meaningful on searches made for this candidate.
        if (mine && /differs/.test(m.why) && l.cls.type === 'direct_product') reject('variant_mismatch', l.url, m.why);
        continue;
      }
      p.evidence_sources.push({ provider: l.provider, url: l.url, title: l.title, type: l.cls.type, country: l.cls.country, retailer: l.cls.retailer, price: l.price, currency: l.currency, strength: m.strength });
      if (l.cls.type !== 'direct_product') { reject(TYPE_REASON[l.cls.type] || 'no_direct_url', l.url); continue; }
      if (!l.cls.egypt) { reject('wrong_country', l.url, l.cls.country || 'not an Egyptian storefront'); continue; }
      // A model-name-only hit is checked only when the listing itself states some configuration (a page check may
      // then confirm the variant); bare model mentions are evidence, not leads.
      if (!STRONG.has(m.strength) && !(l.cpu || l.ram_gb || l.storage_gb)) { reject('weak_evidence', l.url, 'listing states no configuration'); continue; }
      if (!potential.has(l.url)) {
        potential.set(l.url, { url: l.url, retailer: l.cls.retailer || l.source || l.cls.host, listing_price: l.currency === 'EGP' && l.price_from === 'field' ? l.price_egp : null, listing_currency: l.currency, strength: m.strength, provider: l.provider, via: 'listing' });
      } else if (!potential.get(l.url).listing_price && l.currency === 'EGP' && l.price_from === 'field') {
        potential.get(l.url).listing_price = l.price_egp;
      }
    }
    // An LLM-proposed URL is a lead to check, not evidence: it can become an offer only through the page itself.
    for (const c of p.llm_claims) {
      if (!c.url) continue;
      const cls = classifyUrl(c.url);
      if (cls.type !== 'direct_product') { reject(TYPE_REASON[cls.type] || 'no_direct_url', c.url, `${c.provider} claim`); continue; }
      if (!cls.egypt) { reject('wrong_country', c.url, `${c.provider} claim (${cls.country || 'not Egyptian'})`); continue; }
      if (!potential.has(c.url)) potential.set(c.url, { url: c.url, retailer: cls.retailer || cls.host, listing_price: null, strength: null, provider: c.provider, via: 'llm_url' });
    }
    p._potential = [...potential.values()];
  }
  return { parsed: parsed.length };
}

/**
 * Check the pages of potential offers (one plain GET each, never bypassing protection), then decide every offer.
 * @param {any[]} products
 * @param {{fetch?: typeof fetch, enabled?: boolean, maxUrls?: number, timeoutMs?: number}} [opts]
 */
export async function verifyOffers(products, opts = {}) {
  const maxUrls = opts.maxUrls ?? 20;
  const jobs = [];
  const seen = new Set();
  // Listing-backed leads first (they already carry a price and a variant signal), then LLM URLs.
  // Strong listing leads first (priced, then to be priced by the page), then LLM URLs, then weak listing leads.
  const rank = (o) => (o.via === 'listing' ? (STRONG.has(o.strength) ? (o.listing_price ? 0 : 1) : 3) : 2);
  const ordered = products.flatMap((p) => (p._potential || []).map((o) => ({ p, o }))).sort((a, b) => rank(a.o) - rank(b.o));
  for (const j of ordered) {
    if (opts.enabled === false || jobs.length >= maxUrls || seen.has(j.o.url + '|' + j.p.key)) continue;
    seen.add(j.o.url + '|' + j.p.key);
    jobs.push(j);
  }
  const t0 = Date.now();
  const checks = new Map();
  await Promise.all(jobs.map(async ({ p, o }) => { checks.set(o.url + '|' + p.key, await verifyUrl(o.url, p, opts)); }));
  for (const p of products) decideOffers(p, (url) => checks.get(url + '|' + p.key) || null);
  return { checked: jobs.length, ms: Date.now() - t0 };
}

/** Decide which potential offers are verified; set the candidate's status, exclusion reason and observability. */
export function decideOffers(p, checkOf) {
  p.verified_offers = [];
  p.page_checks = [];
  for (const o of p._potential || []) {
    const pc = checkOf(o.url);
    if (pc) p.page_checks.push({ url: o.url, status: pc.status, http: pc.http ?? null, title: (pc.title || '').slice(0, 120) || null, offer: pc.page_offer || null, ms: pc.ms ?? null, error: pc.error || pc.note || null });
    const reject = (reason, detail) => p.rejections.push({ reason, url: o.url, ...(detail ? { detail } : {}) });
    if (pc && pc.status === 'mismatch') { reject('variant_mismatch', 'page names another product'); continue; }
    if (pc && pc.status === 'unavailable') { reject('out_of_stock'); continue; }
    if (pc && pc.http && [404, 410].includes(pc.http)) { reject('unreachable', `HTTP ${pc.http}`); continue; }
    const pageStrong = pc && pc.status === 'verified';
    if (!STRONG.has(o.strength) && !pageStrong) { reject('weak_evidence', o.strength ? `only ${o.strength} matched` : 'page could not confirm the variant'); continue; }
    // A price read from the verified product page itself is the freshest; then the listing; never an LLM claim.
    let price = o.listing_price, priceSource = 'listing';
    // The page's own structured offer (verify.js pageOffer); a bare "price" number elsewhere in the page is not used.
    const po = pc && pc.page_offer;
    const pagePrice = po && po.price && (po.currency === 'EGP' || (!po.currency && pc.page_currency === 'EGP')) && po.price <= MAX_LAPTOP_PRICE_EGP ? po.price : null;
    if (pagePrice && (pageStrong || !(price > 0))) { price = pagePrice; priceSource = 'page'; }
    if (!(price > 0)) { reject(po && po.currency && po.currency !== 'EGP' ? 'wrong_country' : 'no_egyptian_price', po && po.currency ? `page currency ${po.currency}` : pc ? `page check: ${pc.status}${pc.http ? ' HTTP ' + pc.http : ''}` : 'page not checked'); continue; }
    if (price < MIN_LAPTOP_PRICE_EGP || price > MAX_LAPTOP_PRICE_EGP) { reject('implausible_price', `${price} EGP`); continue; }
    const floor = priceFloor(p.gpu);
    if (price < floor && priceSource !== 'page') { reject('implausible_price', `${price} EGP is below ${floor} EGP for ${p.gpu}; not confirmed by the product page`); continue; }
    p.verified_offers.push({
      retailer: o.retailer, url: o.url, price_egp: price, currency: 'EGP', price_source: priceSource,
      match_strength: pageStrong ? (o.strength === 'mpn' ? 'mpn' : 'page_verified') : o.strength,
      page_check: pc ? pc.status : 'not_checked', provider: o.provider, via: o.via,
    });
  }
  p.verified_offers.sort((a, b) => a.price_egp - b.price_egp);
  const best = p.verified_offers[0] || null;
  const reasons = new Set(p.rejections.map((r) => r.reason));
  p.status = best ? 'verified' : 'discovered_unverified';
  p.exclusion_reason = best ? null : (EXCLUSION_PRIORITY.find((r) => reasons.has(r)) || 'no_direct_url');
  p.verification_status = best ? (p.verified_offers.some((o) => o.page_check === 'verified') ? 'verified' : 'listed') : (p.evidence_sources.length ? 'evidence_only' : 'unverified');
  p.evidence_confidence = { verified: 0.9, listed: 0.8, evidence_only: 0.4, unverified: 0.2 }[p.verification_status];
  p.verified_price = best ? best.price_egp : null;
  p.verified_retailer = best ? best.retailer : null;
  p.verified_product_url = best ? best.url : null;
  p.country = best ? 'EG' : null;
  p.currency = best ? 'EGP' : null;
  const strengths = [...p.verified_offers.map((o) => o.match_strength), ...p.evidence_sources.map((e) => e.strength)];
  p.variant_match_strength = ['mpn', 'page_verified', 'model+specs', 'model'].find((s) => strengths.includes(s)) || null;
  p.evidence_providers = [...new Set(p.evidence_sources.map((e) => e.provider))];
  p.evidence_urls = [...new Set([...p.evidence_sources.map((e) => e.url), ...(p.evidence_urls || [])])].filter(Boolean);
  delete p._potential;
  return p;
}

/**
 * Sanity floor by graphics class (new laptops in Egypt, deliberately low: it only catches bait listings, instalment
 * amounts and snippet numbers, e.g. a live "39,900 EGP" RTX 5070 laptop). A price read from the product page itself
 * is not second-guessed.
 */
export function priceFloor(gpu) {
  const g = String(gpu || '').toLowerCase();
  if (/rtx\s*[2-5]0[789]0/.test(g)) return 55000;
  if (/rtx\s*[2-5]060/.test(g)) return 35000;
  return MIN_LAPTOP_PRICE_EGP;
}

/** The per-candidate observability row (API response and run log). */
export function candidateReport(p, productId) {
  return {
    key: p.key, product_id: productId || null, brand: p.brand, model: p.model, mpn: p.mpn,
    specs: { cpu: p.cpu, ram_gb: p.ram_gb, storage_gb: p.storage_gb, gpu: p.gpu, display: p.display },
    discovered_by: p.providers, provider_count: p.provider_count, provider_consensus_score: p.provider_consensus_score,
    llm_claimed_price: p.llm_claimed_price, llm_claimed_retailer: p.llm_claimed_retailer, llm_claims: p.llm_claims,
    verified_price: p.verified_price, verified_retailer: p.verified_retailer, verified_product_url: p.verified_product_url,
    verified_offers: p.verified_offers, status: p.status, verification_status: p.verification_status,
    evidence_confidence: p.evidence_confidence, exclusion_reason: p.exclusion_reason,
    rejections: dedupeRejections(p.rejections), country: p.country, currency: p.currency,
    variant_match_strength: p.variant_match_strength,
    evidence_sources: (p.evidence_sources || []).slice(0, 12), page_checks: p.page_checks || [], fit_reasons: p.fit_reasons, possible_duplicates: p.possible_duplicates,
  };
}

function dedupeRejections(list) {
  const out = new Map();
  for (const r of list || []) {
    const k = `${r.reason}|${r.url}`;
    if (!out.has(k)) out.set(k, r);
  }
  return [...out.values()].slice(0, 15);
}

/** Counts of excluded candidates by reason (for the run summary). */
export function exclusionCounts(products) {
  const c = {};
  for (const p of products) if (p.status !== 'verified') c[p.exclusion_reason] = (c[p.exclusion_reason] || 0) + 1;
  return c;
}
