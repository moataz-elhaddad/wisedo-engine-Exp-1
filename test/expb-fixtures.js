// Experiment B test fixtures: a laptop NeedProfile, candidate lists in each provider's own response format,
// and a fake fetch that serves recorded provider and product-page responses. No network.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNeedProfile } from '../src/profile/build.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const laptopConfig = JSON.parse(readFileSync(join(ROOT, 'config/laptop.json'), 'utf8'));
export const CONFIGS = { laptop: laptopConfig };
export const NOW = '2026-10-03T12:00:00.000Z';

/** Programming laptop, cash, 40,000 EGP, Cairo. */
export const PROFILE = (() => {
  const p = buildNeedProfile(laptopConfig, { use: ['programming'], budget: 40000, pay: 'cash', city: 'cairo' });
  p.status = 'complete';
  return p;
})();

const cand = (o) => ({
  brand: 'Lenovo', model: 'IdeaPad Slim 3 15IAH8', mpn: null, cpu: 'Intel Core i5-12450H', ram_gb: 16, storage_gb: 512,
  gpu: 'Intel UHD Graphics (integrated)', display: '15.6in FHD IPS', screen_inches: 15.6, os: 'Windows 11', weight_kg: 1.62,
  battery_hours: 8, price_egp: 33000, price_basis: 'recent_knowledge', availability_egypt: 'likely_available', grey_import: false,
  offers: [{ retailer: 'Amazon Egypt', url: 'https://www.amazon.eg/dp/B0IDEAPAD3', price_egp: 33000 }],
  fit_reasons: ['16 GB RAM for programming'], confidence: 0.7, evidence: 'from training knowledge', ...o,
});

export const X = cand({});                                   // the same configuration, named three ways below
export const X_ALT = cand({ model: 'Lenovo IdeaPad Slim 3 15IAH8 Laptop', price_egp: 34500, offers: [{ retailer: 'Noon', url: 'https://www.noon.com/egypt-en/ideapad-slim-3/N70012345V/p/', price_egp: 34500 }] });
export const X_8GB = cand({ ram_gb: 8, price_egp: 29000, offers: [{ retailer: 'B.TECH', url: 'https://btech.com/en/lenovo-ideapad-slim-3-8gb-512gb', price_egp: 29000 }] });
export const Y = cand({ brand: 'HP', model: 'Victus 15-fa1xxx', cpu: 'Intel Core i5-13420H', gpu: 'NVIDIA GeForce RTX 3050 6GB', price_egp: 39000, weight_kg: 2.3,
  offers: [{ retailer: '2B', url: 'https://2b.com.eg/en/hp-victus-15-fa1xxx-i5-13420h', price_egp: 39000 }] });
export const Z = cand({ brand: 'Asus', model: 'Vivobook 15 X1504VA', cpu: 'Intel Core i7-1355U', ram_gb: 16, storage_gb: 1024, gpu: 'Intel Iris Xe', price_egp: 37000,
  offers: [{ retailer: 'Raya Shop', url: null, price_egp: 37000 }] });
export const A = cand({ brand: 'Apple', model: 'MacBook Air 13 M2', cpu: 'Apple M2', ram_gb: 8, storage_gb: 256, gpu: null, display: '13.6in Liquid Retina', screen_inches: 13.6, weight_kg: 1.24, os: 'macOS', price_egp: 47000,
  offers: [{ retailer: 'Amazon Egypt', url: 'https://www.amazon.eg/dp/B0MBAM2XYZ', price_egp: 47000 }] });
export const NO_PRICE = cand({ brand: 'Dell', model: 'Inspiron 15 3530', cpu: 'Intel Core i5-1335U', price_egp: null, offers: [{ retailer: 'Dell', url: null, price_egp: null }] });

