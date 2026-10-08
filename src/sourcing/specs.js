// Experiment B: raw laptop specs (as LLM providers describe them) -> the laptop config's attribute scale.
//
// The laptop config scores cpu, gpu and screen on 1..10 editorial scales and stores RAM/storage in GB
// (config/laptop.json, docs/laptop-NOTES.md). Catalog products carry those scores directly; LLM candidates carry
// raw specs ("Core i5-13420H", "RTX 4050", "15.6 FHD IPS 144Hz"), so this module maps one onto the other with
// fixed, deterministic rules. Every rule here is an editorial assumption, like the catalog's own scores.
// Anything not recognised stays null (unknown), which Layer 2 already handles ("not listed", unknownNorm).
//
// Deliberately NOT inferred (kept null): build, keyboard. The LLMs' opinions about them are not used for scoring.

const clamp = (x, lo = 1, hi = 10) => Math.round(Math.max(lo, Math.min(hi, x)) * 10) / 10;
const lc = (s) => String(s ?? '').toLowerCase();

/** Canonical brand spelling, matching the catalog and the brand/brandAvoid filters of config/laptop.json. */
const BRANDS = {
  lenovo: 'Lenovo', hp: 'HP', 'hewlett packard': 'HP', 'hewlett-packard': 'HP', dell: 'Dell', asus: 'Asus',
  acer: 'Acer', apple: 'Apple', msi: 'MSI', huawei: 'Huawei', samsung: 'Samsung', microsoft: 'Microsoft',
  honor: 'Honor', xiaomi: 'Xiaomi', gigabyte: 'Gigabyte', razer: 'Razer', lg: 'LG', infinix: 'Infinix',
  toshiba: 'Toshiba', dynabook: 'Dynabook', chuwi: 'Chuwi',
};

