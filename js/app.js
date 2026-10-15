'use strict';

/* ==========================================================================
   SIP Operator Console — app.js
   Vanilla JS + JsSIP (WebRTC). No build step required to run.
   ========================================================================== */

const CONFIG_KEY = 'sipOperator.config.v1';
const HISTORY_MAX = 200; // cap on the live in-memory amiHistory list, not persisted anywhere

/* -------------------------------------------------------------------- */
/* Compatibility with 1C's embedded WebKit (a Safari 10.0-class engine). */
/* Like fetch (see amiFetch below), URLSearchParams simply doesn't exist */
/* there — and it's load-bearing here: init()'s configFromUrlParams()    */
/* and every history/contacts query builder call it. Without this shim,  */
/* in that engine init() dies before ever connecting (so no live call    */
/* events — including incoming-call popups — ever arrive), and every     */
/* period-button click throws before reaching the server. Only the parts */
/* this app actually uses: string/object init, get/has/set/toString.     */
/* -------------------------------------------------------------------- */
if (!window.URLSearchParams) {
  window.URLSearchParams = function (init) {
    this._pairs = [];
    if (typeof init === 'string') {
      const query = init.charAt(0) === '?' ? init.slice(1) : init;
      const parts = query ? query.split('&') : [];
      for (let i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        const eq = parts[i].indexOf('=');
        const rawKey = eq === -1 ? parts[i] : parts[i].slice(0, eq);
        const rawVal = eq === -1 ? '' : parts[i].slice(eq + 1);
        try {
          this._pairs.push([
            decodeURIComponent(rawKey.replace(/\+/g, ' ')),
            decodeURIComponent(rawVal.replace(/\+/g, ' ')),
          ]);
        } catch (e) { /* skip a malformed percent-encoded pair */ }
      }
    } else if (init && typeof init === 'object') {
      for (const key in init) {
        if (Object.prototype.hasOwnProperty.call(init, key)) this._pairs.push([key, String(init[key])]);
      }
    }
  };
  window.URLSearchParams.prototype = {
    get: function (name) {
      for (let i = 0; i < this._pairs.length; i++) {
        if (this._pairs[i][0] === name) return this._pairs[i][1];
      }
      return null;
    },
    has: function (name) { return this.get(name) !== null; },
    set: function (name, value) {
      for (let i = this._pairs.length - 1; i >= 0; i--) {
        if (this._pairs[i][0] === name) this._pairs.splice(i, 1);
      }
      this._pairs.push([name, String(value)]);
    },
    append: function (name, value) { this._pairs.push([name, String(value)]); },
    toString: function () {
      return this._pairs
        .map((pair) => encodeURIComponent(pair[0]) + '=' + encodeURIComponent(pair[1]))
        .join('&');
    },
  };
}

// Present in Safari 10 (so current 1C builds have it), but the shim costs
// one line if an even older engine ever shows up.
if (window.NodeList && NodeList.prototype && !NodeList.prototype.forEach) {
  NodeList.prototype.forEach = Array.prototype.forEach;
}

/* -------------------------------------------------------------------- */
/* DOM references                                                        */
/* -------------------------------------------------------------------- */
const el = {
  regDot: document.getElementById('regDot'),
  regText: document.getElementById('regText'),
  settingsBtn: document.getElementById('settingsBtn'),

  incomingCall: document.getElementById('incomingCall'),
  incomingNumber: document.getElementById('incomingNumber'),
  incomingName: document.getElementById('incomingName'),
  incomingHint: document.getElementById('incomingHint'),
  acceptBtn: document.getElementById('acceptBtn'),
  declineBtn: document.getElementById('declineBtn'),

  activeCall: document.getElementById('activeCall'),
  activeNumber: document.getElementById('activeNumber'),
  activeState: document.getElementById('activeState'),
  activeTimer: document.getElementById('activeTimer'),
  muteBtn: document.getElementById('muteBtn'),
  holdBtn: document.getElementById('holdBtn'),
  keypadToggleBtn: document.getElementById('keypadToggleBtn'),
  hangupBtn: document.getElementById('hangupBtn'),

  dialForm: document.getElementById('dialForm'),
  dialInput: document.getElementById('dialInput'),
  keypad: document.getElementById('keypad'),
  dialActions: document.getElementById('dialActions'),
  clearInputBtn: document.getElementById('clearInputBtn'),
  callBtn: document.getElementById('callBtn'),
  audioHint: document.getElementById('audioHint'),

  historyBody: document.getElementById('historyBody'),
  recordingPlayer: document.getElementById('recordingPlayer'),
  recordingPlayerLabel: document.getElementById('recordingPlayerLabel'),
  recordingAudio: document.getElementById('recordingAudio'),
  recordingPlayerClose: document.getElementById('recordingPlayerClose'),

  tabHistoryBtn: document.getElementById('tabHistoryBtn'),
  tabCallbacksBtn: document.getElementById('tabCallbacksBtn'),
  callbackBadge: document.getElementById('callbackBadge'),
  tabNotesBtn: document.getElementById('tabNotesBtn'),
  noteBadge: document.getElementById('noteBadge'),
  tabContactsBtn: document.getElementById('tabContactsBtn'),
  addContactBtn: document.getElementById('addContactBtn'),
  historySearchRow: document.getElementById('historySearchRow'),
  historySearchInput: document.getElementById('historySearchInput'),
  historyPeriodRow: document.getElementById('historyPeriodRow'),
  historyDateFrom: document.getElementById('historyDateFrom'),
  historyDateTo: document.getElementById('historyDateTo'),
  historyLoadMoreRow: document.getElementById('historyLoadMoreRow'),
  historyResultsInfo: document.getElementById('historyResultsInfo'),
  historyLoadMoreBtn: document.getElementById('historyLoadMoreBtn'),
  historyView: document.getElementById('historyView'),
  callbacksView: document.getElementById('callbacksView'),
  callbacksBody: document.getElementById('callbacksBody'),
  notesView: document.getElementById('notesView'),
  notesBody: document.getElementById('notesBody'),
  contactsView: document.getElementById('contactsView'),
  contactsBody: document.getElementById('contactsBody'),
  contactsLoadMoreRow: document.getElementById('contactsLoadMoreRow'),
  contactsResultsInfo: document.getElementById('contactsResultsInfo'),
  contactsLoadMoreBtn: document.getElementById('contactsLoadMoreBtn'),

  statHandled: document.getElementById('statHandled'),
  statMissed: document.getElementById('statMissed'),
  statSalesTile: document.getElementById('statSalesTile'),
  statSalesDay: document.getElementById('statSalesDay'),
  statSalesDayCount: document.getElementById('statSalesDayCount'),
  statSalesMonth: document.getElementById('statSalesMonth'),
  statSalesMonthCount: document.getElementById('statSalesMonthCount'),
  statDuration: document.getElementById('statDuration'),

  outcomeModal: document.getElementById('outcomeModal'),
  outcomeSubtitle: document.getElementById('outcomeSubtitle'),
  outcomeContext: document.getElementById('outcomeContext'),
  outcomeContextName: document.getElementById('outcomeContextName'),
  outcomeContextLast: document.getElementById('outcomeContextLast'),
  outcomeCreateContactBtn: document.getElementById('outcomeCreateContactBtn'),
  outcomeBookingCallId: document.getElementById('outcomeBookingCallId'),
  outcomeBookingClientCode: document.getElementById('outcomeBookingClientCode'),

  callbackTimeModal: document.getElementById('callbackTimeModal'),
  callbackTimeSubtitle: document.getElementById('callbackTimeSubtitle'),
  callbackCustomTime: document.getElementById('callbackCustomTime'),
  callbackCustomTimeBtn: document.getElementById('callbackCustomTimeBtn'),
  callbackTimeCancelBtn: document.getElementById('callbackTimeCancelBtn'),

  noteTextModal: document.getElementById('noteTextModal'),
  noteTextTitle: document.getElementById('noteTextTitle'),
  noteTextSubtitle: document.getElementById('noteTextSubtitle'),
  noteTextInput: document.getElementById('noteTextInput'),
  noteTextSaveBtn: document.getElementById('noteTextSaveBtn'),
  noteTextCancelBtn: document.getElementById('noteTextCancelBtn'),

  contactModal: document.getElementById('contactModal'),
  contactModalTitle: document.getElementById('contactModalTitle'),
  contactCode: document.getElementById('contactCode'),
  // Up to 4 interchangeable numbers per contact — index 0 is "Телефон 1".
  contactPhoneInputs: [1, 2, 3, 4].map((i) => document.getElementById('contactPhone' + i)),
  contactCallRow: document.getElementById('contactCallRow'),
  contactCompanyName: document.getElementById('contactCompanyName'),
  contactManagerName: document.getElementById('contactManagerName'),
  contactOperatorExt: document.getElementById('contactOperatorExt'),
  contactComment: document.getElementById('contactComment'),
  contactHistorySection: document.getElementById('contactHistorySection'),
  contactLastCall: document.getElementById('contactLastCall'),
  contactHistoryBody: document.getElementById('contactHistoryBody'),
  contactDeleteBtn: document.getElementById('contactDeleteBtn'),
  contactCancelBtn: document.getElementById('contactCancelBtn'),
  contactSaveBtn: document.getElementById('contactSaveBtn'),

  transferBtn: document.getElementById('transferBtn'),
  transferRow: document.getElementById('transferRow'),
  transferNumberInput: document.getElementById('transferNumberInput'),
  transferConfirmBtn: document.getElementById('transferConfirmBtn'),
  transferCancelBtn: document.getElementById('transferCancelBtn'),

  conferenceBtn: document.getElementById('conferenceBtn'),
  conferenceRow: document.getElementById('conferenceRow'),
  conferenceNumberInput: document.getElementById('conferenceNumberInput'),
  conferenceConfirmBtn: document.getElementById('conferenceConfirmBtn'),
  conferenceCancelBtn: document.getElementById('conferenceCancelBtn'),

  oneCEventBridge: document.getElementById('oneCEventBridge'),

  toast: document.getElementById('toast'),
  toastMessage: document.getElementById('toastMessage'),
  toastClose: document.getElementById('toastClose'),

  debugBtn: document.getElementById('debugBtn'),
  debugPanel: document.getElementById('debugPanel'),
  debugLog: document.getElementById('debugLog'),
  debugClearBtn: document.getElementById('debugClearBtn'),
  debugCloseBtn: document.getElementById('debugCloseBtn'),

  settingsModal: document.getElementById('settingsModal'),
  cfgMode: document.getElementById('cfgMode'),
  modeHint: document.getElementById('modeHint'),
  amiFields: document.getElementById('amiFields'),
  webrtcFields: document.getElementById('webrtcFields'),
  cfgBackendUrl: document.getElementById('cfgBackendUrl'),
  cfgBackendToken: document.getElementById('cfgBackendToken'),
  cfgOperatorExt: document.getElementById('cfgOperatorExt'),
  cfgWsServer: document.getElementById('cfgWsServer'),
  cfgSipUri: document.getElementById('cfgSipUri'),
  cfgPassword: document.getElementById('cfgPassword'),
  cfgDisplayName: document.getElementById('cfgDisplayName'),
  cfgIceServers: document.getElementById('cfgIceServers'),
  cfgTurnUser: document.getElementById('cfgTurnUser'),
  cfgTurnPass: document.getElementById('cfgTurnPass'),
  cfgAutoRegister: document.getElementById('cfgAutoRegister'),
  cfgSaveBtn: document.getElementById('cfgSaveBtn'),
  cfgCancelBtn: document.getElementById('cfgCancelBtn'),
  cfgDisconnectBtn: document.getElementById('cfgDisconnectBtn'),

  remoteAudio: document.getElementById('remoteAudio'),
};

/* -------------------------------------------------------------------- */
/* Notifications — deliberately not alert()/confirm(): those are native  */
/* blocking dialogs, and some embedded browser shells (e.g. 1C's HTML    */
/* field on Windows) have no dialog host wired up for them at all — the  */
/* call never returns, freezing the whole page's JS thread forever.      */
/* -------------------------------------------------------------------- */
let toastTimer = null;

function showToast(message, opts = {}) {
  const { error = false, duration = 6000 } = opts;
  el.toastMessage.textContent = message;
  el.toast.classList.toggle('toast-error', !!error);
  el.toast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, duration);
}

function hideToast() {
  el.toast.classList.add('hidden');
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
}

el.toastClose.addEventListener('click', hideToast);

/* -------------------------------------------------------------------- */
/* Debug panel — a stand-in for browser devtools, which the embedded     */
/* WebKit host (1C's HTML field) doesn't expose. Every entry is plain    */
/* selectable text so it can be copied out and pasted back for support.  */
/* -------------------------------------------------------------------- */
const DEBUG_LOG_MAX = 300;
let debugLines = [];

function logDebug(message) {
  const time = new Date().toLocaleTimeString('ru-RU', { hour12: false });
  debugLines.push(`[${time}] ${message}`);
  if (debugLines.length > DEBUG_LOG_MAX) debugLines.shift();
  if (!el.debugPanel.classList.contains('hidden')) renderDebugPanel();
}

function renderDebugPanel() {
  el.debugLog.value = debugLines.join('\n');
  el.debugLog.scrollTop = el.debugLog.scrollHeight;
}

function openDebugPanel() {
  el.debugPanel.classList.remove('hidden');
  renderDebugPanel();
}

el.debugBtn.addEventListener('click', () => {
  el.debugPanel.classList.contains('hidden') ? openDebugPanel() : el.debugPanel.classList.add('hidden');
});
el.debugCloseBtn.addEventListener('click', () => el.debugPanel.classList.add('hidden'));
el.debugClearBtn.addEventListener('click', () => { debugLines = []; renderDebugPanel(); });

window.addEventListener('error', (e) => {
  logDebug(`JS ERROR: ${e.message} (${e.filename ? e.filename.split('/').pop() : '?'}:${e.lineno}:${e.colno})`);
});
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  logDebug('UNHANDLED REJECTION: ' + (reason && reason.message ? reason.message : String(reason)));
});
logDebug('Страница загружена. User-Agent: ' + navigator.userAgent);
logDebug(`Размер окна: innerWidth=${window.innerWidth} innerHeight=${window.innerHeight} `
  + `documentElement=${document.documentElement.clientWidth}x${document.documentElement.clientHeight}`);

/* -------------------------------------------------------------------- */
/* Persistence helpers                                                   */
/* -------------------------------------------------------------------- */
function loadConfig() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY)) || null;
  } catch (e) {
    return null;
  }
}

function saveConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

// Auto-configure from URL query params — e.g. for embedding this page inside
// 1C's HTML field with a per-operator URL that already carries everything
// needed (same field names as the settings modal saves), so it connects
// immediately with no settings window. Example:
//   index.html?mode=ami&backendUrl=http://localhost:3001&backendToken=XXXX&operatorExt=301
const URL_CONFIG_FIELDS = [
  'mode', 'backendUrl', 'backendToken', 'operatorExt',
  'wsServer', 'sipUri', 'password', 'displayName',
  'iceServers', 'turnUser', 'turnPass',
];
const URL_CONFIG_SECRET_FIELDS = ['backendToken', 'password', 'turnPass'];

function configFromUrlParams() {
  const params = new URLSearchParams(location.search);
  const found = {};
  let hasAny = false;
  for (const key of URL_CONFIG_FIELDS) {
    if (params.has(key)) {
      found[key] = params.get(key);
      hasAny = true;
    }
  }
  if (!hasAny) return null;
  const ar = params.get('autoRegister');
  found.autoRegister = ar !== '0' && ar !== 'false';
  return found;
}

