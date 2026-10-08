// Shared HTTP helper for discovery providers: JSON POST with a hard timeout. Error messages carry the provider's
// own error text (never request headers, so never a key).

export class ProviderError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export async function postJson(doFetch, url, headers, body, timeoutMs, label) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => { if (ctl) ctl.abort(); rej(new ProviderError(`${label}: timeout after ${timeoutMs} ms`, 0)); }, timeoutMs); });
  try {
    const res = await Promise.race([doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), ...(ctl ? { signal: ctl.signal } : {}) }), timeout]);
    let data = null;
    try { data = await Promise.race([res.json(), timeout]); } catch (e) { if (e instanceof ProviderError) throw e; data = null; }
    if (!res.ok) {
      const err = data && data.error;
      const msg = err ? (typeof err === 'string' ? err : [err.type || err.status || err.code, err.message].filter(Boolean).join(' ')) : '';
      throw new ProviderError(`${label}: HTTP ${res.status} ${String(msg).slice(0, 200)}`.trim(), res.status);
    }
    return data;
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(`${label}: ${e && e.name === 'AbortError' ? `timeout after ${timeoutMs} ms` : String((e && e.message) || e).slice(0, 160)}`, 0);
  } finally {
    clearTimeout(timer);
  }
}

