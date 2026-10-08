// Experiment B: multi-LLM product sourcing. Provider adapters, malformed output, failures and timeouts,
// conservative consolidation, verification, ephemeral snapshot conversion, compatibility with the unchanged
// Recommendation Engine, partial and zero provider success, and the Worker route. No network: recorded responses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from './expb-fixtures.js';
import { createOpenAiProvider, createAnthropicProvider, createGeminiProvider, providersFromEnv, estimateCost, parseJsonObject } from '../src/sourcing/providers.js';
import { normalizeProviderOutput, cleanUrl } from '../src/sourcing/normalize.js';
import { consolidate, sameProduct, cpuToken, gpuToken } from '../src/sourcing/consolidate.js';
import { verifyCandidates, pagePrices } from '../src/sourcing/verify.js';
import { buildEphemeralSnapshot, resolveRetailer, EPHEMERAL_TENANT } from '../src/sourcing/ephemeral-snapshot.js';
import { buildDiscoveryRequest, describeNeed, DISCOVERY_SCHEMA } from '../src/sourcing/discovery-prompt.js';
import { discoverProducts, runProvider } from '../src/sourcing/discover.js';
import { LLMProductDiscoverySource, ExistingCatalogProductSource, recommendWith } from '../src/sourcing/product-source.js';
import { cpuScore, gpuInfo, screenScore, laptopAttrs } from '../src/sourcing/specs.js';
import { match } from '../src/layer2/index.js';
import { validateSnapshot, validateMatchResult } from '../src/contracts.js';
import worker from '../worker/index.js';
import { createD1 } from './helpers-d1.js';

const norm = (c, provider = 'p') => normalizeProviderOutput({ candidates: [c] }, provider).candidates[0];
const REQ = buildDiscoveryRequest(F.PROFILE, F.laptopConfig);
const all3 = (f) => [createOpenAiProvider({ apiKey: 'k', fetch: f }), createAnthropicProvider({ apiKey: 'k', fetch: f }), createGeminiProvider({ apiKey: 'k', fetch: f })];

// --- discovery request ---------------------------------------------------------------------------------------

test('discovery request is built from the final NeedProfile and asks for Egypt availability', () => {
  const need = describeNeed(F.PROFILE, F.laptopConfig);
  assert.match(need, /Budget: up to 40000 EGP/);
  assert.match(need, /Programming/i);
  assert.match(need, /cairo/);
  assert.match(REQ.system, /Egypt/);
  assert.match(REQ.system, /Never invent URLs/);
  assert.match(REQ.system, /ONE exact configuration/);
  assert.equal(REQ.schema, DISCOVERY_SCHEMA);
});

// --- provider adapters ---------------------------------------------------------------------------------------

test('OpenAI adapter: Responses API with web search and json_schema; parses output and usage', async () => {
  const f = F.fakeFetch({ openai: F.openaiResponse([F.X, F.Y]) });
  const r = await createOpenAiProvider({ apiKey: 'sk-test', fetch: f }).discover(REQ);
  assert.equal(r.ok, true);
  assert.equal(r.output.candidates.length, 2);
  assert.deepEqual(r.usage, { input_tokens: 9000, output_tokens: 3000, web_searches: 1 });
  const body = f.calls[0].body;
  assert.equal(body.tools[0].type, 'web_search');
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(f.calls[0].headers.authorization, 'Bearer sk-test');
  assert.ok(!JSON.stringify(r).includes('sk-test'), 'the key never appears in results');
});