// Call history, outcomes, notes and callbacks all live server-side in
// SQLite now (see server/src/db.js) — nothing here is duplicated into
// localStorage anymore. This app requires the AMI backend to be connected
// for any of that; only connection *settings* (loadConfig/saveConfig above)
// still live in the browser, since that's how it knows how to reach the
// backend in the first place.
let amiHistory = []; // calls list as reported by the AMI backend (live, in-memory only)

/* -------------------------------------------------------------------- */
/* Formatting helpers                                                    */
/* -------------------------------------------------------------------- */
function formatDuration(seconds) {
  seconds = Math.max(0, Math.floor(seconds));
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  return d.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function shortUri(uri) {
  if (!uri) return '—';
  const str = uri.toString ? uri.toString() : String(uri);
  return str.replace(/^sips?:/, '').split(';')[0];
}

/* -------------------------------------------------------------------- */
/* Phone formatting — strictly "90 601 03 31" (2-3-2-2 grouping of the    */
/* 9-digit Uzbek local number) everywhere a plain phone number is shown   */
/* or typed: contact fields and the dialer. Duplicated in                */
/* server/src/db.js's formatPhoneStrict (kept in sync deliberately, see   */
/* that file's comment) since contacts are also formatted server-side —  */
/* this copy only needs to handle live-as-you-type display here.         */
/* -------------------------------------------------------------------- */
function formatPhoneDisplay(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  const norm = digits.length > 9 ? digits.slice(-9) : digits;
  if (!norm) return '';
  return [norm.slice(0, 2), norm.slice(2, 5), norm.slice(5, 7), norm.slice(7, 9)]
    .filter(Boolean)
    .join(' ');
}

// True for input that's plausibly still a plain phone number being typed —
// digits/spaces/plus only. Anything else (a SIP URI's "@"/letters, or a "*"/
// "#" feature code) is left completely alone: reformatting would mangle
// those, and this dial input doubles as both.
function looksLikePlainNumber(value) {
  return /^[0-9+\s]*$/.test(value);
}

// Reformats an <input> element's current value in place if (and only if)
// it still looks like a plain number, keeping the cursor at the end —
// simplest correct behavior for a field that's overwhelmingly typed
// left-to-right via keypad clicks or a numeric keyboard, not edited
// mid-string.
function reformatPhoneInput(inputEl) {
  const value = inputEl.value;
  if (!looksLikePlainNumber(value)) return;
  const formatted = formatPhoneDisplay(value);
  if (formatted !== value) {
    inputEl.value = formatted;
    inputEl.setSelectionRange(formatted.length, formatted.length);
  }
}

/* -------------------------------------------------------------------- */
/* Call history rendering                                                */
/* -------------------------------------------------------------------- */
// Inline SVG, not emoji: the WebKit build inside 1C's HTML field has no
// color-emoji rendering at all (confirmed — plain squares/tofu), while
// simple stroke/fill SVG built from basic primitives (circle/line/rect)
// renders identically everywhere.
const ICONS = {
  booking: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/></svg>',
  note: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="1"/><line x1="7" y1="8" x2="17" y2="8"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="7" y1="16" x2="13" y2="16"/></svg>',
  declined: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>',
  callback: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 3 21 9 15 9"/></svg>',
  dirIn: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="17" y1="7" x2="7" y2="17"/><polyline points="7 9 7 17 15 17"/></svg>',
  dirOut: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="9 7 17 7 17 15"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>',
  addContact: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="4"/><path d="M2 21c0-4.5 3-7 7-7"/><line x1="17" y1="9" x2="17" y2="15"/><line x1="14" y1="12" x2="20" y2="12"/></svg>',
  call: '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M6.6 10.8c1.4 2.8 3.8 5.2 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.4c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.4 0 .8-.2 1L6.6 10.8z"/></svg>',
};

const OUTCOME_META = {
  booking: { icon: ICONS.booking, label: 'Бронирование' },
  note: { icon: ICONS.note, label: 'Заметка' },
  contact: { icon: ICONS.addContact, label: 'Новый контакт' },
  declined: { icon: ICONS.declined, label: 'Отказ' },
  callback: { icon: ICONS.callback, label: 'Перезвонить' },
};

function renderStats(list) {
  let handled = 0, missed = 0, totalDuration = 0;
  for (const entry of list) {
    if (entry.status === 'completed') {
      handled++;
      totalDuration += entry.duration || 0;
    } else if (entry.status !== 'active' && entry.status !== 'ringing' && entry.status !== 'elsewhere') {
      // 'elsewhere' = a colleague took that ring-group call; not a miss.
      missed++;
    }
  }
  el.statHandled.textContent = handled;
  el.statMissed.textContent = missed;
  el.statDuration.textContent = formatDuration(totalDuration);
  // Sales are NOT derived from this list's outcome tags — an operator
  // clicking "Открыть бронирование" is only local intent. The sales tile
  // comes straight from 1C, see refreshSalesStats().
}

function formatMoney(amount) {
  return Math.round(amount).toLocaleString('ru-RU');
}

// "За день" / "За месяц" sales tile. The numbers come from 1C itself: the
// backend reads the rows of РеализацияТоваров.Товары where this operator is
// set in the "Оператор" column (one booking can be split between several
// operators) — see server/src/operator-sales-1c.js. The backend re-reads
// 1C every minute and shortly after each finished call, and pushes a WS
// "sales" message when the numbers change; this function only reads the
// backend's cached result, so calling it often is cheap.
function salesCountLabel(n) {
  const mod10 = n % 10, mod100 = n % 100;
  const word = mod10 === 1 && mod100 !== 11 ? 'бронь'
    : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'брони' : 'броней';
  return `· ${n} ${word}`;
}

function renderSalesStats(data) {
  const day = (data && data.day) || { amount: 0, count: 0 };
  const month = (data && data.month) || { amount: 0, count: 0 };
  el.statSalesDay.textContent = formatMoney(day.amount || 0);
  el.statSalesDayCount.textContent = salesCountLabel(day.count || 0);
  el.statSalesMonth.textContent = formatMoney(month.amount || 0);
  el.statSalesMonthCount.textContent = salesCountLabel(month.count || 0);
  // Dim the numbers when 1C could not be reached on the last attempt (they
  // are then the last known values, not current ones).
  const stale = !!(data && data.error);
  el.statSalesTile.classList.toggle('stat-stale', stale);
  el.statSalesTile.title = stale
    ? 'Нет связи с 1С, показаны последние полученные данные: ' + data.error
    : 'Продажи по строкам документов «Реализация товаров», где вы указаны оператором'
      + (data && data.updatedAt ? '. Обновлено ' + new Date(data.updatedAt).toLocaleTimeString('ru-RU') : '');
}

function refreshSalesStats() {
  if (!historyBackendReady()) {
    renderSalesStats(null);
    return;
  }
  const cfg = loadConfig();
  amiFetch(cfg, '/api/sales/stats?extension=' + encodeURIComponent(cfg.operatorExt))
    .then(renderSalesStats)
    .catch((err) => logDebug('refreshSalesStats failed: ' + err.message));
}

setInterval(() => { if (historyBackendReady()) refreshSalesStats(); }, 60000);

let historySearchQuery = '';
let currentHistoryTab = 'history';

// Small debounce so a search-as-you-type box doesn't fire an /api/history
// request (or a contacts search) on every keystroke.
function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function buildHistoryRowsHtml(list) {
  return list.map(entry => {
    let dirIcon, dirClass;
    if (entry.direction === 'incoming') {
      dirIcon = ICONS.dirIn;
      dirClass = entry.status === 'missed' ? 'dir-missed' : 'dir-in';
    } else {
      dirIcon = ICONS.dirOut;
      dirClass = 'dir-out';
    }

    let badgeClass = '';
    if (entry.status === 'completed') badgeClass = 'ok';
    else if (entry.status === 'missed' || entry.status === 'failed') badgeClass = 'missed';
    else if (entry.status === 'elsewhere') badgeClass = 'neutral';
    else badgeClass = 'warn';

    const playCell = entry.id
      ? `<button class="play-recording-btn" data-recording-id="${escapeHtml(entry.id)}" data-recording-label="${escapeHtml(entry.number)}" title="Прослушать запись">${ICONS.play}</button>`
      : '';
    // No contact matched this number — offer to add one right from the row,
    // instead of only ever being able to do that from the post-call picker.
    const addContactCell = !entry.contactId
      ? `<button class="add-contact-from-history-btn" data-number="${escapeHtml(entry.number)}" title="Добавить в контакты">${ICONS.addContact}</button>`
      : '';
    const callCell = `<button class="call-from-history-btn" data-number="${escapeHtml(entry.number)}" title="Позвонить">${ICONS.call}</button>`;
    // Retroactive note on an already-ended call — separate from the
    // mandatory post-call picker's own note option: doesn't touch the
    // call's outcome (see openNoteTextModal's `linkOnly` mode), just
    // attaches free text to it.
    const noteCell = entry.id
      ? `<button class="note-from-history-btn" data-call-id="${escapeHtml(entry.id)}" data-number="${escapeHtml(entry.number)}" data-name="${escapeHtml(entry.name || '')}" title="Добавить заметку">${ICONS.note}</button>`
      : '';

    // The "booking" outcome is set the moment an operator clicks "Открыть
    // бронирование" — before anything is actually booked anywhere. Only
    // show the tag once it's backed by a real confirmed booking (POST
    // /api/call/:id/booking, bookingCount > 0) — otherwise it's just local
    // intent, indistinguishable from a booking that never actually
    // happened. Other outcomes (note/declined/callback/contact) have no
    // such external confirmation step, so they still show right away.
    const outcomeKey = entry.outcome;
    const outcomeConfirmed = outcomeKey !== 'booking' || entry.bookingCount > 0;
    const outcomeMeta = outcomeKey && outcomeConfirmed && OUTCOME_META[outcomeKey];
    const outcomeLabel = outcomeMeta && outcomeKey === 'booking' && entry.bookingAmount
      ? `${outcomeMeta.label} · ${formatMoney(entry.bookingAmount)}`
      : outcomeMeta && outcomeMeta.label;
    const outcomeTag = outcomeMeta
      ? `<div class="outcome-tag outcome-${outcomeKey}">${outcomeMeta.icon} ${escapeHtml(outcomeLabel)}</div>`
      : '';
    // A note can exist on a call whose registered outcome is something else
    // entirely (or none at all) — the history row's note button attaches it
    // without touching `outcome` (see the note-from-history-btn handler
    // below), so it needs its own always-shown tag instead of piggybacking
    // on outcomeTag. Skipped only when outcome IS 'note' (outcomeTag above
    // already covers that case) to avoid showing the same label twice.
    const noteTag = entry.noteCount > 0 && outcomeKey !== 'note'
      ? `<div class="outcome-tag outcome-note" title="${entry.noteCount > 1 ? entry.noteCount + ' заметки' : 'Есть заметка'}">${ICONS.note} Заметка</div>`
      : '';
    // The free-text "info" an external system attached to the confirmed
    // booking (e.g. what was actually booked) — same confirmed-only gating
    // as the tag above, so it can't show for an unconfirmed "booking" click.
    const bookingInfoLine = outcomeConfirmed && outcomeKey === 'booking' && entry.bookingInfo
      ? `<div class="booking-info-line" title="${escapeHtml(entry.bookingInfo)}">${escapeHtml(entry.bookingInfo)}</div>`
      : '';

    return `<tr>
      <td class="col-dir"><span class="dir-icon ${dirClass}">${dirIcon}</span></td>
      <td>${escapeHtml(entry.name && entry.name !== entry.number ? `${entry.name} · ${entry.number}` : entry.number)}${outcomeTag}${noteTag}${bookingInfoLine}</td>
      <td>${formatTimestamp(entry.startedAt)}</td>
      <td>${entry.duration != null ? formatDuration(entry.duration) : '—'}</td>
      <td><span class="status-badge ${badgeClass}">${escapeHtml(entry.statusLabel)}</span></td>
      <td class="col-play">${callCell}${noteCell}${playCell}${addContactCell}</td>
    </tr>`;
  }).join('');
}

/* -------------------------------------------------------------------- */
/* History — "Мои звонки": always backed by SQLite via /api/history —    */
/* unlimited, paginated (HISTORY_PAGE_SIZE per page, "Показать ещё" for  */
/* more), indexed on started_at so "Всё время" is just as cheap as any   */
/* other period — it's the same query, just without a date filter.       */
/* Requires the AMI backend to be connected, like Контакты/Заметки.      */
/* Stats above it are fed separately, from the live WS amiHistory list.  */
/* -------------------------------------------------------------------- */
let historyRows = [];
let historyPeriod = 'all';
let historyOffset = 0;
let historyTotal = 0;
const HISTORY_PAGE_SIZE = 50;

function historyBackendReady() {
  const cfg = loadConfig();
  return !!(amiRt.backendUp && cfg && cfg.backendUrl && cfg.backendToken && cfg.operatorExt);
}

// Tolerant of both the native date input's "2026-08-25" and hand-typed
// "25.08.2026" / "25/08/2026" — in 1C's WebKit <input type="date"> silently
// degrades to a plain text box (see the placeholder fallback below), so
// whatever the operator types has to be parseable too. Builds the Date from
// numeric parts instead of Date-string parsing, which old engines handle
// inconsistently. Returns epoch ms, or undefined for anything unparseable.
function parseDateInputValue(value, endOfDay) {
  const parts = String(value || '').trim().split(/[.\-\/]/);
  if (parts.length !== 3) return undefined;
  let year, month, day;
  if (parts[0].length === 4) { // "2026-08-25"
    year = Number(parts[0]); month = Number(parts[1]); day = Number(parts[2]);
  } else {                     // "25.08.2026"
    day = Number(parts[0]); month = Number(parts[1]); year = Number(parts[2]);
  }
  if (year >= 0 && year < 100) year += 2000;
  if (!year || !month || !day || month > 12 || day > 31) return undefined;
  const d = endOfDay ? new Date(year, month - 1, day, 23, 59, 59) : new Date(year, month - 1, day);
  const ts = d.getTime();
  return isNaN(ts) ? undefined : ts;
}

function periodToRange(period) {
  const now = Date.now();
  if (period === 'today') {
    const d = new Date();
    return { from: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), to: now };
  }
  if (period === 'week') return { from: now - 7 * 86400000, to: now };
  if (period === 'month') return { from: now - 30 * 86400000, to: now };
  if (period === 'custom') {
    return {
      from: parseDateInputValue(el.historyDateFrom.value, false),
      to: parseDateInputValue(el.historyDateTo.value, true),
    };
  }
  return {}; // 'all' — no date bound at all, just the plain indexed query
}

function updateHistoryLoadMoreUi() {
  el.historyLoadMoreRow.classList.toggle('hidden', !historyRows.length && !historyTotal);
  el.historyResultsInfo.textContent = historyTotal
    ? `Показано ${historyRows.length} из ${historyTotal}`
    : 'Ничего не найдено';
  el.historyLoadMoreBtn.classList.toggle('hidden', historyRows.length >= historyTotal);
}

