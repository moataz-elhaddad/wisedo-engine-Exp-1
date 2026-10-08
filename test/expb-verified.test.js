// Experiment B: only verified Egyptian direct product listings become offers; everything else is evidence or a claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as F from './expb-fixtures.js';
import { classifyUrl, isEgyptianProductPage } from '../src/sourcing/url-classify.js';
import { collectOffers, verifyOffers, candidateReport, exclusionCounts } from '../src/sourcing/offers.js';
import { normalizeProviderOutput } from '../src/sourcing/normalize.js';
import { consolidate } from '../src/sourcing/consolidate.js';
import { buildEphemeralSnapshot } from '../src/sourcing/ephemeral-snapshot.js';
import { buildDiscoveryRequest } from '../src/sourcing/discovery-prompt.js';
import { exactQueries } from '../src/sourcing/search-providers.js';
import { match } from '../src/layer2/index.js';
import { validateSnapshot } from '../src/contracts.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const norm = (c, provider) => normalizeProviderOutput({ candidates: [c] }, provider, F.NOW).candidates[0];
const listing = (title, url, price, source = 'shop') => F.asListing({ title, link: url, price, source });

/** Run the offer pipeline on one LLM candidate + listings + pages; return the product and its snapshot. */
async function run(cand, listings = [], pages = {}) {
  const products = consolidate([norm(cand, 'gemini')], ['gemini']);
  collectOffers(products, listings);
  await verifyOffers(products, { fetch: F.fakeFetch({}, pages) });
  const built = buildEphemeralSnapshot(products, { configs: F.CONFIGS, category: 'laptop', now: F.NOW });
  return { p: products[0], ...built };
}

const IDEAPAD_TITLE = 'Lenovo IdeaPad Slim 3 15IAH8 Laptop - Intel Core i5-12450H, 16GB RAM, 512GB SSD, Intel UHD Graphics';
const NO_URL = { ...F.X, offers: [{ retailer: 'B.TECH', url: null, price_egp: 33000 }] };

// --- URL classification --------------------------------------------------------------------------------------

test('URL classification: every page type, and only Egyptian direct product pages can sell', () => {
  const cases = {
    'https://www.amazon.eg/dp/B0CX23V2ZK': ['direct_product', true],
    'https://www.noon.com/egypt-en/asus-tuf-gaming-f15/N70098765V/p/': ['direct_product', true],
    'https://www.jumia.com.eg/asus-tuf-gaming-f15-fx507zc4-i5-12500h-16gb-512gb-rtx3050-123456789.html': ['direct_product', true],
    'https://btech.com/en/laptops/c/123': ['category', true],
    'https://2b.com.eg/en/computers/laptops.html': ['category', true],
    'https://www.amazon.eg/s?k=asus+tuf': ['search_results', true],
    'https://www.google.com/search?q=asus+tuf+egypt': ['search_results', false],
    'https://btech.com/en/': ['homepage', true],
    'https://www.asus.com/laptops/for-gaming/tuf-gaming/asus-tuf-gaming-f15-2023/': ['manufacturer_specs', false],
    'https://www.notebookcheck.net/Asus-TUF-Gaming-F15-review.html': ['article', false],
    'https://www.dubizzle.com.eg/en/ad/asus-tuf-f15-ID12345.html': ['classified', true],
    'https://eg.pricena.com/en/product/asus-tuf-f15-price-in-egypt': ['comparison', true],
    'https://www.amazon.ae/dp/B0CX23V2ZK': ['foreign_store', false],
    'https://www.noon.com/saudi-en/asus-tuf-gaming-f15/N70098765V/p/': ['foreign_store', false],
  };
  for (const [url, [type, egypt]] of Object.entries(cases)) {
    const c = classifyUrl(url);
    assert.equal(c.type, type, url);
    assert.equal(c.egypt, egypt, url);
  }
  assert.equal(isEgyptianProductPage('https://www.amazon.eg/dp/B0CX23V2ZK'), true);
  assert.equal(isEgyptianProductPage('https://www.amazon.ae/dp/B0CX23V2ZK'), false);
  assert.equal(classifyUrl('https://www.noon.com/uae-en/x/N70098765V/p/').country, 'AE');
  assert.equal(classifyUrl('https://www.jarir.com/sa-en/asus-tuf-gaming-laptop-12345.html').country, 'SA');
});

// --- offer decisions -----------------------------------------------------------------------------------------

test('a direct Egyptian product page with the exact variant and an EGP price is a verified offer', async () => {
  const url = 'https://www.amazon.eg/dp/B0IDEAPAD3';
  const { p, snapshot } = await run(F.X, [listing(IDEAPAD_TITLE, url, 'EGP 32,499.00', 'Amazon.eg')], F.PAGES);
  assert.equal(p.status, 'verified');
  assert.equal(p.verified_product_url, url);
  assert.equal(p.verified_price, 32999, 'the page price (verified) wins over the listing');
  assert.equal(p.verified_retailer, 'Amazon Egypt');
  assert.equal(p.country, 'EG');
  assert.equal(p.currency, 'EGP');
  assert.equal(snapshot.products.length, 1);
  assert.equal(snapshot.offers[0].url, url);
  assert.equal(validateSnapshot(snapshot).ok, true);
});