test('Anthropic adapter: web_search server tool, output_config format, fallbacks; handles pause_turn', async () => {
  let n = 0;
  const f = F.fakeFetch({
    anthropic: (body) => {
      n++;
      if (n === 1) return new Response(JSON.stringify({ model: 'claude-opus-5-5', stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 's', name: 'web_search', input: {} }], usage: { input_tokens: 100, output_tokens: 10, server_tool_use: { web_search_requests: 1 } } }), { status: 200 });
      assert.equal(body.messages.at(-1).role, 'assistant', 'paused turn is sent back');
      return new Response(JSON.stringify(F.anthropicResponse([F.X])), { status: 200 });
    },
  });
  const r = await createAnthropicProvider({ apiKey: 'sk-ant-test', fetch: f }).discover(REQ);
  assert.equal(r.ok, true);
  assert.equal(r.output.candidates[0].model, F.X.model);
  assert.equal(r.usage.web_searches, 3);
  assert.equal(r.usage.input_tokens, 12100);
  const b = f.calls[0].body;
  assert.equal(b.model, 'claude-opus-5-5');
  assert.equal(b.tools[0].type, 'web_search_20260209');
  assert.equal(b.output_config.format.type, 'json_schema');
  assert.equal(b.fallbacks, 'default');
  assert.equal(f.calls[0].headers['x-api-key'], 'sk-ant-test');
  assert.equal(f.calls[0].headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
});

test('Gemini adapter: google_search grounding and responseJsonSchema', async () => {
  const f = F.fakeFetch({ gemini: F.geminiResponse([F.Z]) });
  const r = await createGeminiProvider({ apiKey: 'g-test', fetch: f }).discover(REQ);
  assert.equal(r.ok, true);
  assert.equal(r.usage.web_searches, 1);
  assert.deepEqual(f.calls[0].body.tools, [{ google_search: {} }]);
  assert.equal(f.calls[0].body.generationConfig.responseMimeType, 'application/json');
  assert.equal(f.calls[0].headers['x-goog-api-key'], 'g-test');
});

test('adapters retry a simpler request variant when the provider rejects the shape (HTTP 400)', async () => {
  const f = F.fakeFetch({
    gemini: (body) => (body.tools && body.generationConfig.responseJsonSchema
      ? new Response(JSON.stringify({ error: { status: 'INVALID_ARGUMENT', message: 'tool + json mode unsupported' } }), { status: 400 })
      : new Response(JSON.stringify(F.geminiResponse([F.X])), { status: 200 })),
  });
  const r = await createGeminiProvider({ apiKey: 'k', fetch: f }).discover(REQ);
  assert.equal(r.ok, true);
  assert.equal(r.variant, 'search');
  assert.equal(r.attempts[0].ok, false);
  assert.match(f.calls[1].body.contents[0].parts[0].text, /JSON schema/);
});

test('adapters do not retry on auth errors and report them without the key', async () => {
  const f = F.fakeFetch({ openai: () => new Response(JSON.stringify({ error: { type: 'invalid_api_key', message: 'Incorrect API key' } }), { status: 401 }) });
  const r = await createOpenAiProvider({ apiKey: 'sk-secret-123', fetch: f }).discover(REQ);
  assert.equal(r.ok, false);
  assert.equal(f.calls.length, 1);
  assert.match(r.error, /401/);
  assert.ok(!r.error.includes('sk-secret-123'));
});

test('refusal and truncation are failures, not candidates', async () => {
  const fa = F.fakeFetch({ anthropic: F.anthropicResponse([], { stop_reason: 'refusal', stop_details: { category: 'cyber' } }) });
  const ra = await createAnthropicProvider({ apiKey: 'k', fetch: fa }).discover(REQ);
  assert.equal(ra.ok, false);
  assert.equal(ra.stopReason, 'refusal');
  const fo = F.fakeFetch({ openai: F.openaiResponse([], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }) });
  const ro = await createOpenAiProvider({ apiKey: 'k', fetch: fo }).discover(REQ);
  assert.equal(ro.ok, false);
  assert.equal(ro.stopReason, 'max_tokens');
});

test('providersFromEnv lists missing secrets and never the key values', () => {
  const { available, missing } = providersFromEnv({ ANTHROPIC_API_KEY: ' sk-ant ', DISCOVERY_PROVIDERS: 'openai,anthropic,gemini' });
  assert.deepEqual(available.map((p) => p.name), ['anthropic']);
  assert.deepEqual(missing, [{ name: 'openai', role: 'llm', secret: 'OPENAI_API_KEY' }, { name: 'gemini', role: 'llm', secret: 'GEMINI_API_KEY' }]);
  assert.ok(!JSON.stringify(missing).includes('sk-ant'));
});