function loadHistoryPage(loadMore) {
  if (!historyBackendReady()) {
    el.historyBody.innerHTML = '<tr class="empty-row"><td colspan="6">История доступна только при подключении к серверу (режим AMI)</td></tr>';
    el.historyLoadMoreRow.classList.add('hidden');
    return;
  }

  const cfg = loadConfig();
  if (!loadMore) { historyOffset = 0; historyRows = []; }

  const range = periodToRange(historyPeriod);
  const params = new URLSearchParams();
  const q = historySearchQuery.trim();
  if (q) params.set('q', q);
  if (range.from) params.set('from', String(range.from));
  if (range.to) params.set('to', String(range.to));
  params.set('extension', cfg.operatorExt);
  params.set('limit', String(HISTORY_PAGE_SIZE));
  params.set('offset', String(historyOffset));

  amiFetch(cfg, '/api/history?' + params.toString())
    .then((data) => {
      historyTotal = data.total || 0;
      const entries = (data.records || []).map(amiRecordToEntry);
      historyRows = loadMore ? historyRows.concat(entries) : entries;
      historyOffset += (data.records || []).length;
      el.historyBody.innerHTML = historyRows.length
        ? buildHistoryRowsHtml(historyRows)
        : '<tr class="empty-row"><td colspan="6">Ничего не найдено</td></tr>';
      updateHistoryLoadMoreUi();
    })
    .catch((err) => showToast('Ошибка загрузки истории: ' + err.message, { error: true }));
}

const debouncedHistorySearch = debounce(() => loadHistoryPage(false), 300);
const debouncedContactsSearch = debounce(() => loadContacts(false), 300);
// Coalesces bursts of live call-state updates (a single call can emit
// several in quick succession — ringing, answered, ended) into one request
// instead of one per event.
const debouncedHistoryRefresh = debounce(() => { if (currentHistoryTab === 'history') loadHistoryPage(false); }, 400);

el.historyLoadMoreBtn.addEventListener('click', () => loadHistoryPage(true));

// The period picker must keep working even in the most bare-bones embedded
// engine (1C's WebKit), so this path is deliberately lowest-common-
// denominator: one delegated click listener instead of per-button ones
// (nothing iterates a NodeList at load time), and a plain for-loop with
// single-argument classList calls for the active highlight (no two-argument
// classList.toggle). Every click also lands in the debug panel, so "ничего
// не произошло" in 1C is diagnosable from the page itself.
function updatePeriodButtonsUi() {
  const buttons = document.querySelectorAll('.period-btn');
  for (let i = 0; i < buttons.length; i++) {
    if (buttons[i].getAttribute('data-period') === historyPeriod) buttons[i].classList.add('active');
    else buttons[i].classList.remove('active');
  }
}

el.historyPeriodRow.addEventListener('click', (e) => {
  const btn = e.target.closest('.period-btn');
  if (!btn) return;
  historyPeriod = btn.getAttribute('data-period');
  logDebug('history period -> ' + historyPeriod);
  updatePeriodButtonsUi();
  el.historyDateFrom.value = '';
  el.historyDateTo.value = '';
  loadHistoryPage(false);
});

function handleCustomHistoryDate() {
  if (!el.historyDateFrom.value && !el.historyDateTo.value) return;
  historyPeriod = 'custom';
  logDebug(`history period -> custom: "${el.historyDateFrom.value}" — "${el.historyDateTo.value}"`);
  updatePeriodButtonsUi();
  loadHistoryPage(false);
}
el.historyDateFrom.addEventListener('change', handleCustomHistoryDate);
el.historyDateTo.addEventListener('change', handleCustomHistoryDate);

// In an engine without <input type="date"> (1C's WebKit) the fields degrade
// to plain text boxes and the resolved `type` property stays "text" — give
// them a format hint the tolerant parser above accepts, and apply what was
// typed on Enter too ("change" alone only fires when the field loses focus).
if (el.historyDateFrom.type !== 'date') {
  el.historyDateFrom.placeholder = 'дд.мм.гггг';
  el.historyDateTo.placeholder = 'дд.мм.гггг';
  const applyOnEnter = (e) => {
    if (e.key === 'Enter' || e.keyCode === 13) handleCustomHistoryDate();
  };
  el.historyDateFrom.addEventListener('keydown', applyOnEnter);
  el.historyDateTo.addEventListener('keydown', applyOnEnter);
}

el.historySearchInput.addEventListener('input', () => {
  const q = el.historySearchInput.value;
  if (currentHistoryTab === 'contacts') {
    contactsQuery = q;
    debouncedContactsSearch();
    return;
  }
  historySearchQuery = q;
  debouncedHistorySearch();
});

function resetHistoryPeriodUi() {
  historyPeriod = 'all';
  updatePeriodButtonsUi();
  el.historyDateFrom.value = '';
  el.historyDateTo.value = '';
}

function switchHistoryTab(tab) {
  currentHistoryTab = tab;
  el.tabHistoryBtn.classList.toggle('active', tab === 'history');
  el.tabCallbacksBtn.classList.toggle('active', tab === 'callbacks');
  el.tabNotesBtn.classList.toggle('active', tab === 'notes');
  el.tabContactsBtn.classList.toggle('active', tab === 'contacts');
  el.historyView.classList.toggle('hidden', tab !== 'history');
  el.callbacksView.classList.toggle('hidden', tab !== 'callbacks');
  el.notesView.classList.toggle('hidden', tab !== 'notes');
  el.contactsView.classList.toggle('hidden', tab !== 'contacts');
  el.historySearchRow.classList.toggle('hidden', tab !== 'history' && tab !== 'contacts');
  el.historyPeriodRow.classList.toggle('hidden', tab !== 'history' || !historyBackendReady());
  el.addContactBtn.classList.toggle('hidden', tab !== 'contacts');

  el.historySearchInput.value = '';
  historySearchQuery = '';

  if (tab === 'history') {
    el.historySearchInput.placeholder = 'Поиск по номеру или имени...';
    resetHistoryPeriodUi();
    loadHistoryPage(false);
  } else if (tab === 'callbacks') {
    refreshCallbacks();
  } else if (tab === 'notes') {
    refreshNotes();
  } else if (tab === 'contacts') {
    el.historySearchInput.placeholder = 'Поиск по коду, компании, ФИО, телефону...';
    contactsQuery = '';
    loadContacts(false);
  }
}

el.tabHistoryBtn.addEventListener('click', () => switchHistoryTab('history'));
el.tabCallbacksBtn.addEventListener('click', () => switchHistoryTab('callbacks'));
el.tabNotesBtn.addEventListener('click', () => switchHistoryTab('notes'));
el.tabContactsBtn.addEventListener('click', () => switchHistoryTab('contacts'));

el.historyBody.addEventListener('click', (e) => {
  const callBtn = e.target.closest('.call-from-history-btn');
  if (callBtn) {
    dialNumber(callBtn.dataset.number);
    return;
  }
  const playBtn = e.target.closest('.play-recording-btn');
  if (playBtn) {
    playRecording(playBtn.dataset.recordingId, playBtn.dataset.recordingLabel);
    return;
  }
  const addBtn = e.target.closest('.add-contact-from-history-btn');
  if (addBtn) {
    openContactCard(null, { phone: addBtn.dataset.number });
    return;
  }
  const noteBtn = e.target.closest('.note-from-history-btn');
  if (noteBtn) {
    // Retroactive note on an already-ended call — linked to it (call_id),
    // but doesn't touch its outcome or offer a "Назад" (there's no pending
    // outcome picker to go back to here, this call may have ended long ago).
    openNoteTextModal({
      callId: noteBtn.dataset.callId,
      entry: { number: noteBtn.dataset.number, name: noteBtn.dataset.name },
    });
  }
});

function playRecording(callId, label) {
  const cfg = loadConfig();
  if (!cfg || !cfg.backendUrl || !cfg.backendToken) {
    showToast('Для прослушивания записей нужен настроенный AMI-backend (адрес и API-ключ в настройках).', { error: true });
    return;
  }
  const url = amiApiUrl(cfg, `/api/call/${encodeURIComponent(callId)}/recording`)
    + `?key=${encodeURIComponent(cfg.backendToken)}`;
  el.recordingPlayerLabel.textContent = 'Запись: ' + (label || callId);
  el.recordingPlayer.classList.remove('hidden');
  el.recordingAudio.src = url;
  el.recordingAudio.play().catch(() => { /* browser may block autoplay until user gesture; controls still work */ });
}

el.recordingAudio.addEventListener('error', () => {
  if (!el.recordingAudio.src) return;
  el.recordingPlayerLabel.textContent = 'Запись не найдена для этого звонка';
});

el.recordingPlayerClose.addEventListener('click', () => {
  el.recordingAudio.pause();
  el.recordingAudio.removeAttribute('src');
  el.recordingAudio.load();
  el.recordingPlayer.classList.add('hidden');
});

/* -------------------------------------------------------------------- */
/* Post-call outcome picker                                              */
/* The outcome itself is stored server-side (calls.outcome, see           */
/* server/src/db.js) via setCallOutcome() below — there's no local copy.  */
/* Requires a real AMI-tracked call id: a pure-WebRTC call placed with no */
/* backend connected has nowhere to attach an outcome to, so tagging it   */
/* is a no-op there (the modal still walks through the motions since      */
/* booking/declined don't do anything beyond tagging the row anyway).     */
/* Mandatory: no backdrop-click-close (see the outcomeModal listener      */
/* below), no skip button — every answered call needs one of these        */
/* picked. The callback/note/contact sub-modals it can lead into all      */
/* return to this picker on "Назад" instead of just closing, for the      */
/* same reason (see their own open/back functions below).                 */
/* -------------------------------------------------------------------- */
let pendingOutcomeKey = null;
let pendingOutcomeEntry = null;

function promptCallOutcome(entryLike) {
  pendingOutcomeKey = entryLike.id || null;
  pendingOutcomeEntry = entryLike;
  const who = entryLike.name && entryLike.name !== entryLike.number
    ? `${entryLike.name} · ${entryLike.number}`
    : entryLike.number;
  el.outcomeSubtitle.textContent = `Разговор с ${who} — отметьте действие`;
  // Only offer to create a contact when we positively know this number
  // isn't one already — entryLike.contactId comes from the AMI record
  // (see call-store.js _emitUpdate), so it's unset/null for WebRTC calls
  // with no backend tracking them; default to showing it in that case
  // rather than hiding a possibly-useful option.
  el.outcomeCreateContactBtn.classList.toggle('hidden', !!entryLike.contactId);
  // Shown as one plain integer (dot stripped) so there's no punctuation to
  // drop or misplace when it gets copied by hand into whatever external
  // system the actual booking is created in — server/src/index.js's
  // reinsertUniqueidDot() puts the "." back before looking the call up.
  el.outcomeBookingCallId.textContent = entryLike.id ? `ID: ${entryLike.id.replace(/\./g, '')}` : '';
  el.outcomeBookingCallId.classList.toggle('hidden', !entryLike.id);
  // The client code arrives async with the contact lookup below — until (and
  // unless) it does, the booking button shows only the call id.
  el.outcomeBookingClientCode.textContent = '';
  el.outcomeBookingClientCode.classList.add('hidden');
  el.outcomeModal.classList.remove('hidden');
  loadOutcomeContext(entryLike);
}

// Who is this, and when did we last actually talk to them — fetched fresh
// every time the picker opens (not carried on entryLike) since it needs the
// PREVIOUS call, not this one, and that's cheaper to ask the server for
// than to reconstruct from whatever history happens to be loaded locally.
function loadOutcomeContext(entryLike) {
  el.outcomeContext.classList.add('hidden');
  el.outcomeContextName.textContent = '';
  el.outcomeContextLast.textContent = '';
  if (!historyBackendReady() || !entryLike.number) return;

  const cfg = loadConfig();
  const params = new URLSearchParams({ number: entryLike.number });
  if (entryLike.id) params.set('excludeCallId', entryLike.id);

  amiFetch(cfg, '/api/contacts/lookup?' + params.toString())
    .then((data) => {
      // The operator may have already skipped/answered a different call by
      // the time this resolves — don't stamp stale info onto whatever's on
      // screen now.
      if (pendingOutcomeEntry !== entryLike) return;

      let hasContent = false;
      if (data.contact && data.contact.companyName) {
        el.outcomeContextName.textContent = data.contact.companyName;
        hasContent = true;
      }
      // The client code is the main identifier to carry into the external
      // booking system — put it right on the booking button, next to the
      // call id filled in by promptCallOutcome().
      if (data.contact && data.contact.code) {
        el.outcomeBookingClientCode.textContent = `Код: ${data.contact.code}`;
        el.outcomeBookingClientCode.classList.remove('hidden');
      }
      if (data.lastCall) {
        const who = data.lastCall.operatorExtension
          ? `оператор ${data.lastCall.operatorExtension}`
          : 'оператор неизвестен';
        el.outcomeContextLast.textContent = `Последний разговор: ${formatTimestamp(data.lastCall.startedAt)}, ${who}`;
        hasContent = true;
      }
      el.outcomeContext.classList.toggle('hidden', !hasContent);
    })
    .catch((err) => logDebug('loadOutcomeContext failed: ' + err.message));
}

function closeOutcomeModal() {
  el.outcomeModal.classList.add('hidden');
  pendingOutcomeKey = null;
  pendingOutcomeEntry = null;
}

el.outcomeModal.addEventListener('click', (e) => {
  const btn = e.target.closest('.outcome-btn');
  if (btn) {
    const outcome = btn.dataset.outcome;
    const key = pendingOutcomeKey;
    const entry = pendingOutcomeEntry;
    closeOutcomeModal();

    if (outcome === 'callback') {
      openCallbackTimeModal(key, entry);
      return;
    }
    if (outcome === 'note') {
      openNoteTextModal({ callId: key, entry, setOutcome: true, backEntry: entry });
      return;
    }
    if (outcome === 'contact') {
      openContactCard(null, {
        phone: entry.number,
        companyName: entry.name && entry.name !== entry.number ? entry.name : '',
        outcomeKey: key,
        backEntry: entry,
      });
      return;
    }
    if (key) {
      setCallOutcome(key, outcome);
    } else {
      showToast('Результат не сохранён — этот звонок не отслеживается сервером', { error: true });
    }
  }
  // Deliberately not closing on a backdrop click — this modal (and the
  // others below) only close via their own explicit buttons now, so a
  // stray click while, say, reading the contact context info above the
  // grid doesn't lose the picker. There's also no skip button anymore —
  // every answered call needs one of the outcome-grid buttons picked.
});

// Shared by the callback queue, notes and contacts dial buttons below —
// drops a number straight into the dialer and places the call.
function dialNumber(number) {
  const trimmed = (number || '').trim();
  if (!trimmed) {
    showToast('Номер не указан', { error: true });
    return;
  }
  el.dialInput.value = looksLikePlainNumber(trimmed) ? formatPhoneDisplay(trimmed) : trimmed;
  updateCallButtonEnabled();
  placeCall();
}

/* -------------------------------------------------------------------- */
/* Callback queue — "Перезвонить позже": schedule a time from the outcome */
/* picker, dial it later from the dedicated tab. Server-backed (SQLite,   */
/* shared across operators/devices) — requires the AMI backend to be      */
/* connected, same as Контакты.                                          */
/* -------------------------------------------------------------------- */
function callbacksBackendReady() {
  const cfg = loadConfig();
  return !!(amiRt.backendUp && cfg && cfg.backendUrl && cfg.backendToken);
}

// Re-fetches from the server so callbacks scheduled by other operators/
// devices show up here too.
function refreshCallbacks() {
  if (!callbacksBackendReady()) {
    callbacks = [];
    updateCallbackBadge();
    el.callbacksBody.innerHTML = '<tr class="empty-row"><td colspan="3">Доступно только при подключении к серверу (режим AMI)</td></tr>';
    return;
  }
  const cfg = loadConfig();
  amiFetch(cfg, '/api/callbacks')
    .then((data) => {
      callbacks = data.callbacks || [];
      updateCallbackBadge();
      renderCallbacksView();
    })
    .catch((err) => logDebug('refreshCallbacks failed: ' + err.message));
}

