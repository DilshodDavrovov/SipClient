'use strict';

/* ------------------------------------------------------------------ */
/* Connection settings — shared with the operator app (index.html) so  */
/* a machine already configured there connects with no re-entry.       */
/* ------------------------------------------------------------------ */
const ADMIN_KEY = 'sipOperator.admin.v1';
const OPERATOR_KEY = 'sipOperator.config.v1';

function loadCfg() {
  let cfg = {};
  try { cfg = JSON.parse(localStorage.getItem(ADMIN_KEY)) || {}; } catch (e) {}
  if (!cfg.backendUrl || !cfg.apiKey) {
    try {
      const op = JSON.parse(localStorage.getItem(OPERATOR_KEY)) || {};
      if (!cfg.backendUrl && op.backendUrl) cfg.backendUrl = op.backendUrl;
      if (!cfg.apiKey && op.backendToken) cfg.apiKey = op.backendToken;
    } catch (e) {}
  }
  return cfg;
}
function saveCfg(cfg) { localStorage.setItem(ADMIN_KEY, JSON.stringify(cfg)); }

const $ = (id) => document.getElementById(id);
let cfg = loadCfg();
$('backendUrl').value = cfg.backendUrl || 'http://localhost:3001';
$('apiKey').value = cfg.apiKey || '';

function base() { return ($('backendUrl').value || '').replace(/\/+$/, ''); }
function headers() { return { 'Content-Type': 'application/json', 'X-Api-Key': $('apiKey').value }; }

async function api(path, opts = {}) {
  const res = await fetch(base() + path, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } });
  const txt = await res.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = { raw: txt }; }
  if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
  return data;
}

function setStatus(state) {
  const dot = $('statusDot');
  dot.className = 'dot' + (state === 'ok' ? ' ok' : state === 'err' ? ' err' : '');
}

async function connect() {
  saveCfg({ backendUrl: base(), apiKey: $('apiKey').value });
  try {
    await api('/api/status');
    setStatus('ok');
    await refreshRegions();
  } catch (e) {
    setStatus('err');
    alert('Не удалось подключиться: ' + e.message);
  }
}
$('connectBtn').onclick = connect;

/* ------------------------------------------------------------------ */
/* Tabs                                                                 */
/* ------------------------------------------------------------------ */
document.querySelectorAll('.tabs button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $('panel-' + b.dataset.tab).classList.add('active');
    if (b.dataset.tab === 'sync') refreshSyncStatus();
  };
});

/* ------------------------------------------------------------------ */
/* Regions                                                              */
/* ------------------------------------------------------------------ */
let regionsCache = [];

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

async function refreshRegions() {
  const { regions } = await api('/api/regions');
  regionsCache = regions;
  renderRegionsTable();
  fillRegionSelects();
}