test('cost estimate uses list prices plus web searches', () => {
  assert.equal(estimateCost('claude-opus-5-5', { input_tokens: 1_000_000, output_tokens: 100_000, web_searches: 10 }).usd, 4 + 2 + 0.1);
  assert.equal(estimateCost('unknown-model', { input_tokens: 1 }).usd, null);
});

// --- malformed output ---------------------------------------------------------------------------------------

test('malformed provider output is dropped with reasons, never thrown', () => {
  assert.equal(normalizeProviderOutput(null, 'p').error, 'output is not a JSON object');
  assert.equal(normalizeProviderOutput({ items: [] }, 'p').error, 'output has no candidates array');
  const r = normalizeProviderOutput({ candidates: [null, 'x', { model: 'No brand' }, { brand: 'HP' }, { brand: 'hp', model: 'HP Victus 15', ram_gb: '16GB', storage_gb: '1 TB', price_egp: '39,999 EGP', offers: [{ retailer: 'Noon', url: 'javascript:alert(1)' }, 5] }] }, 'p');
  assert.equal(r.candidates.length, 1);
  assert.deepEqual(r.rejected.map((x) => x.reason), ['not an object', 'not an object', 'missing brand', 'missing model']);
  const c = r.candidates[0];
  assert.equal(c.brand, 'HP');
  assert.equal(c.model, 'Victus 15');
  assert.equal(c.ram_gb, 16);
  assert.equal(c.storage_gb, 1024);
  assert.equal(c.price_egp, 39999);
  assert.equal(c.offers[0].url, null, 'non-http URL dropped');
  assert.equal(cleanUrl('https://www.google.com/search?q=x'), null);
  assert.equal(parseJsonObject('```json\n{"candidates": []}\n```').candidates.length, 0);
  assert.equal(parseJsonObject('Here you go: {"a": 1} hope it helps').a, 1);
});

test('a provider answering prose (not JSON) fails alone', async () => {
  const f = F.fakeFetch({ openai: { model: 'gpt-5', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'I recommend the IdeaPad.' }] }], usage: {} } });
  const r = await runProvider(createOpenAiProvider({ apiKey: 'k', fetch: f }), REQ, 5000);
  assert.equal(r.ok, false);
  assert.match(r.error, /not JSON/);
  assert.equal(r.candidates.length, 0);
});

// --- timeout / failure / partial and zero success ------------------------------------------------------------

test('provider timeout is reported and does not block the others', async () => {
  const f = F.fakeFetch({ openai: 'timeout', anthropic: F.anthropicResponse([F.X]), gemini: F.geminiResponse([F.X, F.Y]) }, F.PAGES);
  const providers = [createOpenAiProvider({ apiKey: 'k', fetch: f, timeoutMs: 80 }), createAnthropicProvider({ apiKey: 'k', fetch: f }), createGeminiProvider({ apiKey: 'k', fetch: f })];
  const d = await discoverProducts({ profile: F.PROFILE, config: F.laptopConfig, configs: F.CONFIGS, now: F.NOW, providers, fetch: f });
  assert.equal(d.ok, true);
  const o = d.providers.find((p) => p.provider === 'openai');
  assert.equal(o.ok, false);
  assert.match(o.error, /timeout/);
  assert.equal(d.metrics.providers_ok, 2);
  const x = d.consolidated.find((c) => c.brand === 'Lenovo');
  assert.deepEqual(x.providers.sort(), ['anthropic', 'gemini']);
  assert.equal(x.provider_consensus_score, 1, 'consensus counts only providers that answered');
});

test('hard deadline: a provider adapter that never resolves is cut off', async () => {
  const hang = { name: 'hang', model: 'x', discover: () => new Promise(() => {}) };
  const r = await runProvider(hang, REQ, 50);
  assert.equal(r.ok, false);
  assert.match(r.error, /deadline/);
});

