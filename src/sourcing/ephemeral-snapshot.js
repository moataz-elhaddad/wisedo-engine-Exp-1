// Experiment B: consolidated LLM candidates -> an in-memory CatalogSnapshot (docs/CONTRACTS.md), the same shape the
// D1 catalog produces, so the existing Recommendation Engine (src/layer2 match()) ranks them unchanged.
//
// The snapshot lives only for the current request. Nothing here writes to D1 or to wisedo-catalog.
//
// Facts the providers do not give are filled with explicit, flagged assumptions (never silently):
//   - delivery: every zone, fee 0, 3 days                    (offer.assumptions includes "delivery")
//   - retailer trust / COD / return days: table below, unknown shops trust 6, no COD, 7 days
//   - ref_price_egp: null (no deal bonus, no resale value) - a provider's price is not a reference price
//   - plans: none. Card / finance buyers get no installment quote (Layer 2 then drops those offers, as it would
//     for a catalog offer without a plan). Reported in the response.
// Only VERIFIED offers enter a final snapshot (direct Egyptian product page, EGP price, variant match: offers.js).
// Candidates without one are listed as unrankable with their exclusion reason. No search-link fallback exists.
import { laptopAttrs } from './specs.js';
import { isEgyptianProductPage } from './url-classify.js';

export const EPHEMERAL_TENANT = 'expb-ephemeral';

/** Known Egyptian retailers by host. trust 1..10 is an editorial assumption, same scale as the catalog's. */
const KNOWN_RETAILERS = [
  { id: 'amazon_eg', name: 'Amazon Egypt', hosts: ['amazon.eg'], names: ['amazon'], trust: 8, cod: true, return_days: 14 },
  { id: 'noon_eg', name: 'Noon Egypt', hosts: ['noon.com'], names: ['noon'], trust: 8, cod: true, return_days: 14 },
  { id: 'btech', name: 'B.TECH', hosts: ['btech.com'], names: ['b.tech', 'btech', 'b tech'], trust: 8, cod: true, return_days: 14 },
  { id: '2b', name: '2B Egypt', hosts: ['2b.com.eg'], names: ['2b'], trust: 8, cod: true, return_days: 14 },
  { id: 'raya', name: 'Raya Shop', hosts: ['rayashop.com'], names: ['raya'], trust: 8, cod: true, return_days: 14 },
  { id: 'jumia_eg', name: 'Jumia Egypt', hosts: ['jumia.com.eg'], names: ['jumia'], trust: 7, cod: true, return_days: 14 },
  { id: 'dubaiphone', name: 'Dubai Phone', hosts: ['dubaiphone.net'], names: ['dubai phone', 'dubaiphone'], trust: 7, cod: true, return_days: 14 },
  { id: 'compumarts', name: 'Compumarts', hosts: ['compumarts.com'], names: ['compumarts'], trust: 7, cod: true, return_days: 14 },
  { id: 'elbadr', name: 'El Badr Group', hosts: ['elbadrgroupeg.store', 'elbadrgroup.com'], names: ['el badr', 'elbadr', 'badr'], trust: 7, cod: true, return_days: 14 },
  { id: 'sigma', name: 'Sigma Computer', hosts: ['sigma-computer.com'], names: ['sigma'], trust: 7, cod: true, return_days: 14 },
  { id: 'elaraby', name: 'El Araby', hosts: ['elarabygroup.com'], names: ['elaraby', 'el araby'], trust: 7, cod: true, return_days: 14 },
  { id: 'apple_eg', name: 'Apple (official)', hosts: ['apple.com'], names: ['apple store'], trust: 9, cod: false, return_days: 14 },
  { id: 'dell_eg', name: 'Dell (official)', hosts: ['dell.com'], names: ['dell store'], trust: 9, cod: false, return_days: 14 },
  { id: 'hp_eg', name: 'HP (official)', hosts: ['hp.com'], names: ['hp store'], trust: 9, cod: false, return_days: 14 },
  { id: 'lenovo_eg', name: 'Lenovo (official)', hosts: ['lenovo.com'], names: ['lenovo store'], trust: 9, cod: false, return_days: 14 },
];

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/** Retailer for an offer, from its URL host first, then its name. Unknown shops get a conservative row. */
export function resolveRetailer(offer) {
  let host = null;
  try { host = offer.url ? new URL(offer.url).hostname.replace(/^www\./, '').toLowerCase() : null; } catch { host = null; }
  const name = String(offer.retailer || '').toLowerCase();
  const known = KNOWN_RETAILERS.find((r) => (host && r.hosts.some((h) => host === h || host.endsWith('.' + h)))) ||
    (!host ? KNOWN_RETAILERS.find((r) => r.names.some((n) => name === n || name.startsWith(n + ' ') || name.includes(n))) : null);
  if (known) return { id: known.id, name: known.name, trust: known.trust, cod: known.cod, return_days: known.return_days, base_url: `https://${known.hosts[0]}`, known: true };
  const label = offer.retailer || host || 'Unknown shop';
  return { id: `shop-${slugify(host || label) || 'unknown'}`, name: label, trust: 6, cod: false, return_days: 7, base_url: host ? `https://${host}` : null, known: false };
}


/**
 * @param {any[]} products   consolidated + verified candidates
 * @param {{configs: Record<string, any>, category: string, now: string|number|Date, requestId?: string}} ctx
 * @returns {{snapshot: any, index: Record<string, any>, unrankable: any[]}}
 */
