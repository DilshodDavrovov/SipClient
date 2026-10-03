'use strict';

/**
 * Region (viloyat) routing layer.
 *
 * A "region" bundles a FreePBX profile that already exists on the PBX:
 *   - trunk_did        the region's outbound trunk / CallerID (informational)
 *   - outbound_prefix  digits prepended to a dialled number so FreePBX's
 *                      per-region OUTBOUND ROUTE selects that trunk. This is
 *                      the whole trunk-forcing mechanism — no dialplan/SSH
 *                      change is needed, only 4 outbound routes in the GUI.
 *   - queue            the inbound queue that trunk lands on (FreePBX routes
 *                      DID -> queue -> agents natively; stored here for the
 *                      admin panel to show, not enforced by this app)
 *   - agent_extensions the agents that serve the region (CSV or ranges like
 *                      "101-125" — roster/metadata, used by the future dialer)
 *
 * Contacts get a `region_id`. Click-to-call to a region's contact is dialled
 * with that region's prefix (see resolveOutbound), so the call physically
 * leaves through the region's trunk.
 *
 * Self-contained: owns its own table + the contacts.region_id column, and
 * mounts its own /api routes. index.js only require()s it and calls
 * mountRegions() + uses resolveOutbound() inside /api/call.
 */

const { normalizePhone } = require('./db');

/* ---------------------------------------------------------------- */
/* Schema                                                            */
/* ---------------------------------------------------------------- */