test('partial success: Gemini fails, OpenAI and Anthropic results are used', async () => {
  const f = F.fakeFetch({ openai: F.openaiResponse([F.X, F.A]), anthropic: F.anthropicResponse([F.X_ALT, F.Z]), gemini: () => new Response('{"error":{"message":"quota"}}', { status: 429 }) }, F.PAGES);
  const r = await recommendWith(new LLMProductDiscoverySource({ providers: all3(f), configs: F.CONFIGS, fetch: f }), F.PROFILE, F.NOW);
  assert.equal(r.meta.ok, true);
  assert.equal(r.meta.providers.find((p) => p.provider === 'gemini').ok, false);
  assert.equal(r.result.status, 'ok');
  assert.ok(r.result.picks.length >= 1);
});

test('zero providers configured, or all failing: ok false, no picks, every reason reported', async () => {
  const none = await discoverProducts({ profile: F.PROFILE, config: F.laptopConfig, configs: F.CONFIGS, now: F.NOW, providers: [], missing: [{ name: 'openai', secret: 'OPENAI_API_KEY' }] });
  assert.equal(none.ok, false);
  assert.equal(none.snapshot.products.length, 0);
  assert.equal(none.providers_missing[0].secret, 'OPENAI_API_KEY');
  const f = F.fakeFetch({ openai: () => new Response('{}', { status: 500 }), anthropic: () => new Response('{}', { status: 500 }), gemini: F.geminiResponse([], { candidates: [] }) });
  const r = await recommendWith(new LLMProductDiscoverySource({ providers: all3(f), configs: F.CONFIGS, fetch: f }), F.PROFILE, F.NOW);
  assert.equal(r.meta.ok, false);
  assert.equal(r.meta.providers.every((p) => !p.ok && p.error), true);
  assert.equal(r.result.status, 'no_match');
  assert.equal(r.result.picks.length, 0);
});

// --- consolidation -------------------------------------------------------------------------------------------

test('duplicates across providers merge into one product with provider_count', () => {
  const cands = [norm(F.X, 'gemini'), norm(F.X_ALT, 'claude'), norm(F.X, 'openai'), norm(F.Y, 'gemini'), norm(F.Z, 'gemini'), norm(F.Z, 'claude'), norm(F.A, 'openai')];
  const out = consolidate(cands, ['gemini', 'claude', 'openai']);
  const byModel = (b) => out.filter((c) => c.brand === b);
  assert.equal(byModel('Lenovo').length, 1);
  assert.deepEqual(byModel('Lenovo')[0].providers, ['gemini', 'claude', 'openai']);
  assert.equal(byModel('Lenovo')[0].provider_count, 3);
  assert.equal(byModel('HP')[0].provider_count, 1);
  assert.equal(byModel('Asus')[0].provider_count, 2);
  assert.equal(byModel('Apple')[0].provider_count, 1);
  assert.equal(out[0].brand, 'Lenovo', 'ordered by provider count');
  assert.equal(byModel('Lenovo')[0].price_egp, 33000, 'median of 33000, 34500, 33000');
  assert.deepEqual(byModel('Lenovo')[0].price_range, [33000, 34500]);
  assert.equal(byModel('Lenovo')[0].offers.length, 2, 'offers deduplicated by URL');
});

test('same family, different RAM / storage / GPU / CPU stay separate', () => {
  const base = norm(F.X, 'a');
  for (const change of [{ ram_gb: 8 }, { storage_gb: 1024 }, { gpu: 'NVIDIA GeForce RTX 2050' }, { cpu: 'Intel Core i7-13620H' }]) {
    const other = norm({ ...F.X, ...change }, 'b');
    assert.equal(sameProduct(base, other).same, false, JSON.stringify(change));
    const out = consolidate([base, other], ['a', 'b']);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0].possible_duplicates.length, 1, 'cross-referenced for review, not merged');
  }
});

