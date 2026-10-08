// Experiment B: the provider request built from the FINAL NeedProfile (Layer 1 output, unchanged).
// One request shape for every provider: {system, user, schema, maxTokens}. Each adapter maps it to its own API.
//
// The need is rendered from the profile itself (slot answers with the config's English labels, must/prefer
// filters with their reasons, money, logistics), so the providers see the same need the Recommendation Engine
// will score against. Free text the buyer typed is not forwarded: only the structured profile.

export const DISCOVERY_PROMPT_VERSION = 'expb-discovery-2';
export const MAX_CANDIDATES_PER_PROVIDER = 8;

const nul = (t) => ({ type: [t, 'null'] });

const OFFER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['retailer', 'url', 'price_egp'],
  properties: {
    retailer: { type: 'string', description: 'Shop name, e.g. Amazon Egypt, Noon Egypt, B.TECH, 2B, Raya Shop, Jumia Egypt' },
    url: { ...nul('string'), description: 'Product page URL at that shop. null when you do not know the exact URL; never invent one.' },
    price_egp: { ...nul('number'), description: 'Price in Egyptian pounds at that shop, null when unknown' },
  },
};

const CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['brand', 'model', 'mpn', 'cpu', 'ram_gb', 'storage_gb', 'gpu', 'display', 'screen_inches', 'os', 'weight_kg', 'battery_hours',
    'price_egp', 'price_basis', 'availability_egypt', 'grey_import', 'offers', 'fit_reasons', 'confidence', 'evidence', 'source_urls'],
  properties: {
    brand: { type: 'string' },
    model: { type: 'string', description: 'Full model name including generation, e.g. "IdeaPad Slim 3 15IAH8"' },
    mpn: { ...nul('string'), description: 'Exact manufacturer part / model number of THIS configuration (e.g. 83ER00ABED), null when unknown' },
    cpu: { ...nul('string'), description: 'Exact CPU, e.g. "Intel Core i5-12450H"' },
    ram_gb: nul('number'),
    storage_gb: { ...nul('number'), description: 'SSD size in GB (1 TB = 1024)' },
    gpu: { ...nul('string'), description: 'e.g. "NVIDIA GeForce RTX 4050 6GB" or "Intel UHD Graphics (integrated)"' },
    display: { ...nul('string'), description: 'Size, resolution, panel, refresh, e.g. "15.6in FHD IPS 144Hz"' },
    screen_inches: nul('number'),
    os: { ...nul('string'), description: 'Windows 11 / macOS / ChromeOS / FreeDOS' },
    weight_kg: nul('number'),
    battery_hours: { ...nul('number'), description: 'Typical light-use battery hours, null when unknown' },
    price_egp: { ...nul('number'), description: 'Current typical price in Egypt in EGP, null when unknown' },
    price_basis: { type: 'string', enum: ['seen_on_retailer_page', 'recent_knowledge', 'estimate', 'unknown'] },
    availability_egypt: { type: 'string', enum: ['in_stock', 'likely_available', 'uncertain', 'out_of_stock', 'unknown'] },
    grey_import: { ...nul('boolean'), description: 'true when sold in Egypt only as an import without local agent warranty' },
    offers: { type: 'array', items: OFFER_SCHEMA, maxItems: 4 },
    fit_reasons: { type: 'array', items: { type: 'string' }, maxItems: 5, description: 'Why it fits THIS buyer need' },
    confidence: { type: 'number', description: '0..1 how sure you are that this exact configuration exists and is sold in Egypt at about this price' },
    evidence: { type: 'string', description: 'Where the facts come from (pages searched, or "from training knowledge")' },
    source_urls: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Pages you actually read that support this candidate (reviews, spec pages, listings). Empty when none.' },
  },
};

export const DISCOVERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates'],
  properties: { candidates: { type: 'array', items: CANDIDATE_SCHEMA, maxItems: MAX_CANDIDATES_PER_PROVIDER } },
};

const en = (x) => (x && typeof x === 'object' ? x.en || x.ar || '' : String(x ?? ''));

/** Option label for a slot value (or the raw value). */
function valueText(slot, value) {
  const vals = Array.isArray(value) ? value : [value];
  return vals.map((v) => {
    const o = (slot.options || []).find((x) => x.id === v);
    return o ? en(o.label) : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }).join(', ');
}

const SKIP_SLOTS = new Set(['pay', 'provider', 'budget', 'monthlyCap', 'down', 'city', 'cod', 'shops', 'urgentDays', 'acceptImports']);

/**
 * Plain-English description of a NeedProfile, from the config's own labels.
 * @param {any} profile
 * @param {any} config
 * @returns {string}
 */
