// Experiment B: best-effort verification of candidate product URLs.
//
// For each URL (capped): one plain GET with an honest User-Agent and a short timeout. No retries with other
// identities, no cookies, no CAPTCHA solving, no headless browser: a 401/403/429/503 or a challenge page is
// recorded as "blocked" and the candidate keeps a lower evidence confidence. Nothing is ever marked verified
// without the page actually naming the product.
//
// Per URL status: verified | partial | mismatch | unavailable | blocked | unreachable | error
// Candidate status: best URL status, or "no_url" / "not_checked".
import { modelTokens, cpuToken } from './consolidate.js';
import { looksLikeProductPage, isClassifieds, isAccessoryTitle } from './listings.js';

// Amazon product pages are 1-2 MB and their buy box sits past the first 600 KB.
export const VERIFY_DEFAULTS = { maxUrls: 20, timeoutMs: 6000, maxBytes: 2_000_000 };
const USER_AGENT = 'Mozilla/5.0 (compatible; WisedoExp1-LinkCheck/0.1; product-availability experiment)';

const RANK = { verified: 6, partial: 5, unavailable: 4, mismatch: 3, blocked: 2, unreachable: 1, error: 1, not_checked: 0, no_url: 0 };

/**
 * Candidate-level status from the page checks plus search/shopping listings (evidence.js):
 *   verified      a product page was fetched and names the product with matching specs
 *   listed        an Egyptian listing with an EGP price matches the model and specs (or the MPN)
 *   partial / unavailable / mismatch   from the page checks
 *   web_evidence  pages were found that name the product, but nothing priced in Egypt and no page check passed
 *   blocked / unreachable / no_url / not_checked   nothing could be checked
 */
export function finalStatus(p, pageStatus) {
  if (pageStatus === 'verified') return 'verified';
  const strong = (p.listing_evidence || []).filter((e) => e.egypt && e.currency === 'EGP' && e.price && e.strength !== 'model');
  if (strong.length && pageStatus !== 'unavailable') return 'listed';
  if (['partial', 'unavailable', 'mismatch'].includes(pageStatus)) return pageStatus;
  if ((p.listing_evidence || []).length) return 'web_evidence';
  return pageStatus;
}

const CHALLENGE = /captcha|cf-chl|challenge-platform|access denied|are you a robot|verify you are human|bot detection|px-captcha|datadome/i;

async function readLimited(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== 'function') return (await res.text()).slice(0, maxBytes);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = '', n = 0;
  while (n < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    out += dec.decode(value, { stream: true });
  }
  try { await reader.cancel(); } catch { /* ignore */ }
  return out;
}

/** Structured prices on the page (JSON-LD offers, itemprop, Open Graph product price). */
export function pagePrices(html) {
  const out = [];
  const re = [
    /"price"\s*:\s*"?([\d.,]+)"?/g,
    /itemprop=["']price["'][^>]*content=["']([\d.,]+)["']/g,
    /content=["']([\d.,]+)["'][^>]*itemprop=["']price["']/g,
    /property=["'](?:product|og):price:amount["'][^>]*content=["']([\d.,]+)["']/g,
  ];
  for (const r of re) for (const m of html.matchAll(r)) {
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n >= 1000 && n <= 2_000_000) out.push(Math.round(n));
  }
  return [...new Set(out)].slice(0, 10);
}

/** Currency of the page's prices: JSON-LD/itemprop priceCurrency, else an Egyptian-pound marker in the text. */
export function pageCurrency(html) {
  const m = html.match(/"priceCurrency"\s*:\s*"([A-Za-z]{3})"/) || html.match(/itemprop=["']priceCurrency["'][^>]*content=["']([A-Za-z]{3})["']/);
  if (m) return m[1].toUpperCase();
  if (/\bEGP\b|ج\.م|جنيه|E£/.test(html)) return 'EGP';
  if (/\bAED\b|\bSAR\b|US\$|\bUSD\b/.test(html)) return 'OTHER';
  return null;
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const num = (v) => {
  const s = String(v ?? '').replace(/[^\d.,]/g, '');
  const n = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s) || /^\d+(\.\d+)?$/.test(s) ? Number(s.replace(/,/g, '')) : /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) ? Number(s.replace(/\./g, '').replace(',', '.')) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

/** Every schema.org Product node in the page's JSON-LD blocks (graphs and arrays flattened). */
function ldProducts(html) {
  const out = [];
  const walk = (x) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    const t = [].concat(x['@type'] || []).map(String);
    if (t.some((y) => /^(Product|ProductGroup|IndividualProduct)$/i.test(y)) || (!t.length && x.offers)) out.push(x);
    if (x['@graph']) walk(x['@graph']);
  };
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1].trim())); } catch { /* malformed block */ }
  }
  return out;
}