test('UAE listing rejected: wrong country, not rankable', async () => {
  const url = 'https://www.amazon.ae/dp/B0IDEAPAD3';
  const { p, snapshot, unrankable } = await run(NO_URL, [listing(IDEAPAD_TITLE, url, 'AED 2,499.00', 'Amazon.ae')], { [url]: '<title>Lenovo IdeaPad Slim 3 15IAH8</title>' });
  assert.equal(p.status, 'discovered_unverified');
  assert.equal(p.exclusion_reason, 'wrong_country');
  assert.equal(snapshot.products.length, 0);
  assert.equal(unrankable[0].reason, 'wrong_country');
  const noonUae = await run({ ...F.X, offers: [{ retailer: 'Noon', url: 'https://www.noon.com/uae-en/ideapad/N70012345V/p/', price_egp: 33000 }] });
  assert.equal(noonUae.p.exclusion_reason, 'wrong_country');
});

test('Saudi listing rejected: wrong country, not rankable', async () => {
  const url = 'https://www.jarir.com/sa-en/lenovo-ideapad-slim-3-15iah8-i5-12450h-16gb-512gb-123456.html';
  const { p, snapshot } = await run(NO_URL, [listing(IDEAPAD_TITLE, url, 'SAR 2,899.00', 'Jarir')]);
  assert.equal(p.exclusion_reason, 'wrong_country');
  assert.equal(snapshot.offers.length, 0);
  const noonKsa = await run({ ...F.X, offers: [{ retailer: 'Noon', url: 'https://www.noon.com/saudi-en/ideapad/N70012345V/p/', price_egp: 33000 }] });
  assert.equal(noonKsa.p.exclusion_reason, 'wrong_country');
});

test('manufacturer page is evidence only: supports the specs, never an offer', async () => {
  const url = 'https://www.lenovo.com/us/en/p/laptops/ideapad/ideapad-slim-3-15iah8-i5-12450h-16gb-512gb/82xb0005us';
  const { p, snapshot } = await run(NO_URL, [listing(IDEAPAD_TITLE, url, '$549.99', 'Lenovo', 'web')]);
  assert.equal(p.status, 'discovered_unverified');
  assert.equal(p.exclusion_reason, 'manufacturer_evidence_only');
  assert.equal(p.verification_status, 'evidence_only');
  assert.ok(p.evidence_sources.some((e) => e.type === 'manufacturer_specs'));
  assert.equal(snapshot.products.length, 0);
});

test('category page rejected even on an Egyptian retailer', async () => {
  const url = 'https://btech.com/en/laptops/c/lenovo';
  const { p, snapshot } = await run(NO_URL, [listing(IDEAPAD_TITLE, url, 'EGP 32,999.00', 'B.TECH')], { [url]: `<title>${IDEAPAD_TITLE}</title>` });
  assert.equal(p.exclusion_reason, 'category_or_search_page');
  assert.equal(snapshot.products.length, 0);
});

test('Google search URL rejected, and never used as a fallback link', async () => {
  const g = 'https://www.google.com/search?q=Lenovo+IdeaPad+Slim+3+15IAH8+egypt';
  const { p, snapshot, unrankable } = await run({ ...F.X, offers: [{ retailer: 'Google', url: g, price_egp: 33000 }] });
  assert.equal(p.status, 'discovered_unverified');
  assert.ok(['category_or_search_page', 'no_direct_url'].includes(p.exclusion_reason), p.exclusion_reason);
  assert.equal(snapshot.offers.length, 0);
  assert.equal(unrankable.length, 1);
  assert.equal(p.verified_product_url, null);
});

test('no direct URL: an LLM price and retailer alone are claims, the product is not rankable', async () => {
  const { p, snapshot, unrankable } = await run(NO_URL);
  assert.equal(p.status, 'discovered_unverified');
  assert.equal(p.exclusion_reason, 'no_direct_url');
  assert.equal(p.llm_claimed_price, 33000, 'the claim is kept for research');
  assert.equal(p.llm_claimed_retailer, 'B.TECH');
  assert.equal(p.verified_price, null);
  assert.equal(snapshot.products.length, 0);
  assert.equal(snapshot.offers.length, 0);
  assert.equal(unrankable.length, 1);
});

test('LLM URL on an Egyptian product page: the LLM price is never used, only the page price', async () => {
  const url = 'https://www.amazon.eg/dp/B0IDEAPAD3';
  const { p } = await run({ ...F.X, price_egp: 21000, offers: [{ retailer: 'Amazon Egypt', url, price_egp: 21000 }] }, [], F.PAGES);
  assert.equal(p.status, 'verified');
  assert.equal(p.verified_price, 32999);
  assert.equal(p.llm_claimed_price, 21000);
  const noPrice = await run({ ...F.X, offers: [{ retailer: 'Amazon Egypt', url, price_egp: 33000 }] }, [], { [url]: `<title>${IDEAPAD_TITLE}</title>` });
  assert.equal(noPrice.p.status, 'discovered_unverified', 'an LLM price never fills a missing page price');
  assert.equal(noPrice.p.exclusion_reason, 'no_egyptian_price');
});