let callbacks = [];
let callbackModalKey = null;
let callbackModalEntry = null;

function formatCallbackDue(ts) {
  return new Date(ts).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function updateCallbackBadge() {
  const count = callbacks.length;
  el.callbackBadge.textContent = count;
  el.callbackBadge.classList.toggle('hidden', count === 0);
}

function openCallbackTimeModal(key, entry) {
  callbackModalKey = key;
  callbackModalEntry = entry;
  const who = entry.name && entry.name !== entry.number ? `${entry.name} · ${entry.number}` : entry.number;
  el.callbackTimeSubtitle.textContent = `Перезвонить: ${who}`;
  el.callbackCustomTime.value = '';
  el.callbackTimeModal.classList.remove('hidden');
}

function closeCallbackTimeModal() {
  el.callbackTimeModal.classList.add('hidden');
  callbackModalKey = null;
  callbackModalEntry = null;
}

// The only way in here is from the outcome picker (see the outcomeModal
// click handler) — "Назад" returns to it with the same call instead of just
// closing outright, since that would otherwise leave this call with no
// outcome registered at all.
function backFromCallbackTimeModal() {
  const entry = callbackModalEntry;
  closeCallbackTimeModal();
  if (entry) promptCallOutcome(entry);
}

function scheduleCallback(dueAt) {
  if (!callbackModalEntry || isNaN(dueAt)) return;
  if (!callbacksBackendReady()) {
    showToast('Недоступно без подключения к серверу (режим AMI)', { error: true });
    return;
  }

  const cfg = loadConfig();
  amiFetch(cfg, '/api/callbacks', {
    method: 'POST',
    body: JSON.stringify({
      callId: callbackModalKey,
      number: callbackModalEntry.number,
      name: callbackModalEntry.name || '',
      dueAt,
      operatorExtension: cfg.operatorExt,
    }),
  }).then(() => {
    refreshCallbacks();
    if (callbackModalKey) setCallOutcome(callbackModalKey, 'callback');
    showToast(`Перезвонить ${callbackModalEntry.number} запланировано на ${formatCallbackDue(dueAt)}`);
    closeCallbackTimeModal();
  }).catch((err) => showToast('Не удалось запланировать звонок: ' + err.message, { error: true }));
}

el.callbackTimeModal.addEventListener('click', (e) => {
  const btn = e.target.closest('.callback-time-btn');
  if (btn) scheduleCallback(Date.now() + Number(btn.dataset.minutes) * 60000);
});

el.callbackCustomTimeBtn.addEventListener('click', () => {
  if (!el.callbackCustomTime.value) {
    showToast('Укажите дату и время', { error: true });
    return;
  }
  scheduleCallback(new Date(el.callbackCustomTime.value).getTime());
});

el.callbackTimeCancelBtn.addEventListener('click', backFromCallbackTimeModal);

function renderCallbacksView() {
  callbacks.sort((a, b) => a.dueAt - b.dueAt);
  if (!callbacks.length) {
    el.callbacksBody.innerHTML = '<tr class="empty-row"><td colspan="3">Отложенных звонков нет</td></tr>';
    return;
  }
  const now = Date.now();
  el.callbacksBody.innerHTML = callbacks.map((cb) => {
    const overdue = cb.dueAt <= now;
    const who = cb.name && cb.name !== cb.number ? `${cb.name} · ${cb.number}` : cb.number;
    return `<tr>
      <td class="callback-due${overdue ? ' callback-overdue' : ''}">${formatCallbackDue(cb.dueAt)}</td>
      <td>${escapeHtml(who)}</td>
      <td class="callback-actions">
        <button class="btn btn-call btn-sm callback-dial-btn" data-id="${escapeHtml(cb.id)}" data-number="${escapeHtml(cb.number)}">Позвонить</button>
        <button class="btn-link danger callback-remove-btn" data-id="${escapeHtml(cb.id)}">Удалить</button>
      </td>
    </tr>`;
  }).join('');
}

function removeCallback(id) {
  if (!callbacksBackendReady()) return;
  const cfg = loadConfig();
  amiFetch(cfg, `/api/callbacks/${encodeURIComponent(id)}`, { method: 'DELETE' })
    .then(refreshCallbacks)
    .catch((err) => showToast('Не удалось удалить: ' + err.message, { error: true }));
}

el.callbacksBody.addEventListener('click', (e) => {
  const dialBtn = e.target.closest('.callback-dial-btn');
  if (dialBtn) {
    removeCallback(dialBtn.dataset.id);
    dialNumber(dialBtn.dataset.number);
    return;
  }
  const removeBtn = e.target.closest('.callback-remove-btn');
  if (removeBtn) removeCallback(removeBtn.dataset.id);
});

// Keep "overdue" highlighting and the badge fresh without needing a reload
// — and, once a backend is connected, pick up callbacks scheduled from
// another operator's session too.
setInterval(() => {
  if (el.callbacksView.classList.contains('hidden')) return;
  refreshCallbacks();
}, 30000);

/* -------------------------------------------------------------------- */
/* Notes — "Заметки": same pattern as the callback queue above, but just */
/* stores free text against a number/name instead of a due time.         */
/* Server-backed (SQLite) — requires the AMI backend, same as Контакты.  */
/* -------------------------------------------------------------------- */
function notesBackendReady() {
  const cfg = loadConfig();
  return !!(amiRt.backendUp && cfg && cfg.backendUrl && cfg.backendToken);
}

function refreshNotes() {
  if (!notesBackendReady()) {
    notes = [];
    updateNoteBadge();
    el.notesBody.innerHTML = '<tr class="empty-row"><td colspan="4">Доступно только при подключении к серверу (режим AMI)</td></tr>';
    return;
  }
  const cfg = loadConfig();
  // Only this operator's own notes — the server filters by ?extension=.
  amiFetch(cfg, '/api/notes?extension=' + encodeURIComponent(cfg.operatorExt))
    .then((data) => {
      notes = data.notes || [];
      updateNoteBadge();
      renderNotesView();
    })
    .catch((err) => logDebug('refreshNotes failed: ' + err.message));
}

let notes = [];
let noteModalCallId = null;     // call to link the note to (call_id column) — independent of outcome-setting below
let noteModalEntry = null;      // {number, name} for a brand-new note
let noteModalEditId = null;     // existing note's id, when editing one instead
// Whether saving should ALSO tag the call's outcome as 'note' — true only
// when this modal was reached via the mandatory post-call picker; a
// retroactive note added from a history row, or editing an existing note,
// must NOT silently overwrite whatever outcome that call already has.
let noteModalSetOutcome = false;
// entryLike to reopen in the outcome picker on "Назад", or null when this
// modal has nothing to go "back" to (editing/history-row cases) — plain
// "Отмена" then.
let noteModalBackEntry = null;

function formatNoteDate(ts) {
  return new Date(ts).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function updateNoteBadge() {
  const count = notes.length;
  el.noteBadge.textContent = count;
  el.noteBadge.classList.toggle('hidden', count === 0);
}

// { callId, entry, existing, setOutcome, backEntry } — all optional:
//  - outcome picker's "Создать заметку": { callId, entry, setOutcome: true, backEntry: entry }
//  - editing a note from the Заметки tab: { existing }
//  - retroactive note from a history row: { callId, entry } (no setOutcome/backEntry)
function openNoteTextModal({ callId, entry, existing, setOutcome, backEntry } = {}) {
  noteModalCallId = callId || null;
  noteModalEntry = entry || (existing ? { number: existing.number, name: existing.name } : null);
  noteModalEditId = existing ? existing.id : null;
  noteModalSetOutcome = !!setOutcome;
  noteModalBackEntry = backEntry || null;

  const who = noteModalEntry && noteModalEntry.name && noteModalEntry.name !== noteModalEntry.number
    ? `${noteModalEntry.name} · ${noteModalEntry.number}`
    : (noteModalEntry ? noteModalEntry.number : '');
  el.noteTextTitle.textContent = existing ? 'Редактировать заметку' : 'Заметка';
  el.noteTextSubtitle.textContent = who ? `Звонок с ${who}` : '';
  el.noteTextInput.value = existing ? existing.text : '';
  el.noteTextCancelBtn.textContent = noteModalBackEntry ? '← Назад к действиям' : 'Отмена';
  el.noteTextModal.classList.remove('hidden');
  el.noteTextInput.focus();
}

function closeNoteTextModal() {
  el.noteTextModal.classList.add('hidden');
  noteModalCallId = null;
  noteModalEntry = null;
  noteModalEditId = null;
  noteModalSetOutcome = false;
  noteModalBackEntry = null;
}

function saveNoteFromModal() {
  const text = el.noteTextInput.value.trim();
  if (!text) {
    showToast('Введите текст заметки', { error: true });
    return;
  }
  if (!notesBackendReady()) {
    showToast('Недоступно без подключения к серверу (режим AMI)', { error: true });
    return;
  }

  const cfg = loadConfig();
  const isEdit = !!noteModalEditId;
  const path = isEdit
    ? `/api/notes/${encodeURIComponent(noteModalEditId)}?extension=${encodeURIComponent(cfg.operatorExt)}`
    : '/api/notes';
  const body = isEdit
    ? { text }
    : {
        callId: noteModalCallId,
        number: noteModalEntry ? noteModalEntry.number : '',
        name: noteModalEntry ? (noteModalEntry.name || '') : '',
        text,
        operatorExtension: cfg.operatorExt,
      };
  const shouldSetOutcome = noteModalSetOutcome && noteModalCallId;

  amiFetch(cfg, path, { method: isEdit ? 'PUT' : 'POST', body: JSON.stringify(body) })
    .then(() => {
      refreshNotes();
      if (shouldSetOutcome) setCallOutcome(noteModalCallId, 'note');
      // A new note tied to a call changes that call's noteCount/noteTag in
      // "Мои звонки" (see buildHistoryRowsHtml) — without this, the row
      // list stays stale (showing 0 notes) until something else happens to
      // trigger a refresh, e.g. switching tabs away and back.
      if (!isEdit && noteModalCallId) debouncedHistoryRefresh();
      showToast('Заметка сохранена');
      closeNoteTextModal();
    })
    .catch((err) => showToast('Не удалось сохранить заметку: ' + err.message, { error: true }));
}

el.noteTextSaveBtn.addEventListener('click', saveNoteFromModal);
el.noteTextCancelBtn.addEventListener('click', () => {
  const backEntry = noteModalBackEntry;
  closeNoteTextModal();
  if (backEntry) promptCallOutcome(backEntry);
});

function renderNotesView() {
  notes.sort((a, b) => b.createdAt - a.createdAt);
  if (!notes.length) {
    el.notesBody.innerHTML = '<tr class="empty-row"><td colspan="4">Заметок пока нет</td></tr>';
    return;
  }
  el.notesBody.innerHTML = notes.map((n) => {
    const who = n.name && n.name !== n.number ? `${n.name} · ${n.number}` : n.number;
    return `<tr>
      <td class="note-date">${formatNoteDate(n.createdAt)}</td>
      <td>${escapeHtml(who)}</td>
      <td class="note-text">${escapeHtml(n.text)}</td>
      <td class="note-actions">
        <button class="btn btn-call btn-sm note-dial-btn" data-id="${escapeHtml(n.id)}" data-number="${escapeHtml(n.number)}">Позвонить</button>
        <button class="btn-link note-edit-btn" data-id="${escapeHtml(n.id)}">Изменить</button>
        <button class="btn-link danger note-remove-btn" data-id="${escapeHtml(n.id)}">Удалить</button>
      </td>
    </tr>`;
  }).join('');
}

el.notesBody.addEventListener('click', (e) => {
  const dialBtn = e.target.closest('.note-dial-btn');
  if (dialBtn) {
    dialNumber(dialBtn.dataset.number);
    return;
  }
  const editBtn = e.target.closest('.note-edit-btn');
  if (editBtn) {
    const existing = notes.find((n) => n.id === editBtn.dataset.id);
    if (existing) openNoteTextModal({ existing });
    return;
  }
  const removeBtn = e.target.closest('.note-remove-btn');
  if (removeBtn && notesBackendReady()) {
    const cfg = loadConfig();
    amiFetch(cfg, `/api/notes/${encodeURIComponent(removeBtn.dataset.id)}?extension=${encodeURIComponent(cfg.operatorExt)}`, { method: 'DELETE' })
      .then(refreshNotes)
      .catch((err) => showToast('Не удалось удалить: ' + err.message, { error: true }));
  }
});

/* -------------------------------------------------------------------- */
/* Contacts — "Контакты": the client book (company/manager/phones), each */
/* one auto-linked server-side to any call whose caller-ID/dialed number */
/* matches (see server/src/db.js normalizePhone). Purely server-backed   */
/* (SQLite) — there is no localStorage fallback, since a shared client   */
/* list only means something once it's actually shared across operators.*/
/* -------------------------------------------------------------------- */
let contactsQuery = '';
let contactsOffset = 0;
let contactsTotal = 0;
let contactsRows = [];
let contactModalEditingId = null;
let contactDeleteArmed = false;
// Set when the "new contact" card was opened from the post-call outcome
// picker (see promptCallOutcome/setCallOutcome) — a successful save then
// tags that call's outcome as 'contact', same as booking/note/callback do.
let contactModalOutcomeKey = null;
// entryLike to reopen in the outcome picker on "Назад", or null when this
// card has nothing to go back to (history-row/contacts-tab cases) — plain
// "Отмена" then.
let contactModalBackEntry = null;
const CONTACTS_PAGE_SIZE = 100;

function contactsBackendReady() {
  const cfg = loadConfig();
  return !!(amiRt.backendUp && cfg && cfg.backendUrl && cfg.backendToken);
}

function loadContacts(loadMore) {
  if (!contactsBackendReady()) {
    contactsRows = [];
    el.contactsBody.innerHTML = '<tr class="empty-row"><td colspan="7">Контакты доступны только при подключении к серверу (режим AMI)</td></tr>';
    el.contactsLoadMoreRow.classList.add('hidden');
    return;
  }

  const cfg = loadConfig();
  if (!loadMore) contactsOffset = 0;
  const params = new URLSearchParams();
  if (contactsQuery.trim()) params.set('q', contactsQuery.trim());
  params.set('limit', String(CONTACTS_PAGE_SIZE));
  params.set('offset', String(contactsOffset));

  amiFetch(cfg, '/api/contacts?' + params.toString())
    .then((data) => {
      contactsTotal = data.total || 0;
      contactsRows = loadMore ? contactsRows.concat(data.rows) : data.rows;
      contactsOffset += data.rows.length;
      renderContactsTable();
      el.contactsResultsInfo.textContent = contactsTotal ? `Показано ${contactsRows.length} из ${contactsTotal}` : '';
      el.contactsLoadMoreRow.classList.toggle('hidden', contactsTotal === 0);
      el.contactsLoadMoreBtn.classList.toggle('hidden', contactsRows.length >= contactsTotal);
    })
    .catch((err) => showToast('Не удалось загрузить контакты: ' + err.message, { error: true }));
}

// Same calendar day as right now — not "the last 24 hours": a call at 23:50
// yesterday should NOT light up green this morning.
function isToday(ts) {
  if (!ts) return false;
  const d = new Date(ts);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

function renderContactsTable() {
  if (!contactsRows.length) {
    el.contactsBody.innerHTML = `<tr class="empty-row"><td colspan="7">${contactsQuery.trim() ? 'Ничего не найдено' : 'Контактов пока нет'}</td></tr>`;
    return;
  }
  el.contactsBody.innerHTML = contactsRows.map((c) => {
    const phones = (c.phones || []).filter(Boolean);
    const calledToday = isToday(c.lastCallAt);
    return `
    <tr class="contact-row" data-id="${escapeHtml(c.id)}">
      <td class="contact-code">${escapeHtml(c.code || '—')}</td>
      <td>${escapeHtml(c.companyName || '—')}</td>
      <td>${escapeHtml(c.managerName || '—')}</td>
      <td class="contact-phones">
        ${phones.length
          ? phones.map((p, i) => `<span${i ? ' class="contact-phone-secondary"' : ''}>${escapeHtml(p)}</span>`).join('')
          : '<span>—</span>'}
      </td>
      <td>${escapeHtml(c.operatorExtension || '—')}</td>
      <td${calledToday ? ' class="last-call-today" title="Звонок был сегодня"' : ''}>${c.lastCallAt ? formatTimestamp(c.lastCallAt) : '—'}</td>
      <td class="col-contact-call">
        ${phones[0] ? `<button class="btn btn-call btn-sm contact-call-btn" data-number="${escapeHtml(phones[0])}" title="Позвонить">Позвонить</button>` : ''}
      </td>
    </tr>`;
  }).join('');
}

el.contactsBody.addEventListener('click', (e) => {
  const callBtn = e.target.closest('.contact-call-btn');
  if (callBtn) {
    dialNumber(callBtn.dataset.number);
    return;
  }
  const row = e.target.closest('.contact-row');
  if (row) openContactCard(row.dataset.id);
});

el.contactsLoadMoreBtn.addEventListener('click', () => loadContacts(true));
el.addContactBtn.addEventListener('click', () => openContactCard(null));

// One dial button per phone slot — a button is only shown while its input
// actually holds something, tracked live as the operator types/clears.
function updateContactCallButtons() {
  el.contactCallRow.querySelectorAll('.contact-call-slot-btn').forEach((btn) => {
    const input = el.contactPhoneInputs[Number(btn.dataset.phone) - 1];
    btn.classList.toggle('hidden', !(input && input.value.trim()));
  });
}

el.contactPhoneInputs.forEach((input) => input.addEventListener('input', () => {
  reformatPhoneInput(input);
  updateContactCallButtons();
}));

el.contactCallRow.addEventListener('click', (e) => {
  const btn = e.target.closest('.contact-call-slot-btn');
  if (!btn) return;
  const input = el.contactPhoneInputs[Number(btn.dataset.phone) - 1];
  closeContactModal();
  dialNumber(input ? input.value : '');
});

function closeContactModal() {
  el.contactModal.classList.add('hidden');
  contactModalEditingId = null;
  contactModalOutcomeKey = null;
  contactModalBackEntry = null;
  contactDeleteArmed = false;
  el.contactDeleteBtn.textContent = 'Удалить контакт';
}

// `prefill` (only meaningful when id is null, i.e. creating a new contact):
// { phone, companyName, outcomeKey, backEntry } — used by the
// "unrecognized number" button on history rows, the post-call outcome
// picker's "Создать контакт" option (also sets backEntry, for "Назад"), and
// plain "+ Новый контакт" (neither set).
function openContactCard(id, prefill) {
  if (!contactsBackendReady()) {
    showToast('Контакты доступны только при подключении к серверу (режим AMI)', { error: true });
    return;
  }

  contactModalEditingId = id;
  contactModalOutcomeKey = (prefill && prefill.outcomeKey) || null;
  contactModalBackEntry = (prefill && prefill.backEntry) || null;
  contactDeleteArmed = false;
  el.contactDeleteBtn.textContent = 'Удалить контакт';
  el.contactCancelBtn.textContent = contactModalBackEntry ? '← Назад к действиям' : 'Отмена';
  el.contactHistorySection.classList.toggle('hidden', !id);
  el.contactDeleteBtn.classList.toggle('hidden', !id);
  el.contactModal.classList.remove('hidden');

  if (!id) {
    el.contactModalTitle.textContent = 'Новый контакт';
    el.contactCode.value = '';
    const phone = (prefill && prefill.phone) || '';
    el.contactPhoneInputs.forEach((input, i) => {
      input.value = i === 0 && phone ? (looksLikePlainNumber(phone) ? formatPhoneDisplay(phone) : phone) : '';
    });
    updateContactCallButtons();
    el.contactCompanyName.value = (prefill && prefill.companyName) || '';
    el.contactManagerName.value = '';
    el.contactOperatorExt.value = (loadConfig() || {}).operatorExt || '';
    el.contactComment.value = '';
    return;
  }

  const cfg = loadConfig();
  el.contactModalTitle.textContent = 'Контакт';
  el.contactHistoryBody.innerHTML = '<tr class="empty-row"><td colspan="5">Загрузка...</td></tr>';

  amiFetch(cfg, `/api/contacts/${encodeURIComponent(id)}`)
    .then((data) => {
      const c = data.contact;
      el.contactCode.value = c.code || '';
      el.contactPhoneInputs.forEach((input, i) => { input.value = (c.phones && c.phones[i]) || ''; });
      updateContactCallButtons();
      el.contactCompanyName.value = c.companyName || '';
      el.contactManagerName.value = c.managerName || '';
      el.contactOperatorExt.value = c.operatorExtension || '';
      el.contactComment.value = c.comment || '';
      el.contactLastCall.textContent = c.lastCallAt ? `Последний звонок: ${formatTimestamp(c.lastCallAt)}` : 'Звонков ещё не было';
      // Same "called today → green" cue as the contacts table's date column.
      el.contactLastCall.classList.toggle('last-call-today', isToday(c.lastCallAt));
      renderContactHistory(data.calls || []);
    })
    .catch((err) => {
      showToast('Не удалось загрузить контакт: ' + err.message, { error: true });
      closeContactModal();
    });
}

function renderContactHistory(records) {
  if (!records.length) {
    el.contactHistoryBody.innerHTML = '<tr class="empty-row"><td colspan="5">Звонков пока нет</td></tr>';
    return;
  }
  const entries = records.map(amiRecordToEntry);
  el.contactHistoryBody.innerHTML = entries.map((entry) => {
    let dirIcon, dirClass;
    if (entry.direction === 'incoming') {
      dirIcon = ICONS.dirIn;
      dirClass = entry.status === 'missed' ? 'dir-missed' : 'dir-in';
    } else {
      dirIcon = ICONS.dirOut;
      dirClass = 'dir-out';
    }
    let badgeClass = 'warn';
    if (entry.status === 'completed') badgeClass = 'ok';
    else if (entry.status === 'missed' || entry.status === 'failed') badgeClass = 'missed';
    else if (entry.status === 'elsewhere') badgeClass = 'neutral';

    const playCell = entry.id
      ? `<button class="play-recording-btn" data-recording-id="${escapeHtml(entry.id)}" data-recording-label="${escapeHtml(entry.number)}" title="Прослушать запись">${ICONS.play}</button>`
      : '';

    return `<tr>
      <td class="col-dir"><span class="dir-icon ${dirClass}">${dirIcon}</span></td>
      <td>${formatTimestamp(entry.startedAt)}</td>
      <td>${entry.duration != null ? formatDuration(entry.duration) : '—'}</td>
      <td><span class="status-badge ${badgeClass}">${escapeHtml(entry.statusLabel)}</span></td>
      <td class="col-play">${playCell}</td>
    </tr>`;
  }).join('');
}

el.contactHistoryBody.addEventListener('click', (e) => {
  const btn = e.target.closest('.play-recording-btn');
  if (btn) playRecording(btn.dataset.recordingId, btn.dataset.recordingLabel);
});

el.contactCancelBtn.addEventListener('click', () => {
  const backEntry = contactModalBackEntry;
  closeContactModal();
  if (backEntry) promptCallOutcome(backEntry);
});

el.contactSaveBtn.addEventListener('click', () => {
  const phones = el.contactPhoneInputs.map((input) => input.value.trim());
  if (!phones.some(Boolean)) {
    showToast('Укажите хотя бы один номер телефона', { error: true });
    return;
  }
  if (!contactsBackendReady()) {
    showToast('Контакты доступны только при подключении к серверу (режим AMI)', { error: true });
    return;
  }

  const cfg = loadConfig();
  const payload = {
    code: el.contactCode.value.trim(),
    phones,
    companyName: el.contactCompanyName.value.trim(),
    managerName: el.contactManagerName.value.trim(),
    operatorExtension: el.contactOperatorExt.value.trim(),
    comment: el.contactComment.value.trim(),
  };
  const isNew = !contactModalEditingId;
  const path = isNew ? '/api/contacts' : `/api/contacts/${encodeURIComponent(contactModalEditingId)}`;
  const outcomeKey = contactModalOutcomeKey; // closeContactModal() below clears it

  amiFetch(cfg, path, { method: isNew ? 'POST' : 'PUT', body: JSON.stringify(payload) })
    .then(() => {
      showToast(isNew ? 'Контакт добавлен' : 'Контакт обновлён');
      closeContactModal();
      loadContacts(false);
      if (outcomeKey) setCallOutcome(outcomeKey, 'contact');
    })
    .catch((err) => showToast('Не удалось сохранить контакт: ' + err.message, { error: true }));
});

// Two-click confirm instead of confirm() — the embedded WebKit host (1C's
// HTML field) has no native dialog box and just hangs on that call (see the
// note on showToast above); this stays a plain, always-available button.
el.contactDeleteBtn.addEventListener('click', () => {
  if (!contactModalEditingId) return;
  if (!contactDeleteArmed) {
    contactDeleteArmed = true;
    el.contactDeleteBtn.textContent = 'Точно удалить?';
    setTimeout(() => {
      contactDeleteArmed = false;
      el.contactDeleteBtn.textContent = 'Удалить контакт';
    }, 3000);
    return;
  }
  const cfg = loadConfig();
  amiFetch(cfg, `/api/contacts/${encodeURIComponent(contactModalEditingId)}`, { method: 'DELETE' })
    .then(() => {
      showToast('Контакт удалён');
      closeContactModal();
      loadContacts(false);
    })
    .catch((err) => showToast('Не удалось удалить контакт: ' + err.message, { error: true }));
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

// Stats tiles reflect the live WS-reported amiHistory regardless of
// whatever period/search filter the history table itself currently has
// applied; the table (see loadHistoryPage) is a separate, always-SQLite-
// backed query. Without a backend connected there's simply nothing to show
// either way — refreshStatsAndHistory() renders that empty state too.
function refreshStatsAndHistory() {
  renderStats(amiRt.backendUp ? amiHistory.map(amiRecordToEntry) : []);
  if (currentHistoryTab === 'history') loadHistoryPage(false);
}

// The only place the outcome (booking/note/declined/callback) gets written
// — straight to SQLite via the backend, no local copy anywhere (see the
// comment on the outcome picker above for the "no AMI-tracked call id" case).
function setCallOutcome(callId, outcome) {
  if (!historyBackendReady()) {
    showToast('Результат недоступен без подключения к серверу (режим AMI)', { error: true });
    return;
  }
  const cfg = loadConfig();
  amiFetch(cfg, `/api/call/${encodeURIComponent(callId)}/outcome`, {
    method: 'POST',
    body: JSON.stringify({ outcome }),
  }).catch((err) => showToast('Не удалось сохранить результат: ' + err.message, { error: true }));
}

/* -------------------------------------------------------------------- */
/* AMI-mode call records -> history table rows                          */
/* -------------------------------------------------------------------- */

const AMI_DISPOSITION_LABELS = {
  NOANSWER: 'Нет ответа',
  BUSY: 'Занято',
  CANCEL: 'Отменён',
  CONGESTION: 'Перегрузка линии',
  CHANUNAVAIL: 'Недоступен',
  FAILED: 'Ошибка вызова',
};

function amiRecordToEntry(r) {
  let status, statusLabel, duration = null;

  if (r.answeredAt) {
    duration = ((r.endedAt || Date.now()) - r.answeredAt) / 1000;
  }

  switch (r.state) {
    case 'answered':
      status = 'active'; statusLabel = 'В разговоре'; break;
    case 'ended':
      status = 'completed'; statusLabel = 'Завершён'; break;
    case 'operator_no_answer':
      status = 'missed'; statusLabel = 'Вы не ответили'; break;
    case 'failed':
      // Ring group / queue call a colleague answered first — neither missed
      // nor failed (same mapping as deriveStatus in server/src/db.js).
      if (r.disposition === 'ANSWERED_ELSEWHERE') { status = 'elsewhere'; statusLabel = 'Ответил другой оператор'; break; }
      status = 'failed'; statusLabel = AMI_DISPOSITION_LABELS[r.disposition] || 'Не завершён'; break;
    default:
      status = 'ringing'; statusLabel = 'Звонит...';
  }

  return {
    id: r.id,
    direction: r.direction,
    number: r.counterparty.number,
    // Prefer the contact book's name over whatever caller-ID name Asterisk
    // happened to report (usually empty for outgoing calls) — this is what
    // makes even old calls show a name once a matching contact exists,
    // since the match happens by phone number at query time (see
    // searchCalls in server/src/db.js), not by anything stamped on the call
    // when it originally happened.
    name: r.contactCompany || r.counterparty.name,
    startedAt: r.startedAt,
    duration,
    status,
    statusLabel,
    outcome: r.outcome || null,
    contactId: r.contactId || null,
    // Only ever present on rows from /api/history (see searchCalls in
    // server/src/db.js) — undefined elsewhere, which buildHistoryRowsHtml
    // below treats the same as "0 confirmed bookings".
    bookingCount: r.bookingCount || 0,
    bookingAmount: r.bookingAmount || 0,
    bookingInfo: r.bookingInfo || '',
    // Same "only present on /api/history rows" caveat as bookingCount above —
    // counts ALL notes on this call, including ones added via the history
    // row's note button, which deliberately never touch `outcome` (see
    // buildHistoryRowsHtml's noteTag).
    noteCount: r.noteCount || 0,
  };
}

function upsertAmiHistory(record) {
  const idx = amiHistory.findIndex((r) => r.id === record.id);
  if (idx >= 0) amiHistory[idx] = record;
  else amiHistory.unshift(record);
  amiHistory.sort((a, b) => b.startedAt - a.startedAt);
  amiHistory = amiHistory.slice(0, HISTORY_MAX);
  renderStats(amiHistory.map(amiRecordToEntry));
  debouncedHistoryRefresh();
}

/* -------------------------------------------------------------------- */
/* Ringtone / ringback via WebAudio (no external audio files needed)     */
/* -------------------------------------------------------------------- */
let audioCtx = null;
let ringInterval = null;

function ensureAudioCtx() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

// Unlock audio on first user gesture (autoplay policies).
document.addEventListener('click', () => {
  try { ensureAudioCtx(); } catch (e) { /* ignore */ }
}, { once: true });

function beep(ctx, freq, startAt, duration, gainValue = 0.15) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = freq;
  osc.type = 'sine';
  gain.gain.value = gainValue;
  osc.connect(gain).connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration);
}

function startRingtone(pattern) {
  stopRingtone();
  try {
    const ctx = ensureAudioCtx();
    const playCycle = () => {
      const now = ctx.currentTime;
      pattern.forEach(([freq, offset, dur]) => beep(ctx, freq, now + offset, dur));
    };
    playCycle();
    ringInterval = setInterval(playCycle, pattern.cycleMs);
  } catch (e) { /* audio unavailable, ignore */ }
}

function stopRingtone() {
  if (ringInterval) {
    clearInterval(ringInterval);
    ringInterval = null;
  }
}

// Standard DTMF dual-tone pair per key (ITU-T Q.23) — same table a real
// phone keypad uses, reusing the beep() oscillator helper above to play
// both frequencies of the pair at once.
const DTMF_FREQUENCIES = {
  '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
  '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
  '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
  '*': [941, 1209], '0': [941, 1336], '#': [941, 1477],
};

function playDtmfTone(digit) {
  const freqs = DTMF_FREQUENCIES[digit];
  if (!freqs) return;
  try {
    const ctx = ensureAudioCtx();
    const now = ctx.currentTime;
    const duration = 0.12;
    beep(ctx, freqs[0], now, duration, 0.07);
    beep(ctx, freqs[1], now, duration, 0.07);
  } catch (e) { /* audio unavailable — silent keypad, not worth surfacing */ }
}

// Incoming call ring: two short beeps repeating.
const INCOMING_PATTERN = Object.assign(
  [[880, 0, 0.2], [880, 0.25, 0.2]],
  { cycleMs: 2000 }
);
// Outgoing ringback: single longer tone, slower repeat (classic ringback feel).
const RINGBACK_PATTERN = Object.assign(
  [[425, 0, 1.0]],
  { cycleMs: 4000 }
);

/* -------------------------------------------------------------------- */
/* Application / call state                                              */
/* -------------------------------------------------------------------- */
let ua = null;
let currentSession = null;
let callTimerInterval = null;
let callConfirmedAt = null;
let keypadMode = 'dial'; // 'dial' | 'dtmf'
let currentMode = 'webrtc'; // 'webrtc' | 'ami' — which backend is currently driving calls

// --- AMI-mode runtime state (see startAmiMode) ---
const amiRt = {
  ws: null,
  reconnectTimer: null,
  backendUp: false,   // WS connection to our own backend is open
  amiUp: false,       // backend reports it's logged into Asterisk AMI
  pendingActionId: null, // actionId of an Originate we just sent, not yet matched to a record
  activeRecordId: null,  // id of the call currently shown in the UI
};

function setRegStatus(state, text) {
  el.regDot.className = 'dot' + (state ? ` ${state}` : '');
  el.regText.textContent = text;
}

function updateCallButtonEnabled() {
  let ready;
  if (currentMode === 'ami') {
    ready = amiRt.backendUp && amiRt.amiUp && !amiRt.activeRecordId;
  } else {
    const registered = ua && ua.isRegistered && ua.isRegistered();
    ready = registered && !currentSession;
  }
  el.callBtn.disabled = !ready || !el.dialInput.value.trim();
}

el.dialInput.addEventListener('input', () => {
  reformatPhoneInput(el.dialInput);
  updateCallButtonEnabled();
});

/* -------------------- UA lifecycle -------------------- */

function buildIceServers(cfg) {
  if (!cfg.iceServers) return undefined;
  const urls = cfg.iceServers.split(',').map(s => s.trim()).filter(Boolean);
  if (!urls.length) return undefined;
  return urls.map(url => {
    const server = { urls: url };
    if (/^turns?:/.test(url) && cfg.turnUser) {
      server.username = cfg.turnUser;
      server.credential = cfg.turnPass || '';
    }
    return server;
  });
}

function normalizeSipUri(input, cfg) {
  let value = input.trim();
  if (!value) return null;
  if (value.startsWith('sip:') || value.startsWith('sips:')) return value;
  if (value.includes('@')) return `sip:${value}`;
  // Bare number/extension: attach our own domain. The dial input displays
  // numbers formatted with spaces ("90 601 03 31") for readability — those
  // aren't valid inside a SIP URI, so strip them back out here.
  value = value.replace(/\s+/g, '');
  let domain = 'localhost';
  try {
    const at = cfg.sipUri.indexOf('@');
    if (at !== -1) domain = cfg.sipUri.slice(at + 1);
  } catch (e) { /* fallback below */ }
  return `sip:${value}@${domain}`;
}

function startUA(cfg) {
  stopAmiMode();
  stopUA();
  currentMode = 'webrtc';

  if (!isWebRtcSupported()) {
    setRegStatus('failed', 'WebRTC не поддерживается — переключитесь на режим AMI в настройках');
    return;
  }

  let socket;
  try {
    socket = new JsSIP.WebSocketInterface(cfg.wsServer);
  } catch (e) {
    setRegStatus('failed', 'Некорректный адрес сервера');
    return;
  }

  const uaConfig = {
    sockets: [socket],
    uri: cfg.sipUri,
    password: cfg.password,
    display_name: cfg.displayName || undefined,
    register: true,
    session_timers: false,
  };

  let thisUa;
  try {
    thisUa = new JsSIP.UA(uaConfig);
    ua = thisUa;
  } catch (e) {
    setRegStatus('failed', 'Ошибка конфигурации: ' + e.message);
    return;
  }

  // A previous UA's own shutdown (from stopUA() above) can still emit events
  // (e.g. a delayed "disconnected") after this new one has already taken
  // over and registered. Every handler below checks it's still the current
  // UA before touching shared UI state, so a stale/superseded instance can't
  // clobber a perfectly healthy newer connection's status.
  const isCurrent = () => ua === thisUa;

  thisUa.on('connecting', () => { if (isCurrent()) setRegStatus('connecting', 'Подключение...'); });
  thisUa.on('connected', () => { if (isCurrent()) setRegStatus('connecting', 'Соединено, регистрация...'); });
  thisUa.on('disconnected', () => {
    if (!isCurrent()) return;
    setRegStatus('failed', 'Нет соединения с сервером');
    updateCallButtonEnabled();
  });
  thisUa.on('registered', () => {
    if (!isCurrent()) return;
    setRegStatus('registered', 'Зарегистрирован');
    updateCallButtonEnabled();
  });
  thisUa.on('unregistered', () => {
    if (!isCurrent()) return;
    setRegStatus(null, 'Не зарегистрирован');
    updateCallButtonEnabled();
  });
  thisUa.on('registrationFailed', (e) => {
    if (!isCurrent()) return;
    setRegStatus('failed', 'Ошибка регистрации: ' + (e.cause || ''));
    updateCallButtonEnabled();
  });

  thisUa.on('newRTCSession', (data) => { if (isCurrent()) onNewRTCSession(data); });

  setRegStatus('connecting', 'Запуск...');
  ua.start();

  // Independent of call control: if AMI-backend fields are also filled in
  // (from the same settings modal), use them read-only to populate "Мои
  // звонки" and enable recording playback — Asterisk sees this call either
  // way, regardless of which transport placed it. See handleAmiMessage(),
  // which only drives call-control UI when currentMode === 'ami'.
  if (cfg.backendUrl && cfg.backendToken && cfg.operatorExt) {
    connectAmiSocket(cfg);
  } else {
    refreshStatsAndHistory();
  }
}

function stopUA() {
  if (currentSession) {
    try { currentSession.terminate(); } catch (e) { /* ignore */ }
  }
  if (ua) {
    try { ua.stop(); } catch (e) { /* ignore */ }
    ua = null;
  }
  setRegStatus(null, 'Не настроено');
}

/* -------------------------------------------------------------------- */
/* AMI mode: calls are placed/received on the operator's real SIP phone; */
/* this page talks to our own backend (server/), which holds the AMI    */
/* credentials and drives Asterisk. See server/README / project README. */
/* -------------------------------------------------------------------- */

function amiApiUrl(cfg, path) {
  return cfg.backendUrl.replace(/\/+$/, '') + path;
}

const AMI_FETCH_TIMEOUT_MS = 15000;

// XMLHttpRequest, not fetch() — confirmed via the on-page debug log that the
// WebKit build inside 1C's HTML field has no `fetch` at all ("ReferenceError:
// Can't find variable: fetch"), even though WebSocket/Promise/arrow
// functions all work fine there. XHR has been universally available since
// the late 1990s, so it sidesteps that gap entirely.
function amiFetch(cfg, path, options = {}) {
  const url = amiApiUrl(cfg, path);
  const method = options.method || 'GET';
  logDebug(`amiFetch -> ${method} ${url}`);

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    const timer = setTimeout(() => {
      logDebug(`amiFetch TIMEOUT (${AMI_FETCH_TIMEOUT_MS}ms) for ${path}`);
      try { xhr.abort(); } catch (e) { /* ignore */ }
      finish(reject, new Error('Таймаут запроса к серверу'));
    }, AMI_FETCH_TIMEOUT_MS);

    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('X-Api-Key', cfg.backendToken);

    xhr.onreadystatechange = () => {
      if (xhr.readyState !== 4) return;
      logDebug(`amiFetch <- HTTP ${xhr.status || 0} for ${path}`);
      let data = null;
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch (e) { /* empty/non-JSON body */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        finish(resolve, data);
      } else {
        const message = (data && data.error) || `HTTP ${xhr.status || 0}`;
        logDebug(`amiFetch FAILED for ${path}: ${message}`);
        finish(reject, new Error(message));
      }
    };
    xhr.onerror = () => {
      logDebug(`amiFetch NETWORK ERROR for ${path}`);
      finish(reject, new Error('Сетевая ошибка запроса к серверу'));
    };

    xhr.send(options.body || null);
  });
}

function startAmiMode(cfg) {
  stopAmiMode();
  stopUA();
  currentMode = 'ami';

  if (!cfg.backendUrl || !cfg.backendToken || !cfg.operatorExt) {
    setRegStatus(null, 'Не настроено — укажите сервер, ключ и extension');
    return;
  }

  setRegStatus('connecting', 'Подключение к серверу...');
  connectAmiSocket(cfg);
}

function stopAmiMode() {
  amiRt.backendUp = false;
  amiRt.amiUp = false;
  amiRt.pendingActionId = null;
  amiRt.activeRecordId = null;
  if (amiRt.reconnectTimer) { clearTimeout(amiRt.reconnectTimer); amiRt.reconnectTimer = null; }
  if (amiRt.ws) { try { amiRt.ws.close(); } catch (e) { /* ignore */ } amiRt.ws = null; }
  stopRingtone();
  stopCallTimer();
}

const FORCE_CONNECT_KEY = 'sipOperator.forceConnect';

// Recreating a WebSocket (or a JsSIP UA) in-place, after tearing an earlier
// one down, reliably crashes the WebKit build inside 1C's embedded HTML
// field (a native stack-buffer-overrun deep in WebKit.dll — confirmed via
// Windows error reporting, reproduced every time on a second connect). A
// fresh page load connecting for the "first time" is solid there every
// time, so that's the connect/reconnect path everywhere now: a full reload
// instead of tearing down and rebuilding sockets on the same page. The flag
// makes init() connect immediately after that reload even if "Автоматически
// подключаться" is unchecked, since the user (or the auto-reconnect logic)
// just explicitly asked to connect.
function reconnectViaReload() {
  try { sessionStorage.setItem(FORCE_CONNECT_KEY, '1'); } catch (e) { /* ignore */ }
  location.reload();
}

function connectAmiSocket(cfg) {
  const wsUrl = amiApiUrl(cfg, '/ws').replace(/^http/, 'ws') + '?token=' + encodeURIComponent(cfg.backendToken);
  logDebug('connectAmiSocket -> ' + wsUrl);
  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    logDebug('connectAmiSocket: new WebSocket() threw: ' + e.message);
    setRegStatus('failed', 'Некорректный адрес сервера');
    return;
  }
  amiRt.ws = ws;

  ws.onopen = () => { logDebug('ws OPEN'); amiRt.backendUp = true; };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { logDebug('ws message: bad JSON: ' + e.message); return; }
    logDebug('ws <- ' + msg.type);
    handleAmiMessage(msg, cfg);
  };

  ws.onclose = (ev) => {
    logDebug(`ws CLOSE code=${ev.code} reason=${ev.reason || '(none)'}`);
    // stopAmiMode() nulls amiRt.ws (or a fresh connectAmiSocket() call
    // replaces it) synchronously before this async event fires — if that
    // already happened, this is an intentional/superseded closure, not a
    // real drop, so there's nothing to react to or reconnect from.
    if (amiRt.ws !== ws) return;
    amiRt.ws = null;
    amiRt.backendUp = false;
    amiRt.amiUp = false;
    // Server-backed views can't be trusted anymore once the backend drops —
    // a full reload follows shortly either way (see reconnectViaReload), so
    // this is just about not leaving a stale table/period controls on
    // screen for those few seconds.
    el.historyPeriodRow.classList.add('hidden');
    refreshStatsAndHistory(); // shows the "needs a backend" empty state until this reconnects
    if (currentMode === 'ami') {
      setRegStatus('failed', 'Нет соединения с сервером');
      updateCallButtonEnabled();
    }
    if (!amiRt.reconnectTimer) {
      amiRt.reconnectTimer = setTimeout(() => {
        amiRt.reconnectTimer = null;
        logDebug('Auto-reconnect: reloading page');
        reconnectViaReload();
      }, 5000);
    }
  };

  ws.onerror = () => { logDebug('ws ERROR event'); /* onclose follows; nothing extra to do */ };
}