/**
 * The page's own offer for its main product, from structured data only (JSON-LD Product -> offers, Open Graph /
 * product meta, microdata). Free text is never read for a price or for stock: "Sold out" / "Out of stock" strings
 * appear in templates, translations and related-product widgets on in-stock pages (live: 14 false rejections).
 * @returns {{price: number|null, currency: string|null, availability: 'in_stock'|'out_of_stock'|null, source: string|null}}
 */
export function pageOffer(html, url = '') {
  const avail = (v) => (v == null ? null : /InStock|PreOrder|LimitedAvailability|OnlineOnly|InStoreOnly|BackOrder|in stock/i.test(String(v)) ? 'in_stock'
    : /OutOfStock|SoldOut|Discontinued|out of stock/i.test(String(v)) ? 'out_of_stock' : null);
  for (const p of ldProducts(html)) {
    const offers = [].concat(p.offers || []).flatMap((o) => (o && o['@type'] === 'AggregateOffer' ? [{ price: o.lowPrice ?? o.price, priceCurrency: o.priceCurrency, availability: o.availability }, ...[].concat(o.offers || [])] : [o]));
    const o = offers.find((x) => x && num(x.price ?? (x.priceSpecification && x.priceSpecification.price)));
    if (o) return { price: num(o.price ?? o.priceSpecification.price), currency: String(o.priceCurrency || (o.priceSpecification && o.priceSpecification.priceCurrency) || '').toUpperCase() || null, availability: avail(o.availability), source: 'json-ld' };
  }
  const meta = (prop) => {
    const m = html.match(new RegExp(`<meta[^>]*(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i')) || html.match(new RegExp(`<meta[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'));
    return m ? m[1] : null;
  };
  const mp = num(meta('product:price:amount') || meta('og:price:amount'));
  if (mp) return { price: mp, currency: (meta('product:price:currency') || meta('og:price:currency') || '').toUpperCase() || null, availability: avail(meta('product:availability') || meta('og:availability')), source: 'meta' };
  const ip = html.match(/itemprop=["']price["'][^>]*content=["']([\d.,]+)["']/i) || html.match(/content=["']([\d.,]+)["'][^>]*itemprop=["']price["']/i);
  const ic = html.match(/itemprop=["']priceCurrency["'][^>]*content=["']([A-Za-z]{3})["']/i);
  const ia = html.match(/itemprop=["']availability["'][^>]*(?:href|content)=["']([^"']+)["']/i);
  if (ip && num(ip[1])) return { price: num(ip[1]), currency: ic ? ic[1].toUpperCase() : null, availability: avail(ia && ia[1]), source: 'microdata' };
  // Amazon has no JSON-LD offer: its buy box carries the price ("priceAmount" / the core price block) and its
  // #availability block the stock. Only on Amazon's own pages.
  if (/(^|\.)amazon\.eg$/i.test(hostOf(url))) {
    // Only the price-to-pay inside the core price block is this product's price: other a-offscreen prices on the page
    // belong to widgets (live: three different G14 listings all showed the same 85,945.43 from one).
    const i = html.indexOf('id="corePrice_desktop"') >= 0 ? html.indexOf('id="corePrice_desktop"') : html.indexOf('id="corePriceDisplay_desktop_feature_div"');
    const block = i >= 0 ? html.slice(i, i + 6000) : '';
    const pa = block.match(/(?:apexPriceToPay|priceToPay)[\s\S]{0,400}?class=["']a-offscreen["'][^>]*>\s*(?:EGP|ج\.م\.?)(?:\s|&nbsp;)*([\d,.]+)/);
    const j = html.indexOf('id="availability"');
    const at = j >= 0 ? html.slice(j, j + 2500).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ') : '';
    const availability = /Currently unavailable|غير متوفر/i.test(at) ? 'out_of_stock' : /In Stock|left in stock|متوفر/i.test(at) ? 'in_stock' : null;
    if (pa && num(pa[1])) return { price: num(pa[1]), currency: 'EGP', availability, source: 'amazon-buybox' };
    const near = (needle, n = 260) => { const k = html.indexOf(needle); return k < 0 ? null : html.slice(k, k + n).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 160); };
    // No featured offer (common for older models): diagnostics only.
    const text = (k, n) => (k < 0 ? null : html.slice(k, k + n).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/^[^<]*>/, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300));
    const k = html.indexOf('a-price');
    return { price: null, currency: null, availability, source: availability ? 'amazon-availability' : null,
      hints: { bytes: html.length, core: text(i, 6000), availability: text(j, 6000), first_a_price: k >= 0 ? html.slice(k - 120, k + 260).replace(/\s+/g, ' ') : null, outOfStock: html.includes('id="outOfStock"'), buybox: html.includes('id="buybox"') } };
  }
  const az = html.match(/id=["']availability["'][\s\S]{0,600}?(Currently unavailable|In Stock|غير متوفر حاليًا|متوفر)/i);
  return { price: null, currency: null, availability: az ? (/unavailable|غير متوفر/i.test(az[1]) ? 'out_of_stock' : 'in_stock') : null, source: az ? 'amazon-availability' : null };
}

function pageTitle(html) {
  const m = html.match(/<title[^>]*>([^<]{0,300})/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

/**
 * Compare page text with the candidate: brand, model-name tokens, and (when present) key specs.
 * @returns {{brand: boolean, modelShare: number, specs: {ram: boolean|null, storage: boolean|null, cpu: boolean|null}}}
 */
export function compareToPage(text, cand) {
  const t = text.toLowerCase().replace(/\s+/g, ' ');
  const flat = t.replace(/[^a-z0-9]+/g, '');
  const brand = t.includes(cand.brand.toLowerCase());
  const toks = [...modelTokens(cand.model, cand.brand)];
  const hit = toks.filter((k) => (k.length >= 3 ? flat.includes(k) : new RegExp(`\\b${k}\\b`).test(t))).length;
  const mpn = cand.mpn ? flat.includes(cand.mpn.toLowerCase().replace(/[^a-z0-9]/g, '')) : false;
  const cpuT = cpuToken(cand.cpu);
  const cpuDigits = cpuT ? (cpuT.split('-')[1] || '').replace(/[^0-9a-z]/g, '') : '';
  return {
    brand,
    mpn,
    modelShare: toks.length ? hit / toks.length : 0,
    specs: {
      ram: cand.ram_gb ? new RegExp(`\\b${cand.ram_gb}\\s*gb`).test(t) : null,
      storage: cand.storage_gb ? (cand.storage_gb >= 1024 ? new RegExp(`\\b${Math.round(cand.storage_gb / 1024)}\\s*tb|\\b${cand.storage_gb}\\s*gb`).test(t) : new RegExp(`\\b${cand.storage_gb}\\s*gb`).test(t)) : null,
      cpu: cpuDigits && cpuDigits.length >= 3 ? flat.includes(cpuDigits) : null,
    },
  };
}

/**
 * Check one URL against a candidate.
 * @param {string} url
 * @param {any} cand
 * @param {{fetch?: typeof fetch, timeoutMs?: number, maxBytes?: number}} opts
 */
export async function verifyUrl(url, cand, opts = {}) {
  const doFetch = opts.fetch || fetch;
  const timeoutMs = opts.timeoutMs ?? VERIFY_DEFAULTS.timeoutMs;
  const t0 = Date.now();
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctl && ctl.abort(), timeoutMs);
  try {
    const res = await Promise.race([
      doFetch(url, { method: 'GET', redirect: 'follow', headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' }, ...(ctl ? { signal: ctl.signal } : {}) }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs + 50)),
    ]);
    const ms = () => Date.now() - t0;
    if ([401, 403, 429, 503].includes(res.status)) return { url, status: 'blocked', http: res.status, ms: ms() };
    if (!res.ok) return { url, status: 'unreachable', http: res.status, ms: ms() };
    const html = await readLimited(res, opts.maxBytes ?? VERIFY_DEFAULTS.maxBytes);
    const title = pageTitle(html);
    if (CHALLENGE.test(html.slice(0, 20000)) && !(title && title.toLowerCase().includes(cand.brand.toLowerCase()))) {
      return { url, status: 'blocked', http: res.status, ms: ms(), title, note: 'challenge page' };
    }
    // A removed product often redirects to a search or category page that still names it: that is not its page.
    const finalUrl = res.url || url;
    if (/^\s*(search results|نتائج البحث|no results)/i.test(title || '') || (finalUrl !== url && !looksLikeProductPage(finalUrl))) {
      return { url, status: 'unreachable', http: res.status, ms: ms(), title, final_url: finalUrl, note: 'redirected to a search or category page' };
    }
    const cmp = compareToPage(html, cand);
    const specChecks = Object.values(cmp.specs).filter((v) => v !== null);
    const specOk = specChecks.every(Boolean);
    const prices = pagePrices(html);
    let status;
    if (!cmp.brand || (cmp.modelShare < 0.4 && !cmp.mpn) || isAccessoryTitle(title)) status = 'mismatch';
    else if ((cmp.mpn || cmp.modelShare >= 0.6) && specOk) status = 'verified';
    else status = 'partial';
    const offer = pageOffer(html, res.url || url);
    if (status !== 'mismatch' && offer.availability === 'out_of_stock') status = 'unavailable';
    return { url, status, http: res.status, ms: ms(), title, final_url: res.url || url, match: cmp, page_prices: prices, page_currency: pageCurrency(html), page_offer: offer, bytes: html.length };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e).slice(0, 120);
    return { url, status: msg === 'timeout' ? 'unreachable' : 'error', error: msg, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Evidence confidence 0..1 from verification only (kept apart from provider consensus):
 *   verified 0.9 (+0.05 with a structured page price), listed 0.8, partial 0.6, unavailable 0.5, web_evidence 0.45, mismatch 0.15,
 *   not verifiable (blocked, unreachable, no URL, not checked) 0.3.
 */
export function evidenceConfidence(status, hasPagePrice) {
  const base = { verified: 0.9, listed: 0.8, partial: 0.6, unavailable: 0.5, web_evidence: 0.45, mismatch: 0.15 }[status] ?? 0.3;
  return Math.min(1, base + (status === 'verified' && hasPagePrice ? 0.05 : 0));
}

/**
 * Verify the URLs of consolidated candidates (in place: adds .verification and .evidence_confidence).
 * URLs are checked in candidate order until maxUrls is reached; the rest stay "not_checked".
 * @param {any[]} products consolidated candidates
 * @param {{fetch?: typeof fetch, maxUrls?: number, timeoutMs?: number, enabled?: boolean}} opts
 */
export async function verifyCandidates(products, opts = {}) {
  const maxUrls = opts.maxUrls ?? VERIFY_DEFAULTS.maxUrls;
  const jobs = [];
  for (const p of products) {
    p.verification = { status: p.offers.some((o) => o.url) ? 'not_checked' : 'no_url', urls: [] };
    if (opts.enabled === false) continue;
    for (const o of p.offers) {
      if (!o.url || jobs.length >= maxUrls || /google\.[a-z.]+\//.test(o.url)) continue;
      jobs.push({ p, o });
    }
  }
  const t0 = Date.now();
  const results = await Promise.all(jobs.map(({ p, o }) => verifyUrl(o.url, p, opts).then((r) => ({ p, o, r }))));
  for (const { p, o, r } of results) {
    p.verification.urls.push(r);
    // A structured page price close to the provider's claim replaces it (the page is better evidence).
    const retailPage = looksLikeProductPage(o.url) && !isClassifieds(o.url);
    const claimed = o.price_egp ?? p.price_egp;
    const pagePrice = !retailPage ? null : (r.page_prices || []).find((x) => !claimed || (x >= claimed * 0.5 && x <= claimed * 2));
    if ((r.status === 'verified' || r.status === 'partial') && pagePrice) { o.page_price_egp = pagePrice; o.price_source = 'page'; }
    // A search/category page or a classifieds ad can name the product but is not a retail product page:
    // at most "partial", and its price is never used.
    if (!retailPage && r.status === 'verified') { r.status = 'partial'; r.note = isClassifieds(o.url) ? 'classifieds listing' : 'not a single-product page'; }
    if (!retailPage) delete r.page_prices;
    o.verification = r.status;
    if (r.status === 'unavailable') o.in_stock = false;
    // The page shows another product: the link is wrong. Keep the candidate, drop the link (a search link replaces it).
    if (r.status === 'mismatch') { o.rejected_url = o.url; o.url = null; }
  }
  for (const p of products) {
    const pageBest = p.verification.urls.reduce((acc, u) => (RANK[u.status] > RANK[acc] ? u.status : acc), p.verification.status);
    const best = finalStatus(p, pageBest);
    p.verification.page_status = pageBest;
    p.verification.status = best;
    p.verification_status = best;
    p.evidence_confidence = Math.round(100 * evidenceConfidence(best, p.offers.some((o) => o.page_price_egp))) / 100;
  }
  return { checked: jobs.length, ms: Date.now() - t0 };
}