test('conservative: incomplete specs or conflicting MPNs never merge; matching MPNs do', () => {
  const a = norm(F.X, 'a');
  assert.equal(sameProduct(a, norm({ ...F.X, gpu: null }, 'b')).why, 'configuration incomplete');
  assert.equal(sameProduct(a, norm({ ...F.X, ram_gb: null }, 'b')).same, false);
  assert.equal(sameProduct(norm({ ...F.X, mpn: '83ER00ABED' }, 'a'), norm({ ...F.X, mpn: '83ER00XXED' }, 'b')).why, 'MPN differs');
  assert.equal(sameProduct(norm({ ...F.X, mpn: '83ER-00AB-ED' }, 'a'), norm({ ...F.X, model: 'Slim 3', mpn: '83er00abed' }, 'b')).same, true);
  assert.equal(sameProduct(a, norm({ ...F.X, model: 'IdeaPad Pro 5 14' }, 'b')).same, false, 'different model names');
  assert.equal(sameProduct(a, norm({ ...F.X, brand: 'HP' }, 'b')).same, false);
  assert.equal(cpuToken('Intel® Core™ i5-12450H'), 'i5-12450h');
  assert.equal(cpuToken('AMD Ryzen 7 7735HS'), 'ryzen7-7735hs');
  assert.equal(cpuToken('Intel Core Ultra 7 155H'), 'ultra7-155h');
  assert.equal(cpuToken('Intel Core i5'), null, 'vague CPU is not a signature');
  assert.equal(gpuToken('NVIDIA GeForce RTX 4050 Laptop GPU 6GB'), 'rtx4050');
  assert.equal(gpuToken('Intel Iris Xe Graphics'), 'integrated');
});

test('the same provider listing one configuration twice is counted once', () => {
  const out = consolidate([norm(F.X, 'gemini'), norm(F.X_ALT, 'gemini')], ['gemini', 'openai']);
  assert.equal(out.length, 1);
  assert.equal(out[0].provider_count, 1);
  assert.equal(out[0].provider_consensus_score, 0.5);
});

// --- specs mapping -------------------------------------------------------------------------------------------

test('spec mapping onto the laptop attribute scale is deterministic and leaves unknowns null', () => {
  assert.ok(cpuScore('Intel Core i7-13700H') > cpuScore('Intel Core i5-1335U'));
  assert.ok(cpuScore('Apple M3 Pro') > cpuScore('Apple M2'));
  assert.equal(cpuScore('some cpu'), null);
  assert.deepEqual(gpuInfo('NVIDIA GeForce RTX 4060'), { score: 7, dedicated: true });
  assert.equal(gpuInfo('Intel UHD Graphics').dedicated, false);
  assert.ok(screenScore('15.6" 2.8K OLED 120Hz') > screenScore('15.6" FHD IPS'));
  assert.ok(screenScore('15.6" HD TN') < screenScore('15.6" FHD IPS'));
  const { attrs } = laptopAttrs(norm(F.Y));
  assert.equal(attrs.has_dedicated_gpu, true);
  assert.equal(attrs.ram_gb, 16);
  assert.equal(attrs.build, undefined, 'build is not inferred');
  assert.equal(attrs.keyboard, undefined, 'keyboard is not inferred');
  assert.equal(laptopAttrs(norm(F.A)).attrs.os, 'macos');
});

// --- verification --------------------------------------------------------------------------------------------

test('verification: verified, blocked (no bypass), unavailable, mismatch and no URL are kept apart', async () => {
  const f = F.fakeFetch({}, F.PAGES);
  const products = consolidate([norm(F.X, 'a'), norm(F.X_ALT, 'b'), norm(F.X_8GB, 'a'), norm(F.Y, 'a'), norm(F.Z, 'a'), norm(F.A, 'a')], ['a', 'b']);
  const v = await verifyCandidates(products, { fetch: f });
  const by = (brand, ram) => products.find((p) => p.brand === brand && (!ram || p.ram_gb === ram));
  assert.equal(by('Lenovo', 16).verification_status, 'verified');
  assert.equal(by('Lenovo', 16).offers.find((o) => o.url.includes('amazon')).page_price_egp, 32999);
  assert.equal(by('Lenovo', 16).verification.urls.find((u) => u.url.includes('noon')).status, 'blocked');
  assert.equal(by('Lenovo', 8).verification_status, 'unavailable');
  assert.equal(by('HP').verification_status, 'partial', 'page names the product but not every spec');
  assert.equal(by('Asus').verification_status, 'no_url');
  assert.equal(by('Apple').verification_status, 'mismatch');
  assert.equal(by('Apple').offers[0].url, null, 'mismatched link is dropped');
  assert.ok(by('Lenovo', 16).evidence_confidence > by('HP').evidence_confidence);
  assert.ok(by('HP').evidence_confidence > by('Asus').evidence_confidence);
  assert.equal(v.checked, 5);
  // every page request is a single plain GET (no retries, no alternative identities)
  const pageCalls = f.calls.filter((c) => !c.url.includes('api.'));
  assert.equal(new Set(pageCalls.map((c) => c.url)).size, pageCalls.length);
  assert.deepEqual(pagePrices('<script>{"price":"45,999"}</script>'), [45999]);
});