export function buildEphemeralSnapshot(products, ctx) {
  const nowIso = new Date(ctx.now).toISOString();
  const retailers = new Map();
  const outProducts = [];
  const offers = [];
  const index = {};
  const unrankable = [];
  const usedIds = new Set();
  for (const p of products) {
    let id = `expb-${slugify(`${p.brand}-${p.model}`)}-${slugify([p.ram_gb && `${p.ram_gb}gb`, p.storage_gb && `${p.storage_gb}gb`, (p.signature || '').split('|')[3]].filter(Boolean).join('-'))}`;
    for (let k = 2; usedIds.has(id); k++) id = `${id.replace(/~\d+$/, '')}~${k}`;
    usedIds.add(id);
    const { attrs, mapping } = laptopAttrs(p);
    const name = [p.model, [p.cpu, p.ram_gb && `${p.ram_gb}GB`, p.storage_gb && (p.storage_gb >= 1024 ? `${p.storage_gb / 1024}TB` : `${p.storage_gb}GB`)].filter(Boolean).join(' / ')].filter(Boolean).join(' ');
    const product = {
      id, tenant_id: EPHEMERAL_TENANT, category: ctx.category, brand: p.brand, name,
      ref_price_egp: null, popular: false, aliases: p.mpn ? [p.mpn] : [], attrs,
      checked_at: nowIso, source: 'crawl',
    };
    // Final snapshots carry VERIFIED offers only (offers.js): direct Egyptian product page + EGP price + variant
    // match. The provisional mode (evidence targeting only, never ranked for the buyer) prices LLM claims.
    const provisional = ctx.mode === 'provisional';
    const listing = provisional
      ? (p.offers && p.offers.length ? p.offers : [{ retailer: null, url: null, price_egp: p.price_egp, provider: p.providers[0] }])
      : (p.verified_offers || []);
    const made = [];
    for (const o of listing) {
      const price = provisional ? (o.price_egp ?? (listing.length === 1 ? p.price_egp : null)) : o.price_egp;
      if (!(typeof price === 'number' && price > 0)) continue;
      if (!provisional && !(o.url && isEgyptianProductPage(o.url))) continue; // defence in depth
      const r = resolveRetailer(o);
      if (!retailers.has(r.id)) retailers.set(r.id, { id: r.id, tenant_id: EPHEMERAL_TENANT, name: o.retailer && !r.known ? o.retailer : r.name, trust: r.trust, return_days: r.return_days, cod: r.cod, base_url: r.base_url, affiliate_tag: null, source: 'crawl', known: r.known });
      const oid = `o-${id}-${r.id}`;
      if (made.some((x) => x.id === oid)) continue;
      made.push({
        id: oid, tenant_id: EPHEMERAL_TENANT, product_id: id, retailer_id: r.id,
        url: o.url || '', price_egp: price,
        delivery: Object.fromEntries((ctx.configs[ctx.category].zones.ids || []).map((z) => [z, { fee: 0, days: 3 }])),
        in_stock: true,
        official: p.grey_import !== true,
        extras: [], checked_at: nowIso, source: 'crawl',
        // Experiment metadata (ignored by Layer 2):
        url_kind: provisional ? 'provisional' : 'direct_product',
        price_source: provisional ? 'llm_claim' : o.price_source,
        found_by: o.provider || null,
        verification: provisional ? 'provisional' : o.page_check,
        match_strength: o.match_strength || null,
        assumptions: ['delivery', ...(r.known ? [] : ['retailer_terms'])],
      });
    }
    if (!made.length) { unrankable.push({ key: p.key, brand: p.brand, model: p.model, reason: provisional ? 'no claimed price' : (p.exclusion_reason || 'no_verified_offer') }); continue; }
    offers.push(...made);
    outProducts.push(product);
    index[id] = {
      key: p.key, mpn: p.mpn, status: p.status || null,
      raw: { cpu: p.cpu, ram_gb: p.ram_gb, storage_gb: p.storage_gb, gpu: p.gpu, display: p.display, os: p.os, weight_kg: p.weight_kg, battery_hours: p.battery_hours },
      attr_mapping: mapping,
      providers: p.providers, provider_count: p.provider_count, provider_consensus_score: p.provider_consensus_score,
      verification_status: p.verification_status, evidence_confidence: p.evidence_confidence,
      verified_price: p.verified_price ?? null, verified_retailer: p.verified_retailer ?? null, verified_product_url: p.verified_product_url ?? null,
      variant_match_strength: p.variant_match_strength ?? null, llm_claimed_price: p.llm_claimed_price ?? null, llm_claimed_retailer: p.llm_claimed_retailer ?? null,
      price_range: p.price_range, fit_reasons: p.fit_reasons,
      evidence_urls: (p.evidence_urls || []).slice(0, 12), evidence_providers: p.evidence_providers || [], listing_evidence: (p.listing_evidence || []).slice(0, 10), merged_because: p.merged_because, possible_duplicates: p.possible_duplicates,
    };
  }
  const snapshot = {
    snapshot_id: `expb-${ctx.requestId || Date.now().toString(36)}`,
    tenant_id: EPHEMERAL_TENANT,
    now: nowIso,
    configs: { [ctx.category]: ctx.configs[ctx.category] },
    products: outProducts,
    offers,
    retailers: [...retailers.values()],
    plans: [],
    ephemeral: true,
  };
  return { snapshot, index, unrankable };
}
