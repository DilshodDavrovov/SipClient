'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

/**
 * Durable storage for everything that used to live only in the browser's
 * localStorage (call history, notes, callbacks) plus the new contacts book.
 * Built on node's built-in `node:sqlite` (no native module to compile —
 * important on Windows, where a node-gyp toolchain isn't a safe assumption).
 *
 * Design notes:
 *  - `calls` rows are upserted on every call-store 'update', not just at
 *    hangup, so a row always exists by the time an operator picks a post-
 *    call outcome right after the client answers (well before hangup).
 *  - Phone numbers are matched to contacts via a normalized suffix (last 9
 *    digits — a Uzbek local subscriber number) so "+998 90 123-45-67",
 *    "90 123 45 67" and "998901234567" all resolve to the same contact
 *    regardless of how a given call/record happened to format it.
 *  - `outcome` / `recording_filename` are set through their own dedicated
 *    setters and are never touched by the ON CONFLICT clause in
 *    upsertCallRecord, so a later state-change upsert can't clobber them.
 */

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT,
  phone1 TEXT,
  phone1_norm TEXT,
  phone2 TEXT,
  phone2_norm TEXT,
  phone3 TEXT,
  phone3_norm TEXT,
  phone4 TEXT,
  phone4_norm TEXT,
  company_name TEXT,
  manager_name TEXT,
  operator_extension TEXT,
  comment TEXT,
  last_call_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  action_id TEXT,
  linkedid TEXT,
  operator_extension TEXT,
  direction TEXT,
  source TEXT,
  counterparty_number TEXT,
  counterparty_number_norm TEXT,
  counterparty_name TEXT,
  contact_id INTEGER,
  state TEXT,
  disposition TEXT,
  status TEXT,
  status_label TEXT,
  outcome TEXT,
  recording_filename TEXT,
  started_at INTEGER NOT NULL,
  answered_at INTEGER,
  ended_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_started_at ON calls(started_at);
CREATE INDEX IF NOT EXISTS idx_calls_number_norm ON calls(counterparty_number_norm);
CREATE INDEX IF NOT EXISTS idx_calls_operator ON calls(operator_extension);
CREATE INDEX IF NOT EXISTS idx_calls_contact ON calls(contact_id);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  call_id TEXT,
  contact_id INTEGER,
  number TEXT,
  name TEXT,
  text TEXT NOT NULL,
  operator_extension TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_contact ON notes(contact_id);
CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at);