test('verification can be switched off: candidates stay, marked not checked, lower evidence', async () => {
  const products = consolidate([norm(F.X, 'a')], ['a']);
  await verifyCandidates(products, { enabled: false });
  assert.equal(products[0].verification_status, 'not_checked');
  assert.equal(products[0].evidence_confidence, 0.3);
});

test('consensus is not evidence: three providers agreeing on an unverifiable product keep low evidence', async () => {
  const blind = { ...F.X, offers: [{ retailer: 'Noon', url: 'https://www.noon.com/egypt-en/ideapad3/p/', price_egp: 33000 }] };
  const products = consolidate([norm(blind, 'a'), norm(blind, 'b'), norm(blind, 'c')], ['a', 'b', 'c']);
  await verifyCandidates(products, { fetch: F.fakeFetch({}, F.PAGES) });
  assert.equal(products[0].provider_consensus_score, 1);
  assert.equal(products[0].verification_status, 'blocked');
  assert.equal(products[0].evidence_confidence, 0.3);
});

// --- ephemeral snapshot ---------------------------------------------------------------------------------------

async function builtSnapshot() {
  const f = F.fakeFetch({}, F.PAGES);
  const products = consolidate([norm(F.X, 'a'), norm(F.X_ALT, 'b'), norm(F.Y, 'a'), norm(F.Z, 'b'), norm(F.A, 'a'), norm(F.NO_PRICE, 'a')], ['a', 'b']);
  await verifyCandidates(products, { fetch: f });
  return { products, ...buildEphemeralSnapshot(products, { configs: F.CONFIGS, category: 'laptop', now: F.NOW, requestId: 't1' }) };
}

test('snapshot conversion: the same CatalogSnapshot contract as the catalog, in memory only', async () => {
  const { snapshot, index, unrankable } = await builtSnapshot();
  const v = validateSnapshot(snapshot);
  assert.equal(v.ok, true, v.errors.join('\n'));
  assert.equal(snapshot.tenant_id, EPHEMERAL_TENANT);
  assert.equal(snapshot.ephemeral, true);
  assert.equal(snapshot.products.length, 4);
  assert.deepEqual(unrankable.map((u) => u.brand), ['Dell'], 'no price -> not rankable');
  for (const p of snapshot.products) {
    assert.equal(p.ref_price_egp, null, 'no fabricated reference price');
    assert.equal(p.checked_at, F.NOW);
    assert.ok(index[p.id].providers.length >= 1);
  }
  const asus = snapshot.offers.find((o) => o.product_id.includes('asus'));
  assert.equal(asus.url_kind, 'search_link');
  assert.ok(asus.assumptions.includes('delivery'));
  assert.equal(snapshot.plans.length, 0);
  const lenovoAmazon = snapshot.offers.find((o) => o.product_id.includes('lenovo') && o.retailer_id === 'amazon_eg');
  assert.equal(lenovoAmazon.price_egp, 32999, 'structured page price beats the provider claim');
  assert.equal(resolveRetailer({ url: 'https://www.btech.com/x' }).id, 'btech');
  assert.equal(resolveRetailer({ retailer: 'Some Shop' }).trust, 6);
});