test('wrong MPN does not verify', async () => {
  const cand = { ...F.X, mpn: '82XB0005ED', offers: [] };
  const url = 'https://www.amazon.eg/dp/B0OTHERMPN';
  const { p, snapshot } = await run(cand, [{ ...listing(`${IDEAPAD_TITLE} 82XB0009ED`, url, 'EGP 31,999.00', 'Amazon.eg'), for_key: null }]);
  assert.notEqual(p.status, 'verified');
  assert.equal(snapshot.products.length, 0);
  // searched for this exact candidate: the conflict is reported as a variant mismatch
  const products = consolidate([norm(cand, 'gemini')], ['gemini']);
  collectOffers(products, [{ ...listing(`${IDEAPAD_TITLE} 82XB0009ED`, url, 'EGP 31,999.00'), for_key: products[0].key }]);
  await verifyOffers(products, { fetch: F.fakeFetch({}, {}) });
  assert.equal(products[0].exclusion_reason, 'variant_mismatch');
});

test('a different GPU variant does not verify', async () => {
  const cand = { ...F.X, brand: 'Asus', model: 'TUF Gaming F15 FX507ZU4', cpu: 'Intel Core i7-12700H', gpu: 'NVIDIA GeForce RTX 4050', price_egp: 52000, offers: [] };
  const url = 'https://www.amazon.eg/dp/B0TUFRTX40';
  const products = consolidate([norm(cand, 'gemini')], ['gemini']);
  collectOffers(products, [{ ...listing('ASUS TUF Gaming F15 FX507ZU4 Intel Core i7-12700H 16GB 512GB NVIDIA GeForce RTX 4060', url, 'EGP 55,999.00', 'Amazon.eg'), for_key: products[0].key }]);
  await verifyOffers(products, { fetch: F.fakeFetch({}, {}) });
  assert.equal(products[0].status, 'discovered_unverified');
  assert.equal(products[0].exclusion_reason, 'variant_mismatch');
  assert.ok(products[0].rejections.some((r) => /gpu differs/.test(r.detail)));
});

test('family-only match (model, no specs) is weak evidence, not an offer', async () => {
  const url = 'https://www.amazon.eg/dp/B0IDEAFAM1';
  const { p } = await run(NO_URL, [listing('Lenovo IdeaPad Slim 3 15IAH8', url, 'EGP 30,000.00', 'Amazon.eg')], { [url]: '<title>Lenovo IdeaPad Slim 3</title>' });
  assert.equal(p.status, 'discovered_unverified');
  assert.equal(p.exclusion_reason, 'weak_evidence');
});

test('unreachable and out-of-stock pages do not verify', async () => {
  const url = 'https://www.amazon.eg/dp/B0IDEAPAD3';
  const gone = await run(NO_URL, [listing(IDEAPAD_TITLE, url, 'EGP 32,499.00')], {});
  assert.equal(gone.p.exclusion_reason, 'unreachable');
  const oos = await run(NO_URL, [listing(IDEAPAD_TITLE, url, 'EGP 32,499.00')], { [url]: `<title>${IDEAPAD_TITLE}</title><script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","price":"32999","priceCurrency":"EGP","availability":"https://schema.org/OutOfStock"}}</script>` });
  assert.equal(oos.p.exclusion_reason, 'out_of_stock');
  const az = await run(NO_URL, [listing(IDEAPAD_TITLE, url, 'EGP 32,499.00')], { [url]: `<title>${IDEAPAD_TITLE}</title><div id="availability"><span>Currently unavailable.</span></div>` });
  assert.equal(az.p.exclusion_reason, 'out_of_stock', 'Amazon availability block');
  // live regression: "Sold out" / "Out of stock" in templates and related-product widgets is not this product's stock
  const tpl = await run(NO_URL, [listing(IDEAPAD_TITLE, url, 'EGP 32,499.00')], { [url]: `<title>${IDEAPAD_TITLE}</title><script>var t={"sold_out":"Sold out","oos":"Out of stock"}</script><script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","price":"32999","priceCurrency":"EGP","availability":"http://schema.org/InStock"}}</script><div class="related">Out of stock</div>` });
  assert.equal(tpl.p.status, 'verified');
  assert.equal(tpl.p.verified_price, 32999);
});

test('classified and comparison listings never sell', async () => {
  const dub = 'https://www.dubizzle.com.eg/en/ad/lenovo-ideapad-slim-3-15iah8-i5-12450h-ID123456789.html';
  const a = await run(NO_URL, [listing(IDEAPAD_TITLE, dub, 'EGP 23,000')]);
  assert.equal(a.p.exclusion_reason, 'classified_listing');
  const pr = 'https://eg.pricena.com/en/product/lenovo-ideapad-slim-3-15iah8-price-in-egypt-123456';
  const b = await run(NO_URL, [listing(IDEAPAD_TITLE, pr, 'EGP 31,000')]);
  assert.equal(b.p.exclusion_reason, 'comparison_site');
});

