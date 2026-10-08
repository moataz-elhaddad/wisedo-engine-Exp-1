// Experiment B: conservative consolidation (entity resolution) of candidates across providers.
//
// Two candidates are the same product only when ALL of these hold:
//   - same canonical brand;
//   - MPNs do not contradict (both present and different => never merged);
//   - the configuration signature is fully known on both sides and identical:
//       CPU model token, RAM GB, storage GB, GPU token (dedicated model or "integrated");
//   - and the model names agree: equal MPN, or model-name token overlap (Jaccard) >= MODEL_SIMILARITY.
// Anything less certain stays separate. Same brand + similar model name with a different or incomplete signature
// is kept separate and only cross-referenced as a "possible duplicate" for the reviewer.
// Same provider listing the same configuration twice is collapsed too (counted once for consensus).

export const MODEL_SIMILARITY = 0.6;

const lc = (s) => String(s ?? '').toLowerCase().replace(/جيجا(?:بايت)?/g, 'gb').replace(/تيرا(?:بايت)?/g, 'tb');

/** Specific CPU token: "i5-12450h", "ultra7-155h", "ryzen7-7735hs", "m3pro", "snapdragonx-elite"; null when vague. */
export function cpuToken(cpu) {
  const s = lc(cpu).replace(/®|™|\(r\)|\(tm\)/g, '');
  let m;
  if ((m = s.match(/core\s*ultra\s*([579])\s*-?\s*(\d{3}[a-z]*)/))) return `ultra${m[1]}-${m[2]}`;
  if ((m = s.match(/\bi([3579])\s*-?\s*(\d{4,5}[a-z]*)/))) return `i${m[1]}-${m[2]}`;
  if ((m = s.match(/\bcore\s*([357])\s*-?\s*(\d{3}[a-z]*)/))) return `core${m[1]}-${m[2]}`;
  if ((m = s.match(/ryzen\s*ai\s*([579])\s*(?:hx\s*)?(\d{3}[a-z]*)/))) return `ryzenai${m[1]}-${m[2]}`;
  if ((m = s.match(/ryzen\s*([3579])\s*(?:pro\s*)?-?\s*(\d{4}[a-z]*)/))) return `ryzen${m[1]}-${m[2]}`;
  if ((m = s.match(/\bm([1-5])\b(?:\s*(pro|max|ultra))?/)) && /apple|\bm[1-5]\b/.test(s)) {
    const cores = s.match(/(\d{1,2})\s*-?\s*core\s*cpu/);
    return `m${m[1]}${m[2] || ''}${cores ? `-${cores[1]}c` : ''}`;
  }
  if ((m = s.match(/snapdragon\s*x\s*(elite|plus)?\s*([a-z0-9-]*)/))) return `snapdragonx-${m[1] || ''}${m[2] ? '-' + m[2] : ''}`;
  if ((m = s.match(/\b(n\d{3,4}|celeron\s*n?\d{4}|pentium\s*\w+|athlon\s*\w+)/))) return m[1].replace(/\s+/g, '');
  return null;
}

/** GPU token: "rtx4050", "rtx4060", "rx7600s", "integrated"; null when unknown. */
export function gpuToken(gpu, cpu) {
  const s = lc(gpu);
  let m;
  if ((m = s.match(/rtx\s*(a?\d{4})(\s*ti)?/))) return `rtx${m[1]}${m[2] ? 'ti' : ''}`;
  if ((m = s.match(/gtx\s*(\d{3,4})(\s*ti)?/))) return `gtx${m[1]}${m[2] ? 'ti' : ''}`;
  if ((m = s.match(/\brx\s*(\d{4}[a-z]*)/))) return `rx${m[1]}`;
  if ((m = s.match(/\barc\s*(a\d{3}m?)/))) return `arc${m[1]}`;
  if ((m = s.match(/\bmx\s*(\d{3})/))) return `mx${m[1]}`;
  if (/integrated|iris|uhd|intel\s*(arc\s*)?graphics|radeon\s*(\d{3}m|graphics)|adreno|apple|\barc\s*graphics/.test(s)) return 'integrated';
  if (!s.trim() && /apple|\bm[1-5]\b/.test(lc(cpu))) return 'integrated';
  return null;
}

const STOP = new Set(['laptop', 'notebook', 'gaming', 'with', 'and', 'the', 'gb', 'ssd', 'ram', 'inch', 'fhd', 'intel', 'amd', 'core', 'windows', 'win', 'gen', 'new', 'edition']);