test('existing Recommendation Engine runs unchanged on the ephemeral snapshot', async () => {
  const { snapshot } = await builtSnapshot();
  const r = match(F.PROFILE, snapshot, F.NOW, 'rank');
  assert.equal(validateMatchResult(r).ok, true);
  assert.equal(r.status, 'ok');
  assert.ok(r.picks.length >= 1 && r.picks.length <= 3);
  for (const p of r.picks) assert.ok(snapshot.products.some((x) => x.id === p.product.id));
  // determinism: same profile, same snapshot, same now => same result
  assert.deepEqual(match(F.PROFILE, snapshot, F.NOW, 'rank'), r);
  const sim = match(F.PROFILE, snapshot, F.NOW, 'simulate');
  assert.equal(sim.top1, r.picks.find((p) => p.role === 'best_fit').product.id);
});

test('consensus never decides the winner: an over-budget product named by every provider does not rank first', async () => {
  const pricey = { ...F.X, brand: 'Dell', model: 'XPS 15 9530', cpu: 'Intel Core i7-13700H', gpu: 'NVIDIA GeForce RTX 4060', price_egp: 95000, offers: [{ retailer: 'Amazon Egypt', url: null, price_egp: 95000 }] };
  const cands = [norm(pricey, 'a'), norm(pricey, 'b'), norm(pricey, 'c'), norm(F.X, 'a')];
  const products = consolidate(cands, ['a', 'b', 'c']);
  await verifyCandidates(products, { enabled: false });
  const { snapshot, index } = buildEphemeralSnapshot(products, { configs: F.CONFIGS, category: 'laptop', now: F.NOW });
  const dell = Object.keys(index).find((id) => id.includes('dell'));
  assert.equal(index[dell].provider_count, 3);
  const r = match(F.PROFILE, snapshot, F.NOW, 'rank');
  assert.notEqual(r.picks[0].product.id, dell);
  assert.equal(r.picks.find((p) => p.role === 'best_fit').product.brand, 'Lenovo');
});

test('profile constraints still apply: video editing (16 GB must) drops 8 GB LLM candidates', async () => {
  const products = consolidate([norm(F.X_8GB, 'a'), norm(F.X, 'a')], ['a']);
  await verifyCandidates(products, { enabled: false });
  const { snapshot } = buildEphemeralSnapshot(products, { configs: F.CONFIGS, category: 'laptop', now: F.NOW });
  const p = structuredClone(F.PROFILE);
  p.must.push({ attr: 'ram_gb', op: '>=', value: 16 });
  const r = match(p, snapshot, F.NOW, 'rank');
  assert.ok(r.picks.every((x) => !x.product.id.includes('8gb')));
});

test('ProductSource: catalog and LLM sources feed the same engine call', async () => {
  const catalogSnap = { snapshot_id: 'cat', tenant_id: 'wisedo', configs: F.CONFIGS, products: [], offers: [], retailers: [], plans: [] };
  const c = await recommendWith(new ExistingCatalogProductSource(catalogSnap), F.PROFILE, F.NOW);
  assert.equal(c.source, 'catalog');
  assert.equal(c.result.status, 'no_match');
  const f = F.fakeFetch({ anthropic: F.anthropicResponse([F.X]) }, F.PAGES);
  const l = await recommendWith(new LLMProductDiscoverySource({ providers: [createAnthropicProvider({ apiKey: 'k', fetch: f })], configs: F.CONFIGS, fetch: f }), F.PROFILE, F.NOW);
  assert.equal(l.source, 'llm_discovery');
  assert.equal(l.result.picks[0].product.brand, 'Lenovo');
  assert.equal(l.meta.metrics.providers_ok, 1);
  assert.ok(l.meta.providers[0].latency_ms >= 0);
  assert.ok(l.meta.providers[0].cost_usd > 0);
});

// --- Worker route --------------------------------------------------------------------------------------------

