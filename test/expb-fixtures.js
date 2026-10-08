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
  offers: [{ retailer: 'Amazon Egypt', url: 'https://www.amazon.eg/dp/IDEAPAD3', price_egp: 33000 }],
  fit_reasons: ['16 GB RAM for programming'], confidence: 0.7, evidence: 'from training knowledge', ...o,
});

export const X = cand({});                                   // the same configuration, named three ways below
export const X_ALT = cand({ model: 'Lenovo IdeaPad Slim 3 15IAH8 Laptop', price_egp: 34500, offers: [{ retailer: 'Noon', url: 'https://www.noon.com/egypt-en/ideapad3/p/', price_egp: 34500 }] });
export const X_8GB = cand({ ram_gb: 8, price_egp: 29000, offers: [{ retailer: 'B.TECH', url: 'https://btech.com/en/ideapad-8gb', price_egp: 29000 }] });
export const Y = cand({ brand: 'HP', model: 'Victus 15-fa1xxx', cpu: 'Intel Core i5-13420H', gpu: 'NVIDIA GeForce RTX 3050 6GB', price_egp: 39000, weight_kg: 2.3,
  offers: [{ retailer: '2B', url: 'https://2b.com.eg/en/victus-15', price_egp: 39000 }] });
export const Z = cand({ brand: 'Asus', model: 'Vivobook 15 X1504VA', cpu: 'Intel Core i7-1355U', ram_gb: 16, storage_gb: 1024, gpu: 'Intel Iris Xe', price_egp: 37000,
  offers: [{ retailer: 'Raya Shop', url: null, price_egp: 37000 }] });
export const A = cand({ brand: 'Apple', model: 'MacBook Air 13 M2', cpu: 'Apple M2', ram_gb: 8, storage_gb: 256, gpu: null, display: '13.6in Liquid Retina', screen_inches: 13.6, weight_kg: 1.24, os: 'macOS', price_egp: 47000,
  offers: [{ retailer: 'Amazon Egypt', url: 'https://www.amazon.eg/dp/MBAM2', price_egp: 47000 }] });
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
    const which = u.includes('api.openai.com') ? 'openai' : u.includes('api.anthropic.com') ? 'anthropic' : u.includes('generativelanguage') ? 'gemini' : null;
    if (which) {
      const r = routes[which];
      if (r === undefined) return jsonRes(500, { error: { message: 'no route' } });
      if (r === 'timeout') return new Promise((_, rej) => { if (init.signal) init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
      if (typeof r === 'function') return r(init.body ? JSON.parse(init.body) : null, calls);
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
  'https://www.amazon.eg/dp/IDEAPAD3': '<html><title>Lenovo IdeaPad Slim 3 15IAH8 Laptop, Intel Core i5-12450H, 16GB RAM, 512GB SSD</title><script type="application/ld+json">{"offers":{"price":"32999","priceCurrency":"EGP"}}</script></html>',
  'https://www.noon.com/egypt-en/ideapad3/p/': 403,
  'https://btech.com/en/ideapad-8gb': '<html><title>Lenovo IdeaPad Slim 3 8GB 512GB</title><body>Out of stock</body></html>',
  'https://2b.com.eg/en/victus-15': '<html><title>HP Victus 15 gaming laptop</title><body>RTX 3050</body></html>',
  'https://www.amazon.eg/dp/MBAM2': '<html><title>Samsung Galaxy Tab S9</title></html>',
};
