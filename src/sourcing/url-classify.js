// Experiment B: what kind of page is a URL, and is it an Egyptian storefront?
//
//   classifyUrl(url) -> {type, egypt, country, retailer, host}
//   type: direct_product | category | search_results | homepage | article | manufacturer_specs | classified |
//         comparison | foreign_store | unknown
//
// Only a direct_product page on an Egyptian storefront can carry a verified offer (offers.js). Manufacturer pages,
// articles and foreign stores are evidence for specs at most; classifieds and comparison sites never sell.
// Rules are deterministic and deliberately conservative: when in doubt the type is not direct_product.

/** Egyptian retailers: host, display name, and the shape of a single-product URL on that site. */
export const EGYPT_RETAILERS = [
  { host: 'amazon.eg', name: 'Amazon Egypt', product: /\/(dp|gp\/product)\/[A-Z0-9]{10}(\/|$|\?)/i },
  { host: 'noon.com', name: 'Noon Egypt', path: /^\/egypt-(en|ar)\//, product: /\/[A-Z0-9]{8,}\/p\/?$/i },
  { host: 'btech.com', name: 'B.TECH', product: 'slug' },
  { host: '2b.com.eg', name: '2B Egypt', product: 'slug' },
  { host: 'jumia.com.eg', name: 'Jumia Egypt', product: /-\d{5,}\.html$/ },
  { host: 'rayashop.com', name: 'Raya Shop', product: 'slug' },
  { host: 'compumarts.com', name: 'Compumarts', product: /\/products\/[^/]+$/ },
  { host: 'dubaiphone.net', name: 'Dubai Phone Egypt', product: 'slug' },
  { host: 'elbadrgroupeg.store', name: 'El Badr Group', product: 'slug' },
  { host: 'elbadrgroup.com', name: 'El Badr Group', product: 'slug' },
  { host: 'sigma-computer.com', name: 'Sigma Computer', product: 'slug' },
  { host: 'elarabygroup.com', name: 'El Araby', product: 'slug' },
  { host: 'select.com.eg', name: 'Select', product: 'slug' },
  { host: 'tradeline-stores.com', name: 'Tradeline', product: 'slug' },
  { host: 'cairosales.com', name: 'Cairo Sales', product: 'slug' },
  { host: 'carrefouregypt.com', name: 'Carrefour Egypt', product: /\/p\/\d+/ },
  { host: 'egypt.sharafdg.com', name: 'Sharaf DG Egypt', product: 'slug' },
  { host: 'egyptlaptop.com', name: 'Egypt Laptop', product: 'slug' },
  { host: 'kimostore.net', name: 'Kimo Store', product: 'slug' },
  { host: 'badrgroup.com', name: 'Badr Group', product: 'slug' },
  { host: 'elghazawy.com', name: 'El Ghazawy', product: /\/product\/\d+/ },
  { host: 'games2egypt.com', name: 'Games2Egypt', product: /\/product\/\d+/i },
  { host: 'abcshop-eg.com', name: 'ABC Shop Egypt', product: /\/shop\/[^/]+$/ },
  { host: 'oksouq.com', name: 'OK Souq', product: /\/shop\/[^/]+$/ },
  { host: 'eg.labeb.com', name: 'Labeb Egypt', product: 'slug' },
  { host: 'elite.com.eg', name: 'Elite', product: /\/product-page\/[^/]+/ },
];

const MANUFACTURERS = ['asus.com', 'lenovo.com', 'hp.com', 'dell.com', 'acer.com', 'msi.com', 'apple.com', 'huawei.com', 'samsung.com',
  'microsoft.com', 'lg.com', 'gigabyte.com', 'razer.com', 'intel.com', 'amd.com', 'nvidia.com', 'xiaomi.com', 'honor.com', 'infinixmobility.com'];
const ARTICLE_HOSTS = ['youtube.com', 'youtu.be', 'reddit.com', 'facebook.com', 'tiktok.com', 'instagram.com', 'x.com', 'twitter.com', 'notebookcheck.net',
  'tomshardware.com', 'techradar.com', 'pcmag.com', 'rtings.com', 'laptopmag.com', 'theverge.com', 'cnet.com', 'wikipedia.org', 'ts3era.com', 'myxprs.com'];
const COMPARISON_HOSTS = ['pricena.com', 'yaoota.com', 'pricespy.com', 'idealo.com', 'pricerunner.com', 'google.com', 'shopping.google.com'];
const CLASSIFIED_HOSTS = ['dubizzle.com.eg', 'dubizzle.com', 'olx.com.eg', 'opensooq.com', 'hatla2ee.com'];
/** Stores outside Egypt (country), including the non-Egyptian storefronts of regional chains. */
const FOREIGN_STORES = [
  ['amazon.ae', 'AE'], ['amazon.sa', 'SA'], ['amazon.com', 'US'], ['amazon.co.uk', 'GB'], ['amazon.de', 'DE'], ['amazon.in', 'IN'],
  ['bestbuy.com', 'US'], ['newegg.com', 'US'], ['walmart.com', 'US'], ['bhphotovideo.com', 'US'], ['ebay.com', 'US'], ['aliexpress.com', 'CN'],
  ['jarir.com', 'SA'], ['extra.com', 'SA'], ['sharafdg.com', 'AE'], ['jumbo.ae', 'AE'], ['carrefouruae.com', 'AE'], ['virginmegastore.ae', 'AE'],
  ['xcite.com', 'KW'], ['lulu.com', 'AE'],
];
const NOON_COUNTRIES = { uae: 'AE', saudi: 'SA', kuwait: 'KW', bahrain: 'BH', oman: 'OM', qatar: 'QA' };

const onHost = (h, list) => list.some((x) => h === x || h.endsWith('.' + x));

/** Generic single-product slug: a long, specific last path segment (model words, often a part number or .html). */
function looksLikeProductSlug(path) {
  const seg = decodeURIComponent(path.replace(/\/+$/, '').split('/').pop() || '').toLowerCase();
  if (!seg) return false;
  const words = seg.replace(/\.html?$/, '').split(/[-_]+/).filter(Boolean);
  if (/^(laptops?|notebooks?|computers?|gaming|electronics|products?|shop|all|sale|offers|brands?|[a-z]{2})(\.html?)?$/.test(seg)) return false;
  if (/(^|-)(guide|guides|best|top-\d+|vs|versus|review|reviews|comparison|tips|news|blog|deals)(-|$)/.test(seg)) return false; // articles
  return words.length >= 3 && seg.length >= 15 && (/\d/.test(seg) || /\.html?$/.test(seg) || /\/(product|products|p|item)\//.test(path));
}

/**
 * @param {string} url
 * @returns {{type: string, egypt: boolean, country: string|null, retailer: string|null, host: string|null}}
 */
export function classifyUrl(url) {
  let u;
  try { u = new URL(url); } catch { return { type: 'unknown', egypt: false, country: null, retailer: null, host: null }; }
  const h = u.hostname.replace(/^www\./, '').toLowerCase();
  const path = u.pathname;
  const lp = path.toLowerCase();
  const res = (type, egypt, country, retailer = null) => ({ type, egypt, country, retailer, host: h });

  if (/(^|\.)google\.[a-z.]+$/.test(h)) return res(/\/search|\/shopping|\/aclk|\/url/.test(lp) ? 'search_results' : 'comparison', false, null);
  if (onHost(h, CLASSIFIED_HOSTS)) return res('classified', /\.eg$|dubizzle\.com\.eg/.test(h), h.endsWith('.eg') ? 'EG' : null);
  if (onHost(h, COMPARISON_HOSTS)) return res('comparison', h.startsWith('eg.') || h.endsWith('.eg'), h.startsWith('eg.') ? 'EG' : null);
  if (onHost(h, ARTICLE_HOSTS) || /^blog\./.test(h)) return res('article', false, null);
  if (onHost(h, MANUFACTURERS)) return res('manufacturer_specs', /\/eg(-[a-z]{2})?\/|\/ae-ar\/eg/.test(lp), /\/eg(-[a-z]{2})?\//.test(lp) ? 'EG' : null);

  // Noon: one host, many countries; the first path segment says which.
  if (h === 'noon.com' || h.endsWith('.noon.com')) {
    const m = lp.match(/^\/(egypt|uae|saudi|kuwait|bahrain|oman|qatar)-(en|ar)\//);
    if (m && m[1] !== 'egypt') return res('foreign_store', false, NOON_COUNTRIES[m[1]]);
    if (!m) return res(lp === '/' ? 'homepage' : 'unknown', false, null);
  }
  const foreign = FOREIGN_STORES.find(([x]) => h === x || h.endsWith('.' + x));
  if (foreign && !(h === 'egypt.sharafdg.com')) return res('foreign_store', false, foreign[1]);

  const shop = EGYPT_RETAILERS.find((r) => h === r.host || h.endsWith('.' + r.host));
  const egypt = !!shop || h.endsWith('.eg') || /(^|[.-])egypt|masr/.test(h);
  const retailer = shop ? shop.name : null;
  const country = egypt ? 'EG' : null;

  // Page shapes that are never a single product, on any site.
  if (/^\/?((en|ar|egypt-en|egypt-ar)\/?)?$/.test(lp)) return res('homepage', egypt, country, retailer);
  const q = u.searchParams;
  if (/\/(search|catalogsearch|s)(\/|$)/.test(lp) || ['q', 'k', 'query', 'search', 'text', 'keyword'].some((k) => q.has(k))) return res('search_results', egypt, country, retailer);
  if (/\/(blog|blogs|news|reviews?|buying-guides?|guides?|article|articles|tag|compare)(\/|$)/.test(lp)) return res('article', egypt, country, retailer);
  if (/\/(c|b|category|categories|collections|brand|brands)(\/|$)/.test(lp) && !/\/products?\//.test(lp)) return res('category', egypt, country, retailer);
  if (/\/q-[^/]+\/?$/.test(lp)) return res('search_results', egypt, country, retailer);

  if (shop) {
    if (shop.path && !shop.path.test(lp)) return res('unknown', egypt, country, retailer);
    const ok = shop.product === 'slug' ? looksLikeProductSlug(lp) : shop.product.test(path);
    return res(ok ? 'direct_product' : 'category', true, 'EG', retailer);
  }
  return res(looksLikeProductSlug(lp) ? 'direct_product' : 'unknown', egypt, country, retailer);
}

/** A URL that can carry a verified Egyptian retail offer. */
export function isEgyptianProductPage(url) {
  const c = classifyUrl(url);
  return c.type === 'direct_product' && c.egypt;
}
