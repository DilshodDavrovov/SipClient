'use strict';

// Load server/.env by absolute path, not dotenv's default (relative to
// process.cwd()) — a process manager (PM2, systemd, Docker) can launch this
// script from a different working directory than "server/", which would
// silently skip a real, correctly-filled .env and misreport it as missing.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const AmiClient = require('./ami-client');
const CallStore = require('./call-store');
const CallFlowClient = require('./callflow-client');
const { Db } = require('./db');
const regions = require('./regions');

const {
  AMI_HOST,
  AMI_PORT = '5038',
  AMI_USERNAME,
  AMI_SECRET,
  AMI_ORIGINATE_CONTEXT = 'from-internal',
  AMI_ORIGINATE_PRIORITY = '1',
  AMI_CHANNEL_TECH = 'SIP',
  TRACK_EXTENSIONS = '',
  STAGING_QUEUE = '',
  REDIRECT_CONTEXT = 'from-internal',
  DEFAULT_TARGET = '',
  ONEC_URL = '',
  ONEC_LOGIN = '',
  ONEC_PASSWORD = '',
  SYNC_INTERVAL_MS = '60000',
  HTTP_PORT = '3001',
  API_TOKEN,
  FRONTEND_ORIGIN = '*',
  CALLFLOW_BASE_URL,
  CALLFLOW_USERNAME,
  CALLFLOW_PASSWORD,
} = process.env;