export function describeNeed(profile, config) {
  const lines = [];
  const slots = new Map((config.slots || []).map((s) => [s.id, s]));
  lines.push(`Category: ${en(config.label) || config.id}`);
  for (const n of profile.needs || []) {
    const slot = slots.get(n.slot);
    if (!slot || SKIP_SLOTS.has(n.slot) || n.value === null || n.value === undefined) continue;
    const assumed = n.source === 'default' ? ' (assumed default)' : '';
    lines.push(`- ${en(slot.label)}: ${valueText(slot, n.value)}${assumed}`);
  }
  const m = profile.money || {};
  if (typeof m.budget === 'number') lines.push(`- Budget: up to ${m.budget} EGP (hard ceiling; cheaper is fine)`);
  else lines.push('- Budget: not stated');
  if (m.pay) lines.push(`- Payment: ${m.pay}${typeof m.monthlyCap === 'number' ? `, max ${m.monthlyCap} EGP/month` : ''}`);
  const l = profile.logistics || {};
  lines.push(`- Delivery city: ${l.city || 'anywhere in Egypt'}`);
  if (l.acceptImports !== true) lines.push('- Wants official local warranty (no grey imports)');
  if (profile.modelInMind) lines.push(`- Model the buyer mentioned: ${profile.modelInMind}`);
  const must = (profile.must || []).map((f) => en(f.why) || `${f.attr} ${f.op} ${JSON.stringify(f.value)}`);
  const prefer = (profile.prefer || []).map((f) => en(f.why) || `${f.attr} ${f.op} ${JSON.stringify(f.value)}`);
  if (must.length) lines.push(`Hard requirements: ${must.join('; ')}`);
  if (prefer.length) lines.push(`Preferences (nice to have): ${prefer.join('; ')}`);
  const w = Object.entries(profile.weights || {}).filter(([, v]) => typeof v === 'number' && v > 0).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const attr = new Map((config.attributes || []).map((a) => [a.id, a]));
  if (w.length) lines.push(`What matters most (in order): ${w.map(([k]) => en(attr.get(k) && attr.get(k).label) || k).join(', ')}`);
  return lines.join('\n');
}

const SYSTEM = [
  'You are a product researcher for buyers in Egypt. You suggest specific laptop configurations that a buyer can actually buy in Egypt today.',
  'Rules:',
  '- Prioritise products sold now by Egyptian retailers (Amazon.eg, Noon Egypt, B.TECH, 2B, Raya Shop, Jumia Egypt, Dubai Phone, Compumarts, El Badr and similar). Prices in EGP.',
  '- Each candidate is ONE exact configuration (CPU, RAM, storage, GPU). Never merge different configurations of a model family into one entry.',
  '- Give the exact model number (MPN) when you know it; otherwise null.',
  '- Never invent URLs. Give a product URL only when you have seen it or are confident it is the exact product page; otherwise url = null.',
  '- When you are unsure of a fact, use null and lower the confidence. Do not guess specs.',
  '- Respect the hard requirements and the budget ceiling. Suggest between 4 and 8 candidates, best fit first.',
  '- Answer only with the JSON object requested.',
].join('\n');

/** Plain search queries for the web-search and shopping providers, from the same NeedProfile. */
export function searchQueries(profile, config) {
  const filters = [...(profile.must || []), ...(profile.prefer || [])];
  const ram = filters.find((f) => f.attr === 'ram_gb' && (f.op === '>=' || f.op === '=='));
  const storage = filters.find((f) => f.attr === 'storage_gb' && (f.op === '>=' || f.op === '=='));
  const os = filters.find((f) => f.attr === 'os' && f.op === 'in');
  const gpu = filters.find((f) => f.attr === 'has_dedicated_gpu' && f.value === true);
  const useNeed = (profile.needs || []).find((n) => n.slot === 'use');
  const useSlot = (config.slots || []).find((x) => x.id === 'use');
  const uses = useNeed && useSlot ? valueText(useSlot, useNeed.value).toLowerCase() : '';
  const budget = profile.money && typeof profile.money.budget === 'number' ? profile.money.budget : null;
  const specs = [ram && `${ram.value}GB RAM`, storage && `${storage.value >= 1024 ? storage.value / 1024 + 'TB' : storage.value + 'GB'} SSD`, gpu && 'RTX',
    os && Array.isArray(os.value) && os.value.includes('macos') ? 'MacBook' : null].filter(Boolean).join(' ');
  return {
    web: `best laptop ${uses ? 'for ' + uses + ' ' : ''}${specs} ${budget ? `under ${budget} EGP ` : ''}price in Egypt`.replace(/\s+/g, ' ').trim(),
    shopping: `laptop ${specs}`.replace(/\s+/g, ' ').trim(),
    budget,
  };
}

/**
 * The provider-neutral discovery request.
 * @param {any} profile  final NeedProfile
 * @param {any} config   category config
 */
export function buildDiscoveryRequest(profile, config) {
  const user = `Buyer need (from a structured needs interview):\n${describeNeed(profile, config)}\n\n` +
    `Find up to ${MAX_CANDIDATES_PER_PROVIDER} laptop configurations available in Egypt that fit this need. ` +
    'Return {"candidates": [...]} following the schema.';
  return { kind: 'discovery', version: DISCOVERY_PROMPT_VERSION, system: SYSTEM, user, schema: DISCOVERY_SCHEMA, maxTokens: 8000, queries: searchQueries(profile, config) };
}
