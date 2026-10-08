// Experiment B, multi-source: Cohere and Groq LLM adapters, Tavily web search, Serper shopping, listing parsing,
// listing evidence and offers, the five-provider pipeline with partial failure, and the Exp-1 isolation guard.
// No network: recorded responses through a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from './expb-fixtures.js';
import { createCohereProvider, createGroqProvider, createGeminiProvider, providersFromEnv, DEFAULT_PROVIDER_MIX } from '../src/sourcing/providers.js';
import { createTavilyProvider, createSerperProvider, candidateQuery } from '../src/sourcing/search-providers.js';
import { parseListing, parsePrice, listingCandidate, listingMatches, isEgyptian, looksLikeProductPage } from '../src/sourcing/listings.js';
import { buildDiscoveryRequest } from '../src/sourcing/discovery-prompt.js';
import { normalizeProviderOutput } from '../src/sourcing/normalize.js';
import { consolidate, gpuToken } from '../src/sourcing/consolidate.js';
const gpuTokenOf = (c) => gpuToken(c.gpu, c.cpu);
import { attachEvidence } from '../src/sourcing/evidence.js';
import { discoverProducts, runProvider } from '../src/sourcing/discover.js';
import { LLMProductDiscoverySource, recommendWith } from '../src/sourcing/product-source.js';
import { validateSnapshot } from '../src/contracts.js';
import { verifyCandidates } from '../src/sourcing/verify.js';
import { collectOffers, verifyOffers } from '../src/sourcing/offers.js';
import { buildEphemeralSnapshot } from '../src/sourcing/ephemeral-snapshot.js';
import { match } from '../src/layer2/index.js';
import { checkIsolation, loadFiles, parseJsonc, FORBIDDEN } from '../scripts/check-isolation.mjs';

const REQ = buildDiscoveryRequest(F.PROFILE, F.laptopConfig);
const norm = (c, provider = 'p') => normalizeProviderOutput({ candidates: [c] }, provider).candidates[0];
const L = F.LISTINGS;
const shop = (l, provider = 'serper', kind = 'shopping') => ({ provider, kind, title: l.title, url: l.link, price_text: l.price, source: l.source });

