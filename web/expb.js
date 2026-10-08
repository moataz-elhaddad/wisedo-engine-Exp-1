// Experiment B page: the existing Layer 1 session through /api/session, then /api/expb/run with the final profile.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const en = (x) => (x && typeof x === 'object' ? x.en || x.ar || '' : x ?? '');
const egp = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') + ' EGP' : 'n/a');
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };

let state = null;
let profile = null;

$('token').value = store.get('expb-token') || '';
$('token').addEventListener('change', () => store.set('expb-token', $('token').value.trim()));

async function api(path, body, auth) {
  const headers = { 'content-type': 'application/json' };
  if (auth && $('token').value.trim()) headers.authorization = `Bearer ${$('token').value.trim()}`;
  const res = await fetch(path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  return { status: res.status, data };
}

async function loadStatus() {
  const { data } = await api('/api/expb/status');
  if (!data.ok) { $('status').textContent = 'Status unavailable'; return; }
  const on = data.providers.map((p) => `<span class="chip ok">${esc(p.name)} (${esc(p.role)}) · ${esc(p.model)}</span>`).join('');
  const off = data.missing.map((p) => `<span class="chip bad" title="missing secret ${esc(p.secret)}">${esc(p.name)}: needs ${esc(p.secret)}</span>`).join('');
  $('status').innerHTML = `Providers: ${on || '<span class="bad">none configured</span>'} ${off}<br>Web search: ${data.web_search ? 'on' : 'off'} · access: ${esc(data.access)}`;
}

async function step(event) {
  const { data } = await api('/api/session', { state, event });
  if (!data.state) { $('question').innerHTML = `<p class="bad">${esc(data.error || 'session error')}</p>`; return; }
  state = data.state;
  render(data.ui);
}

function render(ui) {
  $('s2').classList.remove('hidden');
  $('chips').innerHTML = (ui.chips || []).map((c) => `<span class="chip${c.assumed ? ' warn' : ''}">${esc(en(c.label))}: ${esc(en(c.valueLabel))}</span>`).join('');
  const q = $('question');
  if (ui.screen === 'question') {
    const qq = ui.question;
    const sel = new Set();
    q.innerHTML = `<p><b>${esc(en(qq.label))}</b> <span class="sub">(${qq.step.index}/${qq.step.of})</span></p>
      <div class="opts">${qq.options.map((o) => `<button data-id="${esc(o.id)}">${esc(en(o.label))}${o.matches != null ? ` <span class="sub">${o.matches}</span>` : ''}</button>`).join('')}</div>
      ${qq.numeric ? `<div class="row"><input id="num" type="number" placeholder="${esc(qq.numeric.unit)}" style="max-width:200px"><button id="numgo">OK</button></div>` : ''}
      <div class="row">${qq.multi ? '<button class="primary" id="multigo">Done</button>' : ''}<button id="skip">${esc(en(qq.skip.label))}</button><button id="now">Show results now</button></div>`;
    q.querySelectorAll('.opts button').forEach((b) => b.addEventListener('click', () => {
      if (!qq.multi) return step({ type: 'answer', value: b.dataset.id });
      b.classList.toggle('sel');
      if (sel.has(b.dataset.id)) sel.delete(b.dataset.id); else sel.add(b.dataset.id);
    }));
    if (qq.multi) $('multigo').addEventListener('click', () => sel.size && step({ type: 'answer', value: [...sel] }));
    if (qq.numeric) $('numgo').addEventListener('click', () => { const v = Number($('num').value); if (v) step({ type: 'answer', value: v }); });
    $('skip').addEventListener('click', () => step({ type: 'skip' }));
    $('now').addEventListener('click', () => step({ type: 'showNow' }));
  } else if (ui.screen === 'clarify') {
    q.innerHTML = `<p><b>${esc(en(ui.clarify.label))}</b></p>` + ui.clarify.options.map((o) => `<button data-id="${esc(o.id)}">${esc(en(o.label))}</button>`).join('');
    q.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => step({ type: 'answer', option: b.dataset.id })));
  } else if (ui.screen === 'result') {
    q.innerHTML = `<p class="ok">Need flow finished (${esc(ui.stopReason)}). The catalog recommendation from this step is NOT used as the Experiment B result.</p>`;
    showProfile(ui.profile);
  } else if (ui.screen === 'tiles' || ui.screen === 'unsupported' || ui.screen === 'not_configured') {
    q.innerHTML = `<p>${esc(en(ui.message))}</p>` + (ui.tiles || []).map((t) => `<button data-t="${esc(t.id || t)}">${esc(en(t.label) || t.id || t)}</button>`).join('');
    q.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { state = null; step({ type: 'start', tile: b.dataset.t }); }));
  } else {
    q.innerHTML = `<p class="bad">${esc(ui.error || ui.screen)}</p>`;
  }
}