export function canonicalBrand(brand) {
  const b = lc(brand).trim().replace(/\s+/g, ' ');
  if (!b) return null;
  if (BRANDS[b]) return BRANDS[b];
  const first = b.split(' ')[0];
  if (BRANDS[first]) return BRANDS[first];
  return String(brand).trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Service network in Egypt by brand: the same editorial table the catalog uses (docs/laptop-NOTES.md). */
const SERVICE_BY_BRAND = { Lenovo: 8, HP: 8, Dell: 8, Asus: 7, Apple: 7, Acer: 6, Huawei: 6, MSI: 5 };

/**
 * CPU performance 1..10 from a CPU name. Null when the name is not recognised.
 * @param {string} cpu
 * @returns {number|null}
 */
export function cpuScore(cpu) {
  const s = lc(cpu);
  if (!s.trim()) return null;
  let m;
  if ((m = s.match(/\bm([1-5])\b(?:\s*(pro|max|ultra))?/)) && /apple|\bm[1-5]\b/.test(s)) {
    const base = { 1: 7, 2: 7.5, 3: 8, 4: 8.5, 5: 9 }[m[1]];
    return clamp(base + (m[2] === 'pro' ? 1 : m[2] === 'max' || m[2] === 'ultra' ? 1.5 : 0));
  }
  if ((m = s.match(/core\s*ultra\s*([579])\s*-?\s*(\d{3})?\s*([a-z]*)/))) {
    const base = { 5: 6.5, 7: 7.8, 9: 9 }[m[1]];
    return clamp(base + (/^h/.test(m[3] || '') ? 0.5 : 0) + (m[2] && Number(m[2][0]) >= 2 ? 0.3 : 0));
  }
  if ((m = s.match(/\bi([3579])\s*-?\s*(\d{4,5})([a-z]*)/)) || (m = s.match(/core\s*i([3579])\b()()/))) {
    const base = { 3: 4, 5: 6, 7: 7.5, 9: 9 }[m[1]];
    let adj = 0;
    if (m[2]) {
      const gen = m[2].length === 5 ? Number(m[2].slice(0, 2)) : Number(m[2][0]);
      adj += Math.max(-1.5, Math.min(0.6, (gen - 12) * 0.3));
    }
    const suf = m[3] || '';
    if (/^h/.test(suf)) adj += 0.5;
    else if (/^u/.test(suf)) adj -= 0.3;
    return clamp(base + adj);
  }
  if ((m = s.match(/\bcore\s*([357])\s*-?\s*(\d{3})([a-z]*)/))) {
    const base = { 3: 4.5, 5: 6, 7: 7 }[m[1]];
    return clamp(base + (/^h/.test(m[3] || '') ? 0.5 : 0));
  }
  if ((m = s.match(/ryzen\s*ai\s*(?:max\+?\s*)?([579])/))) return clamp({ 5: 6.8, 7: 8, 9: 9 }[m[1]]);
  if ((m = s.match(/ryzen\s*([3579])\s*(?:pro\s*)?-?\s*(\d{4})?\s*([a-z]*)/))) {
    const base = { 3: 4, 5: 6, 7: 7.5, 9: 9 }[m[1]];
    let adj = 0;
    if (m[2]) adj += Math.max(-1.2, Math.min(0.6, (Number(m[2][0]) - 7) * 0.3));
    if (/^h/.test(m[3] || '')) adj += 0.5;
    else if (/^u/.test(m[3] || '')) adj -= 0.3;
    return clamp(base + adj);
  }
  if (/snapdragon\s*x\s*(elite)/.test(s)) return 7.5;
  if (/snapdragon\s*x/.test(s)) return 7;
  if (/celeron|pentium|athlon|mediatek|\bn[12]\d{2}\b|intel\s*n\d/.test(s)) return 2;
  return null;
}

/**
 * GPU performance 1..10 and whether it is a dedicated card.
 * @param {string} gpu
 * @param {string} [cpu]  integrated graphics follow the CPU when the GPU field is empty
 * @returns {{score: number|null, dedicated: boolean|null}}
 */
export function gpuInfo(gpu, cpu) {
  const s = lc(gpu);
  const c = lc(cpu);
  let m;
  if ((m = s.match(/rtx\s*a?(\d{4})(\s*ti)?/))) {
    const table = { 2050: 3.5, 3050: 4.5, 3060: 6, 3070: 7, 3080: 8, 4050: 6, 4060: 7, 4070: 8, 4080: 9, 4090: 10, 5050: 6.5, 5060: 7.5, 5070: 8.5, 5080: 9.5, 5090: 10 };
    const v = table[m[1]];
    return { score: v ? clamp(v + (m[2] ? 0.5 : 0)) : 6, dedicated: true };
  }
  if ((m = s.match(/gtx\s*(\d{3,4})/))) return { score: Number(m[1]) >= 1660 ? 4 : 3.5, dedicated: true };
  if (/\brx\s*\d{4}/.test(s) || /radeon\s*rx/.test(s)) return { score: 6, dedicated: true };
  if (/arc\s*a\d{3}m?/.test(s)) return { score: 4, dedicated: true };
  if ((m = s.match(/mx\s*(\d{3})/))) return { score: 2.5, dedicated: true };
  // Integrated graphics
  if (/radeon\s*(8[89]0m|780m|760m)/.test(s)) return { score: 4, dedicated: false };
  if (/radeon\s*(680m|660m)/.test(s)) return { score: 3.5, dedicated: false };
  if (/intel\s*arc|\barc\s*graphics|\barc\s*1[34]0v/.test(s)) return { score: 3.5, dedicated: false };
  if (/iris/.test(s)) return { score: 2.5, dedicated: false };
  if (/uhd|hd\s*graphics/.test(s)) return { score: 1.5, dedicated: false };
  if (/adreno/.test(s)) return { score: 3.5, dedicated: false };
  if (/radeon/.test(s)) return { score: 2.5, dedicated: false };
  const apple = (s.match(/\bm([1-5])\b(?:\s*(pro|max))?/) || c.match(/\bm([1-5])\b(?:\s*(pro|max))?/));
  if (apple && (/apple/.test(s + c) || /\bm[1-5]\b/.test(c))) {
    const base = { 1: 4, 2: 4.5, 3: 5, 4: 5.5, 5: 6 }[apple[1]];
    return { score: clamp(base + (apple[2] === 'pro' ? 1.5 : apple[2] === 'max' ? 3 : 0)), dedicated: false };
  }
  if (/integrated|onboard|shared/.test(s)) {
    if (/core\s*ultra/.test(c)) return { score: 3.5, dedicated: false };
    if (/i[3579]-1[1-4]\d{3}/.test(c)) return { score: 2.5, dedicated: false };
    if (/ryzen\s*[579]\s*[78]\d{3}/.test(c)) return { score: 3.5, dedicated: false };
    return { score: 2, dedicated: false };
  }
  return { score: null, dedicated: null };
}

/**
 * Screen quality 1..10 from a display description (resolution, panel, refresh, brightness).
 * @param {string} display
 * @param {string} [brand]
 * @returns {number|null}
 */
export function screenScore(display, brand) {
  const s = lc(display);
  if (!s.trim()) return brand === 'Apple' ? 8.5 : null;
  if (/liquid\s*retina\s*xdr/.test(s)) return 9.5;
  if (/retina/.test(s)) return 8.5;
  let x = 5;
  if (/4k|uhd|3840|3\.[0-9]k|3k|2\.8k|2880|2560|qhd|wqxga|2\.5k|2\.2k|2240|1600p|2000/.test(s)) x += 1.5;
  else if (/\b(hd|1366|768p)\b/.test(s) && !/fhd|full\s*hd|1080|1920|wuxga|1200/.test(s)) x -= 2;
  if (/oled/.test(s)) x += 2;
  else if (/mini[\s-]*led/.test(s)) x += 2;
  else if (/ips|wva|lcd\s*ips/.test(s)) x += 0.5;
  else if (/\btn\b/.test(s)) x -= 1;
  const hz = s.match(/(\d{2,3})\s*hz/);
  if (hz && Number(hz[1]) >= 120) x += 0.5;
  const nits = s.match(/(\d{3,4})\s*nits?/);
  if (nits && Number(nits[1]) >= 400) x += 0.5;
  else if (nits && Number(nits[1]) <= 250) x -= 0.5;
  if (/100%\s*(dci|srgb)|dci-p3/.test(s)) x += 0.5;
  return clamp(x);
}

/** Inches from a number or a display description ("15.6\" FHD"). */
export function screenInches(value, display) {
  if (typeof value === 'number' && value >= 10 && value <= 19) return value;
  const m = lc(display).match(/(1[0-8](?:\.\d)?)\s*(?:"|''|in\b|inch|”|-inch|بوصة)/) || lc(display).match(/^\s*(1[0-8](?:\.\d)?)\b/);
  return m ? Number(m[1]) : null;
}

/** GB from a number or text: 16, "16GB", "1TB", "512 GB SSD". */
export function toGb(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  const s = lc(v);
  const tb = s.match(/(\d+(?:\.\d+)?)\s*tb/);
  if (tb) return Math.round(Number(tb[1]) * 1024);
  const gb = s.match(/(\d+(?:\.\d+)?)\s*gb/) || s.match(/^\s*(\d{1,4})\s*$/);
  return gb ? Number(gb[1]) : null;
}

function osOf(os, brand, model) {
  const s = lc(os);
  if (/mac/.test(s) || brand === 'Apple') return 'macos';
  if (/chrome/.test(s) || /chromebook/.test(lc(model))) return 'chromeos';
  if (/windows|win\s*1[01]/.test(s)) return 'windows';
  if (/dos|linux|ubuntu|no\s*os|without/.test(s)) return 'windows'; // FreeDOS units are bought to run Windows
  return s ? 'windows' : (brand ? 'windows' : null);
}

/** Series bucket used by the laptop config's resale rule. Price bands follow docs/laptop-NOTES.md. */
export function seriesFor(priceEgp, cpu) {
  if (typeof priceEgp === 'number' && priceEgp > 0) return priceEgp < 30000 ? 'entry' : priceEgp < 55000 ? 'mid' : 'flagship';
  const c = typeof cpu === 'number' ? cpu : null;
  return c === null ? null : c < 5 ? 'entry' : c < 7.5 ? 'mid' : 'flagship';
}

const posNum = (x, lo, hi) => (typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? x : null);

/**
 * Laptop attributes (config/laptop.json ids) from a normalised candidate's raw specs.
 * @param {any} c  normalised candidate (see normalize.js)
 * @returns {{attrs: Record<string, any>, mapping: Record<string, string>}}
 */
export function laptopAttrs(c) {
  const cpu = cpuScore(c.cpu);
  const g = gpuInfo(c.gpu, c.cpu);
  const scr = screenScore(c.display, c.brand);
  const attrs = {
    cpu,
    gpu: g.score,
    ram_gb: c.ram_gb ?? null,
    storage_gb: c.storage_gb ?? null,
    screen: scr,
    battery_hours: posNum(c.battery_hours, 1, 30),
    weight_kg: posNum(c.weight_kg, 0.6, 5),
    build: null,
    service: SERVICE_BY_BRAND[c.brand] ?? null,
    warranty_months: posNum(c.warranty_months, 1, 60),
    keyboard: null,
    screen_inches: screenInches(c.screen_inches, c.display),
    os: osOf(c.os, c.brand, c.model),
    series: seriesFor(c.price_egp, cpu),
    has_dedicated_gpu: g.dedicated,
  };
  const out = Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== null && v !== undefined));
  const mapping = {
    cpu: cpu === null ? 'unknown' : `rule from "${c.cpu}"`,
    gpu: g.score === null ? 'unknown' : `rule from "${c.gpu || 'integrated'}"`,
    screen: scr === null ? 'unknown' : `rule from "${c.display || c.brand}"`,
    service: out.service ? 'brand table (docs/laptop-NOTES.md)' : 'unknown',
    build: 'not inferred', keyboard: 'not inferred',
  };
  return { attrs: out, mapping };
}