function fiveProviders(f) {
  return providersFromEnv({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', COHERE_API_KEY: 'c', TAVILY_API_KEY: 't', SERPER_API_KEY: 's' }, { fetch: f }).available;
}

// --- registry ------------------------------------------------------------------------------------------------

test('default mix is 3 LLM families + 1 web search + 1 shopping; each provider is switchable', () => {
  assert.equal(DEFAULT_PROVIDER_MIX, 'gemini,groq,cohere,tavily,serper');
  const all = fiveProviders();
  assert.deepEqual(all.map((p) => [p.name, p.role]), [['gemini', 'llm'], ['groq', 'llm'], ['cohere', 'llm'], ['tavily', 'web_search'], ['serper', 'shopping']]);
  const only = providersFromEnv({ DISCOVERY_PROVIDERS: 'cohere,serper,nope', COHERE_API_KEY: 'c', SERPER_API_KEY: 's' });
  assert.deepEqual(only.available.map((p) => p.name), ['cohere', 'serper']);
  assert.deepEqual(only.unknown, ['nope']);
});

// --- Cohere --------------------------------------------------------------------------------------------------

test('Cohere adapter: v2 chat, JSON mode with the schema in the prompt first, model command-a-plus-05-2026, billed usage', async () => {
  const f = F.fakeFetch({ cohere: F.cohereResponse([F.X, F.Z]) });
  const r = await createCohereProvider({ apiKey: 'co-SECRET', fetch: f }).discover(REQ);
  assert.equal(r.ok, true);
  assert.equal(r.variant, 'json_object+thinking_2k');
  assert.equal(r.output.candidates.length, 2);
  assert.deepEqual(r.usage, { input_tokens: 3500, output_tokens: 1400, web_searches: 0 });
  const c = f.calls[0];
  assert.deepEqual(c.body.thinking, { type: 'enabled', token_budget: 2048 }, 'thinking is capped');
  assert.equal(c.body.max_tokens, 10000);
  assert.equal(c.url, 'https://api.cohere.com/v2/chat');
  assert.equal(c.body.model, 'command-a-plus-05-2026');
  assert.deepEqual(c.body.response_format, { type: 'json_object' });
  assert.match(c.body.messages[1].content, /JSON schema/);
  assert.equal(c.body.messages[0].role, 'system');
  assert.equal(c.headers.authorization, 'Bearer co-SECRET');
  assert.ok(!JSON.stringify(r).includes('co-SECRET'));
});

test('Cohere adapter: runaway output (MAX_TOKENS) moves to the next attempt and its tokens are still counted', async () => {
  const f = F.fakeFetch({ cohere: (body) => (body.thinking
    ? new Response(JSON.stringify(F.cohereResponse([], { finish_reason: 'MAX_TOKENS', usage: { billed_units: { input_tokens: 400, output_tokens: 10000 } } })), { status: 200 })
    : new Response(JSON.stringify(F.cohereResponse([F.Y])), { status: 200 })) });
  const r = await createCohereProvider({ apiKey: 'k', fetch: f }).discover(REQ);
  assert.equal(r.ok, true);
  assert.equal(r.variant, 'json_object');
  assert.equal(r.attempts[0].ok, false);
  assert.match(r.attempts[0].error, /runaway/);
  assert.equal(r.usage.output_tokens, 10000 + 1400, 'the runaway tokens are part of the cost');
  assert.equal(f.calls[1].body.thinking, undefined, 'second attempt uses the model default');
});

test('Cohere adapter: schema rejected (400) and runaway everywhere end in a reported failure; auth errors are not retried', async () => {
  const run = (finish) => createCohereProvider({ apiKey: 'k', fetch: F.fakeFetch({ cohere: F.cohereResponse([], { finish_reason: finish }) }) }).discover(REQ);
  const cut = await run('MAX_TOKENS');
  assert.equal(cut.ok, false);
  assert.match(cut.error, /max_tokens/);
  assert.equal(cut.attempts.length, 2, 'two attempts at most');
  assert.ok(cut.usage.output_tokens > 0);
  const prose = await createCohereProvider({ apiKey: 'k', fetch: F.fakeFetch({ cohere: F.cohereResponse([], { message: { content: [{ type: 'text', text: 'Buy the IdeaPad.' }] } }) }) }).discover(REQ);
  assert.equal(prose.ok, false);
  assert.match(prose.error, /not JSON/);
  const fa = F.fakeFetch({ cohere: () => new Response(JSON.stringify({ message: 'invalid api token' }), { status: 401 }) });
  const auth = await createCohereProvider({ apiKey: 'co-SECRET', fetch: fa }).discover(REQ);
  assert.equal(auth.ok, false);
  assert.equal(fa.calls.length, 1, 'no retry on 401');
  assert.ok(!auth.error.includes('co-SECRET'));
  const slow = await runProvider(createCohereProvider({ apiKey: 'k', fetch: F.fakeFetch({ cohere: 'timeout' }), timeoutMs: 60 }), REQ, 5000);
  assert.equal(slow.ok, false);
  assert.match(slow.error, /timeout/);
  assert.equal(slow.provider, 'cohere');
  assert.equal(typeof slow.latency_ms, 'number');
});

test('model fallback: a model that does not exist (404) or is out of quota (429) moves to the next configured model', async () => {
  const f = F.fakeFetch({
    groq: (body) => (body.model === 'groq/compound' ? new Response('{"error":{"message":"The model `groq/compound` does not exist"}}', { status: 404 }) : new Response(JSON.stringify(F.groqResponse([F.X], { model: body.model })), { status: 200 })),
    gemini: () => new Response('{"error":{"status":"RESOURCE_EXHAUSTED","message":"quota"}}', { status: 429 }),
  });
  const [groq] = providersFromEnv({ DISCOVERY_PROVIDERS: 'groq', GROQ_API_KEY: 'k', GROQ_DISCOVERY_MODEL: 'groq/compound,compound-beta' }, { fetch: f }).available;
  const r = await runProvider(groq, REQ, 5000);
  assert.equal(r.ok, true);
  assert.equal(r.model, 'compound-beta');
  assert.deepEqual(r.model_attempts.map((x) => [x.model, x.ok]), [['groq/compound', false], ['compound-beta', true]]);
  const [gem] = providersFromEnv({ DISCOVERY_PROVIDERS: 'gemini', GEMINI_API_KEY: 'k', GEMINI_DISCOVERY_MODEL: 'a-model,b-model' }, { fetch: f }).available;
  const g = await runProvider(gem, REQ, 5000);
  assert.equal(g.ok, false);
  assert.equal(g.model_attempts.length, 2, 'both models tried on 429');
  const one = providersFromEnv({ DISCOVERY_PROVIDERS: 'cohere', COHERE_API_KEY: 'k' }).available[0];
  assert.equal(one.model, 'command-a-plus-05-2026');
});

test('shop titles without a GPU are integrated (flagged), never when a dedicated card is named', () => {
  const t = { provider: 'serper', kind: 'shopping', title: 'Lenovo IdeaPad Slim 3 15IAH8 - Core i5-12450H, 16GB, 512GB SSD', url: 'https://www.amazon.eg/x', price_text: 'EGP 32,000' };
  const c = listingCandidate(parseListing(t), 'now');
  assert.equal(c.gpu_assumed, true);
  assert.equal(gpuTokenOf(c), 'integrated');
  const d = listingCandidate(parseListing({ ...t, title: 'HP Victus 15 - Ryzen 5 7535HS 16GB 512GB NVIDIA GeForce' }), 'now');
  assert.equal(d, null, 'a dedicated card is mentioned without a model: configuration unknown, not a candidate');
});

test('diagnose route lists models and tiny-request status codes, never key values', async () => {
  const { diagnoseProviders } = await import('../src/sourcing/diagnose.js');
  const f = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/v1beta/models?')) return new Response(JSON.stringify({ models: [{ name: 'models/gemini-3.8-flash-lite', supportedGenerationMethods: ['generateContent'] }] }));
    if (u.includes('api.groq.com/openai/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'compound-beta' }] }));
    if (u.includes('api.cohere.com/v1/models')) return new Response(JSON.stringify({ models: [{ name: 'command-a-plus-05-2026' }] }));
    return new Response('{"error":{"message":"nope"}}', { status: init.method === 'POST' && u.includes('gemini-3.8-flash:') ? 429 : 200 });
  };
  const d = await diagnoseProviders({ GEMINI_API_KEY: 'g-SECRET', GROQ_API_KEY: 'q-SECRET', COHERE_API_KEY: 'c-SECRET' }, { fetch: f });
  assert.deepEqual(d.gemini.models, ['gemini-3.8-flash-lite']);
  assert.equal(d.gemini.tries['gemini-3.8-flash'].plain.status, 429);
  assert.deepEqual(d.groq.models, ['compound-beta']);
  assert.deepEqual(d.cohere.models, ['command-a-plus-05-2026']);
  assert.ok(!/SECRET/.test(JSON.stringify(d)));
});

test('Cohere observability: cost estimate uses the command-a-plus row; usage and latency are reported', async () => {
  const r = await runProvider(createCohereProvider({ apiKey: 'k', fetch: F.fakeFetch({ cohere: F.cohereResponse([F.X]) }) }), REQ, 5000);
  assert.equal(r.ok, true);
  assert.equal(r.model, 'command-a-plus-05-2026');
  assert.equal(r.cost_usd, Math.round(((3500 * 2.5 + 1400 * 10) / 1e6) * 10000) / 10000);
  assert.match(r.cost_basis, /Cohere trial key/);
});

// --- Groq ----------------------------------------------------------------------------------------------------

test('Groq adapter (gpt-oss-120b): JSON mode by default; built-in browser_search only when switched on', async () => {
  const f = F.fakeFetch({ groq: (body) => new Response(JSON.stringify(F.groqResponse([F.Y], { model: body.model })), { status: 200 }) });
  const r = await createGroqProvider({ apiKey: 'gq', fetch: f }).discover(REQ);
  assert.equal(r.ok, true);
  assert.equal(r.variant, 'json_object');
  assert.equal(f.calls[0].body.model, 'openai/gpt-oss-120b');
  assert.deepEqual(f.calls[0].body.response_format, { type: 'json_object' });
  assert.equal(f.calls[0].body.tools, undefined);
  const fs = F.fakeFetch({ groq: (body) => new Response(JSON.stringify(F.groqResponse([F.Y], { model: body.model })), { status: 200 }) });
  const rs = await createGroqProvider({ apiKey: 'gq', fetch: fs, browserSearch: true }).discover(REQ);
  assert.equal(rs.variant, 'browser_search');
  assert.deepEqual(fs.calls[0].body.tools, [{ type: 'browser_search' }]);
  assert.equal(fs.calls[0].body.reasoning_effort, 'low');
  assert.equal(fs.calls[0].body.response_format, undefined, 'browser search is not combinable with structured output');
  assert.equal(rs.usage.web_searches, 2);
  const env = providersFromEnv({ DISCOVERY_PROVIDERS: 'groq', GROQ_API_KEY: 'k', GROQ_BROWSER_SEARCH: '1' }, { fetch: fs }).available[0];
  assert.ok(env, 'GROQ_BROWSER_SEARCH=1 switches it on through the registry');
});

test('Groq adapter: browser_search rejected (400) retries in JSON mode; Compound models use search_settings; prose fails', async () => {
  const f = F.fakeFetch({ groq: (body) => (body.tools ? new Response('{"error":{"message":"tools not supported"}}', { status: 400 }) : new Response(JSON.stringify(F.groqResponse([F.X])), { status: 200 })) });
  const r = await createGroqProvider({ apiKey: 'k', fetch: f, browserSearch: true }).discover(REQ);
  assert.equal(r.ok, true);
  assert.equal(r.variant, 'json_object');
  assert.deepEqual(f.calls[1].body.response_format, { type: 'json_object' });
  const fc = F.fakeFetch({ groq: F.groqResponse([F.X]) });
  await createGroqProvider({ apiKey: 'k', fetch: fc, model: 'groq/compound' }).discover(REQ);
  assert.deepEqual(fc.calls[0].body.search_settings, { country: 'egypt' });
  const fp = F.fakeFetch({ groq: { choices: [{ finish_reason: 'stop', message: { content: 'Try the Lenovo IdeaPad.' } }], usage: {} } });
  const rp = await createGroqProvider({ apiKey: 'k', fetch: fp }).discover(REQ);
  assert.equal(rp.ok, false);
  assert.match(rp.error, /not JSON/);
});

test('web pages are never candidates; cheap "laptop" prices and category pages never become offers', () => {
  const page = { provider: 'tavily', kind: 'web', title: 'HP Laptops: Shop at Best Price in 2025 Core 5 120U 16GB 512GB EGP 1,520', url: 'https://egypt.sharafdg.com/c/computing/Laptops?dFR=16GB', snippet: '' };
  assert.equal(listingCandidate(parseListing(page), 'now'), null);
  const cheap = { provider: 'serper', kind: 'shopping', title: 'HP 15 Core 5 120U 16GB 512GB', url: 'https://www.amazon.eg/x', price_text: 'EGP 1,520' };
  assert.equal(listingCandidate(parseListing(cheap), 'now'), null);
  assert.equal(looksLikeProductPage('https://egypt.sharafdg.com/c/computing/Laptops?dFR=1'), false);
  assert.equal(looksLikeProductPage('https://2b.com.eg/en/computers/laptops.html'), false);
  assert.equal(looksLikeProductPage('https://www.youtube.com/watch?v=x'), false);
  assert.equal(looksLikeProductPage('https://www.amazon.eg/-/en/Laptop-Computers-30-000-above-EGP/s?rh=n%3A1'), false);
  assert.equal(looksLikeProductPage('https://www.amazon.eg/dp/B0ABC'), true);
  assert.equal(looksLikeProductPage('https://btech.com/en/lenovo-ideapad-slim-3-15iah8.html'), true);
});

// --- Tavily --------------------------------------------------------------------------------------------------

test('Tavily adapter: web search for the need, Egypt boost, listings with URLs; evidence per candidate', async () => {
  const f = F.fakeFetch({ tavily: F.tavilyResponse([L.ideapad, L.vivobook]) });
  const t = createTavilyProvider({ apiKey: 'tvly-SECRET', fetch: f });
  const r = await t.discover(REQ);
  assert.equal(r.ok, true);
  assert.equal(r.listings.length, 2);
  assert.equal(r.listings[0].kind, 'web');
  const b = f.calls[0].body;
  assert.equal(b.country, 'egypt');
  assert.equal(b.search_depth, 'basic');
  assert.match(b.query, /16GB RAM/);
  assert.match(b.query, /under 40000 EGP/);
  assert.equal(f.calls[0].headers.authorization, 'Bearer tvly-SECRET');
  const ev = await t.evidence([{ key: 'c1', brand: 'Lenovo', model: 'IdeaPad Slim 3 15IAH8', cpu: 'Intel Core i5-12450H', ram_gb: 16, storage_gb: 512 }]);
  assert.equal(ev.usage.credits, 1);
  assert.ok(ev.listings.every((l) => l.for_key === 'c1'));
});

// --- Serper --------------------------------------------------------------------------------------------------

test('Serper adapter: Google Shopping (gl=eg) plus a search on Egyptian retailers; one endpoint failing is a warning', async () => {
  const f = F.fakeFetch({ serper_shopping: F.serperShopping([L.ideapad, L.mouse]), serper_search: () => new Response('{"message":"quota"}', { status: 429 }) });
  const r = await createSerperProvider({ apiKey: 'srp', fetch: f }).discover(REQ);
  assert.equal(r.ok, true);
  assert.equal(r.listings.length, 2);
  assert.equal(r.listings[0].price_text, 'EGP 32,499.00');
  assert.equal(r.warnings.length, 2, "both organic queries failed: warnings, not a failure");
  const shopCall = f.calls.find((c) => c.url.endsWith('/shopping'));
  assert.equal(shopCall.body.gl, 'eg');
  assert.equal(shopCall.headers['x-api-key'], 'srp');
  const searchCall = f.calls.find((c) => c.url.endsWith('/search'));
  assert.match(searchCall.body.q, /site:amazon\.eg/);
});

test('Serper adapter: both endpoints failing is a provider failure', async () => {
  const f = F.fakeFetch({ serper_shopping: () => new Response('{}', { status: 403 }), serper_search: () => new Response('{}', { status: 403 }) });
  const r = await runProvider(createSerperProvider({ apiKey: 's', fetch: f }), REQ, 5000);
  assert.equal(r.ok, false);
  assert.match(r.error, /403/);
});

// --- listings ------------------------------------------------------------------------------------------------

test('prices and currencies: EGP in English and Arabic forms, USD and others are kept apart', () => {
  assert.deepEqual(parsePrice('EGP 32,499.00'), { price: 32499, currency: 'EGP' });
  assert.deepEqual(parsePrice('٣٢٬٤٩٩ جنيه'.replace('٬', ',')), { price: 32499, currency: 'EGP' });
  assert.deepEqual(parsePrice('E£ 45,000'), { price: 45000, currency: 'EGP' });
  assert.deepEqual(parsePrice('32.999 ج.م'), { price: 32999, currency: 'EGP' });
  assert.equal(parsePrice('$649.99').currency, 'USD');
  assert.equal(parsePrice('AED 2,499').currency, 'OTHER');
  assert.equal(parsePrice('no price here').price, null);
  assert.equal(isEgyptian('https://www.noon.com/egypt-en/x/p/', null), true);
  assert.equal(isEgyptian('https://www.noon.com/uae-en/x/p/', null), false);
  assert.equal(isEgyptian('https://www.bestbuy.com/x', 'USD'), false);
});

test('a full shop listing becomes a candidate; accessories, USD listings and partial titles do not', () => {
  const ok = listingCandidate(parseListing(shop(L.ideapad)), 't');
  assert.equal(ok.brand, 'Lenovo');
  assert.equal(ok.ram_gb, 16);
  assert.equal(ok.storage_gb, 512);
  assert.equal(ok.price_egp, 32499);
  assert.equal(ok.offers[0].url, L.ideapad.link);
  assert.equal(listingCandidate(parseListing(shop(L.mouse)), 't'), null);
  assert.equal(listingCandidate(parseListing(shop(L.usd)), 't'), null, 'no EGP price');
  assert.equal(listingCandidate(parseListing(shop({ ...L.ideapad, title: 'Lenovo IdeaPad Slim 3 laptop' })), 't'), null, 'configuration unknown');
  const ar = parseListing(shop({ title: 'لاب توب لينوفو ايديا باد - انتل كور i5-12450H - رام 16 جيجا - 512 جيجا SSD', link: 'https://btech.com/ar/x', price: '32,999 جنيه' }));
  assert.equal(ar.brand, 'Lenovo');
  assert.equal(ar.ram_gb, 16);
  assert.equal(ar.storage_gb, 512);
  assert.equal(ar.price_egp, 32999);
});

test('incorrect evidence is rejected: a listing with another RAM, CPU or model never supports a candidate', () => {
  const c = consolidate([norm(F.X, 'gemini')], ['gemini'])[0];
  assert.equal(listingMatches(c, parseListing(shop(L.ideapad))).match, true);
  assert.equal(listingMatches(c, parseListing(shop(L.ideapad8))).why, 'ram differs');
  assert.equal(listingMatches(c, parseListing(shop({ ...L.ideapad, title: L.ideapad.title.replace('i5-12450H', 'i7-13620H') }))).why, 'cpu differs');
  assert.equal(listingMatches(c, parseListing(shop(L.vivobook))).match, false);
  assert.equal(listingMatches(c, parseListing(shop(L.mouse))).match, false);
});

test('listing evidence: Egyptian EGP listings become offers; foreign listings are evidence only', () => {
  const products = consolidate([norm(F.X, 'gemini'), norm(F.Y, 'groq')], ['gemini', 'groq']);
  attachEvidence(products, [shop(L.ideapad), shop(L.ideapad8), shop(L.usd), shop(L.mouse)]);
  const lenovo = products.find((p) => p.brand === 'Lenovo');
  const hp = products.find((p) => p.brand === 'HP');
  assert.equal(lenovo.listing_evidence.length, 1);
  assert.ok(lenovo.offers.some((o) => o.listing_price_egp === 32499 || (o.source === 'listing' && o.price_egp === 32499)), 'listing price attached to the shop offer');
  assert.deepEqual(lenovo.evidence_providers, ['serper']);
  assert.ok(lenovo.evidence_urls.includes(L.ideapad.link));
  assert.equal(hp.listing_evidence.length, 1, 'the US listing names the product');
  assert.equal(hp.offers.filter((o) => o.source === 'listing').length, 0, 'but a USD price is not an Egyptian offer');
  assert.equal(hp.priced_listings, 0);
});

test('LLM candidate and shop listing of the same configuration merge; the shop counts as a provider that found it', () => {
  const out = consolidate([norm(F.X, 'gemini'), norm(F.X_ALT, 'cohere'), listingCandidate(parseListing(shop(L.ideapad)), 't')], ['gemini', 'cohere', 'serper']);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].providers, ['gemini', 'cohere', 'serper']);
  assert.equal(out[0].provider_consensus_score, 1);
});

test('candidate evidence queries carry the exact configuration', () => {
  assert.equal(candidateQuery({ brand: 'Lenovo', model: 'IdeaPad Slim 3 15IAH8', cpu: 'Intel Core i5-12450H', ram_gb: 16, storage_gb: 1024 }), 'Lenovo IdeaPad Slim 3 15IAH8 i5-12450H 16GB 1TB');
});

// --- full pipeline -------------------------------------------------------------------------------------------

function routes(over = {}) {
  return {
    gemini: F.geminiResponse([F.X, F.Y, F.Z]),
    groq: F.groqResponse([F.X_ALT, F.Z]),
    cohere: F.cohereResponse([F.X, F.A, { ...F.X, brand: 'Dell', model: 'XPS 15 9530', cpu: 'Intel Core i7-13700H', gpu: 'NVIDIA GeForce RTX 4060', price_egp: 95000, offers: [{ retailer: 'Amazon Egypt', url: null, price_egp: 95000 }] }]),
    tavily: F.tavilyResponse([L.ideapad, { title: 'Best laptops for programming in Egypt 2026', link: 'https://example-reviews.com.eg/best', price: '' }]),
    serper_shopping: F.serperShopping([L.ideapad, L.ideapad8, L.vivobook, L.mouse]),
    serper_search: (body) => new Response(JSON.stringify(F.serperSearch(/Victus/.test(body.q) ? [L.usd] : /IdeaPad/.test(body.q) ? [L.ideapad] : [])), { status: 200 }),
    ...over,
  };
}

test('five providers: LLM + web + shopping evidence end to end, the unchanged engine ranks the result', async () => {
  const f = F.fakeFetch(routes(), F.PAGES);
  const d = await discoverProducts({ profile: F.PROFILE, config: F.laptopConfig, configs: F.CONFIGS, now: F.NOW, providers: fiveProviders(f), fetch: f });
  assert.equal(d.ok, true);
  assert.equal(d.metrics.providers_ok, 5);
  assert.ok(d.metrics.evidence_candidates >= 1 && d.metrics.evidence_candidates <= 6);
  assert.ok(d.metrics.evidence_searches >= d.metrics.evidence_candidates, 'exact-model Egypt queries per candidate');
  const lenovo = d.consolidated.find((c) => c.brand === 'Lenovo' && c.ram_gb === 16);
  assert.deepEqual([...lenovo.providers].sort(), ['cohere', 'gemini', 'groq', 'serper', 'tavily'], 'an Egyptian product page with a full configuration counts as a find');
  assert.ok(lenovo.evidence_providers.includes('tavily'), 'tavily is evidence');
  assert.ok(['verified', 'listed'].includes(lenovo.verification_status));
  assert.ok(lenovo.evidence_confidence >= 0.8);
  const vivo16 = d.consolidated.find((c) => c.model.includes('X1605VA'));
  assert.deepEqual(vivo16.providers, ['serper'], 'found only by the shopping provider');
  assert.equal(validateSnapshot(d.snapshot).ok, true);
  assert.ok(d.raw.find((r) => r.provider === 'serper').listings.length >= 3, 'raw provider outputs are kept for the UI');
  assert.ok(d.providers.every((p) => typeof p.latency_ms === 'number' && p.usage));
  const r = await recommendWith(new LLMProductDiscoverySource({ providers: fiveProviders(F.fakeFetch(routes(), F.PAGES)), configs: F.CONFIGS, fetch: F.fakeFetch({}, F.PAGES) }), F.PROFILE, F.NOW);
  assert.equal(r.result.status, 'ok');
  assert.ok(r.result.picks.every((p) => p.quote.price <= 40000 || p.affordability === 'stretch'));
  assert.ok(!r.result.picks.some((p) => p.product.brand === 'Dell' && p.role === 'best_fit'), 'the over-budget XPS does not win');
});

test('partial success: two LLMs and the web search fail, shopping + one LLM still produce a Top 3', async () => {
  const bad = () => new Response('{"error":{"message":"rate limit"}}', { status: 429 });
  const f = F.fakeFetch(routes({ gemini: bad, groq: bad, tavily: bad }), F.PAGES);
  const d = await discoverProducts({ profile: F.PROFILE, config: F.laptopConfig, configs: F.CONFIGS, now: F.NOW, providers: fiveProviders(f), fetch: f });
  assert.equal(d.ok, true);
  assert.equal(d.metrics.providers_ok, 2);
  assert.deepEqual(d.providers.filter((p) => !p.ok).map((p) => p.provider).sort(), ['gemini', 'groq', 'tavily']);
  assert.ok(d.providers.filter((p) => !p.ok).every((p) => /429/.test(p.error)));
  assert.ok(d.snapshot.products.length >= 2);
});

test('zero success across all five: ok false, every provider has an error, nothing ranked', async () => {
  const bad = () => new Response('{}', { status: 500 });
  const f = F.fakeFetch({ gemini: bad, groq: bad, cohere: bad, tavily: bad, serper_shopping: bad, serper_search: bad });
  const d = await discoverProducts({ profile: F.PROFILE, config: F.laptopConfig, configs: F.CONFIGS, now: F.NOW, providers: fiveProviders(f), fetch: f });
  assert.equal(d.ok, false);
  assert.equal(d.providers.filter((p) => p.error).length, 5);
  assert.equal(d.snapshot.products.length, 0);
});

test('evidence phase can be switched off and is capped per request', async () => {
  const f = F.fakeFetch(routes(), F.PAGES);
  const off = await discoverProducts({ profile: F.PROFILE, config: F.laptopConfig, configs: F.CONFIGS, now: F.NOW, providers: fiveProviders(f), fetch: f, evidence: { enabled: false } });
  assert.equal(off.metrics.evidence_searches, 0);
  const f2 = F.fakeFetch(routes(), F.PAGES);
  const capped = await discoverProducts({ profile: F.PROFILE, config: F.laptopConfig, configs: F.CONFIGS, now: F.NOW, providers: fiveProviders(f2), fetch: f2, evidence: { maxCandidates: 2 } });
  assert.equal(capped.metrics.evidence_candidates, 2);
});

test('Gemini stays a valid member of the new mix (grounded LLM)', async () => {
  const f = F.fakeFetch({ gemini: F.geminiResponse([F.X]) });
  const r = await createGeminiProvider({ apiKey: 'k', fetch: f }).discover(REQ);
  assert.equal(r.ok, true);
});

// --- isolation -----------------------------------------------------------------------------------------------

test('isolation: this repository only targets the Exp-1 Worker and D1 (production and staging)', () => {
  const files = loadFiles();
  assert.deepEqual(checkIsolation(files), []);
  const cfg = parseJsonc(files.wranglerText);
  assert.equal(cfg.name, 'wisedo-engine-exp-1');
  assert.equal(cfg.env.staging.name, 'wisedo-engine-exp-1-staging');
  for (const id of FORBIDDEN.d1Ids) assert.ok(!files.wranglerText.includes(id));
});

test('isolation: the guard rejects the original Worker, original D1, catalog resources and extra bindings', () => {
  const files = loadFiles();
  const mutate = (fn) => checkIsolation({ ...files, wranglerText: fn(files.wranglerText) });
  assert.ok(mutate((t) => t.replace('"name": "wisedo-engine-exp-1",', '"name": "wisedo-engine-demo",')).some((p) => /wisedo-engine-demo/.test(p)));
  assert.ok(mutate((t) => t.replace('f749d540-7fc7-43a2-abbd-abf3e320831e', '1855c8d1-7165-4627-90b5-03ccb7d7f2f7')).some((p) => /original database id/.test(p)));
  assert.ok(mutate((t) => t.replace('"database_name": "wisedo-engine-exp-1-staging"', '"database_name": "wisedo-catalog-staging"')).length > 0);
  assert.ok(mutate((t) => t.replace('"observability": { "enabled": true },', '"observability": { "enabled": true }, "kv_namespaces": [{ "binding": "X", "id": "abc" }],')).some((p) => /kv_namespaces/.test(p)));
  assert.ok(mutate((t) => t.replace('"staging": {', '"prod2": {')).some((p) => /unknown environment/.test(p)));
  const wf = checkIsolation({ ...files, workflows: { 'x.yml': 'run: npx wrangler d1 migrations apply wisedo-engine-demo --remote' } });
  assert.ok(wf.some((p) => /wisedo-engine-demo/.test(p)));
});

// --- live-run regressions ------------------------------------------------------------------------------------

test('classifieds and search pages: never an offer, never "verified", their prices are ignored', async () => {
  const { isClassifieds } = await import('../src/sourcing/listings.js');
  assert.equal(isClassifieds('https://www.dubizzle.com.eg/en/electronics/laptop-computers/q-slim-3/'), true);
  assert.equal(isClassifieds('https://eg.pricena.com/en/product/latitude-5430-price-in-Egypt-36409735'), true, 'price-comparison sites are not retailers');
  assert.equal(isClassifieds('https://www.amazon.eg/dp/B0ABC'), false);
  assert.equal(looksLikeProductPage('https://www.dubizzle.com.eg/en/electronics/laptop-computers/q-slim-3/'), false);
  const dub = 'https://www.dubizzle.com.eg/en/electronics/laptop-computers/q-slim-3/';
  const pages = { [dub]: '<html><title>Lenovo IdeaPad Slim 3 15IAH8 i5-12450H 16GB 512GB</title><script>{"price":"23000"}</script></html>' };
  const c = norm({ ...F.X, offers: [{ retailer: 'Dubizzle', url: dub, price_egp: 23000 }] }, 'groq');
  const products = consolidate([c], ['groq']);
  await verifyCandidates(products, { fetch: F.fakeFetch({}, pages) });
  assert.equal(products[0].verification.urls[0].status, 'partial');
  assert.equal(products[0].offers[0].page_price_egp, undefined);
  const { snapshot, unrankable } = buildEphemeralSnapshot(products, { configs: F.CONFIGS, category: 'laptop', now: F.NOW });
  assert.equal(snapshot.offers.length, 0, 'a classifieds ad is not a retail offer');
  assert.equal(unrankable.length, 1);
});

test('model fallback also moves on when a model is overloaded (503)', async () => {
  const f = F.fakeFetch({ gemini: (body, calls) => (calls[calls.length - 1].url.includes('model-a') ? new Response('{"error":{"status":"UNAVAILABLE","message":"high demand"}}', { status: 503 }) : new Response(JSON.stringify(F.geminiResponse([F.X])), { status: 200 })) });
  const [gem] = providersFromEnv({ DISCOVERY_PROVIDERS: 'gemini', GEMINI_API_KEY: 'k', GEMINI_DISCOVERY_MODEL: 'model-a,model-b' }, { fetch: f }).available;
  const r = await runProvider(gem, REQ, 5000);
  assert.equal(r.ok, true);
  assert.deepEqual(r.model_attempts.map((x) => [x.model, x.ok]), [['model-a', false], ['model-b', true]]);
});

test('Top 3 continues down the engine ranked list when it names fewer than three roles (order unchanged)', async () => {
  const { topThree } = await import('../worker/expb.js');
  const products = consolidate([norm(F.X, 'a'), norm(F.Y, 'a'), norm(F.Z, 'a')], ['a']);
  collectOffers(products, F.EG_LISTINGS);
  await verifyOffers(products, { fetch: F.fakeFetch({}, F.PAGES) });
  const { snapshot, index } = buildEphemeralSnapshot(products, { configs: F.CONFIGS, category: 'laptop', now: F.NOW });
  assert.equal(snapshot.products.length, 3);
  const r = match(F.PROFILE, snapshot, F.NOW, 'rank');
  const two = { ...r, picks: r.picks.slice(0, 1) };
  const top = topThree(two, snapshot, index);
  assert.equal(top.length, Math.min(3, 1 + two.others.length));
  assert.equal(top[0].product.id, r.picks[0].product.id);
  assert.deepEqual(top.slice(1).map((t) => t.product.id), two.others.slice(0, 2).map((o) => o.product.id));
  assert.ok(top.slice(1).every((t) => t.role === 'ranked' && typeof t.price === 'number' && t.discovery));
  assert.deepEqual(top.map((t) => t.rank), top.map((_, i) => i + 1));
});

test('evidence searches go to the candidates the unchanged engine would rank highest, not to consensus order', async () => {
  const { evidenceTargets } = await import('../src/sourcing/discover.js');
  const pricey = { ...F.X, brand: 'Dell', model: 'XPS 15 9530', cpu: 'Intel Core i7-13700H', gpu: 'NVIDIA GeForce RTX 4060', price_egp: 95000, offers: [{ retailer: 'Amazon Egypt', url: null, price_egp: 95000 }] };
  // the over-budget XPS has the most providers, so consensus order puts it first
  const products = consolidate([norm(pricey, 'a'), norm(pricey, 'b'), norm(pricey, 'c'), norm(F.X, 'a'), norm(F.Z, 'b')], ['a', 'b', 'c']);
  assert.equal(products[0].brand, 'Dell');
  await verifyCandidates(products, { enabled: false });
  const targets = evidenceTargets(products, { profile: F.PROFILE, configs: F.CONFIGS, config: F.laptopConfig, now: F.NOW }, 2);
  assert.equal(targets.length, 2);
  assert.ok(!targets.some((p) => p.brand === 'Dell'), 'the engine ranks in-budget laptops first, so they get the evidence searches');
});