// Note: this backend WS connection serves two purposes that overlap only
// partially. Populating "Мои звонки" (and thus recording playback) happens
// unconditionally, in both call-control modes — Asterisk sees a call on this
// extension regardless of which transport placed it. Driving the incoming/
// active-call UI panels, on the other hand, only makes sense when this app
// is actually the thing controlling the call, i.e. currentMode === 'ami';
// in WebRTC mode that job belongs to onNewRTCSession/JsSIP instead.
function handleAmiMessage(msg, cfg) {
  switch (msg.type) {
    case 'snapshot': {
      amiRt.backendUp = true;
      amiRt.amiUp = !!msg.amiConnected;
      amiHistory = (msg.records || []).filter((r) => r.operatorExtension === cfg.operatorExt);
      renderStats(amiHistory.map(amiRecordToEntry));

      // First confirmation the backend is actually up in this session —
      // "Мои звонки"/notes/callbacks/contacts only exist server-side (see
      // their own "BackendReady" checks), so pull fresh copies now instead
      // of waiting for their tab to be opened.
      el.historyPeriodRow.classList.toggle('hidden', currentHistoryTab !== 'history');
      if (currentHistoryTab === 'history') loadHistoryPage(false);
      refreshNotes();
      refreshCallbacks();
      refreshSalesStats();
      if (currentHistoryTab === 'contacts') loadContacts(false);

      if (currentMode !== 'ami') break;
      setRegStatus(amiRt.amiUp ? 'registered' : 'failed', amiRt.amiUp ? 'Подключено (AMI)' : 'АТС недоступна');
      const active = amiHistory.find((r) => !r.endedAt);
      if (active) {
        amiRt.activeRecordId = active.id;
        applyAmiRecordToUi(active, cfg);
      }
      updateCallButtonEnabled();
      break;
    }
    case 'ami_status': {
      amiRt.amiUp = !!msg.amiConnected;
      if (currentMode !== 'ami') break;
      setRegStatus(amiRt.amiUp ? 'registered' : 'failed', amiRt.amiUp ? 'Подключено (AMI)' : 'АТС недоступна');
      updateCallButtonEnabled();
      break;
    }
    case 'update': {
      if (msg.record.operatorExtension !== cfg.operatorExt) return;
      const isNewToUs = !amiHistory.some((r) => r.id === msg.record.id);
      upsertAmiHistory(msg.record);
      if (currentMode !== 'ami') break;
      if (amiRt.pendingActionId && msg.record.actionId === amiRt.pendingActionId) {
        amiRt.activeRecordId = msg.record.id;
      }
      // A live call we've never seen before and aren't already on: take it
      // over as the active one, same as an 'incoming' message would. Covers
      // calls this PBX hands us already answered with no distinct "ringing"
      // step at all (see call-store.js) — those never get an 'incoming'
      // message, only straight to 'update', so without this the call just
      // updates quietly in the history list with no on-screen indication.
      if (!amiRt.activeRecordId && isNewToUs && !msg.record.endedAt) {
        amiRt.activeRecordId = msg.record.id;
      }
      if (amiRt.activeRecordId === msg.record.id) applyAmiRecordToUi(msg.record, cfg);
      break;
    }
    case 'incoming': {
      if (msg.record.operatorExtension !== cfg.operatorExt) return;
      upsertAmiHistory(msg.record);
      if (currentMode !== 'ami') break;
      if (amiRt.activeRecordId) break; // already on a call — matches the "one call at a time" WebRTC behaviour
      amiRt.activeRecordId = msg.record.id;
      applyAmiRecordToUi(msg.record, cfg);
      break;
    }
    // Pushed by the server the moment an external system confirms a
    // booking (POST /api/call/:id/booking) — refreshes the history tag.
    case 'booking': {
      if (msg.operatorExtension !== cfg.operatorExt) break;
      debouncedHistoryRefresh();
      break;
    }
    // The backend re-read operator sales from 1C and something changed.
    case 'sales': {
      refreshSalesStats();
      break;
    }
  }
}