// --- snapshot, engine, Top results ---------------------------------------------------------------------------

test('only verified offers reach the engine: every snapshot offer is an Egyptian direct product page with a non-LLM EGP price', async () => {
  const products = consolidate([norm(F.X, 'a'), norm(F.Y, 'a'), norm(F.Z, 'b'), norm(F.A, 'b'), norm(F.NO_PRICE, 'a'), norm(NO_URL, 'c')], ['a', 'b', 'c']);
  collectOffers(products, F.EG_LISTINGS);
  await verifyOffers(products, { fetch: F.fakeFetch({}, F.PAGES) });
  const { snapshot, index, unrankable } = buildEphemeralSnapshot(products, { configs: F.CONFIGS, category: 'laptop', now: F.NOW });
  assert.ok(snapshot.offers.length >= 1);
  for (const o of snapshot.offers) {
    assert.equal(isEgyptianProductPage(o.url), true, o.url);
    assert.ok(['listing', 'page'].includes(o.price_source));
    assert.ok(o.price_egp >= 8000);
  }
  for (const p of snapshot.products) assert.equal(index[p.id].status, 'verified');
  assert.ok(unrankable.every((u) => u.reason));
  const r = match(F.PROFILE, snapshot, F.NOW, 'rank');
  for (const pick of r.picks) assert.ok(snapshot.products.some((p) => p.id === pick.product.id));
  const counts = exclusionCounts(products);
  assert.ok(Object.values(counts).reduce((a, b) => a + b, 0) === products.filter((p) => p.status !== 'verified').length);
});

test('observability: every candidate reports discovery, claims, verification and exclusion fields', async () => {
  const { p } = await run(NO_URL);
  const row = candidateReport(p);
  for (const k of ['discovered_by', 'llm_claimed_price', 'llm_claimed_retailer', 'verified_price', 'verified_retailer', 'verified_product_url',
    'verification_status', 'exclusion_reason', 'country', 'currency', 'variant_match_strength', 'evidence_sources']) assert.ok(k in row, k);
  assert.deepEqual(row.discovered_by, ['gemini']);
});