/** Model-name tokens, without spec words and the brand. */
export function modelTokens(model, brand) {
  const b = lc(brand);
  return new Set(lc(model).replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter((t) => t && t !== b && !STOP.has(t) && !/^\d+(gb|tb)$/.test(t)));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function containment(small, big) {
  if (!small.size) return 0;
  let inter = 0;
  for (const t of small) if (big.has(t)) inter++;
  return inter / small.size;
}

const normMpn = (m) => (m ? lc(m).replace(/[^a-z0-9]/g, '') : null);

/** Configuration signature, or null when any part is unknown (then the candidate is never merged). */
export function signature(c) {
  const cpu = cpuToken(c.cpu);
  const gpu = gpuToken(c.gpu, c.cpu);
  if (!cpu || !gpu || !c.ram_gb || !c.storage_gb) return null;
  return `${cpu}|${c.ram_gb}|${c.storage_gb}|${gpu}`;
}

/**
 * Decide whether two candidates are the same product configuration.
 * @returns {{same: boolean, why: string}}
 */
export function sameProduct(a, b) {
  if (a.brand !== b.brand) return { same: false, why: 'brand differs' };
  const ma = normMpn(a.mpn), mb = normMpn(b.mpn);
  if (ma && mb && ma !== mb) return { same: false, why: 'MPN differs' };
  const sa = signature(a), sb = signature(b);
  if (!sa || !sb) return { same: false, why: 'configuration incomplete' };
  if (sa !== sb) return { same: false, why: 'configuration differs' };
  if (ma && mb && ma === mb) return { same: true, why: 'same MPN and configuration' };
  const ta = modelTokens(a.model, a.brand), tb = modelTokens(b.model, b.brand);
  const sim = jaccard(ta, tb);
  if (sim >= MODEL_SIMILARITY) return { same: true, why: `same configuration, model names agree (${sim.toFixed(2)})` };
  // A shop title usually carries extra words ("15IAH8 Arctic Grey"): the shorter name contained in the longer one
  // counts too, when that shorter name has at least 3 tokens (so "IdeaPad 3" alone never matches everything).
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  const cont = containment(small, big);
  if (small.size >= 3 && cont >= 0.9) return { same: true, why: `same configuration, model name contained (${cont.toFixed(2)})` };
  return { same: false, why: `model names differ (${sim.toFixed(2)})` };
}

const median = (xs) => {
  const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b);
  if (!v.length) return null;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};
/** Most common non-null value (first seen wins a tie). */
const mode = (xs) => {
  const counts = new Map();
  for (const x of xs) if (x !== null && x !== undefined && x !== '') counts.set(x, (counts.get(x) || 0) + 1);
  let best = null, n = 0;
  for (const [k, c] of counts) if (c > n) { best = k; n = c; }
  return best;
};

/**
 * Consolidate normalised candidates from every provider.
 * @param {any[]} candidates   normalised candidates (normalize.js), each with .provider
 * @param {string[]} providersAsked  providers that returned a usable answer (consensus denominator)
 * @returns {any[]} consolidated products, ordered by provider_count desc, then first appearance
 */
export function consolidate(candidates, providersAsked) {
  /** @type {{members: any[], why: string[]}[]} */
  const groups = [];
  for (const c of candidates) {
    let placed = false;
    for (const g of groups) {
      const r = sameProduct(g.members[0], c);
      if (r.same) { g.members.push(c); g.why.push(`${c.provider}: ${r.why}`); placed = true; break; }
    }
    if (!placed) groups.push({ members: [c], why: [] });
  }
  const denom = Math.max(1, new Set(providersAsked).size);
  const out = groups.map((g, i) => {
    const m = g.members;
    const providers = [...new Set(m.map((x) => x.provider))];
    const first = m[0];
    const prices = m.map((x) => x.price_egp).filter((x) => typeof x === 'number');
    const offers = [];
    const seen = new Set();
    for (const x of m) for (const o of x.offers) {
      const key = o.url || `${lc(o.retailer)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      offers.push({ ...o, provider: x.provider });
    }
    return {
      key: `c${i + 1}`,
      brand: first.brand,
      model: mode(m.map((x) => x.model)) || first.model,
      mpn: mode(m.map((x) => x.mpn)),
      cpu: mode(m.map((x) => x.cpu)),
      ram_gb: first.ram_gb, storage_gb: first.storage_gb,
      gpu: mode(m.map((x) => x.gpu)),
      display: mode(m.map((x) => x.display)),
      screen_inches: mode(m.map((x) => x.screen_inches)),
      os: mode(m.map((x) => x.os)),
      weight_kg: median(m.map((x) => x.weight_kg)),
      battery_hours: median(m.map((x) => x.battery_hours)),
      warranty_months: median(m.map((x) => x.warranty_months)),
      price_egp: prices.length ? Math.round(median(prices)) : null,
      price_range: prices.length ? [Math.min(...prices), Math.max(...prices)] : null,
      grey_import: m.some((x) => x.grey_import === true) ? true : m.some((x) => x.grey_import === false) ? false : null,
      availability: mode(m.map((x) => x.availability)) || 'unknown',
      offers,
      fit_reasons: m.flatMap((x) => x.fit_reasons.map((r) => ({ provider: x.provider, text: r }))).slice(0, 8),
      provider_confidence: Object.fromEntries(m.map((x) => [x.provider, x.confidence])),
      evidence: m.map((x) => ({ provider: x.provider, text: x.evidence, price_basis: x.price_basis })),
      evidence_urls: [...new Set(m.flatMap((x) => [...(x.evidence_urls || []), ...x.offers.map((o) => o.url)]).filter(Boolean))],
      found_at: m.map((x) => x.timestamp).filter(Boolean)[0] || null,
      signature: signature(first),
      // Consensus: kept apart from fit, price and evidence. It is metadata, never a score input.
      providers,
      provider_count: providers.length,
      provider_consensus_score: Math.round((providers.length / denom) * 100) / 100,
      merged_because: g.why,
      possible_duplicates: [],
      first_index: i,
    };
  });
  // Possible duplicates: same brand, similar model name, kept apart because the configuration differs or is incomplete.
  for (const a of out) for (const b of out) {
    if (a === b || a.brand !== b.brand) continue;
    if (jaccard(modelTokens(a.model, a.brand), modelTokens(b.model, b.brand)) >= MODEL_SIMILARITY) a.possible_duplicates.push(b.key);
  }
  return out.sort((x, y) => y.provider_count - x.provider_count || x.first_index - y.first_index);
}