for (const [name, value] of Object.entries({ AMI_HOST, AMI_USERNAME, AMI_SECRET, API_TOKEN })) {
  if (!value) {
    console.error(`[config] Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

// "*" (or nothing at all) = every internal extension the PBX has — see
// CallStore's autoTrack. An explicit comma-separated list still works for
// the rare case where only a subset should ever be watched.
const trackExtensions = TRACK_EXTENSIONS.split(',').map((s) => s.trim()).filter(Boolean);
const trackAll = !trackExtensions.length || trackExtensions.includes('*');

const path = require('path');
const dbFile = path.join(__dirname, '..', 'data', 'app.db');
const db = new Db(dbFile);
// One-time: fold the old append-only JSONL call log (pre-SQLite) into the
// database, then rename it out of the way so this doesn't re-run every boot.
db.importJsonlIfPresent(path.join(__dirname, '..', 'data', 'calls.log.jsonl'));

// The old periodic XML client-list sync (contacts-sync.js) is retired —
// contacts now arrive from the external system via POST /api/contacts/upsert
// (keyed by client code) instead of being polled from an XML feed.

const callStore = new CallStore({ channelTech: AMI_CHANNEL_TECH, trackExtensions, db });

const ami = new AmiClient({ host: AMI_HOST, port: Number(AMI_PORT), username: AMI_USERNAME, secret: AMI_SECRET });
callStore.attach(ami);

// SSH-free inbound region routing: watch a neutral staging queue and, over
// AMI, redirect each caller to their region's queue/ring group by caller
// number. No dialplan/AGI needed — see region-inbound-ami.js for setup.
require('./region-inbound-ami').initRegionInboundAmi({
  ami,
  db,
  stagingQueues: STAGING_QUEUE.split(',').map((s) => s.trim()).filter(Boolean),
  redirectContext: REDIRECT_CONTEXT,
  defaultTarget: DEFAULT_TARGET,
});

// Diagnostics while we bring up click-to-call — logs only events touching a
// tracked extension's own channel (never the whole PBX's traffic, which
// carries other agents' real customer calls). Safe to remove once reliable.
const DEBUG_CHANNEL_RE = trackAll
  ? /^[A-Za-z0-9_]+\/\d{2,5}-/
  : new RegExp(`^[A-Za-z0-9_]+/(${trackExtensions.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})-`, 'i');
function isDebugRelevant(e) {
  return DEBUG_CHANNEL_RE.test(e.Channel || '') || DEBUG_CHANNEL_RE.test(e.Destination || '');
}
for (const name of ['Newchannel', 'OriginateResponse', 'Newstate', 'Dial', 'Hangup']) {
  ami.on(`event:${name}`, (e) => {
    if (isDebugRelevant(e)) console.log(`[ami:event:${name}]`, JSON.stringify(e));
  });
}

let amiConnected = false;
ami.on('banner', (b) => console.log('[ami] connected to', `${AMI_HOST}:${AMI_PORT}`, '-', b));
ami.on('connected', () => {
  amiConnected = true;
  console.log('[ami] login OK, watching extensions:', trackAll ? 'all internal extensions (auto)' : trackExtensions.join(', '));
  // Every (re)connect is exactly when a call could have hung up while we
  // weren't listening — reconcile before anything else touches call state.
  reconcileNow('after (re)connect');
});

// Closes calls whose Hangup was missed, by comparing against Asterisk's live
// channel list. Runs on every AMI (re)connect and then periodically — a lost
// event otherwise leaves a call "В разговоре" in the UI until someone
// restarts the backend.
function reconcileNow(reason) {
  if (!amiConnected) return;
  const snapshotAt = Date.now();
  ami.listActiveChannels()
    .then((channels) => {
      const n = callStore.reconcileWithAsterisk(channels, snapshotAt);
      if (n) console.log(`[ami] reconciled ${n} call(s) no longer live on Asterisk (${reason})`);
    })
    .catch((err) => console.error('[ami] reconcile failed:', err.message));
}
setInterval(() => reconcileNow('periodic'), 2 * 60 * 1000);
ami.on('disconnected', () => { amiConnected = false; console.warn('[ami] disconnected, will retry'); });
ami.on('error', (err) => console.error('[ami] error:', err.message));
ami.connect();

let callflow = null;
if (CALLFLOW_BASE_URL && CALLFLOW_USERNAME && CALLFLOW_PASSWORD) {
  callflow = new CallFlowClient({ baseUrl: CALLFLOW_BASE_URL, username: CALLFLOW_USERNAME, password: CALLFLOW_PASSWORD });
} else {
  console.warn('[callflow] CALLFLOW_* not set in .env — call recording playback disabled');
}

/* ------------------------------------------------------------------ */
/* HTTP API                                                             */
/* ------------------------------------------------------------------ */

const app = express();
app.use(cors({ origin: FRONTEND_ORIGIN === '*' ? true : FRONTEND_ORIGIN.split(',').map((s) => s.trim()) }));
app.use(express.json({ limit: '10mb' }));

function requireApiKey(req, res, next) {
  // Query-param fallback exists so a plain <audio src="...?key=..."> tag can
  // play a recording without JS setting a custom header.
  const key = req.get('X-Api-Key') || req.query.key;
  if (key !== API_TOKEN) {
    return res.status(401).json({ error: 'invalid or missing X-Api-Key' });
  }
  next();
}

app.get('/api/status', requireApiKey, (req, res) => {
  res.json({ amiConnected, trackExtensions: trackAll ? ['*'] : trackExtensions });
});

app.get('/api/calls', requireApiKey, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 300);
  let records = callStore.list(limit);
  if (req.query.extension) {
    records = records.filter((r) => r.operatorExtension === req.query.extension);
  }
  res.json({ records });
});

// Durable, unlimited history search — backed by SQLite (see db.js), unlike
// /api/calls above which only ever sees the last MAX_IN_MEMORY live calls.
// Query params: q (text/phone), from/to (epoch ms), extension, limit, offset.
app.get('/api/history', requireApiKey, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const result = db.searchCalls({
    q: req.query.q,
    from: req.query.from ? Number(req.query.from) : undefined,
    to: req.query.to ? Number(req.query.to) : undefined,
    operator: req.query.extension || undefined,
    status: req.query.status || undefined,
    limit,
    offset,
  });
  res.json(result);
});

// Asterisk Uniqueids look like "<10-digit-epoch-seconds>.<sequence>". The
// outcome picker in app.js deliberately shows this id with the dot stripped
// (one plain integer, harder to drop/misplace a character copying by hand
// into an external system) — put it back before looking anything up. A
// no-op for an id that already has a dot, or doesn't look like a bare
// Uniqueid at all (short-lived synthetic ids like "fail-..." pass through
// unchanged).
function reinsertUniqueidDot(rawId) {
  if (!rawId || rawId.includes('.') || !/^\d{11,}$/.test(rawId)) return rawId;
  return rawId.slice(0, 10) + '.' + rawId.slice(10);
}

app.post('/api/call/:id/outcome', requireApiKey, (req, res) => {
  const { outcome } = req.body || {};
  if (!['booking', 'note', 'declined', 'callback', 'contact'].includes(outcome)) {
    return res.status(400).json({ error: 'invalid outcome' });
  }
  callStore.setOutcome(req.params.id, outcome);
  res.json({ ok: true });
});

// Meant to be called by whatever external system the operator actually
// creates the booking in — not by this app's own UI (the outcome picker
// only shows the call id so the operator can carry it over there). Same
// X-Api-Key auth as everything else; that system needs to be handed the
// API_TOKEN to use this.
app.post('/api/call/:id/booking', requireApiKey, (req, res) => {
  const { amount, info, reference, operatorExtension } = req.body || {};
  const amountNum = Number(amount);
  // 0 and negative both accepted (e.g. a voided/cancelled booking, or a
  // correction against an earlier one) — only actually missing/non-numeric
  // amounts are rejected. Note this can't use `!amount` (0 is falsy).
  if (amount === undefined || amount === null || amount === '' || !Number.isFinite(amountNum)) {
    return res.status(400).json({ error: '"amount" must be a number' });
  }
  const callId = reinsertUniqueidDot(req.params.id);
  const record = callStore.get(callId) || db.getCallRow(callId);
  if (!record) {
    // Doesn't necessarily mean the id is wrong (could be a call this AMI
    // instance genuinely never tracked), but in practice this has been the
    // cause of "the booking counter didn't update" — a mistyped/truncated
    // call id creates a booking nobody can be credited for. Logged loudly
    // since most integrations calling this won't be inspecting the
    // response body closely.
    console.warn(`[booking] no known call for id "${req.params.id}" (looked up as "${callId}") — double-check this id was copied in full (see "callFound" in the response)`);
  }
  // Explicit operatorExtension in the body wins — lets the caller credit
  // the right operator even when the call id above can't be resolved.
  const resolvedOperator = operatorExtension || (record ? record.operatorExtension : undefined);
  const booking = db.createBooking({
    callId,
    operatorExtension: resolvedOperator,
    amount: amountNum,
    info,
    reference,
  });
  // A confirmed booking implies the outcome, whether or not the operator
  // already tagged it manually — keeps the history tag and the bookings
  // ledger from disagreeing with each other.
  callStore.setOutcome(callId, 'booking');
  // This confirmation comes from an external system hitting this endpoint
  // directly — nothing about it flows through the normal AMI event path,
  // so without this push the "Брони" stat tile would just sit stale until
  // its own 60s poll happens to catch up.
  broadcast({ type: 'booking', callId, operatorExtension: resolvedOperator, amount: amountNum });
  res.status(201).json({ ...booking, callFound: !!record });
});

app.get('/api/call/:id/booking', requireApiKey, (req, res) => {
  res.json({ bookings: db.getBookingsForCall(reinsertUniqueidDot(req.params.id)) });
});

app.get('/api/bookings/stats', requireApiKey, (req, res) => {
  res.json(db.getBookingStats({
    operatorExtension: req.query.extension || undefined,
    from: req.query.from ? Number(req.query.from) : undefined,
    to: req.query.to ? Number(req.query.to) : undefined,
  }));
});

const DIAL_TARGET_RE = /^[0-9+*#]{1,32}$/;
const EXT_RE = /^[a-zA-Z0-9_-]{1,32}$/;

app.post('/api/call', requireApiKey, async (req, res) => {
  const { from, to } = req.body || {};
  if (!EXT_RE.test(String(from || ''))) {
    return res.status(400).json({ error: 'invalid "from" extension' });
  }
  if (!DIAL_TARGET_RE.test(String(to || ''))) {
    return res.status(400).json({ error: 'invalid "to" number (digits, +, *, # only)' });
  }
  if (!amiConnected) {
    return res.status(503).json({ error: 'AMI not connected' });
  }

  // Region routing: if this number belongs to a region with an outbound
  // prefix, dial the prefixed target so FreePBX's per-region outbound route
  // picks that region's trunk. Unknown numbers dial through unchanged. The
  // call log still stores the real number (toNumber: to), not the prefix.
  const { dialTarget, region } = regions.resolveOutbound(db.db, to);

  const actionId = 'c2c-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  callStore.registerOrigination(actionId, { operatorExtension: from, toNumber: to });

  try {
    const ack = await ami.sendWithActionId('Originate', actionId, {
      Channel: `${AMI_CHANNEL_TECH}/${from}`,
      Context: AMI_ORIGINATE_CONTEXT,
      Exten: dialTarget,
      Priority: AMI_ORIGINATE_PRIORITY,
      Async: 'true',
      Timeout: 30000,
      CallerID: `CRM Click2Call <${from}>`,
    });
    if (region) console.log(`[ami:originate region] "${region.name}" trunk=${region.trunkDid || '?'} ${to} -> ${dialTarget}`);
    console.log('[ami:originate ack]', JSON.stringify(ack));
    if (ack.Response !== 'Success') {
      return res.status(502).json({ error: ack.Message || 'Originate rejected by Asterisk' });
    }
    res.status(202).json({ queued: true, actionId });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// "Завершить". Must never leave the operator stuck: if the call is no longer
// in memory (or its channel names are unknown — e.g. reloaded from SQLite),
// ask Asterisk which channels of this call are still alive and hang those
// up; if none are, the call is already over — close the record and say so
// (`alreadyEnded`), and the UI resets itself (see hangupAmiCall in app.js).
app.post('/api/call/:id/hangup', requireApiKey, async (req, res) => {
  const id = req.params.id;
  const record = callStore.get(id) || callStore.findByActionId(id) || callStore._reviveFromDb(id) || db.getCallRow(id);
  if (!record) return res.status(404).json({ error: 'call not found (or not established yet)', alreadyEnded: true });
  if (record.endedAt) return res.json({ ok: true, alreadyEnded: true });

  try {
    let channel = callStore.resolveRemoteChannel(record);
    if (!channel && amiConnected) {
      const live = await ami.listActiveChannels();
      const legs = live.filter((c) => c.Uniqueid === record.id || (record.linkedid && c.Linkedid === record.linkedid));
      if (!legs.length) {
        callStore.finalizeMissing(record);
        return res.json({ ok: true, alreadyEnded: true });
      }
      // Prefer the operator's own leg — hanging it up ends the whole call.
      const own = new RegExp(`^${AMI_CHANNEL_TECH}/${record.operatorExtension}-`, 'i');
      channel = (legs.find((c) => own.test(c.Channel)) || legs[0]).Channel;
    }
    if (!channel) return res.status(409).json({ error: 'no channel to hang up yet, try again shortly' });

    const ack = await ami.send('Hangup', { Channel: channel });
    if (ack.Response !== 'Success' && /no such channel/i.test(ack.Message || '')) {
      // The channel is already gone — the Hangup event was missed.
      callStore.finalizeMissing(record);
      return res.json({ ok: true, alreadyEnded: true });
    }
    res.json({ ok: ack.Response === 'Success', message: ack.Message });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/call/:id/dtmf', requireApiKey, async (req, res) => {
  const { digit } = req.body || {};
  if (!/^[0-9*#A-D]$/.test(String(digit || ''))) {
    return res.status(400).json({ error: 'invalid digit' });
  }
  const record = callStore.get(req.params.id) || callStore.findByActionId(req.params.id);
  if (!record) return res.status(404).json({ error: 'call not found' });
  const channel = callStore.resolveRemoteChannel(record);
  if (!channel) return res.status(409).json({ error: 'no active channel' });

  try {
    const ack = await ami.send('PlayDTMF', { Channel: channel, Digit: digit });
    res.json({ ok: ack.Response === 'Success', message: ack.Message });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/call/:id/transfer', requireApiKey, async (req, res) => {
  const { to } = req.body || {};
  if (!DIAL_TARGET_RE.test(String(to || ''))) {
    return res.status(400).json({ error: 'invalid "to" number (digits, +, *, # only)' });
  }
  const record = callStore.get(req.params.id) || callStore.findByActionId(req.params.id);
  if (!record) return res.status(404).json({ error: 'call not found' });
  const remoteChannel = callStore.resolveRemoteChannel(record);
  if (!remoteChannel) return res.status(409).json({ error: 'no active channel to transfer' });

  try {
    // Blind transfer: redirect the far end's own channel back into the same
    // dialplan context/priority used for outbound dialing (the one already
    // proven to work via click-to-call), so it dials the new number
    // directly. The operator's own leg is then hung up to complete the
    // handoff — leaving the far end alone, still connected to the new call.
    const ack = await ami.send('Redirect', {
      Channel: remoteChannel,
      Context: AMI_ORIGINATE_CONTEXT,
      Exten: to,
      Priority: AMI_ORIGINATE_PRIORITY,
    });
    if (ack.Response !== 'Success') {
      return res.status(502).json({ error: ack.Message || 'Redirect rejected by Asterisk' });
    }
    const operatorChannel = record.channels.operator;
    if (operatorChannel && operatorChannel !== remoteChannel) {
      await ami.send('Hangup', { Channel: operatorChannel }).catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/call/:id/conference', requireApiKey, async (req, res) => {
  const { to } = req.body || {};
  if (!DIAL_TARGET_RE.test(String(to || ''))) {
    return res.status(400).json({ error: 'invalid "to" number (digits, +, *, # only)' });
  }
  const record = callStore.get(req.params.id) || callStore.findByActionId(req.params.id);
  if (!record) return res.status(404).json({ error: 'call not found' });
  const operatorChannel = record.channels.operator;
  const remoteChannel = callStore.resolveRemoteChannel(record);
  if (!operatorChannel || !remoteChannel) {
    return res.status(409).json({ error: 'no active channels to add to a conference' });
  }

  // Rebuilt after a live test came back "Context not specified": that was
  // `Action: Redirect` with Application/Data, which Redirect (unlike
  // Originate) simply doesn't accept — it always wants Context/Exten/
  // Priority, and we don't control this PBX's dialplan well enough to know
  // an extension that runs ConfBridge(). This version instead uses
  // Asterisk's native bridging-core AMI actions (BridgeCreate/
  // BridgeAddChannel) throughout — no ConfBridge() dialplan app, no
  // dialplan cooperation needed at all, just move channels between bridge
  // objects directly.
  const room = 'conf-' + String(record.id).replace(/[^0-9]/g, '').slice(-8);
  try {
    // BridgeType deliberately omitted — not confident enough of the exact
    // accepted values to risk another "invalid parameter"-style rejection;
    // Asterisk's own default for an unspecified type is a normal
    // multi-party-capable bridge, which is exactly what's needed here.
    const created = await ami.send('BridgeCreate', { BridgeUniqueid: room });
    if (created.Response !== 'Success') {
      // Not necessarily fatal — e.g. a second "add to conference" on the
      // same call hits an already-existing room; only BridgeAddChannel
      // failing below is treated as a real error.
      console.warn('[conference] BridgeCreate:', created.Message);
    }

    const addOperator = await ami.send('BridgeAddChannel', { BridgeUniqueid: room, Channel: operatorChannel });
    const addRemote = await ami.send('BridgeAddChannel', { BridgeUniqueid: room, Channel: remoteChannel });
    if (addOperator.Response !== 'Success' || addRemote.Response !== 'Success') {
      return res.status(502).json({ error: addOperator.Message || addRemote.Message || 'Could not move the call into a conference bridge' });
    }

    // Dial the third party the same reliable way click2call dials any
    // outside number (a Local channel into the normal outbound dialplan
    // context/extension) — "/n" disables Local-channel optimization, so the
    // ;1 leg referenced below for BridgeAddChannel doesn't get silently
    // melded away by Asterisk the moment it answers.
    const actionId = 'conf-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

    // Deliberately not awaited: the frontend's own request timeout (15s) is
    // shorter than a ring could reasonably take, so the HTTP response goes
    // back as soon as the invite is queued. The operator and remote party
    // are already talking in `room` at this point regardless of whether
    // this third leg ever answers — a failure here just means no third
    // voice joins; logged for troubleshooting, nothing left broken.
    ami.waitForEvent('event:OriginateResponse', (evt) => evt.ActionID === actionId, 35000)
      .then(async (evt) => {
        if (evt.Response !== 'Success') {
          console.warn(`[conference] ${to} did not join ${room}: ${evt.Reason || evt.Message || 'no answer'}`);
          return;
        }
        const addThird = await ami.send('BridgeAddChannel', { BridgeUniqueid: room, Channel: evt.Channel });
        if (addThird.Response !== 'Success') {
          console.error(`[conference] failed to add ${evt.Channel} to ${room}:`, addThird.Message);
        } else {
          console.log(`[conference] ${to} joined ${room}`);
        }
      })
      .catch((err) => console.error('[conference] background join wait failed:', err.message));

    const ack = await ami.sendWithActionId('Originate', actionId, {
      Channel: `Local/${to}@${AMI_ORIGINATE_CONTEXT}/n`,
      Application: 'Wait',
      Data: '3600',
      Async: 'true',
      Timeout: 30000,
      CallerID: `CRM Conference <${record.operatorExtension}>`,
    });
    if (ack.Response !== 'Success') {
      return res.status(502).json({ error: ack.Message || 'Originate rejected by Asterisk' });
    }
    res.status(202).json({ ok: true, room });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/call/:id/recording', requireApiKey, async (req, res) => {
  if (!callflow) return res.status(503).json({ error: 'recording lookup not configured on this backend' });

  // Falls back to SQLite for calls old enough to have aged out of the
  // in-memory working set (see call-store.js) — recording playback used to
  // only work for the last ~300 calls; with history search now unlimited,
  // this needs to reach just as far back.
  const record = callStore.get(req.params.id) || callStore.findByActionId(req.params.id) || db.getCallRow(req.params.id);
  if (!record) return res.status(404).json({ error: 'call not found' });

  try {
    // The report-page search behind findRecordingFilename is the slow part
    // (it scans CallFlow's own log) — cache a hit in SQLite so replaying the
    // same call doesn't repeat that search every time.
    let filename = record.recordingFilename || null;
    if (!filename) {
      filename = await callflow.findRecordingFilename(record.id, record.operatorExtension, record.startedAt);
      if (filename) db.setCallRecordingFilename(record.id, filename);
    }
    if (!filename) return res.status(404).json({ error: 'no recording found for this call' });

    const dateStr = CallFlowClient.tashkentDate(record.startedAt);
    const upstream = await callflow.fetchRecording(filename, dateStr);
    if (!upstream.ok) return res.status(502).json({ error: 'CallFlow returned HTTP ' + upstream.status });

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.set('Content-Type', upstream.headers.get('content-type') || 'audio/wav');
    res.set('Content-Disposition', upstream.headers.get('content-disposition') || `inline; filename="${filename}"`);
    res.send(buf);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Contacts                                                             */
/* ------------------------------------------------------------------ */

app.get('/api/contacts', requireApiKey, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  res.json(db.listContacts({ q: req.query.q, limit, offset }));
});

// Registered before /api/contacts/:id so "lookup" doesn't get swallowed as
// an :id value. Backs the post-call outcome picker's context line: is this
// number a known contact, and when (if ever) did we last talk to it?
app.get('/api/contacts/lookup', requireApiKey, (req, res) => {
  const { number, excludeCallId } = req.query;
  if (!number) return res.status(400).json({ error: '"number" query param is required' });
  const contactId = db.resolveContactIdForNumber(number);
  const contact = contactId ? db.getContact(contactId) : null;
  const lastCall = db.findLastCallForNumber(number, excludeCallId);
  res.json({ contact, lastCall });
});

app.get('/api/contacts/:id', requireApiKey, (req, res) => {
  const contact = db.getContact(req.params.id);
  if (!contact) return res.status(404).json({ error: 'contact not found' });
  const calls = db.listCallsForContact(req.params.id, { limit: 200 });
  res.json({ contact, calls: calls.records, callsTotal: calls.total });
});

// Up to 4 interchangeable phones per contact (phones: ["...", ...]); at
// least one non-empty is required from the UI paths here. Flat phone1..4
// and the legacy phonePrimary/phoneBackup keys are accepted too (see
// contactPhonesFromData in db.js).
function contactBodyHasPhone(body) {
  const phones = Array.isArray(body.phones)
    ? body.phones
    : [body.phone1, body.phone2, body.phone3, body.phone4, body.phonePrimary, body.phoneBackup];
  return phones.some((p) => p && String(p).trim());
}

// The client code is unique (see idx_contacts_code_unique in db.js) — a
// save that reuses another contact's code violates that index; turn the
// raw SQLite error into a response the UI can show as-is.
function handleContactSaveError(res, err) {
  if (String(err.message).includes('contacts.code')) {
    return res.status(409).json({ error: 'контакт с таким кодом уже существует' });
  }
  throw err;
}

app.post('/api/contacts', requireApiKey, (req, res) => {
  if (!contactBodyHasPhone(req.body || {})) {
    return res.status(400).json({ error: 'at least one phone number is required' });
  }
  try {
    res.status(201).json(db.createContact(req.body));
  } catch (err) {
    handleContactSaveError(res, err);
  }
});

app.put('/api/contacts/:id', requireApiKey, (req, res) => {
  if (!db.getContact(req.params.id)) return res.status(404).json({ error: 'contact not found' });
  if (!contactBodyHasPhone(req.body || {})) {
    return res.status(400).json({ error: 'at least one phone number is required' });
  }
  try {
    res.json(db.updateContact(req.params.id, req.body));
  } catch (err) {
    handleContactSaveError(res, err);
  }
});

// Import/refresh of the client book from the external booking system, keyed
// by the client code (the contact's durable unique identifier). Accepts one
// contact object, a bare array, or { contacts: [...] }; each item's fields:
// code (required), phones (array of up to 4, or flat phone1..phone4 keys),
// companyName, managerName, operatorExtension, comment. Re-sending an
// existing code updates that contact in place (only the fields present in
// the item — see upsertContactByCode in db.js); an unknown code creates a
// new contact, EXCEPT when one of its numbers matches a pre-existing
// contact that has no code yet — then the code is attached to that contact
// instead of duplicating it. Same X-Api-Key auth as everything else; see
// the "Интеграция с 1С" section in the project README for examples.
app.post('/api/contacts/upsert', requireApiKey, (req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body) ? body : (Array.isArray(body.contacts) ? body.contacts : [body]);
  if (!items.length) return res.status(400).json({ error: 'no contacts in request body' });

  let created = 0;
  let updated = 0;
  const results = items.map((item, index) => {
    const code = item && String(item.code || '').trim();
    if (!code) return { index, error: '"code" is required' };
    try {
      const r = db.upsertContactByCode(item);
      if (r.created) created++; else updated++;
      // `adopted: true` marks a pre-existing code-less contact that matched
      // by phone number and had this code attached to it (counted as updated).
      return { index, code, id: r.contact.id, created: r.created, adopted: r.adopted };
    } catch (err) {
      return { index, code, error: err.message };
    }
  });
  const errors = results.filter((r) => r.error).length;
  console.log(`[contacts-upsert] processed ${items.length} item(s): ${created} created, ${updated} updated, ${errors} error(s)`);
  res.status(errors === items.length ? 400 : 200).json({ ok: errors === 0, created, updated, errors, results });
});

app.get('/api/contacts/by-code/:code', requireApiKey, (req, res) => {
  const contact = db.getContactByCode(req.params.code);
  if (!contact) return res.status(404).json({ error: 'contact not found' });
  res.json(contact);
});

app.delete('/api/contacts/:id', requireApiKey, (req, res) => {
  db.deleteContact(req.params.id);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Notes                                                                */
/* ------------------------------------------------------------------ */

app.get('/api/notes', requireApiKey, (req, res) => {
  res.json({ notes: db.listNotes({ contactId: req.query.contactId }) });
});

app.post('/api/notes', requireApiKey, (req, res) => {
  const { text, number } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: '"text" is required' });
  const id = 'note-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  res.status(201).json(db.createNote({
    id,
    callId: req.body.callId,
    number,
    name: req.body.name,
    text,
    operatorExtension: req.body.operatorExtension,
  }));
});

app.put('/api/notes/:id', requireApiKey, (req, res) => {
  const { text } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: '"text" is required' });
  res.json(db.updateNote(req.params.id, text));
});

app.delete('/api/notes/:id', requireApiKey, (req, res) => {
  db.deleteNote(req.params.id);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Callbacks                                                            */
/* ------------------------------------------------------------------ */

app.get('/api/callbacks', requireApiKey, (req, res) => {
  res.json({ callbacks: db.listCallbacks() });
});

app.post('/api/callbacks', requireApiKey, (req, res) => {
  const { number, dueAt } = req.body || {};
  if (!number || !dueAt || isNaN(Number(dueAt))) {
    return res.status(400).json({ error: '"number" and "dueAt" are required' });
  }
  const id = 'cb-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  res.status(201).json(db.createCallback({
    id,
    callId: req.body.callId,
    number,
    name: req.body.name,
    dueAt: Number(dueAt),
    operatorExtension: req.body.operatorExtension,
  }));
});

app.delete('/api/callbacks/:id', requireApiKey, (req, res) => {
  db.deleteCallback(req.params.id);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Regions (admin panel: region CRUD, contact import, region routing)   */
/* ------------------------------------------------------------------ */

regions.mountRegions(app, { db, requireApiKey });

/* ------------------------------------------------------------------ */
/* Reports for 1C: operator analytics + per-call client info — see      */
/* reports.js. Was left unmounted when the file landed, so both routes  */
/* answered 404 on prod.                                                */
/* ------------------------------------------------------------------ */
const { mountReports } = require('./reports');
mountReports(app, { db, requireApiKey });

/* ------------------------------------------------------------------ */
/* 1C contact sync — polls the 1C service per region every minute and   */
/* upserts counterparties (replaces the manual Excel upload).           */
/* ------------------------------------------------------------------ */
const { initContactsSync } = require('./contacts-sync-1c');
const contactsSync = initContactsSync({
  db,
  url: ONEC_URL,
  login: ONEC_LOGIN,
  password: ONEC_PASSWORD,
  intervalMs: Number(SYNC_INTERVAL_MS) || 60000,
});
contactsSync.start();

// Sync status for the admin panel, and a manual "sync now" trigger.
app.get('/api/sync/status', requireApiKey, (req, res) => res.json(contactsSync.getStatus()));
app.post('/api/sync/run', requireApiKey, async (req, res) => {
  const status = await contactsSync.syncNow();
  res.json(status);
});

/* ------------------------------------------------------------------ */
/* WebSocket: live call events                                          */
/* ------------------------------------------------------------------ */

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.searchParams.get('token') !== API_TOKEN) {
    ws.close(4401, 'invalid token');
    return;
  }
  // The whole in-memory working set, not just the last 100: with every
  // extension tracked, one operator's own recent calls are a thin slice
  // of the total, and the browser filters this down to its extension.
  ws.send(JSON.stringify({ type: 'snapshot', records: callStore.list(300), amiConnected }));
});

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

callStore.on('update', (record) => broadcast({ type: 'update', record }));
callStore.on('incoming', (record) => broadcast({ type: 'incoming', record }));
ami.on('connected', () => broadcast({ type: 'ami_status', amiConnected: true }));
ami.on('disconnected', () => broadcast({ type: 'ami_status', amiConnected: false }));

server.listen(Number(HTTP_PORT), () => {
  console.log(`[http] SIP operator AMI backend listening on http://localhost:${HTTP_PORT}`);
});