function applyAmiRecordToUi(record, cfg) {
  if (record.endedAt) {
    finalizeAmiRecord(record);
    return;
  }

  if (record.direction === 'incoming' && record.state === 'ringing_operator') {
    showIncomingCallAmi(record);
    return;
  }

  showActiveCallAmi(record, cfg);
}

/* -------------------------------------------------------------------- */
/* JS -> 1C event bridge. 1C's HTML field can't subscribe to arbitrary   */
/* JS events, but it does get its own ПриНажатии (OnClick) with the      */
/* clicked element in ДанныеСобытия — so "sending an event to 1C" means  */
/* stamping the details onto a hidden button (see index.html) and        */
/* clicking it programmatically. Outside 1C the click just lands on a    */
/* display:none button nobody listens to — a no-op.                      */
/* -------------------------------------------------------------------- */
let lastBridgeEventKey = null;

function notify1C(eventName, record) {
  // The same call can re-enter showIncomingCallAmi on every state update
  // while it keeps ringing — 1C only needs to hear about it once.
  const key = eventName + ':' + (record.id || '');
  if (lastBridgeEventKey === key) return;
  lastBridgeEventKey = key;

  const bridge = el.oneCEventBridge;
  bridge.setAttribute('data-event', eventName);
  bridge.setAttribute('data-call-id', record.id || '');
  bridge.setAttribute('data-number', (record.counterparty && record.counterparty.number) || '');
  bridge.setAttribute('data-name', (record.counterparty && record.counterparty.name) || '');
  // The client's code from the contact book (see _emitUpdate in
  // call-store.js) — empty when this number isn't a known contact yet.
  bridge.setAttribute('data-contact-code', record.contactCode || '');
  bridge.setAttribute('data-contact-id', record.contactId || '');
  try { bridge.click(); } catch (e) { /* ignore */ }
  logDebug(`1C bridge: ${eventName} number=${(record.counterparty && record.counterparty.number) || ''}`);
}

