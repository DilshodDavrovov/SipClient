'use strict';
/**
 * Operator sales from 1C — the "Продажи за день" / "Продажи за месяц" tiles
 * in the operator window.
 *
 * The source of truth is 1C itself: GET <bot_api>/get_operator_sales returns
 * per-operator totals built from the rows of РеализацияТоваров.Товары (one
 * booking can be assembled by several operators, so amounts are split by the
 * row's "Оператор"). Operators are keyed by Пользователи.ВнутреннийНомерОператора,
 * i.e. the SIP extension. See HTTPServices/bot_api in the 1C configuration
 * for the exact counting rules.
 *
 * Refreshed every SALES_SYNC_INTERVAL_MS (default 60s) and shortly after any
 * call ends (refreshSoon) — the operator usually saves the booking right
 * after hanging up. Results are cached in memory; the browser reads the
 * cache (GET /api/sales/stats) and is pushed a WS "sales" message whenever
 * the numbers change.
 */
const { delatinizeUrl } = require('./contacts-sync-1c');

function initOperatorSales({ url, login = '', password = '', intervalMs = 60000, timeoutMs = 20000, onChange = () => {}, log = console }) {
  url = delatinizeUrl(url);
  const basicHeader = login ? 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64') : '';

  const state = {
    url,
    enabled: !!url,
    running: false,
    date: null,        // 1C report date, "YYYYMMDD"
    generatedAt: null, // 1C-side timestamp of the numbers
    fetchedAt: null,   // when we last got a good answer (epoch ms)
    lastError: null,
    byExtension: {},   // "302" -> { dayAmount, dayCount, monthAmount, monthCount, users: [...] }
  };
  let lastSignature = '';
  let timer = null;
  let soonTimer = null;

  async function fetchSales() {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers = {};
      if (basicHeader) headers.Authorization = basicHeader;
      const res = await fetch(url, { headers, signal: ctrl.signal });
      const text = await res.text();
      if (!res.ok) throw new Error('HTTP ' + res.status + (text ? ' — ' + text.slice(0, 300) : ''));
      let data;
      try { data = JSON.parse(text); } catch (e) { throw new Error('non-JSON reply: ' + text.slice(0, 200)); }
      if (!data || data.success !== true || !Array.isArray(data.operators)) {
        throw new Error('unexpected 1C payload: ' + text.slice(0, 200));
      }
      return data;
    } finally {
      clearTimeout(t);
    }
  }

  async function refresh(reason = 'periodic') {
    if (!state.enabled || state.running) return state;
    state.running = true;
    try {
      const data = await fetchSales();
      // Several 1C users can share one extension (e.g. a workplace used by
      // two people) — their sales add up on that extension.
      const byExt = {};
      for (const row of data.operators) {
        const ext = String(row.extension || '').trim();
        if (!ext) continue;
        const acc = byExt[ext] || (byExt[ext] = { dayAmount: 0, dayCount: 0, monthAmount: 0, monthCount: 0, users: [] });
        acc.dayAmount += Number(row.dayAmount) || 0;
        acc.dayCount += Number(row.dayCount) || 0;
        acc.monthAmount += Number(row.monthAmount) || 0;
        acc.monthCount += Number(row.monthCount) || 0;
        if (row.user) acc.users.push(String(row.user));
      }
      state.byExtension = byExt;
      state.date = data.date || null;
      state.generatedAt = data.generatedAt || null;
      state.fetchedAt = Date.now();
      if (state.lastError) log.log('[sales-1c] 1C is reachable again');
      state.lastError = null;
      const signature = JSON.stringify([state.date, byExt]);
      if (signature !== lastSignature) {
        lastSignature = signature;
        try { onChange(state); } catch (e) { /* listener errors are not ours */ }
      }
    } catch (err) {
      // Logged once per distinct error, not every minute while 1C is down
      // (or before the method is loaded into the 1C database).
      if (err.message !== state.lastError) log.error(`[sales-1c] refresh (${reason}) failed:`, err.message);
      state.lastError = err.message;
    } finally {
      state.running = false;
    }
    return state;
  }

  // Debounced: a burst of hangups (or a reconcile closing many calls at
  // once) costs one 1C request, not one per call.
  function refreshSoon(delayMs = 15000) {
    if (!state.enabled || soonTimer) return;
    soonTimer = setTimeout(() => { soonTimer = null; refresh('call ended'); }, delayMs);
  }

  function statsFor(extension) {
    const ext = String(extension || '').trim();
    const row = state.byExtension[ext] || { dayAmount: 0, dayCount: 0, monthAmount: 0, monthCount: 0, users: [] };
    return {
      extension: ext,
      day: { amount: Math.round(row.dayAmount * 100) / 100, count: row.dayCount },
      month: { amount: Math.round(row.monthAmount * 100) / 100, count: row.monthCount },
      users: row.users,
      date: state.date,
      updatedAt: state.fetchedAt,
      error: state.lastError,
      enabled: state.enabled,
    };
  }

  function start() {
    if (!state.enabled) {
      log.warn('[sales-1c] no 1C URL configured — sales tiles disabled (set ONEC_SALES_URL or ONEC_URL)');
      return;
    }
    log.log(`[sales-1c] polling ${url} every ${Math.round(intervalMs / 1000)}s`);
    refresh('startup');
    timer = setInterval(() => refresh('periodic'), intervalMs);
  }

  function stop() {
    if (timer) clearInterval(timer);
    if (soonTimer) clearTimeout(soonTimer);
    timer = soonTimer = null;
  }

  return { start, stop, refresh, refreshSoon, statsFor, getStatus: () => state };
}

// ONEC_SALES_URL wins; otherwise the method sits next to the contacts sync
// method in the same bot_api service: ".../hs/bot_api/get_counterparties"
// -> ".../hs/bot_api/get_operator_sales".
function resolveSalesUrl(salesUrl, contactsUrl) {
  if (salesUrl) return salesUrl;
  if (!contactsUrl) return '';
  return String(contactsUrl).replace(/\/[^/?#]*([?#].*)?$/, '/get_operator_sales');
}

module.exports = { initOperatorSales, resolveSalesUrl };