function showProfile(p) {
  profile = p;
  $('s3').classList.remove('hidden');
  const money = p.money || {};
  $('profile').innerHTML = `<div class="sub">Category: ${esc(p.category)} · status: ${esc(p.status)} · budget: ${egp(money.budget)} · pay: ${esc(money.pay || 'not given (cash assumed)')} · city: ${esc((p.logistics || {}).city || 'nationwide')}</div>
    <div>${(p.needs || []).map((n) => `<span class="chip">${esc(n.slot)}: ${esc(JSON.stringify(n.value))}${n.source === 'default' ? ' (default)' : ''}</span>`).join('')}</div>
    <div class="sub">Must: ${esc((p.must || []).map((f) => en(f.why) || f.attr).join('; ') || 'none')} · Prefer: ${esc((p.prefer || []).map((f) => en(f.why) || f.attr).join('; ') || 'none')}</div>
    <details><summary>NeedProfile JSON</summary><pre>${esc(JSON.stringify(p, null, 2))}</pre></details>`;
  if (p.category !== 'laptop') $('runmsg').innerHTML = '<span class="bad">Experiment B supports laptops only.</span>';
}

const VSTYLE = { verified: 'ok', listed: 'ok', web_evidence: 'warn', partial: 'ok', unavailable: 'warn', mismatch: 'bad', blocked: 'warn', unreachable: 'warn', error: 'warn', no_url: 'warn', not_checked: 'warn' };
const vchip = (s) => `<span class="chip ${VSTYLE[s] || ''}">${esc(s || 'n/a')}</span>`;