function showIncomingCallAmi(record) {
  notify1C('incoming', record);
  stopRingtone();
  el.incomingNumber.textContent = record.counterparty.number || '—';
  el.incomingName.textContent = record.counterparty.name || '';
  el.incomingHint.classList.remove('hidden');
  el.acceptBtn.classList.add('hidden');
  el.incomingCall.classList.remove('hidden');
  el.activeCall.classList.add('hidden');
  el.dialForm.classList.add('hidden');
  el.dialActions.classList.add('hidden');
  refreshKeypadVisibility();
  startRingtone(INCOMING_PATTERN);
}

const AMI_STATE_LABELS = {
  ringing_operator: 'Звоним на ваш телефон...',
  ringing_destination: 'Соединяем с абонентом...',
  answered: 'В разговоре',
  operator_no_answer: 'Вы не подняли трубку',
  failed: 'Звонок не состоялся',
};

function showActiveCallAmi(record, cfg) {
  hideIncomingCall();
  el.activeNumber.textContent = record.counterparty.number || '—';
  el.activeCall.classList.remove('hidden');
  el.dialForm.classList.add('hidden');
  el.dialActions.classList.add('hidden');
  el.muteBtn.classList.remove('active');
  el.holdBtn.classList.remove('active');
  el.muteBtn.disabled = true;
  el.holdBtn.disabled = true;
  el.muteBtn.title = 'Доступно только в WebRTC-режиме';
  el.holdBtn.title = 'Доступно только в WebRTC-режиме';
  el.transferBtn.disabled = false;
  el.conferenceBtn.disabled = false;
  el.transferBtn.title = 'Перевести звонок на другой номер';
  el.conferenceBtn.title = 'Добавить номер в разговор';
  setActiveCallState(AMI_STATE_LABELS[record.state] || record.state);
  keypadMode = 'dtmf';
  refreshKeypadVisibility();

  if (record.state === 'answered' && record.answeredAt) {
    callConfirmedAt = record.answeredAt;
    stopRingtone();
    startCallTimer();
    maybePromptOutcomeOnAnswer(record);
  } else if (record.state === 'ringing_destination') {
    startRingtone(RINGBACK_PATTERN);
  }
}

// The outcome picker opens the moment the conversation actually starts (not
// after it ends) — per explicit request. Records can arrive as multiple
// 'update' events while already answered (other fields changing), so guard
// against popping it more than once for the same call.
let outcomePromptedForId = null;

function maybePromptOutcomeOnAnswer(record) {
  if (outcomePromptedForId === record.id) return;
  outcomePromptedForId = record.id;
  promptCallOutcome({
    id: record.id,
    direction: record.direction,
    number: record.counterparty.number,
    name: record.counterparty.name,
    startedAt: record.startedAt,
    contactId: record.contactId || null,
  });
}

function finalizeAmiRecord(record) {
  // Call over: the backend re-reads sales from 1C shortly and pushes a
  // "sales" message; read the current cache right away as well.
  if (amiRt.activeRecordId === record.id) refreshSalesStats();
  stopRingtone();
  stopCallTimer();
  hideIncomingCall();
  hideActiveCall();
  if (amiRt.activeRecordId === record.id) {
    amiRt.activeRecordId = null;
    amiRt.pendingActionId = null;
    callConfirmedAt = null;
  }
  updateCallButtonEnabled();
}

function placeCallAmi(cfg) {
  logDebug(`placeCallAmi: click received, dialInput="${el.dialInput.value}"`);
  const displayNumber = el.dialInput.value.trim();
  if (!displayNumber) { logDebug('placeCallAmi: empty number, aborting'); return; }
  // The dial input is formatted with spaces for readability ("90 601 03
  // 31") — strip them back out for the actual dial target, which the
  // backend validates as digits/+/*/# only (see DIAL_TARGET_RE server-side).
  const to = displayNumber.replace(/\s+/g, '');

  el.dialInput.value = '';
  updateCallButtonEnabled();

  amiRt.pendingActionId = null;
  el.activeNumber.textContent = displayNumber;
  el.activeCall.classList.remove('hidden');
  el.dialForm.classList.add('hidden');
  el.dialActions.classList.add('hidden');
  setActiveCallState(`Звоним на ваш телефон (${cfg.operatorExt})...`);
  keypadMode = 'dtmf';
  refreshKeypadVisibility();
  startRingtone(RINGBACK_PATTERN);

  logDebug(`placeCallAmi: POST /api/call from=${cfg.operatorExt} to=${to}`);
  amiFetch(cfg, '/api/call', {
    method: 'POST',
    body: JSON.stringify({ from: cfg.operatorExt, to }),
  }).then((data) => {
    logDebug('placeCallAmi: queued OK, actionId=' + data.actionId);
    amiRt.pendingActionId = data.actionId;
  }).catch((err) => {
    logDebug('placeCallAmi: FAILED: ' + err.message);
    stopRingtone();
    hideActiveCall();
    showToast('Не удалось начать вызов: ' + err.message, { error: true });
  });
}

function hangupAmiCall(cfg) {
  const id = amiRt.activeRecordId || amiRt.pendingActionId;
  logDebug('hangupAmiCall: click received, id=' + id);
  if (!id) {
    // Panel is showing but there is no call behind it — just close it.
    logDebug('hangupAmiCall: no active call id, resetting the call panel');
    resetAmiCallUi(null);
    return;
  }
  amiFetch(cfg, `/api/call/${encodeURIComponent(id)}/hangup`, { method: 'POST' })
    .then((data) => {
      logDebug('hangupAmiCall: OK' + (data && data.alreadyEnded ? ' (call had already ended)' : ''));
      // The server found the call already over (its Hangup event was
      // missed) — no 'update' will ever arrive for it, so reset here.
      if (data && data.alreadyEnded) resetAmiCallUi(id);
    })
    .catch((err) => {
      logDebug('hangupAmiCall: FAILED: ' + err.message);
      // "call not found" = the server no longer knows this call at all, so
      // there is nothing left to hang up: drop the stuck panel instead of
      // leaving the operator unable to get out of "В разговоре".
      if (/call not found/i.test(err.message)) {
        resetAmiCallUi(id);
        return;
      }
      showToast('Не удалось завершить звонок: ' + err.message, { error: true });
    });
}

// Clears the active/incoming call panels for a call the server says is over
// (same end state as finalizeAmiRecord, without needing its record).
function resetAmiCallUi(id) {
  finalizeAmiRecord({ id: amiRt.activeRecordId || id, endedAt: Date.now() });
  amiRt.activeRecordId = null;
  amiRt.pendingActionId = null;
  callConfirmedAt = null;
  updateCallButtonEnabled();
}

function sendAmiDtmf(cfg, digit) {
  const id = amiRt.activeRecordId;
  if (!id) return;
  amiFetch(cfg, `/api/call/${encodeURIComponent(id)}/dtmf`, {
    method: 'POST',
    body: JSON.stringify({ digit }),
  }).catch(() => { /* best-effort */ });
}

/* -------------------- Incoming/outgoing session handling -------------------- */

function onNewRTCSession(data) {
  const session = data.session;

  // Only handle one call at a time in this operator console.
  if (currentSession) {
    if (session.direction === 'incoming') {
      session.terminate({ status_code: 486, reason_phrase: 'Busy Here' });
    }
    return;
  }

  currentSession = session;
  session._meta = {
    direction: session.direction,
    startedAt: Date.now(),
    number: shortUri(session.remote_identity && session.remote_identity.uri),
    name: (session.remote_identity && session.remote_identity.display_name) || '',
    confirmed: false,
    declinedByUser: false,
  };

  attachSessionAudio(session);

  session.on('progress', () => {
    if (session.direction === 'outgoing') {
      setActiveCallState('Вызов...');
      startRingtone(RINGBACK_PATTERN);
    }
  });

  session.on('accepted', () => {
    setActiveCallState('Соединение...');
  });

  session.on('confirmed', () => {
    session._meta.confirmed = true;
    callConfirmedAt = Date.now();
    stopRingtone();
    setActiveCallState('В разговоре');
    startCallTimer();
    promptCallOutcome({
      direction: session._meta.direction,
      number: session._meta.number,
      name: session._meta.name,
      startedAt: session._meta.startedAt,
    });
  });

  session.on('failed', (e) => endSession(session, e.cause));
  session.on('ended', (e) => endSession(session, e.cause));

  session.on('peerconnection', (e) => {
    const pc = e.peerconnection;
    pc.addEventListener('track', (ev) => {
      if (ev.streams && ev.streams[0]) {
        el.remoteAudio.srcObject = ev.streams[0];
      }
    });
  });

  if (session.direction === 'incoming') {
    showIncomingCall(session);
  } else {
    showActiveCall(session);
  }
}

function getMediaOptions() {
  const cfg = loadConfig() || {};
  const iceServers = buildIceServers(cfg);
  return {
    mediaConstraints: { audio: true, video: false },
    pcConfig: iceServers ? { iceServers } : {},
  };
}

function attachSessionAudio() {
  el.remoteAudio.autoplay = true;
}

/* -------------------- UI: incoming call -------------------- */

function showIncomingCall(session) {
  el.incomingNumber.textContent = session._meta.number;
  el.incomingName.textContent = session._meta.name || '';
  el.incomingHint.classList.add('hidden');
  el.acceptBtn.classList.remove('hidden');
  el.incomingCall.classList.remove('hidden');
  el.dialForm.classList.add('hidden');
  el.dialActions.classList.add('hidden');
  refreshKeypadVisibility();
  startRingtone(INCOMING_PATTERN);
}

function hideIncomingCall() {
  el.incomingCall.classList.add('hidden');
  stopRingtone();
}

el.acceptBtn.addEventListener('click', () => {
  if (currentMode === 'ami') return; // hidden in this mode — answering happens on the physical phone
  if (!currentSession) return;
  hideIncomingCall();
  showActiveCall(currentSession);
  currentSession.answer(getMediaOptions());
});

el.declineBtn.addEventListener('click', () => {
  if (currentMode === 'ami') {
    const cfg = loadConfig();
    if (cfg) hangupAmiCall(cfg);
    return;
  }
  if (!currentSession) return;
  currentSession._meta.declinedByUser = true;
  currentSession.terminate({ status_code: 486, reason_phrase: 'Busy Here' });
});

/* -------------------- UI: active call -------------------- */

function showActiveCall(session) {
  el.activeNumber.textContent = session._meta.number;
  el.activeCall.classList.remove('hidden');
  el.dialForm.classList.add('hidden');
  el.dialActions.classList.add('hidden');
  el.muteBtn.classList.remove('active');
  el.holdBtn.classList.remove('active');
  el.muteBtn.disabled = false;
  el.holdBtn.disabled = false;
  el.muteBtn.title = 'Микрофон';
  el.holdBtn.title = 'Удержание';
  el.transferBtn.disabled = true;
  el.conferenceBtn.disabled = true;
  el.transferBtn.title = 'Доступно только в AMI-режиме';
  el.conferenceBtn.title = 'Доступно только в AMI-режиме';
  el.keypadToggleBtn.classList.remove('active');
  setActiveCallState(session.direction === 'outgoing' ? 'Вызов...' : 'Входящий...');
  el.activeTimer.textContent = '00:00';
  keypadMode = 'dtmf';
  refreshKeypadVisibility();
}

// The on-screen keypad is shared: while idle it's always shown for dialing;
// during a call it's hidden unless the operator toggles "Клавиатура" on
// (which switches key presses to sendDTMF instead of editing the dial input).
// Driven off the visible call panels (not `currentSession`) so it behaves
// the same in AMI mode, which has no local media session at all.
function refreshKeypadVisibility() {
  const callActive = !el.activeCall.classList.contains('hidden');
  const callIncoming = !el.incomingCall.classList.contains('hidden');
  if (callActive) {
    el.keypad.classList.toggle('hidden', !el.keypadToggleBtn.classList.contains('active'));
  } else if (callIncoming) {
    el.keypad.classList.add('hidden');
  } else {
    el.keypad.classList.remove('hidden');
  }
}

function setActiveCallState(text) {
  el.activeState.textContent = text;
}

