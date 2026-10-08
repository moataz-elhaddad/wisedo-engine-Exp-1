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

const VSTYLE = { verified: 'ok', listed: 'ok', evidence_only: 'warn', unverified: 'bad', discovered_unverified: 'warn' };
const vchip = (s) => `<span class="chip ${VSTYLE[s] || ''}">${esc(s || 'n/a')}</span>`;
const link = (u, label) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(label || u)}</a>` : '');
const chips = (xs) => (xs || []).map((x) => `<span class="chip">${esc(x)}</span>`).join('');
const REASON = {
  variant_mismatch: 'listing is a different variant (GPU/RAM/storage/CPU/MPN)', out_of_stock: 'out of stock on the product page',
  unreachable: 'product page unreachable', no_egyptian_price: 'no EGP price on a listing or the page', implausible_price: 'price too low to be this laptop',
  weak_evidence: 'only the model family matched (variant not confirmed)', wrong_country: 'only found on non-Egyptian stores (UAE / Saudi / global)',
  classified_listing: 'only classifieds ads (Dubizzle/OLX)', comparison_site: 'only price-comparison pages', manufacturer_evidence_only: 'only the manufacturer spec page',
  article_evidence_only: 'only articles / reviews', category_or_search_page: 'only category or search pages', no_direct_url: 'no direct Egyptian product URL found',
};
const specLine = (c) => [c.cpu, c.ram_gb && c.ram_gb + 'GB RAM', c.storage_gb && c.storage_gb + 'GB', c.gpu, c.display].filter(Boolean).join(' · ');

function showRun(d) {
  $('s4').classList.remove('hidden');
  $('raw').textContent = JSON.stringify(d, null, 2);
  const m = d.metrics || {};
  const ex = Object.entries(m.excluded_by_reason || {}).map(([k, v]) => `${esc(k)} ${v}`).join(', ');
  $('runmsg').innerHTML = `${d.ok ? '<span class="ok">done</span>' : `<span class="bad">${esc(d.error || 'failed')}</span>`} · ${m.providers_ok ?? 0}/${m.providers_called ?? 0} providers · ${m.raw_candidates ?? 0} raw → ${m.consolidated ?? 0} candidates → <b>${m.verified_products ?? 0} verified</b> (${m.verified_offers ?? 0} offers) · excluded: ${ex || 'none'} · ${((m.total_ms || 0) / 1000).toFixed(1)} s · est. $${m.estimated_cost_usd ?? 'n/a'}`;
  $('top3').innerHTML = (d.top3 || []).map((p) => {
    const ds = p.discovery || {};
    const reasons = (p.reasons || []).slice(0, 4).map((r) => `<li>${esc(en(r.text) || en(r) || r.code)}</li>`).join('');
    return `<div class="card"><div class="sub">#${p.rank} · ${esc(p.role)}</div><h3>${esc(p.product.brand)} ${esc(p.product.name)}</h3>
      <div class="sub">Variant: ${esc(specLine(ds.raw || {}))}${p.mpn ? ` · MPN ${esc(p.mpn)}` : ''} · match: ${esc(p.variant_match_strength || 'n/a')}</div>
      <div><b>${egp(p.verified_price ?? p.price)}</b> at <b>${esc(p.verified_retailer || p.retailer)}</b></div>
      <div>${link(p.verified_product_url || p.url, 'Direct product page ↗')}</div>
      <div>Status: ${vchip(ds.verification_status)} ${p.verified ? '<span class="chip ok">verified Egyptian listing</span>' : ''}</div>
      <div>Discovered by: ${chips(ds.providers)} consensus ${ds.provider_consensus_score ?? 'n/a'} (signal only)</div>
      <div class="sub">Evidence: ${chips(ds.evidence_providers) || 'none'} ${(ds.evidence_urls || []).slice(0, 4).map((u, i) => link(u, `src${i + 1}`)).join(' ')}</div>
      ${ds.llm_claimed_price ? `<div class="sub">LLM claimed ${egp(ds.llm_claimed_price)}${ds.llm_claimed_retailer ? ' at ' + esc(ds.llm_claimed_retailer) : ''} (unverified, not used)</div>` : ''}
      <div class="sub">Engine score ${p.score} (fit ${p.fit}) · ${esc(p.affordability)}</div>
      <b>Why it matched</b><ul>${reasons}</ul>
      ${(p.notListed || []).length ? `<div class="sub">Not listed (unknown, scored neutral): ${esc(p.notListed.map((x) => en(x.label) || x.id || x).join(', '))}</div>` : ''}</div>`;
  }).join('') || `<div class="card"><b>${esc(d.no_verified_message || 'No pick.')}</b> ${esc(en(d.result && d.result.nothingFits && d.result.nothingFits.text))}</div>`;
  if ((d.top3 || []).length && d.top3.length < 3) $('top3').innerHTML += `<div class="card sub">Only ${d.top3.length} verified product(s) fit. Unverified candidates are never used to fill the list.</div>`;
  const row = (c) => `<tr><td><b>${esc(c.brand)} ${esc(c.model)}</b>${c.mpn ? `<br><span class="sub">${esc(c.mpn)}</span>` : ''}${(c.possible_duplicates || []).length ? `<br><span class="sub warn">similar to ${esc(c.possible_duplicates.join(', '))} (kept separate)</span>` : ''}</td>
    <td>${esc(specLine(c.specs || {}))}</td>
    <td>${chips(c.discovered_by)}<br>${c.provider_count} (${c.provider_consensus_score})</td>
    <td>${c.llm_claimed_price ? egp(c.llm_claimed_price) : 'n/a'}<br><span class="sub">${esc(c.llm_claimed_retailer || '')}</span></td>
    <td>${c.verified_price ? `<b>${egp(c.verified_price)}</b><br>${esc(c.verified_retailer)}<br>${link(c.verified_product_url, 'product page ↗')}` : '<span class="bad">none</span>'}</td>
    <td>${vchip(c.verification_status)}<br>${esc(c.variant_match_strength || '')} ${c.country ? `· ${esc(c.country)} ${esc(c.currency)}` : ''}</td>
    <td>${c.exclusion_reason ? `<span class="warn">${esc(c.exclusion_reason)}</span><br><span class="sub">${esc(REASON[c.exclusion_reason] || '')}</span>` : '<span class="ok">rankable</span>'}
      ${(c.rejections || []).length ? `<details><summary>${c.rejections.length} rejected URL(s)</summary>${c.rejections.map((r) => `<div class="sub">${esc(r.reason)} ${link(r.url, (r.url || '').slice(0, 60))} ${esc(r.detail || '')}</div>`).join('')}</details>` : ''}</td>
    <td>${(c.evidence_sources || []).slice(0, 5).map((e) => `<div class="sub">${esc(e.provider)} · ${esc(e.type)}${e.country ? ' ' + esc(e.country) : ''} ${link(e.url, (e.title || e.url || '').slice(0, 50))}</div>`).join('')}</td></tr>`;
  const head = '<thead><tr><th>Product</th><th>Specs</th><th>Discovered by</th><th>LLM claim (unverified)</th><th>Verified offer</th><th>Status</th><th>Exclusion</th><th>Evidence</th></tr></thead>';
  const ver = d.verified_candidates || [], unv = d.unverified_candidates || [];
  $('cands').innerHTML = `<h3>Verified candidates (${ver.length})</h3><table>${head}<tbody>${ver.map(row).join('')}</tbody></table>`;
  $('unverified').innerHTML = `<div class="sub">Found by discovery, but no verified Egyptian direct product listing: never ranked, never in the Top results.</div><table>${head}<tbody>${unv.map(row).join('')}</tbody></table>`;
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
  $('runmsg').textContent = 'Asking LLM, web-search and shopping providers, then verifying Egyptian product pages (can take up to ~90 s)...';
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