test('fewer than three verified: Top results are not backfilled; zero verified gives the explicit message', async () => {
  const { topThree } = await import('../worker/expb.js');
  const products = consolidate([norm(F.X, 'a'), norm(NO_URL, 'b'), norm({ ...F.Y, offers: [] }, 'a')], ['a', 'b']);
  collectOffers(products, [F.EG_LISTINGS[0]]);
  await verifyOffers(products, { fetch: F.fakeFetch({}, F.PAGES) });
  const { snapshot, index } = buildEphemeralSnapshot(products, { configs: F.CONFIGS, category: 'laptop', now: F.NOW });
  const r = match(F.PROFILE, snapshot, F.NOW, 'rank');
  const top = topThree(r, snapshot, index);
  assert.equal(top.length, 1, 'one verified product -> one Top result, no unverified backfill');
  assert.equal(top[0].verified, true);
  assert.equal(top[0].verified_product_url, 'https://www.amazon.eg/dp/B0IDEAPAD3');

  const { default: worker } = await import('../worker/index.js');
  const { createD1 } = await import('./helpers-d1.js');
  const TOKEN = 'test-admin-token-0123456789abcdef';
  const env = { DB: createD1(), WISEDO_ADMIN_TOKEN: TOKEN, DISCOVERY_PROVIDERS: 'gemini', GEMINI_API_KEY: 'g', EXPB_RATE_PER_MIN: '100', ASSETS: { fetch: async () => new Response('a') } };
  const call = async (path, body) => {
    const res = await worker.fetch(new Request(`https://exp.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: body ? JSON.stringify(body) : undefined }), env);
    return res.json();
  };
  await call('/api/admin/reset');
  const realFetch = globalThis.fetch;
  globalThis.fetch = F.fakeFetch({ gemini: F.geminiResponse([NO_URL, { ...F.Y, offers: [{ retailer: 'Google', url: 'https://www.google.com/search?q=victus', price_egp: 39000 }] }]) }, {});
  let body;
  try { body = await call('/api/expb/run', { profile: F.PROFILE }); } finally { globalThis.fetch = realFetch; }
  assert.equal(body.top3.length, 0);
  assert.equal(body.no_verified_message, 'No sufficiently verified Egyptian product listings were found for this request.');
  assert.equal(body.unverified_candidates.length, 2);
  assert.ok(body.unverified_candidates.every((c) => c.exclusion_reason));
});

// --- Egypt-only market targeting -----------------------------------------------------------------------------

test('every prompt and query targets Egypt and EGP', () => {
  const req = buildDiscoveryRequest(F.PROFILE, F.laptopConfig);
  assert.match(req.system, /Egypt/);
  assert.match(req.system, /EGP/);
  assert.match(req.user, /Target market: Egypt/);
  assert.match(req.user, /cairo, Egypt|Egypt nationwide/i);
  const q = exactQueries({ brand: 'Asus', model: 'TUF Gaming F15 FX507ZC4', mpn: 'FX507ZC4-HN002W', cpu: 'Intel Core i5-12500H', ram_gb: 16, storage_gb: 512 });
  for (const site of ['btech.com', '2b.com.eg', 'amazon.eg', 'noon.com/egypt-en', 'compumarts.com', 'rayashop.com']) assert.ok(q.sites.includes(site), site);
  assert.match(q.price, /Egypt|EGP/);
  assert.match(q.price, /FX507ZC4-HN002W/);
});

// --- the original engine is untouched ------------------------------------------------------------------------

test('original engine unchanged: Layer 1 and Layer 2 never import the sourcing layer, and match() does not mutate the snapshot', async () => {
  for (const dir of ['src/layer1', 'src/layer2']) {
    for (const f of readdirSync(join(ROOT, dir)).filter((x) => x.endsWith('.js'))) {
      const text = readFileSync(join(ROOT, dir, f), 'utf8');
      assert.ok(!/sourcing\//.test(text) && !/expb/i.test(text), `${dir}/${f}`);
    }
  }
  const products = consolidate([norm(F.X, 'a'), norm(F.Y, 'a')], ['a']);
  collectOffers(products, F.EG_LISTINGS);
  await verifyOffers(products, { fetch: F.fakeFetch({}, F.PAGES) });
  const { snapshot } = buildEphemeralSnapshot(products, { configs: F.CONFIGS, category: 'laptop', now: F.NOW });
  const before = JSON.stringify(snapshot);
  match(F.PROFILE, snapshot, F.NOW, 'rank');
  assert.equal(JSON.stringify(snapshot), before);
});

// --- broad discovery from real Egyptian listings ----------------------------------------------------------------

test('a web result that is an Egyptian product page with a full configuration and an EGP price becomes a candidate; category pages never do', async () => {
  const { listingCandidate, parseListing } = await import('../src/sourcing/listings.js');
  const web = (url) => ({ provider: 'serper', kind: 'web', title: 'ASUS TUF Gaming A15 FA506NCR Ryzen 7 7435HS 16GB 512GB SSD RTX 3050 4GB', url, snippet: 'Price EGP 38,999.00', price_text: 'EGP 38,999.00' });
  const ok = listingCandidate(parseListing(web('https://www.amazon.eg/-/en/ASUS-TUF-Gaming-FA506NCR/dp/B0D1234567')), F.NOW);
  assert.equal(ok.brand, 'Asus');
  assert.equal(ok.price_egp, 38999);
  assert.equal(ok.offers[0].url, 'https://www.amazon.eg/-/en/ASUS-TUF-Gaming-FA506NCR/dp/B0D1234567');
  assert.equal(listingCandidate(parseListing(web('https://btech.com/en/laptops/c/gaming')), F.NOW), null, 'category page');
  assert.equal(listingCandidate(parseListing(web('https://www.amazon.ae/dp/B0D1234567')), F.NOW), null, 'foreign store');
  assert.equal(listingCandidate(parseListing({ ...web('https://www.amazon.eg/dp/B0D1234567'), title: 'ASUS TUF Gaming A15 laptop' })), null, 'not a full configuration');
});

test('evidence searches widen discovery: a real Egyptian listing of another configuration becomes its own candidate', async () => {
  const { evidenceCandidates } = await import('../src/sourcing/discover.js');
  const products = consolidate([norm(F.X, 'cohere')], ['cohere']);
  const runs = [{ listings: [
    { provider: 'serper', kind: 'web', for_key: products[0].key, title: 'ASUS TUF Gaming F15 FX507ZC4 Core i5-12500H 16GB 512GB RTX 3050', url: 'https://www.amazon.eg/-/en/ASUS-TUF-FX507ZC4/dp/B0BTUF5070', price_text: 'EGP 39,500.00' },
    { provider: 'serper', kind: 'web', for_key: products[0].key, title: IDEAPAD_TITLE, url: 'https://www.amazon.eg/dp/B0IDEAPAD3', price_text: 'EGP 32,499.00' },
  ] }];
  const extra = evidenceCandidates(products, runs, F.NOW, ['cohere', 'serper']);
  assert.equal(extra.length, 1, 'the IdeaPad listing is the existing candidate, not a new one');
  assert.equal(extra[0].brand, 'Asus');
  assert.equal(extra[0].found_via, 'evidence_search');
  assert.match(extra[0].key, /^e\d+$/);
});

test('prices: glued cents and absurd EGP values are not laptop prices', async () => {
  const { parsePrice } = await import('../src/sourcing/listings.js');
  assert.equal(parsePrice('EGP 45,79900').price, 45799);
  assert.equal(parsePrice('45.799,00 EGP').price, 45799);
  assert.equal(parsePrice('EGP 4579900').price, null);
  assert.equal(parsePrice('EGP 45,799.00').price, 45799);
});

test('model fallback moves on after a timeout or an unusable answer', async () => {
  const { withModelFallback } = await import('../src/sourcing/providers.js');
  const answers = { a: { ok: false, error: 'gemini: timeout after 45000 ms' }, b: { ok: false, error: 'groq: answer is not JSON' }, c: { ok: true, output: { candidates: [] } } };
  const p = withModelFallback(['a', 'b', 'c'], (m) => ({ name: 'x', discover: async () => answers[m] }));
  const r = await p.discover({});
  assert.equal(r.ok, true);
  assert.deepEqual(r.model_attempts.map((x) => x.model), ['a', 'b', 'c']);
});

// --- live-run regressions (staging, 2026-10-08) ------------------------------------------------------------------

test('live regression: specs spelled only in the URL slug still reject a different variant (TUF F15 FX506HC i7-11800H RTX 3050 is not i7-13700H RTX 4060)', async () => {
  const cand = { ...F.X, brand: 'Asus', model: 'TUF Gaming F15 (FX506HC)', cpu: 'Intel Core i7-13700H', ram_gb: 16, storage_gb: 512, gpu: 'NVIDIA GeForce RTX 4060 8GB', price_egp: 34000, offers: [{ retailer: 'Sigma', url: null, price_egp: 34000 }] };
  const url = 'https://egyptlaptop.com/laptops/asus-tuf-gaming-f15-fx506hc-ub74-intel-corei7-11800h-512gb-ssd-16gb-ram-nvidia-geforce-rtx-3050-4gb-15-6-inch-fhd-win-10?srsltid=x';
  const products = consolidate([norm(cand, 'cohere')], ['cohere']);
  collectOffers(products, [{ provider: 'serper', kind: 'web', for_key: products[0].key, title: 'Asus TUF Gaming F15 FX506HC', url, price_text: 'EGP 41,199.00' }]);
  await verifyOffers(products, { fetch: F.fakeFetch({}, {}) });
  assert.equal(products[0].status, 'discovered_unverified');
  assert.equal(products[0].exclusion_reason, 'variant_mismatch');
});

test('a model-name match without the CPU or GPU agreeing is only "model" strength (weak evidence)', async () => {
  const { parseListing, listingMatches } = await import('../src/sourcing/listings.js');
  const cand = { brand: 'Asus', model: 'TUF Gaming F15 FX507ZC4', cpu: 'Intel Core i5-12500H', ram_gb: 16, storage_gb: 512, gpu: 'NVIDIA GeForce RTX 3050' };
  const l = parseListing({ provider: 'serper', kind: 'web', title: 'ASUS TUF Gaming F15 FX507ZC4 16GB 512GB SSD', url: 'https://www.amazon.eg/dp/B0TUF50700', price_text: 'EGP 39,999' });
  assert.equal(listingMatches(cand, l).strength, 'model');
  const full = parseListing({ provider: 'serper', kind: 'web', title: 'ASUS TUF Gaming F15 FX507ZC4 Core i5-12500H 16GB 512GB RTX 3050', url: 'https://www.amazon.eg/dp/B0TUF50700', price_text: 'EGP 39,999' });
  assert.equal(listingMatches(cand, full).strength, 'model+specs');
});

test('"nothing fits" is not padded with the engine\'s closest misses', async () => {
  const { topThree } = await import('../worker/expb.js');
  const products = consolidate([norm({ ...F.X, offers: [] }, 'a')], ['a']);
  collectOffers(products, [F.EG_LISTINGS[0]]);
  await verifyOffers(products, { fetch: F.fakeFetch({}, F.PAGES) });
  const { snapshot, index } = buildEphemeralSnapshot(products, { configs: F.CONFIGS, category: 'laptop', now: F.NOW });
  const poor = structuredClone(F.PROFILE);
  poor.money.budget = 15000;
  if (poor.derived) poor.derived.maxPrice = 15000;
  const r = match(poor, snapshot, F.NOW, 'rank');
  assert.notEqual(r.status, 'ok');
  assert.equal(topThree(r, snapshot, index).length, 0);
});

test('live regression: "R7 7435HS" / "RyzenTM" / "Ci7" are read as processors, so a different CPU never verifies (TUF A15 R5 6600H vs R7 7435HS)', async () => {
  const { parseListing, listingMatches } = await import('../src/sourcing/listings.js');
  const l = parseListing({ provider: 'serper', kind: 'web', title: 'ASUS TUF Gaming A15', price_text: 'EGP 37,299',
    url: 'https://eshop.vodafone.com.eg/en/prod/asus-tuf-gaming-a15-r7-7435hs---8gb-ddr5512gb-ssd--nvidia-geforce-rtx-3050-laptop-gpu---fa506ncr-hn007w' });
  assert.equal(l.cpu, 'ryzen 7 7435hs');
  assert.equal(l.storage_gb, 512);
  assert.equal(listingMatches({ brand: 'Asus', model: 'TUF Gaming A15', cpu: 'AMD Ryzen 5 6600H', ram_gb: 8, storage_gb: 512, gpu: 'NVIDIA GeForce RTX 3050 4GB' }, l).why, 'cpu differs');
  assert.equal(parseListing({ title: 'ASUS ROG Strix G16 AMD RyzenTM 9 9955HX 16GB 1TB', url: 'https://2b.com.eg/x' }).cpu, 'ryzen 9 9955hx');
  assert.equal(parseListing({ title: 'ASUS TUF F15 FX507VU Ci7-13620H 16GB 512GB', url: 'https://www.compumarts.com/products/x' }).cpu, 'core i7-13620h');
});

test('live regression: prices read from free text never verify; an RTX x070 laptop at 39,900 EGP from a listing is implausible', async () => {
  const cand = { ...F.X, brand: 'Asus', model: 'ROG Strix G16 G614FP', mpn: 'G614FP-GR169W', cpu: 'AMD Ryzen 9 9955HX', ram_gb: 16, storage_gb: 1024, gpu: 'NVIDIA GeForce RTX 5070 8GB', price_egp: 39900, offers: [] };
  const url = 'https://www.noon.com/egypt-en/asus-g614fp-gr169w-gaming-laptop-ryzen-9-9955hx-rtx-5070-8gb-16gb-ram-1tb-ssd/N70410542V/p/';
  const title = 'ASUS G614FP-GR169W Gaming Laptop Ryzen 9 9955HX RTX 5070 8GB 16GB RAM 1TB SSD';
  const textOnly = await run(cand, [{ provider: 'tavily', kind: 'web', title, url, snippet: 'Now EGP 39,900' }], { [url]: 403 });
  assert.equal(textOnly.p.status, 'discovered_unverified');
  assert.equal(textOnly.p.exclusion_reason, 'no_egyptian_price');
  const field = await run(cand, [{ provider: 'serper', kind: 'web', title, url, price_text: 'EGP 39,900' }], { [url]: 403 });
  assert.equal(field.p.exclusion_reason, 'implausible_price');
  const real = await run(cand, [{ provider: 'serper', kind: 'web', title, url, price_text: 'EGP 104,999' }], { [url]: 403 });
  assert.equal(real.p.status, 'verified');
  assert.equal(real.p.verified_price, 104999);
});

test('a listing-only lead without a structured price becomes a candidate, and verifies only with the price on its own product page', async () => {
  const { evidenceCandidates } = await import('../src/sourcing/discover.js');
  const url = 'https://2b.com.eg/en/asus-tuf-gaming-a15-fa506ncr-hn007w-ryzen-7-7435hs-8gb-512gb-rtx-3050.html';
  const lead = { provider: 'serper', kind: 'web', title: 'ASUS TUF Gaming A15 FA506NCR-HN007W Ryzen 7 7435HS 8GB 512GB SSD RTX 3050', url, snippet: 'Save EGP 5,000' };
  const products = [];
  const extra = evidenceCandidates(products, [{ listings: [lead] }], F.NOW, ['serper']);
  assert.equal(extra.length, 1);
  assert.equal(extra[0].price_egp, null, 'snippet text is not a price');
  const page = `<html><title>ASUS TUF Gaming A15 FA506NCR-HN007W Ryzen 7 7435HS 8GB 512GB RTX 3050</title><script type="application/ld+json">{"offers":{"price":"37299","priceCurrency":"EGP"}}</script></html>`;
  products.push(...extra);
  collectOffers(products, [lead]);
  await verifyOffers(products, { fetch: F.fakeFetch({}, { [url]: page }) });
  assert.equal(products[0].status, 'verified');
  assert.equal(products[0].verified_price, 37299);
  const blocked = [...evidenceCandidates([], [{ listings: [lead] }], F.NOW, ['serper'])];
  collectOffers(blocked, [lead]);
  await verifyOffers(blocked, { fetch: F.fakeFetch({}, { [url]: 403 }) });
  assert.equal(blocked[0].status, 'discovered_unverified');
  assert.equal(blocked[0].exclusion_reason, 'no_egyptian_price');
});

test('live regression: a candidate made from an evidence listing keeps its own URL as an offer lead (searched for another candidate)', async () => {
  const { evidenceCandidates } = await import('../src/sourcing/discover.js');
  const products = consolidate([norm(F.X, 'cohere')], ['cohere']);
  const url = 'https://www.compumarts.com/products/asus-rog-strix-g15-g513qc-hn163t-ryzen-7-5800h-16gb-512gb-rtx-3050';
  const lead = { provider: 'serper', kind: 'web', for_key: products[0].key, title: 'ASUS ROG Strix G15 G513QC-HN163T Ryzen 7 5800H 16GB 512GB RTX 3050', url };
  products.push(...evidenceCandidates(products, [{ listings: [lead] }], F.NOW, ['cohere', 'serper']));
  const page = `<html><title>ASUS ROG Strix G15 G513QC-HN163T Ryzen 7 5800H 16GB 512GB RTX 3050</title><script type="application/ld+json">{"offers":{"price":"36999","priceCurrency":"EGP"}}</script></html>`;
  collectOffers(products, [lead]);
  await verifyOffers(products, { fetch: F.fakeFetch({}, { [url]: page }) });
  const g15 = products.find((p) => p.found_via === 'evidence_search');
  assert.equal(g15.status, 'verified');
  assert.equal(g15.verified_product_url, url);
  assert.equal(g15.verified_price, 36999);
});

// --- live-run regressions: page checks (staging, 2026-10-08) -----------------------------------------------------

test('accessories that name the laptop model (battery, keyboard, charger, screen) are neither evidence nor offer leads', async () => {
  const { isAccessoryTitle } = await import('../src/sourcing/listings.js');
  for (const t of ['Asus TUF F15 FX506LH Battery new 48Wh', 'CASOSHIELD Keyboard Cover for ASUS TUF Gaming F15 FX506LH', '15.6" Screen Replacement for ASUS TUF Gaming F15 FX506',
    'BestParts New CPU+GPU Cooling Fan Replacement for 2022 Asus ROG Strix G15', '180W Replacement Charger compatible for Asus ROG Zephyrus G14']) assert.equal(isAccessoryTitle(t), true, t);
  for (const t of ['ASUS ROG Strix G15 G513RC-HF223 Gaming Laptop (AMD Ryzen 7-6800H, RTX 3050 4GB) Backlit Keyboard', 'ASUS TUF Gaming A15 FA506NCR Ryzen 7 7435HS 8GB 512GB RTX 3050']) assert.equal(isAccessoryTitle(t), false, t);
  const url = 'https://www.amazon.eg/-/en/Asus-TUF-FX506LH-Battery-48Wh/dp/B08GJHQXBK';
  const { p } = await run({ ...F.X, brand: 'Asus', model: 'TUF Gaming F15 FX506LH', cpu: 'Intel Core i5-10300H', gpu: 'NVIDIA GeForce GTX 1650', offers: [] }, [listing('Asus TUF F15 FX506LH Battery new 48Wh', url, 'EGP 1,999')]);
  assert.equal(p.evidence_sources.length, 0);
  assert.equal(p.rejections.length, 0);
});

test('Amazon.eg: the price comes from the buy box and stock from #availability (it has no JSON-LD offer)', async () => {
  const { pageOffer } = await import('../src/sourcing/verify.js');
  const widget = '<div class="similar"><span class="a-price"><span class="a-offscreen">EGP85,945.43 EGP</span></span></div>';
  const html = `${widget}<div id="corePrice_desktop" class="celwidget"><span class="a-price a-text-price apexPriceToPay" data-a-size="b"><span class="a-offscreen">EGP36,999.00 EGP</span></span></div><div id="availability" data-csa-c-slot-id="availability_feature_div"> <div id="all"><span class="a-size-medium a-color-success"> In Stock </span></div></div>`;
  assert.deepEqual(pageOffer(html, 'https://www.amazon.eg/dp/B0D1234567'), { price: 36999, currency: 'EGP', availability: 'in_stock', source: 'amazon-buybox' });
  const noOffer = pageOffer(`${widget}<div id="corePrice_desktop"></div><div id="availability"><span>Currently unavailable.</span></div>`, 'https://www.amazon.eg/dp/B0D1234567');
  assert.equal(noOffer.price, null, 'a widget price is never the product price');
  assert.equal(noOffer.availability, 'out_of_stock');
  assert.equal(pageOffer(html, 'https://example.com/x').price, null, 'buy-box rules only on Amazon');
});

test('a page price above the laptop ceiling is implausible; article slugs are not product pages', async () => {
  const url = 'https://btech.com/en/p/asus-rog-strix-g15-g513rc-hn088w-ryzen-7-6800h-16gb-512gb-rtx-3050';
  const cand = { ...F.X, brand: 'Asus', model: 'ROG Strix G15 G513RC', mpn: 'G513RC-HN088W', cpu: 'AMD Ryzen 7 6800H', gpu: 'NVIDIA GeForce RTX 3050', offers: [{ retailer: 'B.TECH', url, price_egp: 39000 }] };
  const page = '<title>Asus ROG Strix G15 G513RC-HN088W Ryzen 7-6800H 16GB 512GB RTX 3050</title><script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","price":"672076","priceCurrency":"EGP","availability":"InStock"}}</script>';
  const { p } = await run(cand, [], { [url]: page });
  assert.equal(p.status, 'discovered_unverified');
  assert.equal(p.exclusion_reason, 'no_egyptian_price');
  assert.notEqual(classifyUrl('https://hw-egypt.com/laptop-price-in-egypt-a-comprehensive-guide-for-2024').type, 'direct_product');
});

test('live regression: a product URL that now lands on a search-results page is unreachable, not verified', async () => {
  const url = 'https://2b.com.eg/en/lenovo-ideapad-slim-3-15iah8-i5-12450h-16gb-512gb.html';
  const page = `<title>Search results for: 'lenovo ideapad slim 3 15iah8 i5 12450h 16gb 512gb'</title><script type="application/ld+json">{"@type":"Product","offers":{"price":"31999","priceCurrency":"EGP"}}</script>`;
  const { p } = await run(NO_URL, [listing(IDEAPAD_TITLE, url, 'EGP 32,499.00')], { [url]: page });
  assert.equal(p.status, 'discovered_unverified');
  assert.equal(p.exclusion_reason, 'unreachable');
});
