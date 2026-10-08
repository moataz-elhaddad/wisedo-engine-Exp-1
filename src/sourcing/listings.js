// Experiment B: web-search and shopping results ("listings") -> structured facts, deterministically.
//
// A listing is one search/shopping hit: {provider, kind: 'web'|'shopping', title, url, snippet, price_text, source}.
// parseListing() reads brand, model, CPU, RAM, storage, GPU, display, price and currency from its text with fixed
// rules (no LLM). A listing becomes a stand-alone discovery candidate only when the full configuration
// (CPU + RAM + storage + GPU) and an EGP price are readable; otherwise it is used as evidence only.
import { canonicalBrand } from './specs.js';
import { modelTokens, cpuToken, gpuToken, signature } from './consolidate.js';

/** Egyptian retailers' hosts (also used to decide whether a listing is relevant to Egypt). */
export const EGYPT_HOSTS = ['amazon.eg', 'noon.com', 'btech.com', '2b.com.eg', 'rayashop.com', 'jumia.com.eg', 'dubaiphone.net', 'compumarts.com',
  'elbadrgroupeg.store', 'elbadrgroup.com', 'sigma-computer.com', 'elarabygroup.com', 'select.com.eg', 'tradeline-stores.com', 'cairosales.com', 'carrefouregypt.com'];

const BRAND_WORDS = [
  ['lenovo', 'Lenovo'], ['لينوفو', 'Lenovo'], ['hp', 'HP'], ['اتش بي', 'HP'], ['إتش بي', 'HP'], ['dell', 'Dell'], ['ديل', 'Dell'],
  ['asus', 'Asus'], ['اسوس', 'Asus'], ['أسوس', 'Asus'], ['acer', 'Acer'], ['ايسر', 'Acer'], ['أيسر', 'Acer'], ['apple', 'Apple'], ['macbook', 'Apple'],
  ['ماك بوك', 'Apple'], ['msi', 'MSI'], ['huawei', 'Huawei'], ['هواوي', 'Huawei'], ['samsung', 'Samsung'], ['microsoft', 'Microsoft'], ['surface', 'Microsoft'],
  ['honor', 'Honor'], ['xiaomi', 'Xiaomi'], ['gigabyte', 'Gigabyte'], ['razer', 'Razer'], ['infinix', 'Infinix'], ['chuwi', 'Chuwi'],
];

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } };

/** Is this URL/listing relevant to Egypt? */
export function isEgyptian(url, currency) {
  const h = host(url);
  if (currency === 'EGP') return true;
  if (!h) return false;
  if (h.endsWith('.eg')) return true;
  if (h === 'noon.com' || h.endsWith('.noon.com')) return /\/egypt/.test(String(url));
  return EGYPT_HOSTS.some((x) => h === x || h.endsWith('.' + x));
}

/**
 * Price and currency from text like "EGP 32,999.00", "32,999 جنيه", "E£32,999", "$599.99", "AED 2,499".
 * @returns {{price: number|null, currency: string|null}}
 */
export function parsePrice(text) {
  const s = String(text ?? '').replace(/ /g, ' ');
  const pats = [
    [/(?:EGP|E£|LE|L\.E\.?|ج\.?م\.?|جنيه(?:ا)?(?: مصري)?)\s*([\d٠-٩][\d٠-٩,.]*)/i, 'EGP'],
    [/([\d٠-٩][\d٠-٩,.]*)\s*(?:EGP|E£|LE\b|L\.E\.?|ج\.?م\.?|جنيه)/i, 'EGP'],
    [/(?:US\$|\$|USD)\s*([\d,.]+)/i, 'USD'], [/([\d,.]+)\s*(?:USD|\$)/i, 'USD'],
    [/(?:AED|SAR|€|EUR|£|GBP)\s*([\d,.]+)/i, 'OTHER'],
  ];
  for (const [re, cur] of pats) {
    const m = s.match(re);
    if (!m) continue;
    const digits = m[1].replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
    // "32,999.00" / "32.999" (thousands dot) / "32999"
    let n;
    if (/^\d{1,3}(\.\d{3})+$/.test(digits)) n = Number(digits.replace(/\./g, ''));
    else n = Number(digits.replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) return { price: Math.round(n), currency: cur };
  }
  return { price: null, currency: null };
}

// Lower case, with Arabic unit words mapped to GB/TB so the spec patterns read Arabic titles too.
const lc = (s) => String(s ?? '').toLowerCase().replace(/جيجا(?:بايت)?|جيجابايت|جيجا بايت/g, 'gb').replace(/تيرا(?:بايت)?/g, 'tb');