function ensureSchema(sqlite) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS regions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      trunk_did TEXT,
      outbound_prefix TEXT,
      queue TEXT,
      agent_extensions TEXT,
      inbound_did TEXT,
      inbound_target TEXT,
      inbound_ivr TEXT,
      oblast_1c TEXT,
      color TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_regions_name ON regions(name COLLATE NOCASE);
  `);
  // Migrate a Phase-1 regions table that predates inbound_target.
  const rcols = new Set(sqlite.prepare('PRAGMA table_info(regions)').all().map((c) => c.name));
  if (!rcols.has('inbound_target')) sqlite.exec('ALTER TABLE regions ADD COLUMN inbound_target TEXT');
  if (!rcols.has('inbound_ivr')) sqlite.exec('ALTER TABLE regions ADD COLUMN inbound_ivr TEXT');
  // oblast_1c: the 1C "Область" name this region syncs contacts for.
  if (!rcols.has('oblast_1c')) sqlite.exec('ALTER TABLE regions ADD COLUMN oblast_1c TEXT');

  const cols = new Set(sqlite.prepare('PRAGMA table_info(contacts)').all().map((c) => c.name));
  if (!cols.has('region_id')) sqlite.exec('ALTER TABLE contacts ADD COLUMN region_id INTEGER');
  sqlite.exec('CREATE INDEX IF NOT EXISTS idx_contacts_region ON contacts(region_id)');
}

/* ---------------------------------------------------------------- */
/* Helpers                                                           */
/* ---------------------------------------------------------------- */

// "101-125, 130, 201" -> ["101","102",...,"125","130","201"]. Kept as
// strings; numeric ranges expanded, bare tokens passed through verbatim.
function expandExtensions(raw) {
  const out = [];
  const seen = new Set();
  for (const tokenRaw of String(raw || '').split(',')) {
    const token = tokenRaw.trim();
    if (!token) continue;
    const m = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      let a = Number(m[1]);
      let b = Number(m[2]);
      if (a > b) [a, b] = [b, a];
      // guard against a fat-fingered "1-99999" blowing up memory
      if (b - a > 5000) { if (!seen.has(token)) { seen.add(token); out.push(token); } continue; }
      const width = m[1].length;
      for (let n = a; n <= b; n++) {
        const s = String(n).padStart(width, '0');
        if (!seen.has(s)) { seen.add(s); out.push(s); }
      }
    } else if (!seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

function regionRowToJson(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    trunkDid: row.trunk_did || '',
    outboundPrefix: row.outbound_prefix || '',
    queue: row.queue || '',
    agentExtensions: row.agent_extensions || '',
    agentCount: expandExtensions(row.agent_extensions).length,
    inboundDid: row.inbound_did || '',
    inboundTarget: row.inbound_target || '',
    inboundIvr: row.inbound_ivr || '',
    oblast1c: row.oblast_1c || '',
    color: row.color || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function regionParams(body) {
  const s = (v) => {
    const t = String(v == null ? '' : v).trim();
    return t || null;
  };
  return {
    name: String(body.name || '').trim(),
    trunk_did: s(body.trunkDid),
    outbound_prefix: s(body.outboundPrefix),
    queue: s(body.queue),
    agent_extensions: s(body.agentExtensions),
    inbound_did: s(body.inboundDid),
    inbound_target: s(body.inboundTarget),
    inbound_ivr: s(body.inboundIvr),
    oblast_1c: s(body.oblast1c),
    color: s(body.color),
  };
}

/**
 * Inbound routing: given the CALLER's number (and optionally the DID it
 * arrived on), find which region that caller belongs to and where the call
 * should be sent inside FreePBX. This is what makes one shared DID fan out
 * to several regions' extension groups by caller — something FreePBX's own
 * DID-based inbound routing can't do. Target precedence: the region's
 * explicit inbound_target, else its queue. Returns null target when the
 * caller isn't a known region contact (dialplan then uses its fallback).
 */
function resolveInbound(sqlite, number, did) {
  const norm = normalizePhone(number);
  if (!norm) return { found: false, region: null, target: '' };
  const rows = sqlite.prepare(`
    SELECT r.* FROM contacts c
    JOIN regions r ON r.id = c.region_id
    WHERE ? IN (c.phone1_norm, c.phone2_norm, c.phone3_norm, c.phone4_norm)
    ORDER BY c.updated_at DESC
  `).all(norm);
  if (!rows.length) return { found: false, region: null, target: '' };
  // When a DID is supplied and the caller is tagged to more than one region,
  // prefer the region whose inbound_did matches the DID the call came in on.
  const didNorm = normalizePhone(did);
  let row = rows[0];
  if (didNorm && rows.length > 1) {
    const match = rows.find((r) => normalizePhone(r.inbound_did) === didNorm);
    if (match) row = match;
  }
  const target = (row.inbound_target || row.queue || '').trim();
  return {
    found: true,
    target,
    region: {
      id: row.id, name: row.name,
      inboundDid: row.inbound_did || '', inboundTarget: row.inbound_target || '',
      queue: row.queue || '', agentExtensions: row.agent_extensions || '',
    },
  };
}

/**
 * For an UNKNOWN caller (not tagged to any region), pick the IVR by the DID
 * the call arrived on: find the region whose inbound_did (or trunk_did)
 * matches that DID and return its inbound_ivr. This is what lets each trunk
 * send its own unknown callers to its own IVR. Returns '' when no region
 * matches the DID or that region has no IVR set — the caller then falls back
 * to the global DEFAULT_TARGET, or the staging queue's own failover.
 */
function resolveDidIvr(sqlite, did) {
  const d = String(did || '').trim();
  if (!d) return '';
  const didNorm = normalizePhone(d);
  const rows = sqlite.prepare('SELECT inbound_did, trunk_did, inbound_ivr FROM regions').all();
  // exact string match first, then normalized (last-9-digits) match
  let hit = rows.find((r) => (r.inbound_did || '').trim() === d || (r.trunk_did || '').trim() === d);
  if (!hit && didNorm) hit = rows.find((r) => normalizePhone(r.inbound_did) === didNorm || normalizePhone(r.trunk_did) === didNorm);
  return hit ? (hit.inbound_ivr || '').trim() : '';
}

/**
 * Given a raw dialled number, find the contact's region and return the
 * number to actually dial (prefixed when the region defines a prefix).
 * Falls back to the number unchanged when the contact/region/prefix is
 * unknown, so non-region numbers keep working exactly as before.
 */
function resolveOutbound(sqlite, to) {
  const norm = normalizePhone(to);
  if (!norm) return { dialTarget: to, region: null };
  const row = sqlite.prepare(`
    SELECT r.* FROM contacts c
    JOIN regions r ON r.id = c.region_id
    WHERE ? IN (c.phone1_norm, c.phone2_norm, c.phone3_norm, c.phone4_norm)
    ORDER BY c.updated_at DESC
    LIMIT 1
  `).get(norm);
  if (!row) return { dialTarget: to, region: null };
  const prefix = (row.outbound_prefix || '').trim();
  const cleanTo = String(to).replace(/\s+/g, '');
  return {
    dialTarget: prefix ? prefix + cleanTo : cleanTo,
    region: { id: row.id, name: row.name, trunkDid: row.trunk_did || '', prefix },
  };
}

/* ---------------------------------------------------------------- */
/* Routes                                                            */
/* ---------------------------------------------------------------- */

function mountRegions(app, { db, requireApiKey }) {
  const sqlite = db.db;
  ensureSchema(sqlite);

  const listRegions = () => {
    const rows = sqlite.prepare('SELECT * FROM regions ORDER BY name COLLATE NOCASE').all();
    const counts = new Map(
      sqlite.prepare('SELECT region_id, COUNT(*) c FROM contacts WHERE region_id IS NOT NULL GROUP BY region_id')
        .all().map((r) => [r.region_id, r.c])
    );
    return rows.map((r) => ({ ...regionRowToJson(r), contactCount: counts.get(r.id) || 0 }));
  };

  app.get('/api/regions', requireApiKey, (req, res) => {
    res.json({ regions: listRegions() });
  });

  // Inbound routing lookup, called by the FreePBX dialplan on every inbound
  // call (via CURL() or an AGI). number = the CALLER's number, did = the DID
  // it arrived on. ?format=raw returns ONLY the target string (empty when
  // unknown) so the dialplan can Set()/Goto() it directly; default is JSON
  // for the admin "test routing" box. Auth via X-Api-Key header OR ?key=
  // (requireApiKey already accepts the query param, for the dialplan URL).
  app.get('/api/route', requireApiKey, (req, res) => {
    const number = String(req.query.number || '').trim();
    const did = String(req.query.did || '').trim();
    const r = resolveInbound(sqlite, number, did);
    if (String(req.query.format) === 'raw') {
      res.type('text/plain').send(r.target || '');
      return;
    }
    res.json({ number, did, found: r.found, target: r.target, region: r.region });
  });

  app.post('/api/regions', requireApiKey, (req, res) => {
    const p = regionParams(req.body || {});
    if (!p.name) return res.status(400).json({ error: 'name is required' });
    const now = Date.now();
    try {
      const info = sqlite.prepare(`
        INSERT INTO regions (name, trunk_did, outbound_prefix, queue, agent_extensions, inbound_did, inbound_target, inbound_ivr, oblast_1c, color, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(p.name, p.trunk_did, p.outbound_prefix, p.queue, p.agent_extensions, p.inbound_did, p.inbound_target, p.inbound_ivr, p.oblast_1c, p.color, now, now);
      res.status(201).json(regionRowToJson(sqlite.prepare('SELECT * FROM regions WHERE id = ?').get(info.lastInsertRowid)));
    } catch (err) {
      if (String(err.message).includes('regions.name')) {
        return res.status(409).json({ error: 'region with this name already exists' });
      }
      throw err;
    }
  });

  app.put('/api/regions/:id', requireApiKey, (req, res) => {
    const existing = sqlite.prepare('SELECT * FROM regions WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'region not found' });
    const p = regionParams(req.body || {});
    if (!p.name) return res.status(400).json({ error: 'name is required' });
    try {
      sqlite.prepare(`
        UPDATE regions SET name = ?, trunk_did = ?, outbound_prefix = ?, queue = ?,
          agent_extensions = ?, inbound_did = ?, inbound_target = ?, inbound_ivr = ?, oblast_1c = ?, color = ?, updated_at = ?
        WHERE id = ?
      `).run(p.name, p.trunk_did, p.outbound_prefix, p.queue, p.agent_extensions, p.inbound_did, p.inbound_target, p.inbound_ivr, p.oblast_1c, p.color, Date.now(), req.params.id);
      res.json(regionRowToJson(sqlite.prepare('SELECT * FROM regions WHERE id = ?').get(req.params.id)));
    } catch (err) {
      if (String(err.message).includes('regions.name')) {
        return res.status(409).json({ error: 'region with this name already exists' });
      }
      throw err;
    }
  });

  app.delete('/api/regions/:id', requireApiKey, (req, res) => {
    sqlite.prepare('UPDATE contacts SET region_id = NULL WHERE region_id = ?').run(req.params.id);
    sqlite.prepare('DELETE FROM regions WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // Region-scoped contact list (paged). Reuses the same JSON shape the main
  // /api/contacts returns, plus region_id, so the admin table can render it.
  app.get('/api/regions/:id/contacts', requireApiKey, (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const total = sqlite.prepare('SELECT COUNT(*) c FROM contacts WHERE region_id = ?').get(req.params.id).c;
    const rows = sqlite.prepare(`
      SELECT id, code, phone1, phone2, phone3, phone4, company_name, manager_name, operator_extension, region_id, last_call_at
      FROM contacts WHERE region_id = ?
      ORDER BY company_name COLLATE NOCASE ASC
      LIMIT ? OFFSET ?
    `).all(req.params.id, limit, offset);
    res.json({
      total,
      rows: rows.map((r) => ({
        id: r.id,
        code: r.code || '',
        phones: [r.phone1, r.phone2, r.phone3, r.phone4].filter(Boolean),
        companyName: r.company_name || '',
        managerName: r.manager_name || '',
        operatorExtension: r.operator_extension || '',
        regionId: r.region_id,
        lastCallAt: r.last_call_at,
      })),
    });
  });

  // Bulk import of a region's contact sheet (parsed client-side from .xls/.xlsx
  // into { name, phone } rows). Matches an existing contact by phone number and
  // tags it with the region; inserts a new contact when the number is unknown.
  // Rows without a usable phone are skipped by default (they can't be dialled),
  // unless includeNoPhone is set — then they're inserted as name-only members.
  const setRegionStmt = sqlite.prepare('UPDATE contacts SET region_id = ?, updated_at = ? WHERE id = ?');
  const backfillNameStmt = sqlite.prepare(
    "UPDATE contacts SET company_name = ?, updated_at = ? WHERE id = ? AND (company_name IS NULL OR company_name = '')"
  );

  app.post('/api/contacts/import', requireApiKey, (req, res) => {
    const body = req.body || {};
    const regionId = Number(body.regionId);
    const region = sqlite.prepare('SELECT * FROM regions WHERE id = ?').get(regionId);
    if (!region) return res.status(400).json({ error: 'valid regionId is required' });
    const rows = Array.isArray(body.rows) ? body.rows : [];
    if (!rows.length) return res.status(400).json({ error: 'no rows in request body' });
    const includeNoPhone = !!body.includeNoPhone;

    let created = 0;
    let tagged = 0;
    let skipped = 0;
    const now = Date.now();

    const run = sqlite.prepare('BEGIN');
    run.run();
    try {
      for (const row of rows) {
        const name = String((row && row.name) || '').trim();
        const phoneRaw = (row && row.phone) != null ? String(row.phone).trim() : '';
        const norm = normalizePhone(phoneRaw);

        if (!norm) {
          if (includeNoPhone && name) {
            const c = db.createContact({ companyName: name, phones: [] });
            setRegionStmt.run(regionId, now, c.id);
            created++;
          } else {
            skipped++;
          }
          continue;
        }

        const existingId = db.resolveContactIdForNumber(phoneRaw);
        if (existingId) {
          setRegionStmt.run(regionId, now, existingId);
          if (name) backfillNameStmt.run(name, now, existingId);
          tagged++;
        } else {
          const c = db.createContact({ companyName: name, phones: [phoneRaw] });
          setRegionStmt.run(regionId, now, c.id);
          created++;
        }
      }
      sqlite.prepare('COMMIT').run();
    } catch (err) {
      sqlite.prepare('ROLLBACK').run();
      return res.status(500).json({ error: err.message });
    }

    console.log(`[contacts-import] region "${region.name}": ${created} created, ${tagged} tagged, ${skipped} skipped`);
    res.json({ ok: true, region: region.name, created, tagged, skipped, total: rows.length });
  });
}

module.exports = { mountRegions, resolveOutbound, resolveInbound, resolveDidIvr, expandExtensions, ensureSchema };