// Provider-format responses -----------------------------------------------------------------------------------
export const anthropicResponse = (candidates, extra = {}) => ({
  id: 'msg_test', type: 'message', model: 'claude-opus-5-5', stop_reason: 'end_turn',
  content: [{ type: 'server_tool_use', id: 'srv1', name: 'web_search', input: { query: 'laptop egypt' } }, { type: 'text', text: JSON.stringify({ candidates }) }],
  usage: { input_tokens: 12000, output_tokens: 2500, server_tool_use: { web_search_requests: 2 } }, ...extra,
});
export const openaiResponse = (candidates, extra = {}) => ({
  id: 'resp_test', model: 'gpt-5', status: 'completed',
  output: [{ type: 'web_search_call', status: 'completed' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify({ candidates }) }] }],
  usage: { input_tokens: 9000, output_tokens: 3000 }, ...extra,
});
export const geminiResponse = (candidates, extra = {}) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify({ candidates }) }] }, finishReason: 'STOP', groundingMetadata: { webSearchQueries: ['laptop egypt'] } }],
  usageMetadata: { promptTokenCount: 5000, candidatesTokenCount: 2000 }, ...extra,
});

export const chatResponse = (candidates, extra = {}, msgExtra = {}) => ({
  id: 'chat_test', model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ candidates }), ...msgExtra } }],
  usage: { prompt_tokens: 4000, completion_tokens: 1500 }, ...extra,
});
/** Cohere v2 chat response shape. */
export const cohereResponse = (candidates, extra = {}) => ({
  id: 'co_test', finish_reason: 'COMPLETE',
  message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ candidates }) }] },
  usage: { billed_units: { input_tokens: 3500, output_tokens: 1400 }, tokens: { input_tokens: 3600, output_tokens: 1400 } }, ...extra,
});
export const groqResponse = (c, e) => chatResponse(c, { model: 'groq/compound', ...e }, { executed_tools: [{ type: 'search', arguments: '{"query":"laptop egypt"}' }, { type: 'search' }] });

/** Shop listing titles as they look on Egyptian retailers. */
export const LISTINGS = {
  ideapad: { title: 'Lenovo IdeaPad Slim 3 15IAH8 Laptop - Intel Core i5-12450H, 16GB RAM, 512GB SSD, Intel UHD Graphics, 15.6" FHD IPS', source: 'Amazon.eg', link: 'https://www.amazon.eg/dp/B0IDEAPAD3', price: 'EGP 32,499.00' },
  ideapad8: { title: 'Lenovo IdeaPad Slim 3 15IAH8 - Core i5-12450H - 8GB RAM - 512GB SSD', source: 'B.TECH', link: 'https://btech.com/en/lenovo-ideapad-slim-3-8gb-512gb', price: 'EGP 28,999.00' },
  vivobook: { title: 'ASUS Vivobook 16 X1605VA, Intel Core i7-13620H, 16GB RAM, 1TB SSD, Intel UHD Graphics, 16" WUXGA', source: '2B', link: 'https://2b.com.eg/en/vivobook-16-x1605va', price: 'EGP 38,750.00' },
  mouse: { title: 'Logitech M185 Wireless Mouse', source: 'Noon', link: 'https://www.noon.com/egypt-en/m185/N11111111A/p/', price: 'EGP 450.00' },
  usd: { title: 'HP Victus 15-fa1xxx Intel Core i5-13420H 16GB 512GB RTX 3050', source: 'BestBuy', link: 'https://www.bestbuy.com/victus', price: '$649.99' },
};
export const asListing = (x, provider = 'serper', kind = 'shopping') => ({ provider, kind, title: x.title, url: x.link, price_text: x.price, source: x.source });
/** Egyptian direct product listings (shopping-provider shape) that can verify X, Y, Z and an XPS. */
export const EG_LISTINGS = [
  { ...LISTINGS.ideapad },
  { title: 'HP Victus 15-fa1xxx Intel Core i5-13420H 16GB RAM 512GB SSD NVIDIA GeForce RTX 3050 6GB', source: '2B', link: 'https://2b.com.eg/en/hp-victus-15-fa1xxx-i5-13420h', price: 'EGP 39,000.00' },
  { title: 'ASUS Vivobook 15 X1504VA Intel Core i7-1355U 16GB RAM 1TB SSD Intel Iris Xe', source: 'Raya Shop', link: 'https://www.rayashop.com/en/asus-vivobook-15-x1504va-i7-1355u-16gb-1tb', price: 'EGP 36,999.00' },
  { title: 'Dell XPS 15 9530 Intel Core i7-13700H 16GB 512GB RTX 4060', source: 'Amazon.eg', link: 'https://www.amazon.eg/dp/B0XPS15953', price: 'EGP 95,000.00' },
].map((x) => asListing(x));
export const serperShopping = (items) => ({ shopping: items.map((x, i) => ({ ...x, position: i + 1 })), credits: 1 });
export const serperSearch = (items) => ({ organic: items.map((x, i) => ({ title: x.title, link: x.link, snippet: `${x.title} price ${x.price}`, position: i + 1 })), credits: 1 });
export const tavilyResponse = (results) => ({ query: 'q', results: results.map((r) => ({ title: r.title, url: r.link || r.url, content: r.content || `${r.title} – available in Egypt for ${r.price || 'n/a'}`, score: 0.8 })), response_time: 1.2 });