const TOKEN = 'test-admin-token-0123456789abcdef';
async function workerSetup(extraEnv = {}) {
  const env = { DB: createD1(), WISEDO_ADMIN_TOKEN: TOKEN, ASSETS: { fetch: async () => new Response('asset') }, ...extraEnv };
  const call = async (method, path, body, auth = true) => {
    const headers = { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}) };
    const res = await worker.fetch(new Request(`https://exp.test${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
    return { status: res.status, body: await res.json() };
  };
  await call('POST', '/api/admin/reset');
  return { env, call };
}

test('worker: /api/expb/status reports configured providers and missing secrets', async () => {
  const { call } = await workerSetup({ GEMINI_API_KEY: 'g', SERPER_API_KEY: 's' });
  const r = await call('GET', '/api/expb/status', null, false);
  assert.deepEqual(r.body.providers.map((p) => [p.name, p.role]), [['gemini', 'llm'], ['serper', 'shopping']]);
  assert.deepEqual(r.body.missing.map((m) => m.secret), ['GROQ_API_KEY', 'MISTRAL_API_KEY', 'TAVILY_API_KEY']);
  assert.equal(r.body.access, 'admin_token');
});

test('worker: /api/expb/run needs the token, validates the profile, runs end to end and logs the run', async () => {
  const { env, call } = await workerSetup({ DISCOVERY_PROVIDERS: 'openai,anthropic,gemini', OPENAI_API_KEY: 'sk-openai-SECRET', ANTHROPIC_API_KEY: 'sk-ant-SECRET', GEMINI_API_KEY: 'gemini-SECRET', EXPB_RATE_PER_MIN: '100' });
  assert.equal((await call('POST', '/api/expb/run', { profile: F.PROFILE }, false)).status, 401);
  assert.equal((await call('POST', '/api/expb/run', { profile: { ...F.PROFILE, category: 'tv' } })).status, 400);
  assert.equal((await call('POST', '/api/expb/run', { profile: { ...F.PROFILE, needs: 'x' } })).status, 422);
  const before = await call('GET', '/api/health', null, false);
  const realFetch = globalThis.fetch;
  globalThis.fetch = F.fakeFetch({ openai: F.openaiResponse([F.X, F.A]), anthropic: F.anthropicResponse([F.X_ALT, F.Z]), gemini: () => new Response('{}', { status: 503 }) }, F.PAGES);
  let r;
  try { r = await call('POST', '/api/expb/run', { profile: F.PROFILE }); } finally { globalThis.fetch = realFetch; }
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.metrics.providers_ok, 2);
  assert.equal(r.body.providers.find((p) => p.provider === 'gemini').ok, false);
  assert.ok(r.body.top3.length >= 1 && r.body.top3.length <= 3);
  assert.ok(r.body.top3[0].discovery.providers.length >= 1);
  assert.ok(r.body.consolidated.find((c) => c.brand === 'Lenovo').provider_count === 2);
  assert.ok(Array.isArray(r.body.catalog.top3));
  assert.ok(typeof r.body.metrics.total_ms === 'number');
  for (const k of ['sk-openai-SECRET', 'sk-ant-SECRET', 'gemini-SECRET']) assert.ok(!JSON.stringify(r.body).includes(k), 'no key in the response');
  // the catalog is untouched: same counts before and after, no LLM product rows
  const after = await call('GET', '/api/health', null, false);
  assert.deepEqual(after.body.counts, before.body.counts);
  const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM products WHERE id LIKE 'expb-%'").first('n');
  assert.equal(rows, 0);
  const runs = await call('GET', '/api/expb/runs');
  assert.equal(runs.body.length, 1);
  assert.equal(runs.body[0].providers_ok, 2);
});

test('worker: zero providers configured returns 502 with the missing secrets, not a crash', async () => {
  const { call } = await workerSetup();
  const r = await call('POST', '/api/expb/run', { profile: F.PROFILE });
  assert.equal(r.status, 502);
  assert.equal(r.body.ok, false);
  assert.deepEqual(r.body.providers_missing.map((m) => m.secret), ['GEMINI_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'TAVILY_API_KEY', 'SERPER_API_KEY']);
  assert.equal(r.body.top3.length, 0);
});
