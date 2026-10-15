'use strict';

/**
 * 1C contact sync — replaces the manual Excel upload.
 *
 * Every SYNC_INTERVAL_MS (default 60s) this polls the 1C HTTP service once
 * per region that has an `oblast_1c` set, and upserts the counterparties it
 * returns into the contacts table, tagging each with that region_id. From
 * then on inbound CLID routing (regions.resolveInbound) finds the caller's
 * region automatically — no file import, no manual step.
 *
 * 1C request (per region):
 *   POST <ONEC_URL>
 *   Header:  Exchange: Exchanger
 *   Body:    {"Region": "<oblast_1c>"}       e.g. {"Region":"АНДИЖАН"}
 *
 * 1C response:
 *   { "success": true, "result": [
 *       { "Наименование": "...", "Телефоны": "", "ТелефонДиректора": "",
 *         "ТелефонБухгалтера": "", "ТелефонКонтактногоЛица": "+998916079000",
 *         "Область": "АНДИЖАН" }, ... ] }
 *
 * Phone handling (per the requirement): every phone is reduced to the bare
 * 9-digit subscriber number — "+998", spaces and dashes stripped — e.g.
 * "+998 90-909-07-74" -> "909090774". A counterparty with no usable phone is
 * skipped (it can't be matched to an inbound call anyway).
 */

const { normalizePhone } = require('./db');

// The four phone fields 1C may return, in priority order (the contact-person
// number first — that's who a call is expected from). Reduced to bare 9-digit
// and de-duplicated into contacts.phone1..phone4.
const PHONE_FIELDS = ['ТелефонКонтактногоЛица', 'Телефоны', 'ТелефонДиректора', 'ТелефонБухгалтера'];

// "+998 90-909-07-74" / "998909090774" / "909090774" -> "909090774".
// normalizePhone already strips non-digits and takes the last 9, which drops
// a leading 998 (12 digits -> 9) exactly as required.
function clean9(raw) {
  return normalizePhone(raw); // null when there are no digits
}

function collectPhones(item) {
  const out = [];
  const seen = new Set();
  for (const f of PHONE_FIELDS) {
    const n = clean9(item[f]);
    if (n && n.length >= 7 && !seen.has(n)) { seen.add(n); out.push(n); }
    if (out.length >= 4) break;
  }
  return out;
}

// Cyrillic homoglyph -> Latin, for the URL only. The 1C endpoint path is pure
// ASCII (…/get_counterparties), but it is easy to paste a Cyrillic "с"/"о"/…
// that looks identical; that silently hits the WRONG 1C method and returns
// HTTP 400 "Поле объекта не обнаружено". We fold these back to Latin so the
// URL works regardless of how it was typed.
const CYR2LAT = { 'а':'a','с':'c','е':'e','о':'o','р':'p','х':'x','у':'y','і':'i','ј':'j','ѕ':'s','к':'k','м':'m','н':'h','т':'t','в':'b','А':'A','С':'C','Е':'E','О':'O','Р':'P','Х':'X','У':'Y' };
function delatinizeUrl(u) {
  return String(u || '').replace(/[Ѐ-ӿ]/g, (ch) => CYR2LAT[ch] || ch);
}