const jsonRes = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const page = (html, status = 200) => new Response(html, { status, headers: { 'content-type': 'text/html' } });

/**
 * Fake fetch. routes: {openai, anthropic, gemini} -> body | (body) => Response | 'timeout'; pages: url -> html | status.
 * Records every call in .calls.
 */
export function fakeFetch(routes = {}, pages = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const which = u.includes('api.openai.com') ? 'openai' : u.includes('api.anthropic.com') ? 'anthropic' : u.includes('generativelanguage') ? 'gemini'
      : u.includes('api.cohere.com') ? 'cohere' : u.includes('api.groq.com') ? 'groq' : u.includes('api.tavily.com') ? 'tavily'
      : u.includes('google.serper.dev/shopping') ? 'serper_shopping' : u.includes('google.serper.dev/search') ? 'serper_search' : null;
    if (which) {
      const r = routes[which];
      if (r === undefined) return jsonRes(500, { error: { message: 'no route' } });
      if (r === 'timeout') return new Promise((_, rej) => { if (init.signal) init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
      const body = init.body ? JSON.parse(init.body) : null;
      // Serper batch: an array of queries in, an array of result objects out (each element answered like a single query).
      if (which === 'serper_search' && Array.isArray(body)) {
        const each = await Promise.all(body.map(async (q) => {
          const res = typeof r === 'function' ? await r(q, calls) : jsonRes(200, r);
          if (!res.ok) return { status: res.status };
          return res.json();
        }));
        const bad = each.find((x) => x && x.status && !x.organic);
        return bad ? jsonRes(bad.status, { message: 'error' }) : jsonRes(200, each);
      }
      if (typeof r === 'function') return r(body, calls);
      return jsonRes(200, r);
    }
    const p = pages[u];
    if (p === undefined) return page('not found', 404);
    if (typeof p === 'number') return page('blocked', p);
    return page(p);
  };
  f.calls = calls;
  return f;
}

export const PAGES = {
  'https://www.amazon.eg/dp/B0IDEAPAD3': '<html><title>Lenovo IdeaPad Slim 3 15IAH8 Laptop, Intel Core i5-12450H, 16GB RAM, 512GB SSD</title><script type="application/ld+json">{"offers":{"price":"32999","priceCurrency":"EGP"}}</script></html>',
  'https://www.noon.com/egypt-en/ideapad-slim-3/N70012345V/p/': 403,
  'https://btech.com/en/lenovo-ideapad-slim-3-8gb-512gb': '<html><title>Lenovo IdeaPad Slim 3 8GB 512GB</title><script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","price":"28999","priceCurrency":"EGP","availability":"https://schema.org/OutOfStock"}}</script><body>Out of stock</body></html>',
  'https://2b.com.eg/en/hp-victus-15-fa1xxx-i5-13420h': '<html><title>HP Victus 15 gaming laptop</title><body>RTX 3050</body></html>',
  'https://www.amazon.eg/dp/B0MBAM2XYZ': '<html><title>Samsung Galaxy Tab S9</title></html>',
  'https://www.rayashop.com/en/asus-vivobook-15-x1504va-i7-1355u-16gb-1tb': '<html><title>ASUS Vivobook 15 X1504VA i7-1355U 16GB 1TB</title><body>EGP 36,999</body></html>',
  'https://www.amazon.eg/dp/B0XPS15953': '<html><title>Dell XPS 15 9530 Core i7-13700H 16GB 512GB RTX 4060</title></html>',
  'https://2b.com.eg/en/vivobook-16-x1605va': '<html><title>ASUS Vivobook 16 X1605VA Intel Core i7-13620H 16GB RAM 1TB SSD</title><script type="application/ld+json">{"offers":{"price":"38750","priceCurrency":"EGP"}}</script></html>',
};