function brandOf(text) {
  const t = ' ' + lc(text) + ' ';
  let best = null, at = Infinity;
  for (const [w, b] of BRAND_WORDS) {
    const i = /^[a-z]+$/.test(w) ? t.search(new RegExp(`[^a-z]${w}[^a-z]`)) : t.indexOf(w);
    if (i >= 0 && i < at) { at = i; best = b; }
  }
  return best;
}

/** RAM GB: "16GB RAM", "16 GB DDR5", "RAM 16GB", "16GB/512GB" (first of a pair). */
function ramOf(t) {
  let m = t.match(/(\d{1,2})\s*gb\s*(?:of\s*)?(?:ram|ddr\d?x?|lpddr\d?x?|memory|unified|رام|رامات)/) || t.match(/(?:ram|رام|رامات|memory)\s*:?\s*(\d{1,2})\s*gb/);
  if (m) return Number(m[1]);
  m = t.match(/\b(\d{1,2})\s*gb\s*[/|,]?\s*(\d{3,4}\s*gb|\d\s*tb)/);
  return m ? Number(m[1]) : null;
}

/** Storage GB: "512GB SSD", "1TB NVMe", "SSD 512GB", "16GB/512GB". */
function storageOf(t) {
  let m = t.match(/(\d{3,4})\s*gb\s*(?:pcie\s*|nvme\s*|m\.2\s*)*(?:ssd|nvme|pcie|emmc|storage|هارد)/) || t.match(/(\d(?:\.\d)?)\s*tb\s*(?:pcie\s*|nvme\s*)*(?:ssd|nvme|pcie|hdd|storage|هارد)?/) || t.match(/(?:ssd|storage)\s*:?\s*(\d{3,4})\s*gb/);
  if (m) return /tb/.test(m[0]) ? Math.round(Number(m[1]) * 1024) : Number(m[1]);
  m = t.match(/\b\d{1,2}\s*gb\s*[/|,]?\s*(\d{3,4})\s*gb/);
  return m ? Number(m[1]) : null;
}

function cpuText(t) {
  const m = t.match(/(intel\s*)?core\s*ultra\s*[579]\s*-?\s*\d{3}[a-z]*|(?:intel\s*)?(?:core\s*)?i[3579]\s*-?\s*\d{4,5}[a-z]*|core\s*[357]\s*-?\s*\d{3}[a-z]*|ryzen\s*ai\s*[579]\s*\w*\s*\d{3}[a-z]*|ryzen\s*[3579]\s*(?:pro\s*)?\d{4}[a-z]*|apple\s*m[1-5](?:\s*(?:pro|max))?|\bm[1-5]\s*(?:pro|max)?\s*chip|snapdragon\s*x\s*\w*|celeron\s*n?\d{4}|\bn[12]\d{2}\b/);
  if (!m) return null;
  const s = m[0].replace(/\s*chip$/, '');
  return /^m[1-5]/.test(s) ? `Apple ${s.toUpperCase()}` : s;
}

function gpuText(t) {
  const m = t.match(/(?:nvidia\s*)?(?:geforce\s*)?rtx\s*a?\d{4}(?:\s*ti)?|(?:geforce\s*)?gtx\s*\d{3,4}(?:\s*ti)?|radeon\s*rx\s*\d{4}[a-z]*|\barc\s*a\d{3}m?|iris\s*xe|uhd\s*graphics|intel\s*arc(?:\s*graphics)?|radeon\s*(?:\d{3}m|graphics)|intel\s*graphics/);
  if (m) return m[0];
  return null;
}

