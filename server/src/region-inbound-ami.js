'use strict';

const regions = require('./regions');

/**
 * SSH-free inbound region routing, driven entirely over AMI — no dialplan
 * edit, no AGI, no custom context. Works with just an AMI token.
 *
 * Why: FreePBX's own inbound routing keys off the DIALLED number (the DID),
 * so one shared DID can't be split by WHO is calling. We instead let every
 * inbound call land in a neutral STAGING QUEUE, then move each caller to the
 * right region's queue/ring group over AMI, based on the caller's number.
 *
 * FreePBX setup (GUI only):
 *   1. Applications -> Queues: create a staging queue, e.g. 5000 — no members,
 *      Music-on-hold on, a "Fail Over Destination" (safety, e.g. your IVR),
 *      and a Max Wait Time (e.g. 30s) so a caller can't get stuck if this
 *      backend is down.
 *   2. Create per-region queues/ring groups whose members are that region's
 *      extensions (701xx / 801xx / 901xx). Their numbers are each region's
 *      "Вх. назначение" (inbound_target) in the admin panel.
 *   3. Inbound Route for the shared DID (557041122) -> Destination = the
 *      staging queue (5000). Repeat for every shared DID.
 *   4. server/.env: STAGING_QUEUE=5000  (comma-separate if several).
 *
 * On QueueCallerJoin for a staging queue: read CallerIDNum, resolve the
 * region (by caller number, DID as tiebreaker), and AMI-Redirect the caller
 * channel to `${REDIRECT_CONTEXT},<inbound_target>,1` (from-internal covers
 * queues, ring groups and extensions in FreePBX). Unknown callers are left
 * in the staging queue to hit its Fail Over Destination.
 *
 * Requires the AMI user to receive queue events (read class `call`/`agent` —
 * the same classes this backend already uses for Dial/Hangup, so if
 * click-to-call history works, these arrive too).
 */
function initRegionInboundAmi({ ami, db, stagingQueues, redirectContext = 'from-internal', defaultTarget = '', log = console }) {
  const sqlite = db.db;
  const staging = new Set((stagingQueues || []).map((s) => String(s).trim()).filter(Boolean));

  if (!staging.size) {
    log.log('[region-inbound] STAGING_QUEUE not set — AMI inbound routing disabled');
    return;
  }
  log.log(`[region-inbound] AMI inbound routing on staging queue(s) [${[...staging].join(', ')}] -> redirect via ${redirectContext}`
    + (defaultTarget ? `; unknown callers -> ${defaultTarget}` : '; unknown callers left in staging'));

  // A target is either a bare number (dialled in redirectContext) or an
  // explicit "context,exten[,priority]" — the latter lets DEFAULT_TARGET be
  // an IVR (e.g. "ivr-3,s,1"), which isn't reachable as a plain from-internal
  // number. Region targets are normally bare queue/ring-group numbers.
  function targetParams(channel, target) {
    const parts = String(target).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      return { Channel: channel, Context: parts[0], Exten: parts[1], Priority: parts[2] || '1' };
    }
    return { Channel: channel, Context: redirectContext, Exten: parts[0], Priority: '1' };
  }

  // De-dupe: a caller can generate more than one QueueCallerJoin (rejoin on
  // timeout); redirect each channel once. Entries self-expire.
  const handled = new Set();
  function markHandled(uid) {
    handled.add(uid);
    setTimeout(() => handled.delete(uid), 60000);
  }

  ami.on('event:QueueCallerJoin', async (evt) => {
    try {
      const queue = String(evt.Queue || '');
      if (!staging.has(queue)) return;

      const channel = evt.Channel;
      const uid = evt.Uniqueid || channel;
      if (!channel || handled.has(uid)) return;

      const caller = String(evt.CallerIDNum || '').trim();

      // Best-effort DID (FreePBX sets FROM_DID) as the region tiebreaker for
      // the rare caller tagged to more than one region. Short timeout so a
      // slow reply never delays the redirect much; caller-number match is
      // enough on its own when this comes back empty.
      let did = '';
      try {
        const gv = await ami.send('Getvar', { Channel: channel, Variable: 'FROM_DID' }, 2500);
        if (gv && gv.Response === 'Success' && gv.Value && gv.Value !== '(null)') did = gv.Value;
      } catch (e) { /* ignore — DID is optional */ }

      const r = regions.resolveInbound(sqlite, caller, did);

      // Unknown caller: redirect to DEFAULT_TARGET (e.g. the IVR) right away
      // if set, so they don't sit in the staging queue until it times out. If
      // DEFAULT_TARGET is empty, leave them in the queue for its own failover.
      if (!r.found || !r.target) {
        // Unknown caller: prefer the IVR of the region that owns the DID this
        // call arrived on (per-trunk IVR split), else the global DEFAULT_TARGET,
        // else leave in the staging queue for its own failover.
        const didIvr = regions.resolveDidIvr(sqlite, did);
        const fallback = didIvr || defaultTarget;
        if (!fallback) {
          log.log(`[region-inbound] caller "${caller}" (did ${did || '?'}) -> no region; left in staging for failover`);
          return;
        }
        markHandled(uid);
        const dack = await ami.send('Redirect', targetParams(channel, fallback));
        log.log(`[region-inbound] caller "${caller}" (did ${did || '?'}) -> unknown, ${didIvr ? 'region IVR' : 'default'} ${fallback} (${channel}): ${dack.Response}`);
        return;
      }

      markHandled(uid);
      const ack = await ami.send('Redirect', targetParams(channel, r.target));
      log.log(`[region-inbound] caller "${caller}" -> region "${r.region.name}" target ${r.target} (${channel}): ${ack.Response}${ack.Response !== 'Success' ? ' — ' + (ack.Message || '') : ''}`);
    } catch (err) {
      log.log('[region-inbound] handler error:', err.message);
    }
  });
}

module.exports = { initRegionInboundAmi };