function renderRegionsTable() {
  if (!regionsCache.length) {
    $('regionsTableWrap').innerHTML = '<p class="muted">Регионы ещё не заданы. Нажмите «+ Добавить регион».</p>';
    return;
  }
  const rows = regionsCache.map((r) => `
    <tr>
      <td><b>${esc(r.name)}</b></td>
      <td>${esc(r.trunkDid) || '<span class="muted">—</span>'}</td>
      <td>${r.outboundPrefix ? '<span class="pill">' + esc(r.outboundPrefix) + '</span>' : '<span class="muted">нет</span>'}</td>
      <td>${esc(r.queue) || '<span class="muted">—</span>'}</td>
      <td>${r.inboundDid ? esc(r.inboundDid) : '<span class="muted">—</span>'}${r.inboundTarget ? ' <span class="muted">→</span> <span class="pill">' + esc(r.inboundTarget) + '</span>' : ''}</td>
      <td>${r.oblast1c ? '<span class="pill">' + esc(r.oblast1c) + '</span>' : '<span class="muted">нет</span>'}</td>
      <td>${esc(r.agentExtensions) || '<span class="muted">—</span>'}<br><span class="muted">${r.agentCount} доб.</span></td>
      <td>${r.contactCount}</td>
      <td style="white-space:nowrap">
        <button class="btn small ghost" data-edit="${r.id}">Изм.</button>
        <button class="btn small danger" data-del="${r.id}">Удл.</button>
      </td>
    </tr>`).join('');
  $('regionsTableWrap').innerHTML = `
    <table>
      <thead><tr><th>Регион</th><th>Транк / DID</th><th>Префикс</th><th>Очередь</th><th>Входящий (DID → назн.)</th><th>Область (1C)</th><th>Агенты</th><th>Контактов</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  $('regionsTableWrap').querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => openRegionModal(b.dataset.edit));
  $('regionsTableWrap').querySelectorAll('[data-del]').forEach((b) => b.onclick = () => deleteRegion(b.dataset.del));
}

// 1C "Область" reference — the exact names the 1C service expects in the
// {"Region": "..."} request body. A region's oblast_1c must be one of these.
const OBLAST_LIST = [
  'АНДИЖАН', 'БУХАРА', 'ДЖИЗАК', 'КАРАКАЛПАКСТАН', 'КАШКАДАРЬЯ', 'НАВОИЙ',
  'НАМАНГАН', 'САМАРКАНД', 'СУРХАНДАРЬЯ', 'СЫРДАРЯ', 'ТАШКЕНТ',
  'ТОШКЕНТ ВИЛОЯТИ', 'ФЕРГАНА', 'ХОРЕЗМ',
];

function fillRegionSelects() {
  const opts = regionsCache.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  const ph = '<option value="">— выберите регион —</option>';
  $('contactsRegion').innerHTML = ph + opts;
}

function fillOblastSelect(selected) {
  const opts = OBLAST_LIST.map((o) => `<option value="${esc(o)}"${o === selected ? ' selected' : ''}>${esc(o)}</option>`).join('');
  $('rOblast1c').innerHTML = '<option value="">— не синхронизировать —</option>' + opts;
}

function openRegionModal(id) {
  const r = id ? regionsCache.find((x) => String(x.id) === String(id)) : null;
  $('regionModalTitle').textContent = r ? 'Регион: ' + r.name : 'Новый регион';
  $('regionId').value = r ? r.id : '';
  $('rName').value = r ? r.name : '';
  $('rTrunk').value = r ? r.trunkDid : '';
  $('rPrefix').value = r ? r.outboundPrefix : '';
  $('rQueue').value = r ? r.queue : '';
  $('rAgents').value = r ? r.agentExtensions : '';
  $('rInbound').value = r ? r.inboundDid : '';
  $('rInboundTarget').value = r ? r.inboundTarget : '';
  $('rInboundIvr').value = r ? r.inboundIvr : '';
  fillOblastSelect(r ? r.oblast1c : '');
  $('regionMsg').className = 'msg';
  $('regionModal').classList.add('show');
}
$('addRegionBtn').onclick = () => openRegionModal(null);
$('regionCancel').onclick = () => $('regionModal').classList.remove('show');

$('regionSave').onclick = async () => {
  const id = $('regionId').value;
  const body = {
    name: $('rName').value.trim(),
    trunkDid: $('rTrunk').value.trim(),
    outboundPrefix: $('rPrefix').value.trim(),
    queue: $('rQueue').value.trim(),
    agentExtensions: $('rAgents').value.trim(),
    inboundDid: $('rInbound').value.trim(),
    inboundTarget: $('rInboundTarget').value.trim(),
    inboundIvr: $('rInboundIvr').value.trim(),
    oblast1c: $('rOblast1c').value,
  };
  if (!body.name) { showMsg('regionMsg', 'err', 'Укажите название региона'); return; }
  try {
    await api(id ? '/api/regions/' + id : '/api/regions', {
      method: id ? 'PUT' : 'POST', body: JSON.stringify(body),
    });
    $('regionModal').classList.remove('show');
    await refreshRegions();
  } catch (e) { showMsg('regionMsg', 'err', e.message); }
};

async function deleteRegion(id) {
  const r = regionsCache.find((x) => String(x.id) === String(id));
  if (!confirm(`Удалить регион «${r ? r.name : id}»? Контакты останутся, но потеряют привязку к региону.`)) return;
  await api('/api/regions/' + id, { method: 'DELETE' });
  await refreshRegions();
}

function showMsg(el, kind, text) { const n = $(el); n.className = 'msg ' + kind; n.textContent = text; }

/* ------------------------------------------------------------------ */
/* 1C sync — status table + manual "sync now"                           */
/* ------------------------------------------------------------------ */
function fmtTime(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString('ru-RU'); } catch (e) { return String(ts); }
}

async function refreshSyncStatus() {
  let st;
  try { st = await api('/api/sync/status'); }
  catch (e) { showMsg('syncSummary', 'err', e.message); return; }
  const per = st.perRegion || {};
  const names = Object.keys(per);
  const summary = st.running
    ? 'Идёт синхронизация…'
    : `Последний запуск: ${fmtTime(st.lastRunAt)} · ` +
      (st.lastError ? ('ошибка: ' + esc(st.lastError)) : ('успешно ' + fmtTime(st.lastOkAt))) +
      ` · интервал ${Math.round((st.intervalMs || 60000) / 1000)} с`;
  const sm = $('syncSummary'); sm.className = 'msg ' + (st.lastError ? 'err' : 'ok'); sm.style.display = 'block'; sm.innerHTML = summary;

  if (!names.length) {
    $('syncTableWrap').innerHTML = '<p class="muted">Ещё не было ни одной синхронизации, либо ни у одного региона не задана «Область (1C)».</p>';
    return;
  }
  const rows = names.map((n) => {
    const r = per[n];
    return `<tr>
      <td><b>${esc(n)}</b></td>
      <td>${r.fetched}</td>
      <td>${r.upserted}</td>
      <td>${r.deleted ? '<span style="color:var(--danger)">' + r.deleted + '</span>' : 0}</td>
      <td>${r.error ? '<span style="color:var(--danger)">' + esc(r.error) + '</span>' : '<span class="muted">—</span>'}</td>
      <td class="muted">${fmtTime(r.at)}</td>
    </tr>`;
  }).join('');
  $('syncTableWrap').innerHTML = `
    <table>
      <thead><tr><th>Регион</th><th>Получено из 1C</th><th>Обновлено</th><th>Удалено</th><th>Ошибка</th><th>Время</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

$('refreshSyncBtn').onclick = refreshSyncStatus;
$('runSyncBtn').onclick = async () => {
  const btn = $('runSyncBtn'); btn.disabled = true; btn.textContent = 'Синхронизация…';
  try {
    await api('/api/sync/run', { method: 'POST' });
    await refreshSyncStatus();
  } catch (e) { showMsg('syncSummary', 'err', e.message); }
  finally { btn.disabled = false; btn.textContent = 'Синхронизировать сейчас'; }
};

/* ------------------------------------------------------------------ */
/* Region contacts                                                      */
/* ------------------------------------------------------------------ */
$('loadContactsBtn').onclick = async () => {
  const id = Number($('contactsRegion').value);
  if (!id) { $('contactsTableWrap').innerHTML = '<p class="muted">Выберите регион.</p>'; return; }
  const { total, rows } = await api(`/api/regions/${id}/contacts?limit=1000`);
  if (!rows.length) { $('contactsTableWrap').innerHTML = '<p class="muted">В этом регионе пока нет контактов.</p>'; return; }
  const body = rows.map((r) => `
    <tr>
      <td>${esc(r.companyName) || '<span class="muted">—</span>'}</td>
      <td>${r.phones.map((p) => '<span class="pill">' + esc(p) + '</span>').join(' ') || '<span class="muted">—</span>'}</td>
      <td>${esc(r.code) || '<span class="muted">—</span>'}</td>
      <td>${esc(r.operatorExtension) || '<span class="muted">—</span>'}</td>
    </tr>`).join('');
  $('contactsTableWrap').innerHTML = `
    <p class="note">Всего в регионе: <b>${total}</b>${total > 1000 ? ' (показаны первые 1000)' : ''}</p>
    <table>
      <thead><tr><th>Контрагент</th><th>Телефоны</th><th>Код</th><th>Оператор</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
};

/* ------------------------------------------------------------------ */
/* Inbound routing test                                                 */
/* ------------------------------------------------------------------ */
$('testRouteBtn').onclick = async () => {
  const number = $('testNumber').value.trim();
  const did = $('testDid').value.trim();
  if (!number) { showMsg('testMsg', 'err', 'Введите номер звонящего'); return; }
  try {
    const q = new URLSearchParams({ number, did }).toString();
    const r = await api('/api/route?' + q);
    if (r.found && r.target) {
      showMsg('testMsg', 'ok', `Регион «${r.region.name}» → назначение ${r.target}` +
        (r.region.agentExtensions ? ` (агенты ${r.region.agentExtensions})` : ''));
    } else if (r.found) {
      showMsg('testMsg', 'err', `Регион «${r.region.name}» найден, но «Вх. назначение» не задано — звонок уйдёт в fallback.`);
    } else {
      showMsg('testMsg', 'err', 'Номер не привязан ни к одному региону — звонок уйдёт в fallback дайлплана.');
    }
  } catch (e) { showMsg('testMsg', 'err', e.message); }
};

/* ------------------------------------------------------------------ */
/* Boot                                                                 */
/* ------------------------------------------------------------------ */
if (cfg.backendUrl && cfg.apiKey) connect();