function displayText(t) {
  const m = t.match(/(1[0-8](?:\.\d)?)\s*(?:"|''|”|-?\s*inch(?:es)?|بوصة)[^,|;]{0,40}/);
  return m ? m[0].trim() : null;
}

/** Model text: the title with brand prefix stripped, cut at the first spec-ish separator. */
function modelOf(title, brand) {
  let s = String(title ?? '').replace(/^(?:لاب ?توب|laptop|notebook)\s+/i, '');
  if (brand) {
    const re = new RegExp(`^.*?\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b\\s*`, 'i');
    s = s.replace(re, '');
  }
  s = s.split(/\s[-–|(,]\s?|,|\s\d+\s*(?:gb|tb)\b|\schip\b|\s(?:laptop|notebook|gaming laptop|لاب ?توب)\b|\s(?:intel|amd|core|ryzen|with|بمعالج)\b/i)[0];
  return s.trim().slice(0, 80) || null;
}

/**
 * @param {{provider: string, kind: string, title: string, url: string, snippet?: string, price_text?: string, source?: string}} l
 */
export function parseListing(l) {
  const text = `${l.title || ''} ${l.snippet || ''}`;
  const t = lc(text);
  const titleL = lc(l.title || '');
  const brand = brandOf(l.title || '') || brandOf(text);
  const fromField = parsePrice(l.price_text || '');
  const { price, currency } = fromField.price ? fromField : parsePrice(text);
  const cpu = cpuText(titleL) || cpuText(t);
  const gpu = gpuText(titleL) || gpuText(t);
  return {
    ...l,
    brand,
    model: brand ? modelOf(l.title, brand) : null,
    cpu, gpu,
    ram_gb: ramOf(titleL) ?? ramOf(t),
    storage_gb: storageOf(titleL) ?? storageOf(t),
    display: displayText(titleL) || displayText(t),
    price_egp: currency === 'EGP' ? price : null,
    price, currency,
    retailer: l.source || host(l.url),
    host: host(l.url),
    egypt: isEgyptian(l.url, currency),
  };
}

/** A listing that is a full configuration with an EGP price, as a normalised candidate (normalize.js shape). */
export function listingCandidate(p, now) {
  if (!p.brand || !p.model || p.price_egp === null) return null;
  const c = {
    provider: p.provider, brand: canonicalBrand(p.brand), model: p.model, mpn: null, cpu: p.cpu, ram_gb: p.ram_gb, storage_gb: p.storage_gb,
    gpu: p.gpu || null, display: p.display, screen_inches: null, os: null, weight_kg: null, battery_hours: null, warranty_months: null,
    price_egp: p.price_egp, currency: 'EGP', price_basis: 'listing', availability: 'listed', grey_import: null,
    offers: [{ retailer: p.retailer, url: p.url, price_egp: p.price_egp, source: 'listing' }],
    fit_reasons: [], confidence: null, evidence: `${p.kind} listing: ${p.title}`.slice(0, 300),
    evidence_urls: [p.url].filter(Boolean), timestamp: now || null, from_listing: true,
  };
  return signature(c) ? c : null;
}

/**
 * Does a parsed listing describe this (consolidated) candidate? Conservative: any readable spec that conflicts
 * rejects the match; a positive match needs the MPN in the text, or most of the model-name tokens.
 * @returns {{match: boolean, strength: 'mpn'|'model+specs'|'model'|null, why: string}}
 */
export function listingMatches(cand, p) {
  if (!p.brand || canonicalBrand(p.brand) !== cand.brand) return { match: false, strength: null, why: 'brand' };
  if (p.ram_gb && cand.ram_gb && p.ram_gb !== cand.ram_gb) return { match: false, strength: null, why: 'ram differs' };
  if (p.storage_gb && cand.storage_gb && p.storage_gb !== cand.storage_gb) return { match: false, strength: null, why: 'storage differs' };
  const ct = cpuToken(cand.cpu), pt = cpuToken(p.cpu);
  if (ct && pt && ct !== pt) return { match: false, strength: null, why: 'cpu differs' };
  const cg = gpuToken(cand.gpu, cand.cpu), pg = gpuToken(p.gpu, p.cpu);
  if (cg && pg && cg !== pg) return { match: false, strength: null, why: 'gpu differs' };
  const flat = lc(`${p.title} ${p.snippet || ''}`).replace(/[^a-z0-9]+/g, '');
  if (cand.mpn && flat.includes(lc(cand.mpn).replace(/[^a-z0-9]/g, ''))) return { match: true, strength: 'mpn', why: 'MPN in listing' };
  const toks = [...modelTokens(cand.model, cand.brand)];
  if (!toks.length) return { match: false, strength: null, why: 'no model tokens' };
  const hit = toks.filter((k) => flat.includes(k)).length / toks.length;
  if (hit < 0.75) return { match: false, strength: null, why: `model tokens ${hit.toFixed(2)}` };
  const specsSeen = [p.ram_gb, p.storage_gb, pt].filter(Boolean).length;
  return { match: true, strength: specsSeen >= 2 ? 'model+specs' : 'model', why: `model tokens ${hit.toFixed(2)}, ${specsSeen} specs agree` };
}
