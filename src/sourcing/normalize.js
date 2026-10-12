// Experiment B: validate and normalise one provider's raw output into discovery candidates.
// Provider output is untrusted: anything malformed is dropped with a reason, never thrown.
import { canonicalBrand, toGb } from './specs.js';
import { MAX_CANDIDATES_PER_PROVIDER } from './discovery-prompt.js';

const str = (x, max = 300) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : null);
const num = (x) => {
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (typeof x === 'string') {
    const n = Number(x.replace(/[,\s]|egp|le|جنيه/gi, ''));
    return Number.isFinite(n) && x.trim() ? n : null;
  }
  return null;
};
const price = (x) => { const n = num(x); return n !== null && n >= 1000 && n <= 2_000_000 ? Math.round(n) : null; };

/** http(s) URL or null. Search-result and javascript: URLs are dropped. */
export function cleanUrl(u) {
  const s = str(u, 1000);
  if (!s) return null;
  let url;
  try { url = new URL(s); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (/(^|\.)google\.[a-z.]+$/.test(url.hostname) && url.pathname.startsWith('/search')) return null;
  if (/example\.(com|org)|invalid$|localhost/.test(url.hostname)) return null;
  return url.toString();
}

/**
 * @param {any} raw  provider output (expected {candidates: [...]})
 * @param {string} provider
 * @returns {{candidates: any[], rejected: {index: number, reason: string}[], error: string|null}}
 */
export function normalizeProviderOutput(raw, provider, now = null) {
  if (!raw || typeof raw !== 'object') return { candidates: [], rejected: [], error: 'output is not a JSON object' };
  const list = Array.isArray(raw) ? raw : Array.isArray(raw.candidates) ? raw.candidates : null;
  if (!list) return { candidates: [], rejected: [], error: 'output has no candidates array' };
  const candidates = [];
  const rejected = [];
  list.slice(0, MAX_CANDIDATES_PER_PROVIDER * 2).forEach((c, index) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) { rejected.push({ index, reason: 'not an object' }); return; }
    const brand = canonicalBrand(str(c.brand, 60));
    let model = str(c.model, 200);
    if (!brand) { rejected.push({ index, reason: 'missing brand' }); return; }
    if (!model) { rejected.push({ index, reason: 'missing model' }); return; }
    if (model.toLowerCase().startsWith(brand.toLowerCase() + ' ')) model = model.slice(brand.length + 1);
    const offers = (Array.isArray(c.offers) ? c.offers : []).slice(0, 6).map((o) => (o && typeof o === 'object' ? {
      retailer: str(o.retailer, 80), url: cleanUrl(o.url), price_egp: price(o.price_egp),
    } : null)).filter((o) => o && (o.retailer || o.url));
    const conf = num(c.confidence);
    candidates.push({
      provider,
      brand,
      model,
      mpn: str(c.mpn, 60),
      cpu: str(c.cpu, 120),
      ram_gb: toGb(c.ram_gb),
      storage_gb: toGb(c.storage_gb),
      gpu: str(c.gpu, 120),
      display: str(c.display, 200),
      screen_inches: num(c.screen_inches),
      os: str(c.os, 40),
      weight_kg: num(c.weight_kg),
      battery_hours: num(c.battery_hours),
      warranty_months: num(c.warranty_months),
      price_egp: price(c.price_egp) ?? (offers.find((o) => o.price_egp) || {}).price_egp ?? null,
      price_basis: str(c.price_basis, 40) || 'unknown',
      availability: str(c.availability_egypt, 40) || 'unknown',
      grey_import: typeof c.grey_import === 'boolean' ? c.grey_import : null,
      offers,
      fit_reasons: (Array.isArray(c.fit_reasons) ? c.fit_reasons : []).map((r) => str(r, 300)).filter(Boolean).slice(0, 5),
      confidence: conf !== null ? Math.max(0, Math.min(1, conf)) : null,
      evidence: str(c.evidence, 500),
      evidence_urls: (Array.isArray(c.source_urls) ? c.source_urls : []).map(cleanUrl).filter(Boolean).slice(0, 4),
      currency: 'EGP',
      timestamp: now,
    });
  });
  return { candidates: candidates.slice(0, MAX_CANDIDATES_PER_PROVIDER), rejected, error: null };
}