function initContactsSync({ db, url, exchangeHeader = '', login = '', password = '', intervalMs = 60000, timeoutMs = 20000, log = console }) {
  const sqlite = db.db;

  // Fix any Cyrillic look-alike letters in the configured URL (see above).
  const cleanUrl = delatinizeUrl(url);
  if (url && cleanUrl !== url) {
    log.log(`[1c-sync] WARNING: URL contained Cyrillic look-alike letters — corrected to ${cleanUrl}`);
  }
  url = cleanUrl;

  // Auth: HTTP Basic (ONEC_LOGIN/ONEC_PASSWORD — login "Exchange", password
  // "Exchanger") is the verified method. The custom header "Exchange:
  // <ONEC_EXCHANGE>" is also sent when ONEC_EXCHANGE is non-empty. Built once.
  const basicHeader = login
    ? 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64')
    : '';

  // Prepared once. We write the bare 9-digit number into BOTH phoneN and
  // phoneN_norm so the stored form is exactly "909090774" (no pretty format),
  // and routing (which matches on phoneN_norm) keeps working unchanged.
  const findByNorm = sqlite.prepare(`
    SELECT id, company_name FROM contacts
    WHERE ? IN (phone1_norm, phone2_norm, phone3_norm, phone4_norm) LIMIT 1
  `);
  const insertContact = sqlite.prepare(`
    INSERT INTO contacts (code, phone1, phone1_norm, phone2, phone2_norm, phone3, phone3_norm, phone4, phone4_norm,
      company_name, region_id, created_at, updated_at)
    VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateContact = sqlite.prepare(`
    UPDATE contacts SET phone1 = ?, phone1_norm = ?, phone2 = ?, phone2_norm = ?, phone3 = ?, phone3_norm = ?,
      phone4 = ?, phone4_norm = ?, company_name = ?, region_id = ?, updated_at = ? WHERE id = ?
  `);
  const listRegions = sqlite.prepare("SELECT id, name, oblast_1c FROM regions WHERE oblast_1c IS NOT NULL AND TRIM(oblast_1c) <> ''");
  // Reconciliation: contacts currently tied to a region, and delete-by-id.
  // Every region-tagged contact comes from this 1C sync (there is no other
  // path that sets region_id), so a contact no longer returned by 1C for its
  // region is stale and gets removed.
  const listRegionContactIds = sqlite.prepare('SELECT id FROM contacts WHERE region_id = ?');
  const deleteContact = sqlite.prepare('DELETE FROM contacts WHERE id = ?');

  const status = {
    running: false,
    lastRunAt: null,
    lastOkAt: null,
    lastError: null,
    intervalMs,
    perRegion: {}, // name -> { fetched, upserted, error, at }
  };

  async function fetchRegion(oblast) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      // charset=utf-8 matters: the body carries Cyrillic region names, and
      // without it 1C can reject the request (HTTP 400).
      const headers = { 'Content-Type': 'application/json; charset=utf-8' };
      if (exchangeHeader) headers.Exchange = exchangeHeader;
      if (basicHeader) headers.Authorization = basicHeader;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ Region: oblast }),
        signal: ctrl.signal,
      });
      // On any non-2xx, surface the body 1C returned — that text is what
      // tells us WHY (bad region name, wrong body key, auth) instead of a
      // bare "HTTP 400".
      const text = await res.text();
      if (!res.ok) throw new Error('HTTP ' + res.status + (text ? ' — ' + text.slice(0, 300) : ''));
      let data;
      try { data = JSON.parse(text); } catch (e) { throw new Error('non-JSON reply: ' + text.slice(0, 200)); }
      if (!data || data.success !== true || !Array.isArray(data.result)) {
        throw new Error('unexpected 1C payload: ' + text.slice(0, 200));
      }
      return data.result;
    } finally {
      clearTimeout(t);
    }
  }

  // Upsert one region's counterparties inside a single transaction.
  // node:sqlite (DatabaseSync) has no .transaction() helper, so BEGIN/COMMIT
  // are issued explicitly — matching how regions.js does its bulk import.
  function upsertRegion(regionId, items) {
    let upserted = 0;
    let deleted = 0;
    const now = Date.now();
    sqlite.prepare('BEGIN').run();
    try {
      // Snapshot the contacts currently tied to this region. Any id NOT seen
      // in this 1C response is stale (client removed from 1C, or moved to a
      // different region) and is deleted at the end — so the contacts table
      // always mirrors 1C's current state for the region.
      const stale = new Set(listRegionContactIds.all(regionId).map((r) => r.id));

      for (const item of items) {
        const phones = collectPhones(item);
        if (!phones.length) continue; // no phone -> useless for routing
        const name = String(item['Наименование'] || '').trim();
        const p = [phones[0] || null, phones[1] || null, phones[2] || null, phones[3] || null];

        // Match an existing contact by ANY of this counterparty's numbers.
        let existing = null;
        for (const ph of phones) {
          existing = findByNorm.get(ph);
          if (existing) break;
        }

        if (existing) {
          const keepName = name || existing.company_name || null;
          updateContact.run(p[0], p[0], p[1], p[1], p[2], p[2], p[3], p[3], keepName, regionId, now, existing.id);
          stale.delete(existing.id); // still present in 1C -> keep
        } else {
          const info = insertContact.run(p[0], p[0], p[1], p[1], p[2], p[2], p[3], p[3], name || null, regionId, now, now);
          if (info && info.lastInsertRowid != null) stale.delete(Number(info.lastInsertRowid));
        }
        upserted++;
      }

      // Whatever is left in `stale` was in this region but is no longer in
      // 1C's list -> remove it.
      for (const id of stale) { deleteContact.run(id); deleted++; }

      sqlite.prepare('COMMIT').run();
    } catch (err) {
      sqlite.prepare('ROLLBACK').run();
      throw err;
    }
    return { upserted, deleted };
  }

  async function syncNow() {
    if (!url) { status.lastError = 'ONEC_URL not configured'; return status; }
    if (status.running) return status; // never overlap
    status.running = true;
    status.lastRunAt = Date.now();
    let hadError = false;
    try {
      const regions = listRegions.all();
      if (!regions.length) {
        log.log('[1c-sync] no regions have Область (oblast_1c) set — nothing to sync');
      }
      for (const r of regions) {
        const oblast = r.oblast_1c.trim();
        try {
          const items = await fetchRegion(oblast);
          const { upserted, deleted } = upsertRegion(r.id, items);
          status.perRegion[r.name] = { fetched: items.length, upserted, deleted, error: null, at: Date.now() };
          log.log(`[1c-sync] region "${r.name}" (${oblast}): fetched ${items.length}, upserted ${upserted}, deleted ${deleted}`);
        } catch (err) {
          hadError = true;
          status.perRegion[r.name] = { fetched: 0, upserted: 0, deleted: 0, error: err.message, at: Date.now() };
          log.log(`[1c-sync] region "${r.name}" (${oblast}) FAILED: ${err.message}`);
        }
      }
      status.lastError = hadError ? 'one or more regions failed (see perRegion)' : null;
      if (!hadError) status.lastOkAt = Date.now();
    } catch (err) {
      status.lastError = err.message;
      log.log('[1c-sync] run error:', err.message);
    } finally {
      status.running = false;
    }
    return status;
  }

  let timer = null;
  function start() {
    if (!url) {
      log.log('[1c-sync] ONEC_URL not set — 1C contact sync disabled');
      return;
    }
    log.log(`[1c-sync] enabled — polling 1C every ${Math.round(intervalMs / 1000)}s (${url})`);
    // First run shortly after boot, then on the interval.
    setTimeout(() => { syncNow().catch(() => {}); }, 3000);
    timer = setInterval(() => { syncNow().catch(() => {}); }, intervalMs);
    if (timer.unref) timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  function getStatus() { return status; }

  return { start, stop, syncNow, getStatus };
}

module.exports = { initContactsSync, clean9, collectPhones, delatinizeUrl };