function showRun(d) {
  $('s4').classList.remove('hidden');
  $('raw').textContent = JSON.stringify(d, null, 2);
  const m = d.metrics || {};
  $('runmsg').innerHTML = `${d.ok ? '<span class="ok">done</span>' : `<span class="bad">${esc(d.error || 'failed')}</span>`} · ${m.providers_ok ?? 0}/${m.providers_called ?? 0} providers · ${m.raw_candidates ?? 0} raw → ${m.consolidated ?? 0} consolidated (${m.rankable ?? 0} rankable) · ${((m.total_ms || 0) / 1000).toFixed(1)} s · est. $${m.estimated_cost_usd ?? 'n/a'}`;
  $('top3').innerHTML = (d.top3 || []).map((p) => {
    const ds = p.discovery || {};
    const reasons = (p.reasons || []).slice(0, 4).map((r) => `<li>${esc(en(r.text) || en(r) || r.code)}</li>`).join('');
    return `<div class="card"><div class="sub">#${p.rank} · ${esc(p.role)}</div><h3>${esc(p.product.brand)} ${esc(p.product.name)}</h3>
      <div>${egp(p.price)} at ${esc(p.retailer)} ${p.url ? `· <a href="${esc(p.url)}" target="_blank" rel="noopener">${/google\.com\/search/.test(p.url) ? 'search (no product URL)' : 'product page'}</a>` : ''}</div>
      <div class="sub">Engine score ${p.score} (fit ${p.fit}) · ${esc(p.affordability)}</div>
      <div>Providers: ${(ds.providers || []).map((x) => `<span class="chip">${esc(x)}</span>`).join('')} consensus ${ds.provider_consensus_score ?? 'n/a'}</div>
      <div>Verification: ${vchip(ds.verification_status)} evidence ${ds.evidence_confidence ?? 'n/a'}</div>
      <div class="sub">Evidence from: ${(ds.evidence_providers || []).map((x) => `<span class="chip">${esc(x)}</span>`).join('') || 'none'} ${(ds.evidence_urls || []).slice(0, 3).map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">src${i + 1}</a>`).join(' ')}</div>
      <div class="sub">${esc([ds.raw && ds.raw.cpu, ds.raw && ds.raw.ram_gb && ds.raw.ram_gb + 'GB', ds.raw && ds.raw.storage_gb && ds.raw.storage_gb + 'GB', ds.raw && ds.raw.gpu, ds.raw && ds.raw.display].filter(Boolean).join(' · '))}</div>
      <b>Why the engine ranked it here</b><ul>${reasons}</ul>
      ${(p.notListed || []).length ? `<div class="sub">Not listed (unknown, scored neutral): ${esc(p.notListed.map((x) => en(x.label) || x.id || x).join(', '))}</div>` : ''}</div>`;
  }).join('') || `<div class="card">No pick. ${esc(en(d.result && d.result.nothingFits && d.result.nothingFits.text))}</div>`;
  const rows = (d.consolidated || []).map((c) => `<tr><td>${esc(c.key)}</td><td><b>${esc(c.brand)} ${esc(c.model)}</b>${c.mpn ? `<br><span class="sub">${esc(c.mpn)}</span>` : ''}${c.possible_duplicates.length ? `<br><span class="sub warn">similar to ${esc(c.possible_duplicates.join(', '))} (kept separate)</span>` : ''}</td>
    <td>${esc(c.cpu)}<br>${esc(c.ram_gb)}GB / ${esc(c.storage_gb)}GB<br>${esc(c.gpu)}<br><span class="sub">${esc(c.display)}</span></td>
    <td>${egp(c.price_egp)}${c.price_range && c.price_range[0] !== c.price_range[1] ? `<br><span class="sub">${egp(c.price_range[0])}–${egp(c.price_range[1])}</span>` : ''}</td>
    <td>${c.providers.map((x) => `<span class="chip">${esc(x)}</span>`).join('')}<br>${c.provider_count} (${c.provider_consensus_score})</td>
    <td>${vchip(c.verification_status)}<br>evidence ${c.evidence_confidence}<br>${(c.evidence_providers || []).map((x) => `<span class="chip">${esc(x)}</span>`).join('')}${(c.evidence_urls || []).slice(0, 3).map((u, i) => ` <a href="${esc(u)}" target="_blank" rel="noopener">src${i + 1}</a>`).join('')}</td>
    <td>${c.offers.map((o) => `${esc(o.retailer || '?')}${o.url ? ` <a href="${esc(o.url)}" target="_blank" rel="noopener">↗</a>` : ''} ${o.price_egp ? egp(o.page_price_egp || o.price_egp) : ''} ${o.verification ? `<span class="sub">${esc(o.verification)}</span>` : ''}`).join('<br>')}</td>
    <td>${c.product_id ? 'yes' : '<span class="bad">no price</span>'}</td></tr>`).join('');
  $('cands').innerHTML = `<table><thead><tr><th></th><th>Product</th><th>Specs</th><th>Price</th><th>Found by</th><th>Verification / evidence</th><th>Offers</th><th>Ranked</th></tr></thead><tbody>${rows}</tbody></table>`;
  const prow = (d.providers || []).map((p) => `<tr><td>${esc(p.provider)}<br><span class="sub">${esc(p.role)}</span></td><td>${esc(p.model)}</td><td>${p.ok ? '<span class="ok">ok</span>' : `<span class="bad">${esc(p.error)}</span>`}</td><td>${(p.latency_ms / 1000).toFixed(1)} s</td><td>${p.candidate_count} cand.<br>${p.listing_count || 0} listings</td><td>${p.usage ? (p.role === 'llm' ? `${p.usage.input_tokens} in / ${p.usage.output_tokens} out / ${p.usage.web_searches} searches` : `${p.usage.search_calls} calls / ${p.usage.credits} credits`) : 'n/a'}</td><td>${p.cost_usd != null ? '$' + p.cost_usd : 'n/a'}<br><span class="sub">${esc(p.cost_basis)}</span></td><td class="sub">${esc(p.variant || '')}</td></tr>`).join('');
  const miss = (d.providers_missing || []).map((p) => `<tr><td>${esc(p.name)}</td><td colspan="7" class="bad">not configured: add secret ${esc(p.secret)}</td></tr>`).join('');
  const erow = (d.evidence_runs || []).map((e) => `<tr><td>${esc(e.provider)}<br><span class="sub">evidence</span></td><td></td><td>${e.ok ? '<span class="ok">ok</span>' : `<span class="bad">${esc(e.error)}</span>`}</td><td>${(e.latency_ms / 1000).toFixed(1)} s</td><td>${e.listing_count} listings</td><td>${e.usage ? `${e.usage.search_calls} calls` : ''}</td><td>${e.cost_usd != null ? '$' + e.cost_usd : ''}</td><td class="sub">${esc((e.candidates_searched || []).join(', '))}</td></tr>`).join('');
  $('rawprov').innerHTML = (d.raw || []).map((r) => `<details class="card"><summary>${esc(r.provider)} (${esc(r.role)}) · ${r.ok ? 'ok' : 'failed'} · ${r.candidates.length} candidates · ${r.listings.length} listings</summary>
    ${r.listings.length ? `<table><tbody>${r.listings.map((l) => `<tr><td>${esc(l.kind)}</td><td><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a><br><span class="sub">${esc((l.snippet || '').slice(0, 160))}</span></td><td>${esc(l.price_text || '')}</td><td>${esc(l.source || '')}</td></tr>`).join('')}</tbody></table>` : ''}
    <pre>${esc(JSON.stringify(r.raw_output ?? r.candidates, null, 1).slice(0, 20000))}</pre></details>`).join('');
  $('provs').innerHTML = `<table><thead><tr><th>Provider</th><th>Model</th><th>Result</th><th>Latency</th><th>Candidates</th><th>Usage</th><th>Est. cost</th><th>Variant</th></tr></thead><tbody>${prow}${erow}${miss}</tbody></table>`;
  const ct = (d.catalog && d.catalog.top3) || [];
  $('catalog').innerHTML = `<div class="sub">${esc(d.catalog && d.catalog.note)}</div>` + (ct.map((p) => `<div>#${p.rank} ${esc(p.product.name.startsWith(p.product.brand) ? p.product.name : p.product.brand + ' ' + p.product.name)} · ${egp(p.price)} · score ${p.score}</div>`).join('') || '<div>No catalog pick.</div>');
}

$('start').addEventListener('click', () => { state = null; const t = $('text').value.trim(); step(t ? { type: 'start', text: t } : { type: 'start', tile: 'laptop' }); });
$('tile').addEventListener('click', () => { state = null; step({ type: 'start', tile: 'laptop' }); });
$('run').addEventListener('click', async () => {
  if (!profile) return;
  $('run').disabled = true;
  $('runmsg').textContent = 'Asking LLM, web-search and shopping providers (can take up to ~90 s)...';
  try {
    const { status, data } = await api('/api/expb/run', { profile }, true);
    if (status === 401 || status === 429 || status === 400 || status === 422) $('runmsg').innerHTML = `<span class="bad">${esc(data.error)}</span>`;
    else showRun(data);
  } catch (e) {
    $('runmsg').innerHTML = `<span class="bad">${esc(e.message)}</span>`;
  } finally {
    $('run').disabled = false;
  }
});
loadStatus();
