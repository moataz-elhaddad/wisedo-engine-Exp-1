// Experiment B: attach search/shopping listings to consolidated candidates as evidence.
//
// For each candidate, every parsed listing that listingMatches() accepts (same brand, no conflicting spec, model
// name or MPN present) becomes evidence. An Egyptian listing with an EGP price also becomes a retailer offer
// (price_source "listing"). Listings never change a candidate's specs. Search evidence is kept apart from LLM
// consensus: providers that FOUND a product vs. pages that SUPPORT it.
import { parseListing, listingMatches, looksLikeProductPage, MIN_LAPTOP_PRICE_EGP } from './listings.js';

/**
 * @param {any[]} products   consolidated candidates (mutated: .listing_evidence, .offers, .evidence_urls)
 * @param {any[]} listings   raw listings from every search/shopping provider (phase 1 and phase 2)
 */
export function attachEvidence(products, listings) {
  const parsed = listings.map(parseListing);
  for (const p of products) {
    p.listing_evidence = [];
    for (const l of parsed) {
      if (l.for_key && l.for_key !== p.key) continue;
      const m = listingMatches(p, l);
      if (!m.match) continue;
      p.listing_evidence.push({ provider: l.provider, kind: l.kind, title: l.title, url: l.url, retailer: l.retailer, egypt: l.egypt, price: l.price, currency: l.currency, strength: m.strength });
      if (l.url && !p.evidence_urls.includes(l.url)) p.evidence_urls.push(l.url);
      const isShopRedirect = /google\.[a-z.]+\/(shopping|aclk|url)/.test(l.url || '');
      // An offer needs an Egyptian EGP price on a single-product listing (shop result, or a product page).
      const singleProduct = l.kind === 'shopping' || (l.url && looksLikeProductPage(l.url));
      if (l.egypt && l.price_egp >= MIN_LAPTOP_PRICE_EGP && singleProduct && (l.url || l.retailer) && m.strength !== 'model') {
        const key = l.url && !isShopRedirect ? l.url : `retailer:${String(l.retailer).toLowerCase()}`;
        const same = p.offers.find((o) => (o.url || `retailer:${String(o.retailer).toLowerCase()}`) === key);
        // The same shop page proposed by an LLM: the listing's price (from the search API) is better evidence.
        if (same && same.source !== 'listing') { same.listing_price_egp = l.price_egp; same.price_source = same.price_source || 'listing'; }
        if (!same) {
          p.offers.push({ retailer: l.retailer, url: isShopRedirect ? null : l.url, price_egp: l.price_egp, provider: l.provider, source: 'listing', listing_strength: m.strength });
        }
      }
    }
    p.evidence_providers = [...new Set(p.listing_evidence.map((e) => e.provider))];
    p.egypt_listings = p.listing_evidence.filter((e) => e.egypt).length;
    p.priced_listings = p.listing_evidence.filter((e) => e.egypt && e.currency === 'EGP' && e.price).length;
  }
  return { parsed: parsed.length };
}