CREATE TABLE IF NOT EXISTS callbacks (
  id TEXT PRIMARY KEY,
  call_id TEXT,
  contact_id INTEGER,
  number TEXT,
  name TEXT,
  due_at INTEGER NOT NULL,
  operator_extension TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_callbacks_due ON callbacks(due_at);

-- Confirmed bookings, reported by whatever external system the operator
-- actually creates the booking in (see the call-id-on-button UI in
-- js/app.js's outcome picker) — this table, not the outcome tag alone, is
-- the source of truth for "Брони" stat count/sum, since the outcome tag is
-- only ever a local intent marker the operator clicked, not confirmation a
-- booking (and its amount) actually exists.
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL,
  operator_extension TEXT,
  amount REAL NOT NULL,
  info TEXT,
  reference TEXT,
  confirmed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_call_id ON bookings(call_id);
CREATE INDEX IF NOT EXISTS idx_bookings_operator ON bookings(operator_extension);
`;

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  return digits.length > 9 ? digits.slice(-9) : digits;
}

// A contact holds up to 4 interchangeable phone numbers (phone1..phone4).
const CONTACT_PHONE_SLOTS = 4;

// Accepts any of the shapes a caller might reasonably send: the canonical
// `phones: [...]` array, flat `phone1`..`phone4` keys, or the legacy
// `phonePrimary`/`phoneBackup` pair — always returning exactly
// CONTACT_PHONE_SLOTS entries (empty string for a vacant slot).
function contactPhonesFromData(data) {
  const raw = Array.isArray(data.phones)
    ? data.phones
    : [
        data.phone1 !== undefined ? data.phone1 : data.phonePrimary,
        data.phone2 !== undefined ? data.phone2 : data.phoneBackup,
        data.phone3,
        data.phone4,
      ];
  const out = [];
  for (let i = 0; i < CONTACT_PHONE_SLOTS; i++) out.push(raw[i] == null ? '' : String(raw[i]));
  return out;
}

// True when the payload carries ANY phone information at all (in any of the
// shapes above) — the upsert merge uses this to tell "replace the stored
// numbers with these" apart from "payload doesn't mention phones, keep them".
function dataHasPhones(data) {
  return Array.isArray(data.phones)
    || data.phone1 !== undefined || data.phone2 !== undefined
    || data.phone3 !== undefined || data.phone4 !== undefined
    || data.phonePrimary !== undefined || data.phoneBackup !== undefined;
}

// The client code — the contact's durable unique identifier, assigned by the
// external booking system (see POST /api/contacts/upsert). Stored trimmed;
// empty means "no code" and is kept as NULL so the unique index ignores it.
function normalizeContactCode(raw) {
  const code = String(raw == null ? '' : raw).trim();
  return code || null;
}

// Canonical display/storage form for a Uzbek local number: "90 601 03 31"
// (2-3-2-2 grouping of the 9-digit subscriber number). Applied to every
// contact phone field on the way in — from the settings UI, and from the
// /api/contacts/upsert import alike — so there's exactly one format
// anywhere a number is stored, regardless of how it arrived ("+998 90
// 601-03-31", "998906010331", already-clean, etc). Also duplicated (kept
// in sync deliberately, see the AMI_DISPOSITION_LABELS comment above) in
// js/app.js for the live-as-you-type dialer/contact-form formatting.
function formatPhoneStrict(raw) {
  const norm = normalizePhone(raw);
  if (!norm) return '';
  return [norm.slice(0, 2), norm.slice(2, 5), norm.slice(5, 7), norm.slice(7, 9)]
    .filter(Boolean)
    .join(' ');
}

// Same mapping as the frontend's amiRecordToEntry() in js/app.js — kept in
// sync deliberately (not shared as a module: different runtimes, and this
// is small/stable enough that duplication is cheaper than wiring up a
// shared file between browser and server code for it).
const AMI_DISPOSITION_LABELS = {
  NOANSWER: 'Нет ответа',
  BUSY: 'Занято',
  CANCEL: 'Отменён',
  CONGESTION: 'Перегрузка линии',
  CHANUNAVAIL: 'Недоступен',
  FAILED: 'Ошибка вызова',
};

// Turns the call-store's raw state machine (state/disposition) into the
// same coarse status/label the UI shows, so it's stored as its own durable,
// queryable column instead of only ever existing as something recomputed
// on the fly from state+disposition.
function deriveStatus(record) {
  switch (record.state) {
    case 'answered': return { status: 'active', statusLabel: 'В разговоре' };
    case 'ended': return { status: 'completed', statusLabel: 'Завершён' };
    case 'operator_no_answer': return { status: 'missed', statusLabel: 'Вы не ответили' };
    case 'failed': return { status: 'failed', statusLabel: AMI_DISPOSITION_LABELS[record.disposition] || 'Не завершён' };
    default: return { status: 'ringing', statusLabel: 'Звонит...' };
  }
}

function rowToRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    actionId: row.action_id,
    linkedid: row.linkedid,
    operatorExtension: row.operator_extension,
    direction: row.direction,
    source: row.source,
    counterparty: { number: row.counterparty_number || 'неизвестно', name: row.counterparty_name || '' },
    state: row.state,
    disposition: row.disposition,
    status: row.status || null,
    statusLabel: row.status_label || null,
    startedAt: row.started_at,
    answeredAt: row.answered_at,
    endedAt: row.ended_at,
    channels: { operator: null, destination: null, other: null },
    outcome: row.outcome || null,
    // `resolved_contact_id`/`contact_company`/`contact_manager` only exist on
    // rows from searchCalls()'s phone-matched join (see there) — plain
    // selects elsewhere just leave these undefined, which is fine here.
    contactId: row.resolved_contact_id || row.contact_id || null,
    contactCompany: row.contact_company || null,
    contactManager: row.contact_manager || null,
    // Only present on rows from searchCalls() (see the correlated
    // subqueries there) — a confirmed booking (POST /api/call/:id/booking),
    // not the "booking" outcome tag alone, which is just local intent an
    // operator clicked and proves nothing actually got booked.
    bookingCount: row.booking_count || 0,
    bookingAmount: row.booking_amount || 0,
    bookingInfo: row.booking_info || null,
    // Total notes attached to this call (see POST/PUT /api/notes) —
    // independent of `outcome`: the history-row note button (js/app.js's
    // note-from-history-btn) deliberately attaches a note WITHOUT touching
    // the call's registered outcome, so a call can have notes even when
    // outcome is 'callback'/'contact'/etc, or none at all. Only present on
    // rows from searchCalls() (see the correlated subquery there).
    noteCount: row.note_count || 0,
    recordingFilename: row.recording_filename || null,
  };
}

function contactRowToJson(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code || '',
    phones: [row.phone1 || '', row.phone2 || '', row.phone3 || '', row.phone4 || ''],
    companyName: row.company_name || '',
    managerName: row.manager_name || '',
    operatorExtension: row.operator_extension || '',
    comment: row.comment || '',
    lastCallAt: row.last_call_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function noteRowToJson(row) {
  return {
    id: row.id,
    callId: row.call_id || null,
    contactId: row.contact_id || null,
    number: row.number || '',
    name: row.name || '',
    text: row.text,
    operatorExtension: row.operator_extension || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function callbackRowToJson(row) {
  return {
    id: row.id,
    callId: row.call_id || null,
    contactId: row.contact_id || null,
    number: row.number || '',
    name: row.name || '',
    dueAt: row.due_at,
    operatorExtension: row.operator_extension || '',
    createdAt: row.created_at,
  };
}

function bookingRowToJson(row) {
  return {
    id: row.id,
    callId: row.call_id,
    operatorExtension: row.operator_extension || '',
    amount: row.amount,
    info: row.info || '',
    reference: row.reference || '',
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
  };
}

class Db {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = OFF;');
    // SQLite's built-in lower()/upper() only case-fold ASCII — "Дилшод" and
    // "дилшод" are, as far as they're concerned, already both "lowercase"
    // and don't match each other, which silently broke every case-
    // insensitive LIKE search here for Cyrillic (and any other non-ASCII)
    // text. Overriding them with JS's String.prototype.lower/upperCase
    // (which do handle Unicode case-folding correctly) fixes every query
    // that already calls lower()/upper() — including any added later —
    // without needing a per-query workaround.
    this.db.function('lower', { deterministic: true }, (s) => (s == null ? null : String(s).toLowerCase()));
    this.db.function('upper', { deterministic: true }, (s) => (s == null ? null : String(s).toUpperCase()));
    this.db.exec(SCHEMA_SQL);
    this._migrateColumns();
    this._migrateContacts();
    this._migrateBookingsUnique();
    this._prepare();
    this._backfillContactPhoneFormat();
  }

  // Contacts grew from 2 phone slots (phone_primary/phone_backup) to 4
  // interchangeable ones (phone1..phone4), plus the client `code` — the
  // durable unique identifier assigned by the external booking system. A
  // fresh database gets the final shape straight from SCHEMA_SQL; one that
  // predates this needs the old columns renamed and the new ones bolted on.
  // The indexes are created here rather than in SCHEMA_SQL for the same
  // reason as idx_calls_status above: against an old on-disk table the
  // columns don't exist until this migration has run.
  _migrateContacts() {
    let cols = new Set(this.db.prepare('PRAGMA table_info(contacts)').all().map((c) => c.name));
    if (cols.has('phone_primary')) {
      this.db.exec(`
        ALTER TABLE contacts RENAME COLUMN phone_primary TO phone1;
        ALTER TABLE contacts RENAME COLUMN phone_primary_norm TO phone1_norm;
        ALTER TABLE contacts RENAME COLUMN phone_backup TO phone2;
        ALTER TABLE contacts RENAME COLUMN phone_backup_norm TO phone2_norm;
      `);
      // SQLite carried the old indexes over to the renamed columns — drop
      // them so the uniformly-named ones below are the only copies.
      this.db.exec('DROP INDEX IF EXISTS idx_contacts_phone_primary_norm;');
      this.db.exec('DROP INDEX IF EXISTS idx_contacts_phone_backup_norm;');
      console.log('[db] migrated contacts phone_primary/phone_backup to phone1/phone2');
      cols = new Set(this.db.prepare('PRAGMA table_info(contacts)').all().map((c) => c.name));
    }
    for (const col of ['code', 'phone3', 'phone3_norm', 'phone4', 'phone4_norm']) {
      if (!cols.has(col)) this.db.exec(`ALTER TABLE contacts ADD COLUMN ${col} TEXT`);
    }
    for (let i = 1; i <= CONTACT_PHONE_SLOTS; i++) {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_contacts_phone${i}_norm ON contacts(phone${i}_norm)`);
    }
    // Partial: rows without a code (NULL) don't collide with each other —
    // only actually-assigned codes must be unique.
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_code_unique
      ON contacts(code) WHERE code IS NOT NULL
    `);
  }

  // A resubmitted booking for a call id that already has one now updates it
  // in place (see upsertBooking) rather than piling up a duplicate row —
  // needs a unique index on call_id for the ON CONFLICT target, which (like
  // the status/status_label columns above) has to be bolted on after the
  // fact for a database that already existed. Rows written before this
  // existed could have more than one booking per call already; those are
  // collapsed down to the most recent submission first, so the same
  // "resubmitting updates it" rule effectively applies retroactively too.
  _migrateBookingsUnique() {
    const dupes = this.db.prepare(`
      SELECT call_id FROM bookings GROUP BY call_id HAVING COUNT(*) > 1
    `).all();
    if (dupes.length) {
      const keepLatest = this.db.prepare(`
        DELETE FROM bookings WHERE call_id = ? AND id NOT IN (
          SELECT id FROM bookings WHERE call_id = ? ORDER BY confirmed_at DESC LIMIT 1
        )
      `);
      for (const { call_id } of dupes) keepLatest.run(call_id, call_id);
      console.log(`[db] collapsed duplicate bookings for ${dupes.length} call(s) down to their most recent submission`);
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_call_id_unique ON bookings(call_id)');
  }

  // One-time (per boot, effectively a no-op once caught up) cleanup for
  // contacts that were created before formatPhoneStrict() existed, or came
  // in some other format some other way — re-saves every contact's phone
  // fields through the same formatter createContact/updateContact use, so
  // "strictly 90 601 03 31 everywhere" also covers rows already on disk.
  _backfillContactPhoneFormat() {
    const rows = this.db.prepare('SELECT id, phone1, phone2, phone3, phone4 FROM contacts').all();
    let changed = 0;
    for (const row of rows) {
      const current = [row.phone1, row.phone2, row.phone3, row.phone4];
      const formatted = current.map(formatPhoneStrict);
      if (formatted.every((p, i) => p === (current[i] || ''))) continue;
      this.stmts.updateContactPhoneFormat.run(...formatted.map((p) => p || null), row.id);
      changed++;
    }
    if (changed) console.log(`[db] reformatted phone numbers for ${changed} existing contact(s)`);
  }

  // `CREATE TABLE IF NOT EXISTS` above only helps on a brand-new database —
  // a `calls` table that already existed before the `status`/`status_label`
  // columns were added needs them bolted on explicitly, or every insert
  // referencing them fails against the on-disk schema.
  _migrateColumns() {
    const existing = new Set(this.db.prepare('PRAGMA table_info(calls)').all().map((c) => c.name));
    if (!existing.has('status')) this.db.exec('ALTER TABLE calls ADD COLUMN status TEXT');
    if (!existing.has('status_label')) this.db.exec('ALTER TABLE calls ADD COLUMN status_label TEXT');
    // Only safe to add now that the column above is guaranteed to exist —
    // SCHEMA_SQL's CREATE TABLE IF NOT EXISTS is a no-op against an
    // already-existing table, so this can't live there.
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status)');
    this._backfillStatus();
  }

  // Rows written before the status/status_label columns existed (or any
  // that otherwise slipped through without one) never get another AMI event
  // to trigger a fresh upsertCallRecord — without this they'd sit at NULL
  // forever. Cheap to run unconditionally on every boot: a no-op once
  // everything already has a status.
  _backfillStatus() {
    const rows = this.db.prepare('SELECT id, state, disposition FROM calls WHERE status IS NULL').all();
    if (!rows.length) return;
    const update = this.db.prepare('UPDATE calls SET status = ?, status_label = ? WHERE id = ?');
    for (const row of rows) {
      const { status, statusLabel } = deriveStatus(row);
      update.run(status, statusLabel, row.id);
    }
    console.log(`[db] backfilled status for ${rows.length} existing call record(s)`);
  }

  _prepare() {
    const db = this.db;

    this.stmts = {
      upsertCall: db.prepare(`
        INSERT INTO calls (
          id, action_id, linkedid, operator_extension, direction, source,
          counterparty_number, counterparty_number_norm, counterparty_name,
          contact_id, state, disposition, status, status_label,
          started_at, answered_at, ended_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          action_id = excluded.action_id,
          linkedid = excluded.linkedid,
          operator_extension = excluded.operator_extension,
          direction = excluded.direction,
          source = excluded.source,
          counterparty_number = excluded.counterparty_number,
          counterparty_number_norm = excluded.counterparty_number_norm,
          counterparty_name = excluded.counterparty_name,
          contact_id = excluded.contact_id,
          state = excluded.state,
          disposition = excluded.disposition,
          status = excluded.status,
          status_label = excluded.status_label,
          started_at = excluded.started_at,
          answered_at = excluded.answered_at,
          ended_at = excluded.ended_at,
          updated_at = excluded.updated_at
      `),
      getCall: db.prepare('SELECT * FROM calls WHERE id = ?'),
      updateOutcome: db.prepare('UPDATE calls SET outcome = ?, updated_at = ? WHERE id = ?'),
      insertMinimalOutcome: db.prepare(`
        INSERT INTO calls (id, outcome, started_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `),
      updateRecordingFilename: db.prepare('UPDATE calls SET recording_filename = ?, updated_at = ? WHERE id = ?'),
      insertMinimalRecording: db.prepare(`
        INSERT INTO calls (id, recording_filename, started_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `),
      touchContactLastCall: db.prepare(`
        UPDATE contacts SET last_call_at = MAX(COALESCE(last_call_at, 0), ?), updated_at = ?
        WHERE id = ?
      `),
      findContactByNorm: db.prepare(`
        SELECT id FROM contacts
        WHERE (phone1_norm IS NOT NULL AND phone1_norm = ?)
           OR (phone2_norm IS NOT NULL AND phone2_norm = ?)
           OR (phone3_norm IS NOT NULL AND phone3_norm = ?)
           OR (phone4_norm IS NOT NULL AND phone4_norm = ?)
        LIMIT 1
      `),
      findContactByCode: db.prepare('SELECT * FROM contacts WHERE code = ? LIMIT 1'),
      insertContact: db.prepare(`
        INSERT INTO contacts (
          code,
          phone1, phone1_norm, phone2, phone2_norm,
          phone3, phone3_norm, phone4, phone4_norm,
          company_name, manager_name, operator_extension, comment,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updateContact: db.prepare(`
        UPDATE contacts SET
          code = ?,
          phone1 = ?, phone1_norm = ?, phone2 = ?, phone2_norm = ?,
          phone3 = ?, phone3_norm = ?, phone4 = ?, phone4_norm = ?,
          company_name = ?, manager_name = ?, operator_extension = ?, comment = ?, updated_at = ?
        WHERE id = ?
      `),
      getContact: db.prepare('SELECT * FROM contacts WHERE id = ?'),
      deleteContact: db.prepare('DELETE FROM contacts WHERE id = ?'),
      updateContactPhoneFormat: db.prepare('UPDATE contacts SET phone1 = ?, phone2 = ?, phone3 = ?, phone4 = ? WHERE id = ?'),
      insertNote: db.prepare(`
        INSERT INTO notes (id, call_id, contact_id, number, name, text, operator_extension, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      updateNote: db.prepare('UPDATE notes SET text = ?, updated_at = ? WHERE id = ?'),
      deleteNote: db.prepare('DELETE FROM notes WHERE id = ?'),
      insertCallback: db.prepare(`
        INSERT INTO callbacks (id, call_id, contact_id, number, name, due_at, operator_extension, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      deleteCallback: db.prepare('DELETE FROM callbacks WHERE id = ?'),
      // A second confirmation for a call id that already has one updates it
      // in place — created_at is deliberately left out of the SET clause so
      // it still reflects the first-ever submission, not the latest.
      upsertBooking: db.prepare(`
        INSERT INTO bookings (call_id, operator_extension, amount, info, reference, confirmed_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(call_id) DO UPDATE SET
          operator_extension = excluded.operator_extension,
          amount = excluded.amount,
          info = excluded.info,
          reference = excluded.reference,
          confirmed_at = excluded.confirmed_at
      `),
      bookingsForCall: db.prepare('SELECT * FROM bookings WHERE call_id = ? ORDER BY confirmed_at DESC'),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Contacts                                                             */
  /* ------------------------------------------------------------------ */

  resolveContactIdForNumber(number) {
    const norm = normalizePhone(number);
    if (!norm) return null;
    const row = this.stmts.findContactByNorm.get(norm, norm, norm, norm);
    return row ? row.id : null;
  }

  touchContactLastCall(contactId, startedAt) {
    if (!contactId || !startedAt) return;
    this.stmts.touchContactLastCall.run(startedAt, Date.now(), contactId);
  }

  // Both share the same parameter layout: code, then the 4 phone slots as
  // (display, norm) pairs, then the plain text fields.
  _contactParams(data) {
    const params = [normalizeContactCode(data.code)];
    for (const phone of contactPhonesFromData(data)) {
      params.push(formatPhoneStrict(phone) || null, normalizePhone(phone));
    }
    params.push(
      data.companyName || null, data.managerName || null,
      data.operatorExtension || null, data.comment || null
    );
    return params;
  }

  createContact(data) {
    const now = Date.now();
    const info = this.stmts.insertContact.run(...this._contactParams(data), now, now);
    return this.getContact(info.lastInsertRowid);
  }

  updateContact(id, data) {
    this.stmts.updateContact.run(...this._contactParams(data), Date.now(), id);
    return this.getContact(id);
  }

  // Import path for an external system (POST /api/contacts/upsert): the
  // client code is the durable identifier — a row already carrying it is
  // updated in place; re-sending the same code any number of times keeps
  // updating that same contact. Only keys actually present in `data`
  // overwrite the stored value (phones replace as a whole set when any
  // phone key is given — see dataHasPhones), so a partial payload can't
  // blank out fields the operators maintain by hand.
  upsertContactByCode(data) {
    const code = normalizeContactCode(data.code);
    if (!code) throw new Error('"code" is required');
    let existingRow = this.stmts.findContactByCode.get(code);
    let adopted = false;

    // The code is new to us — but the phone number may not be: the contact
    // book predates codes (manual entries, the old XML sync), so a CODE-LESS
    // contact matching one of the payload's numbers is this same client and
    // should get the code attached, not be duplicated. A contact already
    // carrying a different code is never adopted (that's a different client
    // who happens to share a number — a data-quality case, not ours to merge).
    if (!existingRow) {
      for (const phone of contactPhonesFromData(data)) {
        const norm = normalizePhone(phone);
        if (!norm) continue;
        const match = this.stmts.findContactByNorm.get(norm, norm, norm, norm);
        if (!match) continue;
        const full = this.stmts.getContact.get(match.id);
        if (full && !normalizeContactCode(full.code)) {
          existingRow = full;
          adopted = true;
          break;
        }
      }
    }

    if (!existingRow) {
      return { contact: this.createContact({ ...data, code }), created: true, adopted: false };
    }
    const current = contactRowToJson(existingRow);
    const merged = {
      code,
      phones: dataHasPhones(data) ? contactPhonesFromData(data) : current.phones,
      companyName: data.companyName !== undefined ? data.companyName : current.companyName,
      managerName: data.managerName !== undefined ? data.managerName : current.managerName,
      operatorExtension: data.operatorExtension !== undefined ? data.operatorExtension : current.operatorExtension,
      comment: data.comment !== undefined ? data.comment : current.comment,
    };
    return { contact: this.updateContact(current.id, merged), created: false, adopted };
  }

  getContact(id) {
    return contactRowToJson(this.stmts.getContact.get(id));
  }

  getContactByCode(code) {
    const normalized = normalizeContactCode(code);
    if (!normalized) return null;
    return contactRowToJson(this.stmts.findContactByCode.get(normalized));
  }

  deleteContact(id) {
    this.stmts.deleteContact.run(id);
  }

  listContacts({ q, limit = 200, offset = 0 } = {}) {
    const clauses = [];
    const params = [];
    if (q && q.trim()) {
      const like = '%' + q.trim().toLowerCase() + '%';
      const digits = normalizePhone(q);
      clauses.push(`(
        lower(company_name) LIKE ? OR lower(manager_name) LIKE ? OR lower(code) LIKE ? OR
        lower(phone1) LIKE ? OR lower(phone2) LIKE ? OR lower(phone3) LIKE ? OR lower(phone4) LIKE ?
        ${digits ? 'OR phone1_norm LIKE ? OR phone2_norm LIKE ? OR phone3_norm LIKE ? OR phone4_norm LIKE ?' : ''}
      )`);
      params.push(like, like, like, like, like, like, like);
      if (digits) params.push('%' + digits + '%', '%' + digits + '%', '%' + digits + '%', '%' + digits + '%');
    }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const total = this.db.prepare(`SELECT COUNT(*) AS c FROM contacts ${where}`).get(...params).c;
    const rows = this.db.prepare(`
      SELECT * FROM contacts ${where}
      ORDER BY COALESCE(last_call_at, 0) DESC, company_name COLLATE NOCASE ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    return { total, rows: rows.map(contactRowToJson) };
  }

  /* ------------------------------------------------------------------ */
  /* Calls                                                                */
  /* ------------------------------------------------------------------ */

  upsertCallRecord(record) {
    const now = Date.now();
    const number = record.counterparty && record.counterparty.number;
    const norm = normalizePhone(number);
    const contactId = this.resolveContactIdForNumber(number);
    const { status, statusLabel } = deriveStatus(record);
    this.stmts.upsertCall.run(
      record.id,
      record.actionId || null,
      record.linkedid || null,
      record.operatorExtension || null,
      record.direction || null,
      record.source || null,
      number || null,
      norm,
      (record.counterparty && record.counterparty.name) || null,
      contactId,
      record.state || null,
      record.disposition || null,
      status,
      statusLabel,
      record.startedAt || now,
      record.answeredAt || null,
      record.endedAt || null,
      now, now
    );
    if (contactId) this.touchContactLastCall(contactId, record.startedAt || now);
    return contactId;
  }

  setCallOutcome(id, outcome) {
    const now = Date.now();
    const info = this.stmts.updateOutcome.run(outcome, now, id);
    if (info.changes === 0) {
      // No row yet (shouldn't normally happen — see class doc comment —
      // but guard anyway): create a placeholder the next state-change
      // upsert will flesh out, without losing the outcome already chosen.
      this.stmts.insertMinimalOutcome.run(id, outcome, now, now, now);
    }
  }

  setCallRecordingFilename(id, filename) {
    const now = Date.now();
    const info = this.stmts.updateRecordingFilename.run(filename, now, id);
    if (info.changes === 0) {
      this.stmts.insertMinimalRecording.run(id, filename, now, now, now);
    }
  }

  getCallRow(id) {
    return rowToRecord(this.stmts.getCall.get(id));
  }

  listRecentRaw(limit) {
    const rows = this.db.prepare('SELECT * FROM calls ORDER BY started_at DESC LIMIT ?').all(limit);
    return rows.map(rowToRecord);
  }

  // The most recent call to/from this number *other than* excludeId (the
  // call currently on screen) — backs the "last spoke on ... with operator
  // ..." context line on the post-call outcome picker. Matched by
  // normalized number, same as everywhere else, so it doesn't care whether
  // that older call ever got linked to a contact_id.
  findLastCallForNumber(number, excludeId) {
    const norm = normalizePhone(number);
    if (!norm) return null;
    const row = this.db.prepare(`
      SELECT * FROM calls
      WHERE counterparty_number_norm = ? AND id != ?
      ORDER BY started_at DESC
      LIMIT 1
    `).get(norm, excludeId || '');
    return rowToRecord(row);
  }

  searchCalls({ q, from, to, operator, status, limit = 50, offset = 0 } = {}) {
    const clauses = [];
    const params = [];
    if (operator) { clauses.push('c.operator_extension = ?'); params.push(operator); }
    if (status) { clauses.push('c.status = ?'); params.push(status); }
    if (from) { clauses.push('c.started_at >= ?'); params.push(from); }
    if (to) { clauses.push('c.started_at <= ?'); params.push(to); }
    if (q && q.trim()) {
      const like = '%' + q.trim().toLowerCase() + '%';
      const digits = normalizePhone(q);
      clauses.push(`(
        lower(c.counterparty_number) LIKE ? OR lower(c.counterparty_name) LIKE ?
        OR lower(ct.company_name) LIKE ? OR lower(ct.manager_name) LIKE ?
        ${digits ? 'OR c.counterparty_number_norm LIKE ?' : ''}
      )`);
      params.push(like, like, like, like);
      if (digits) params.push('%' + digits + '%');
    }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    // Matched by phone number, not just the contact_id stamped on the call
    // at the time it happened — a contact created (or edited) *after* the
    // call still needs to show up here. GROUP BY collapses the join back to
    // one row per call even if more than one contact happens to share a
    // number (a data-quality edge case, not something to let inflate totals
    // or duplicate rows).
    const join = `
      LEFT JOIN contacts ct ON ct.id = c.contact_id
        OR ct.phone1_norm = c.counterparty_number_norm
        OR ct.phone2_norm = c.counterparty_number_norm
        OR ct.phone3_norm = c.counterparty_number_norm
        OR ct.phone4_norm = c.counterparty_number_norm
    `;
    const total = this.db.prepare(`
      SELECT COUNT(*) AS c FROM (
        SELECT c.id FROM calls c ${join} ${where} GROUP BY c.id
      )
    `).get(...params).c;
    const rows = this.db.prepare(`
      SELECT c.*,
        MAX(ct.id) AS resolved_contact_id,
        MAX(ct.company_name) AS contact_company,
        MAX(ct.manager_name) AS contact_manager,
        (SELECT COUNT(*) FROM bookings b WHERE b.call_id = c.id) AS booking_count,
        (SELECT amount FROM bookings b WHERE b.call_id = c.id) AS booking_amount,
        (SELECT info FROM bookings b WHERE b.call_id = c.id) AS booking_info,
        (SELECT COUNT(*) FROM notes n WHERE n.call_id = c.id) AS note_count
      FROM calls c ${join}
      ${where}
      GROUP BY c.id
      ORDER BY c.started_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    return { total, records: rows.map(rowToRecord) };
  }

  listCallsForContact(contactId, { limit = 200, offset = 0 } = {}) {
    // Same reasoning as searchCalls' join above: a call placed before this
    // contact existed never got contact_id stamped on it, but should still
    // show up here once the phone number matches.
    const contact = this.stmts.getContact.get(contactId);
    const norms = contact
      ? [contact.phone1_norm, contact.phone2_norm, contact.phone3_norm, contact.phone4_norm].filter(Boolean)
      : [];
    const clauses = ['c.contact_id = ?'];
    const params = [contactId];
    for (const norm of norms) {
      clauses.push('c.counterparty_number_norm = ?');
      params.push(norm);
    }
    const where = `WHERE ${clauses.join(' OR ')}`;
    const total = this.db.prepare(`SELECT COUNT(*) AS c FROM calls c ${where}`).get(...params).c;
    const rows = this.db.prepare(`
      SELECT * FROM calls c ${where} ORDER BY c.started_at DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    return { total, records: rows.map(rowToRecord) };
  }

  /* ------------------------------------------------------------------ */
  /* Notes                                                                */
  /* ------------------------------------------------------------------ */

  createNote({ id, callId, number, name, text, operatorExtension }) {
    const now = Date.now();
    const contactId = this.resolveContactIdForNumber(number);
    this.stmts.insertNote.run(id, callId || null, contactId, number || null, name || null, text, operatorExtension || null, now, now);
    return noteRowToJson(this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id));
  }

  updateNote(id, text) {
    this.stmts.updateNote.run(text, Date.now(), id);
    return noteRowToJson(this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id));
  }

  deleteNote(id) {
    this.stmts.deleteNote.run(id);
  }

  listNotes({ contactId, limit = 500, offset = 0 } = {}) {
    const where = contactId ? 'WHERE contact_id = ?' : '';
    const params = contactId ? [contactId] : [];
    const rows = this.db.prepare(`
      SELECT * FROM notes ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    return rows.map(noteRowToJson);
  }

  /* ------------------------------------------------------------------ */
  /* Callbacks                                                            */
  /* ------------------------------------------------------------------ */

  createCallback({ id, callId, number, name, dueAt, operatorExtension }) {
    const contactId = this.resolveContactIdForNumber(number);
    this.stmts.insertCallback.run(id, callId || null, contactId, number || null, name || null, dueAt, operatorExtension || null, Date.now());
    return callbackRowToJson(this.db.prepare('SELECT * FROM callbacks WHERE id = ?').get(id));
  }

  deleteCallback(id) {
    this.stmts.deleteCallback.run(id);
  }

  listCallbacks() {
    const rows = this.db.prepare('SELECT * FROM callbacks ORDER BY due_at ASC').all();
    return rows.map(callbackRowToJson);
  }

  /* ------------------------------------------------------------------ */
  /* Bookings — confirmed externally (amount + info), see the CREATE       */
  /* TABLE comment above for why this is the source of truth for the       */
  /* "Брони" stat rather than the outcome tag alone.                       */
  /* ------------------------------------------------------------------ */

  createBooking({ callId, operatorExtension, amount, info, reference }) {
    const now = Date.now();
    // Re-fetched by call_id rather than trusting lastInsertRowid — on the
    // ON CONFLICT DO UPDATE path that's the *existing* row being updated,
    // not necessarily reliable to key off of, and this works identically
    // either way.
    this.stmts.upsertBooking.run(callId, operatorExtension || null, amount, info || null, reference || null, now, now);
    return bookingRowToJson(this.db.prepare('SELECT * FROM bookings WHERE call_id = ?').get(callId));
  }

  getBookingsForCall(callId) {
    return this.stmts.bookingsForCall.all(callId).map(bookingRowToJson);
  }

  // { count, totalAmount } — optionally scoped to one operator extension
  // (matched against the booking's own operator_extension, stamped at
  // confirm time — not looked up via the call, so it stays correct even if
  // a call's operator_extension is ever missing/stale).
  getBookingStats({ operatorExtension, from, to } = {}) {
    const clauses = [];
    const params = [];
    if (operatorExtension) { clauses.push('operator_extension = ?'); params.push(operatorExtension); }
    if (from) { clauses.push('confirmed_at >= ?'); params.push(from); }
    if (to) { clauses.push('confirmed_at <= ?'); params.push(to); }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
      FROM bookings ${where}
    `).get(...params);
    return { count: row.count, totalAmount: row.total };
  }

  /* ------------------------------------------------------------------ */
  /* One-time migration from the old JSONL call log                      */
  /* ------------------------------------------------------------------ */

  importJsonlIfPresent(jsonlPath) {
    const markerPath = jsonlPath + '.imported';
    if (fs.existsSync(markerPath) || !fs.existsSync(jsonlPath)) return;
    try {
      const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
      let count = 0;
      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          this.upsertCallRecord(record);
          count++;
        } catch (e) { /* skip malformed line */ }
      }
      fs.renameSync(jsonlPath, markerPath);
      console.log(`[db] migrated ${count} call record(s) from ${path.basename(jsonlPath)} into SQLite`);
    } catch (err) {
      console.error('[db] failed to migrate old JSONL call log:', err.message);
    }
  }

  close() {
    this.db.close();
  }
}

module.exports = { Db, normalizePhone };