function startCallTimer() {
  stopCallTimer();
  callTimerInterval = setInterval(() => {
    if (!callConfirmedAt) return;
    const secs = (Date.now() - callConfirmedAt) / 1000;
    el.activeTimer.textContent = formatDuration(secs);
  }, 1000);
}

function stopCallTimer() {
  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }
}

function hideActiveCall() {
  el.activeCall.classList.add('hidden');
  el.dialForm.classList.remove('hidden');
  el.dialActions.classList.remove('hidden');
  el.keypadToggleBtn.classList.remove('active');
  el.transferRow.classList.add('hidden');
  el.transferNumberInput.value = '';
  el.conferenceRow.classList.add('hidden');
  el.conferenceNumberInput.value = '';
  stopCallTimer();
  keypadMode = 'dial';
  refreshKeypadVisibility();
}

el.hangupBtn.addEventListener('click', () => {
  logDebug('hangupBtn clicked, currentMode=' + currentMode);
  if (currentMode === 'ami') {
    const cfg = loadConfig();
    if (!cfg) { logDebug('hangupBtn: loadConfig() returned null'); return; }
    hangupAmiCall(cfg);
    return;
  }
  if (currentSession) {
    try { currentSession.terminate(); } catch (e) { /* ignore */ }
  }
});

el.muteBtn.addEventListener('click', () => {
  if (currentMode === 'ami') return; // no local media session to mute in this mode
  if (!currentSession) return;
  const muted = currentSession.isMuted && currentSession.isMuted().audio;
  if (muted) {
    currentSession.unmute({ audio: true });
    el.muteBtn.classList.remove('active');
  } else {
    currentSession.mute({ audio: true });
    el.muteBtn.classList.add('active');
  }
});

el.holdBtn.addEventListener('click', () => {
  if (currentMode === 'ami') return; // no local media session to hold in this mode
  if (!currentSession) return;
  const onHold = currentSession.isOnHold && currentSession.isOnHold().local;
  if (onHold) {
    currentSession.unhold();
    el.holdBtn.classList.remove('active');
    setActiveCallState('В разговоре');
  } else {
    currentSession.hold();
    el.holdBtn.classList.add('active');
    setActiveCallState('На удержании');
  }
});

el.keypadToggleBtn.addEventListener('click', () => {
  el.keypadToggleBtn.classList.toggle('active');
  refreshKeypadVisibility();
});

/* -------------------- Transfer / conference (AMI mode only) -------------------- */
// Both need a channel Asterisk is actively holding for us, which we only
// have a live reference to while AMI is the one driving the call.

function currentAmiCallId() {
  return amiRt.activeRecordId || amiRt.pendingActionId;
}

el.transferBtn.addEventListener('click', () => {
  el.conferenceRow.classList.add('hidden');
  el.transferRow.classList.toggle('hidden');
  if (!el.transferRow.classList.contains('hidden')) el.transferNumberInput.focus();
});

el.transferCancelBtn.addEventListener('click', () => {
  el.transferRow.classList.add('hidden');
  el.transferNumberInput.value = '';
});

el.transferConfirmBtn.addEventListener('click', () => {
  const to = el.transferNumberInput.value.trim();
  if (!to) return;
  const cfg = loadConfig();
  const id = currentAmiCallId();
  if (!cfg || !id) { showToast('Нет активного звонка для перевода', { error: true }); return; }

  logDebug(`transfer -> id=${id} to=${to}`);
  amiFetch(cfg, `/api/call/${encodeURIComponent(id)}/transfer`, {
    method: 'POST',
    body: JSON.stringify({ to }),
  }).then(() => {
    showToast(`Звонок переведён на ${to}`);
    el.transferRow.classList.add('hidden');
    el.transferNumberInput.value = '';
  }).catch((err) => {
    logDebug('transfer FAILED: ' + err.message);
    showToast('Не удалось перевести звонок: ' + err.message, { error: true });
  });
});

el.conferenceBtn.addEventListener('click', () => {
  el.transferRow.classList.add('hidden');
  el.conferenceRow.classList.toggle('hidden');
  if (!el.conferenceRow.classList.contains('hidden')) el.conferenceNumberInput.focus();
});

el.conferenceCancelBtn.addEventListener('click', () => {
  el.conferenceRow.classList.add('hidden');
  el.conferenceNumberInput.value = '';
});

el.conferenceConfirmBtn.addEventListener('click', () => {
  const to = el.conferenceNumberInput.value.trim();
  if (!to) return;
  const cfg = loadConfig();
  const id = currentAmiCallId();
  if (!cfg || !id) { showToast('Нет активного звонка для конференции', { error: true }); return; }

  logDebug(`conference -> id=${id} to=${to}`);
  amiFetch(cfg, `/api/call/${encodeURIComponent(id)}/conference`, {
    method: 'POST',
    body: JSON.stringify({ to }),
  }).then(() => {
    showToast(`Набираем ${to} для добавления в разговор...`);
    el.conferenceRow.classList.add('hidden');
    el.conferenceNumberInput.value = '';
  }).catch((err) => {
    logDebug('conference FAILED: ' + err.message);
    showToast('Не удалось добавить номер в конференцию: ' + err.message, { error: true });
  });
});

/* -------------------- Ending a call / logging history -------------------- */

function endSession(session, cause) {
  if (session._meta.logged) return;
  session._meta.logged = true;

  stopRingtone();
  stopCallTimer();

  // Nothing to log locally anymore (history lives in SQLite server-side) —
  // a WebRTC call with no AMI backend connected in parallel has no server-side record to
  // attach to, so it just won't appear in "Мои звонки" at all. With a
  // backend connected, Asterisk already sees this call via AMI regardless
  // of this WebRTC leg, and that's the copy that shows up there.

  if (currentSession === session) {
    currentSession = null;
    callConfirmedAt = null;
    hideIncomingCall();
    hideActiveCall();
    el.remoteAudio.srcObject = null;
  }
  updateCallButtonEnabled();
}

/* -------------------- Dialing / DTMF keypad -------------------- */

el.keypad.addEventListener('click', (e) => {
  const btn = e.target.closest('.key');
  if (!btn) return;
  const digit = btn.dataset.key;
  playDtmfTone(digit);

  if (keypadMode === 'dtmf' && currentMode === 'ami' && amiRt.activeRecordId) {
    sendAmiDtmf(loadConfig(), digit);
  } else if (currentSession && keypadMode === 'dtmf') {
    try { currentSession.sendDTMF(digit); } catch (err) { /* ignore */ }
  } else {
    el.dialInput.value += digit;
    reformatPhoneInput(el.dialInput);
    updateCallButtonEnabled();
  }
});

el.clearInputBtn.addEventListener('click', () => {
  el.dialInput.value = '';
  updateCallButtonEnabled();
});

el.dialInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !el.callBtn.disabled) placeCall();
});

el.callBtn.addEventListener('click', placeCall);

// Some embedded browser shells (e.g. 1C's HTML field on Windows) have no
// RTCPeerConnection/getUserMedia at all — JsSIP.call() there fails with a
// generic "WebRTC not supported", which reads like a bug report rather than
// "you're in the wrong mode". Check for it explicitly so the message is
// actionable, and check it before ever trying to register too.
function isWebRtcSupported() {
  return !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

function placeCall() {
  logDebug('callBtn clicked, currentMode=' + currentMode);
  const cfg = loadConfig();
  if (!cfg) { logDebug('placeCall: loadConfig() returned null'); return; }

  if (currentMode === 'ami') {
    placeCallAmi(cfg);
    return;
  }

  if (!isWebRtcSupported()) {
    showToast('Этот браузер/встроенный движок не поддерживает WebRTC. Откройте настройки и переключите «Режим работы» на «Через сервер (AMI)».', { error: true });
    return;
  }

  if (!ua) return;
  const target = normalizeSipUri(el.dialInput.value, cfg);
  if (!target) return;

  try { ensureAudioCtx(); } catch (e) { /* ignore */ }

  const options = getMediaOptions();
  try {
    ua.call(target, options);
  } catch (e) {
    showToast('Не удалось начать вызов: ' + e.message, { error: true });
    return;
  }
  el.dialInput.value = '';
  updateCallButtonEnabled();
}

/* -------------------------------------------------------------------- */
/* Settings modal                                                        */
/* -------------------------------------------------------------------- */

const MODE_HINTS = {
  ami: 'Звонок инициируется через backend (AMI): Asterisk сам звонит на ваш SIP-телефон, затем соединяет с абонентом. Работает уже сейчас, без изменений на Asterisk.',
  webrtc: 'Прямой звонок в браузере по WebSocket/WebRTC. Требует, чтобы на Asterisk был включён ws/wss-транспорт и WebRTC для вашего добавочного номера.',
};

function refreshModeFieldsVisibility() {
  const mode = el.cfgMode.value;
  el.amiFields.classList.toggle('hidden', mode !== 'ami');
  el.webrtcFields.classList.toggle('hidden', mode !== 'webrtc');
  el.modeHint.textContent = MODE_HINTS[mode] || '';
}

el.cfgMode.addEventListener('change', refreshModeFieldsVisibility);

function openSettings() {
  const cfg = loadConfig() || {};

  // Guard against ever picking WebRTC where it can't work at all (e.g. 1C's
  // embedded HTML field) — disable the option, and if a stale config from a
  // different environment left "webrtc" saved, show AMI instead so hitting
  // Save corrects it rather than repeating the same confusing failure.
  const webrtcOption = el.cfgMode.querySelector('option[value="webrtc"]');
  const webrtcOk = isWebRtcSupported();
  let savedMode = cfg.mode || (cfg.wsServer && cfg.sipUri ? 'webrtc' : 'ami');
  if (!webrtcOk) {
    if (webrtcOption) {
      webrtcOption.disabled = true;
      webrtcOption.textContent = 'WebRTC в браузере (не поддерживается этим браузером/движком)';
    }
    if (savedMode === 'webrtc') savedMode = 'ami';
  }
  el.cfgMode.value = savedMode;
  el.cfgBackendUrl.value = cfg.backendUrl || 'http://localhost:3001';
  el.cfgBackendToken.value = cfg.backendToken || '';
  el.cfgOperatorExt.value = cfg.operatorExt || '';
  el.cfgWsServer.value = cfg.wsServer || '';
  el.cfgSipUri.value = cfg.sipUri || '';
  el.cfgPassword.value = cfg.password || '';
  el.cfgDisplayName.value = cfg.displayName || '';
  el.cfgIceServers.value = cfg.iceServers || '';
  el.cfgTurnUser.value = cfg.turnUser || '';
  el.cfgTurnPass.value = cfg.turnPass || '';
  el.cfgAutoRegister.checked = cfg.autoRegister !== false;
  refreshModeFieldsVisibility();
  el.settingsModal.classList.remove('hidden');
}

function closeSettings() {
  el.settingsModal.classList.add('hidden');
}

el.settingsBtn.addEventListener('click', openSettings);
el.cfgCancelBtn.addEventListener('click', closeSettings);

el.settingsModal.addEventListener('click', (e) => {
  const toggleBtn = e.target.closest('.toggle-visibility-btn');
  if (toggleBtn) {
    const input = document.getElementById(toggleBtn.dataset.target);
    if (!input) return;
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    toggleBtn.textContent = showing ? 'Показать' : 'Скрыть';
    toggleBtn.title = showing ? 'Показать' : 'Скрыть';
  }
});

el.cfgSaveBtn.addEventListener('click', () => {
  const mode = el.cfgMode.value;
  const cfg = {
    mode,
    backendUrl: el.cfgBackendUrl.value.trim(),
    backendToken: el.cfgBackendToken.value,
    operatorExt: el.cfgOperatorExt.value.trim(),
    wsServer: el.cfgWsServer.value.trim(),
    sipUri: el.cfgSipUri.value.trim(),
    password: el.cfgPassword.value,
    displayName: el.cfgDisplayName.value.trim(),
    iceServers: el.cfgIceServers.value.trim(),
    turnUser: el.cfgTurnUser.value.trim(),
    turnPass: el.cfgTurnPass.value,
    autoRegister: el.cfgAutoRegister.checked,
  };

  if (mode === 'ami') {
    if (!cfg.backendUrl || !cfg.backendToken || !cfg.operatorExt) {
      showToast('Заполните адрес сервера, API-ключ и ваш добавочный номер.', { error: true });
      return;
    }
  } else if (!cfg.wsServer || !cfg.sipUri || !cfg.password) {
    showToast('Заполните адрес сервера, SIP URI и пароль.', { error: true });
    return;
  }

  saveConfig(cfg);
  closeSettings();
  // See reconnectViaReload(): always reload rather than connecting in-place
  // here, so "first connect" and "reconnect after changing settings" are
  // the exact same code path — the only one confirmed stable in 1C's
  // embedded WebKit.
  reconnectViaReload();
});

el.cfgDisconnectBtn.addEventListener('click', () => {
  stopUA();
  stopAmiMode();
  currentMode = 'webrtc';
  setRegStatus(null, 'Не настроено');
  closeSettings();
  updateCallButtonEnabled();
});

/* -------------------------------------------------------------------- */
/* Init                                                                   */
/* -------------------------------------------------------------------- */

function init() {
  refreshStatsAndHistory();
  refreshSalesStats();
  updateCallButtonEnabled();
  refreshKeypadVisibility();
  updateCallbackBadge();
  updateNoteBadge();

  const urlCfg = configFromUrlParams();
  if (urlCfg) {
    saveConfig(Object.assign({}, loadConfig() || {}, urlCfg));
    const setKeys = Object.keys(urlCfg).filter((k) => !URL_CONFIG_SECRET_FIELDS.includes(k));
    logDebug('Config applied from URL query params: ' + setKeys.join(', '));
  }

  const cfg = loadConfig();
  const mode = cfg ? (cfg.mode || (cfg.wsServer && cfg.sipUri ? 'webrtc' : 'ami')) : null;

  // Set by reconnectViaReload() right before a reload triggered by "Сохранить
  // и подключиться" or by the auto-reconnect logic — either way, connecting
  // was just explicitly requested, so honor that even if "Автоматически
  // подключаться" happens to be unchecked. Config supplied via URL params
  // (see above) is the same kind of explicit request to connect right now.
  let forceConnect = !!urlCfg;
  try {
    if (sessionStorage.getItem(FORCE_CONNECT_KEY) === '1') forceConnect = true;
    sessionStorage.removeItem(FORCE_CONNECT_KEY);
  } catch (e) { /* ignore */ }
  const shouldConnect = !!cfg && (forceConnect || cfg.autoRegister !== false);

  if (mode === 'webrtc') {
    if (!window.JsSIP) {
      setRegStatus('failed', 'Библиотека JsSIP не загружена');
      el.audioHint.textContent = 'Ошибка: не найден vendor/jssip.bundle.min.js';
      return;
    }
    if (!navigator.mediaDevices || !window.RTCPeerConnection) {
      el.audioHint.textContent = 'Внимание: страница должна открываться по HTTPS или с localhost для доступа к микрофону.';
    }
  }

  if (shouldConnect && mode === 'ami' && cfg.backendUrl && cfg.backendToken && cfg.operatorExt) {
    currentMode = 'ami';
    startAmiMode(cfg);
  } else if (shouldConnect && mode === 'webrtc' && cfg.wsServer && cfg.sipUri) {
    currentMode = 'webrtc';
    startUA(cfg);
  } else {
    setRegStatus(null, 'Не настроено — откройте настройки');
    if (!cfg) openSettings();
  }
}

init();
