'use strict';

const EventEmitter = require('events');

const MAX_IN_MEMORY = 300;
// An "in progress" record older than this is treated as stale for memory
// eviction purposes (no real call lasts this long; see _pruneMemory).
const STALE_ACTIVE_MS = 12 * 60 * 60 * 1000;
const MAX_EXTEN_CACHE = 2000;

/**
 * Turns raw AMI events into a list of "calls" for the operator UI, and keeps
 * enough live state to route hangup/DTMF actions to the right channel.
 *
 * Two ways a call enters this store:
 *  - click2call: we originated it ourselves (see registerOrigination). We
 *    already know the destination number, so no guessing is needed there.
 *  - manual: observed passively (call placed from a real phone like MicroSIP,
 *    or a genuine inbound call). Built from Dial/Newexten events for the
 *    extensions listed in TRACK_EXTENSIONS. Number extraction here is
 *    best-effort (see resolveDialedNumber) since Asterisk doesn't hand it to
 *    us as one clean field.
 *
 * Emits:
 *  - 'update' (record)         call created or changed
 *  - 'incoming' (record)       a new inbound call started ringing (screen-pop)
 *
 * Durable storage lives in SQLite (see db.js), not here: every 'update' is
 * also upserted there (see _emitUpdate), which is what backs unlimited
 * history search/period filtering and the contact call-history lookup. This
 * class's own `records` Map is deliberately just a bounded, in-memory
 * working set for live call-state correlation (byUniqueid etc.) — it is
 * pruned back to MAX_IN_MEMORY and is never the source of truth for history.
 */
class CallStore extends EventEmitter {
  constructor({ channelTech, trackExtensions, db }) {
    super();
    this.channelTech = channelTech;
    this.trackExtensions = trackExtensions;
    // No explicit list (or a "*" in it) = watch every internal extension
    // the PBX has, not a hand-maintained subset. This is what makes calls
    // placed/answered on the operators' own SIP phones (MicroSIP) show up
    // for every operator, including ones added after this was configured.
    this.autoTrack = !trackExtensions.length || trackExtensions.includes('*');
    this.db = db;

    this.records = new Map(); // recordId -> record
    this.byUniqueid = new Map(); // any leg's Uniqueid -> recordId
    this.pendingOriginations = new Map(); // actionId -> { operatorExtension, toNumber, createdAt }
    this.lastExtenByChannel = new Map(); // channel -> { exten, context, app, appData }

    this._preloadFromDb();
  }

  attach(ami) {
    // Kept for _onDialEnd's auto-hangup (see there) — needs to issue its own
    // AMI action outside of any request/response cycle, not just listen.
    this.ami = ami;
    ami.on('event:OriginateResponse', (e) => this._onOriginateResponse(e));
    ami.on('event:Newchannel', (e) => this._onNewchannel(e));
    ami.on('event:Newexten', (e) => this._onNewexten(e));
    ami.on('event:Newstate', (e) => this._onNewstate(e));
    // Asterisk <= 11 emits one "Dial" event with SubEvent Begin/End; 12+
    // (this PBX — AMI 11.0.0 banner, DestChannel/DialString fields) emits
    // separate DialBegin/DialEnd. Same handlers, both spellings.
    ami.on('event:Dial', (e) => this._onDial(e));
    ami.on('event:DialBegin', (e) => this._onDialBegin(e));
    ami.on('event:DialEnd', (e) => this._onDialEnd(e));
    ami.on('event:Hangup', (e) => this._onHangup(e));
  }

  registerOrigination(actionId, { operatorExtension, toNumber }) {
    this.pendingOriginations.set(actionId, { operatorExtension, toNumber, createdAt: Date.now() });
    // Don't let a lost/never-answered OriginateResponse leak memory forever.
    setTimeout(() => this.pendingOriginations.delete(actionId), 5 * 60 * 1000);
  }

  list(limit = 100) {
    return [...this.records.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }

  get(id) {
    return this.records.get(id) || null;
  }

  // Outcome tagging (post-call outcome picker) goes through here rather than
  // straight to the DB so that (a) an in-memory record — if this call is
  // still recent enough to have one — picks up `outcome` too, since that's
  // what the frontend's amiRecordToEntry() reads to render the tag, and (b)
  // re-emitting 'update' broadcasts the change over the WS to every
  // connected operator live, the same way notes/callbacks are already
  // shared — not just the browser tab that set it.
  setOutcome(id, outcome) {
    if (this.db) this.db.setCallOutcome(id, outcome);
    const record = this.records.get(id);
    if (record) {
      record.outcome = outcome;
      this._emitUpdate(record);
    }
  }

  // Cross-checks every record we still think is "active" (no endedAt)
  // against Asterisk's actual live channel list (see AmiClient.
  // listActiveChannels — call this with its result) and force-finalizes
  // any that no longer correspond to a real channel there. Exists because
  // a dropped/restarted AMI connection can miss the one Hangup event a
  // call needed to ever be marked ended — without this, that call stays
  // "active" forever: stuck in the UI, and hangup/DTMF on it fail with "no
  // channel" since there's nothing left to target. Matched by Linkedid
  // (falls back to the record's own id/Uniqueid) rather than by channel
  // name, since a record reloaded from SQLite after a restart never had
  // channel names persisted (see db.js rowToRecord) — only call
  // correlation ids survive that round-trip.
  reconcileWithAsterisk(liveChannelEvents, snapshotAt = Date.now()) {
    const liveLinkedids = new Set();
    const liveUniqueids = new Set();
    for (const evt of liveChannelEvents) {
      if (evt.Linkedid) liveLinkedids.add(evt.Linkedid);
      if (evt.Uniqueid) liveUniqueids.add(evt.Uniqueid);
    }

    // A call that began around the moment the channel list was taken may
    // simply not be in it yet — never treat those as gone.
    const tooFresh = (r) => (r.startedAt || 0) > snapshotAt - 10000;
    const isLive = (r) => tooFresh(r) || (r.linkedid && liveLinkedids.has(r.linkedid)) || liveUniqueids.has(r.id);

    let finalized = 0;
    for (const record of this.records.values()) {
      if (record.endedAt || isLive(record)) continue;
      if (this.finalizeMissing(record)) finalized++;
    }

    // Rows that are unfinished in the DB but no longer in memory (evicted
    // before the fix in _pruneMemory, or orphaned by a restart). They ended
    // at an unknown time — close them at their last known moment so the
    // history doesn't show multi-day "conversations".
    if (this.db) {
      let stale = [];
      try { stale = this.db.listUnfinishedCalls(); } catch (err) { stale = []; }
      for (const record of stale) {
        if (this.records.has(record.id) || isLive(record)) continue;
        if (this.finalizeMissing(record, record.answeredAt || record.startedAt)) finalized++;
      }
    }
    return finalized;
  }

  // Which channel to target for hangup/DTMF: for an incoming call that's the
  // operator's own ringing/bridged leg (hanging it up ends the whole call);
  // for an outgoing call it's the destination leg when known (so DTMF reaches
  // the far end, and hangup drops the bridge) falling back to the operator leg.
  resolveRemoteChannel(record) {
    if (!record) return null;
    if (record.direction === 'incoming') {
      return record.channels.operator || record.channels.other || null;
    }
    return record.channels.destination || record.channels.operator || null;
  }

  findByActionId(actionId) {
    for (const record of this.records.values()) {
      if (record.actionId === actionId) return record;
    }
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* Channel-name helpers                                               */
  /* ---------------------------------------------------------------- */

  // Channel name -> the tracked extension it belongs to, or null. Any
  // channel technology is accepted (mixed PJSIP/SIP installs exist and
  // AMI_CHANNEL_TECH only matters for our own Originate). In auto mode
  // every internal-extension-looking channel counts: 2..5 digits right
  // after "TECH/", which keeps trunk channels (named after the provider,
  // or a long account number) and Local/... legs out.
  _matchTrackedExtension(channelName) {
    if (!channelName) return null;
    if (this.autoTrack) {
      const m = /^[A-Za-z0-9_]+\/(\d{2,5})-/.exec(channelName);
      return m ? m[1] : null;
    }
    for (const ext of this.trackExtensions) {
      const re = new RegExp(`^[A-Za-z0-9_]+/${ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-`, 'i');
      if (re.test(channelName)) return ext;
    }
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* Event handlers                                                     */
  /* ---------------------------------------------------------------- */

  _onOriginateResponse(evt) {
    const pending = this.pendingOriginations.get(evt.ActionID);
    if (!pending) return; // not one of ours (or already handled)
    this.pendingOriginations.delete(evt.ActionID);

    // _onNewchannel may already have claimed this by channel name and
    // created the record (see there for why) — update it in place instead
    // of creating a second, duplicate one.
    const existing = pending.uniqueid && this.records.get(pending.uniqueid);

    if (evt.Response === 'Failure') {
      const record = existing || this._newRecord({
        id: 'fail-' + evt.ActionID,
        actionId: evt.ActionID,
        operatorExtension: pending.operatorExtension,
        direction: 'outgoing',
        source: 'click2call',
        counterpartyNumber: pending.toNumber,
        startedAt: pending.createdAt,
      });
      record.state = 'operator_no_answer';
      record.disposition = evt.Reason === '0' ? 'FAILED' : (evt.Reason || 'FAILED');
      record.endedAt = Date.now();
      this._emitUpdate(record);
      return;
    }

    const record = existing || this._newRecord({
      id: evt.Uniqueid,
      actionId: evt.ActionID,
      operatorExtension: pending.operatorExtension,
      direction: 'outgoing',
      source: 'click2call',
      counterpartyNumber: pending.toNumber,
      startedAt: pending.createdAt,
    });
    // Only move state forward: on this PBX the channel's Newstate("Up") —
    // handled in _onNewstate — often arrives before this very event, since
    // OriginateResponse only fires once the agent leg reaches a final
    // state. Don't stomp "answered" back to an earlier-looking state if
    // that already happened.
    if (record.state !== 'answered') record.state = 'ringing_destination';
    record.channels.operator = evt.Channel;
    this.byUniqueid.set(evt.Uniqueid, record.id);
    this._emitUpdate(record);
  }

  // Three jobs, in order:
  //  1. Recognize the SECOND leg of a call we're already tracking — e.g. the
  //     trunk channel Asterisk creates to actually dial the destination once
  //     the operator (or the initiating extension) has answered/is already
  //     up. Same Linkedid as an existing record, different channel. This is
  //     how we later learn when the CLIENT (not the operator) actually
  //     answers — see _onNewstate — instead of mistaking "operator picked
  //     up their own phone" for "the call connected".
  //  2. Claim the channel for our own pending click2call as soon as it
  //     exists. Waiting for OriginateResponse to learn the Uniqueid (as
  //     this used to) is too late on this PBX: the channel's Newstate("Up")
  //     — the agent answering — can arrive *before* OriginateResponse does,
  //     and with no record registered yet under that Uniqueid, _onNewstate
  //     has nothing to update. Matching by channel name (tech/extension)
  //     lets us register it right away instead.
  //  3. Otherwise, detect manually-placed outgoing calls (a real phone, or a
  //     browser over WebRTC — anything that isn't our own click2call
  //     Originate): these never produced a matching "Dial" event on this
  //     PBX for some dialplans, so they weren't getting tracked at all.
  //     Newchannel's own Exten field already has the real destination here
  //     (the channel is created only once the dialplan already matched it).
  //     Inbound calls are deliberately NOT detected here — at this exact
  //     moment Asterisk hasn't populated the caller's identity yet (it's
  //     "<unknown>"/the extension's own number); see _onNewstate instead,
  //     once the channel actually starts ringing.
  _onNewchannel(evt) {
    const { Channel, Uniqueid, Exten, Linkedid } = evt;
    if (this.byUniqueid.has(Uniqueid)) return; // already tracked

    for (const record of this.records.values()) {
      if (record.endedAt || !record.linkedid || record.linkedid !== Linkedid) continue;
      // Only an OUTGOING call has a "destination" leg to discover. An
      // inbound ring-group call shares one Linkedid across every operator
      // channel it rings — adopting PJSIP/102 as the destination of 101's
      // record would credit 101 with the answer when 102 picks up (and
      // leave 102 with no record at all). Another operator's own channel
      // is never our destination, even for an internal extension-to-
      // extension call: they get their own inbound record via _onNewstate.
      if (record.direction !== 'outgoing') continue;
      if (this._matchTrackedExtension(Channel)) continue;
      if (record.channels.operator === Channel || record.channels.destination) continue;
      record.channels.destination = Channel;
      this.byUniqueid.set(Uniqueid, record.id);
      this._emitUpdate(record);
      return;
    }

    for (const [actionId, pending] of this.pendingOriginations) {
      if (pending.uniqueid) continue; // this pending origination already claimed a channel
      const re = new RegExp(`^${this.channelTech}/${pending.operatorExtension}-`, 'i');
      if (!re.test(Channel)) continue;

      pending.uniqueid = Uniqueid;
      const record = this._newRecord({
        id: Uniqueid,
        actionId,
        linkedid: Linkedid,
        operatorExtension: pending.operatorExtension,
        direction: 'outgoing',
        source: 'click2call',
        counterpartyNumber: pending.toNumber,
        startedAt: pending.createdAt,
      });
      record.channels.operator = Channel;
      this.byUniqueid.set(Uniqueid, record.id);
      this._emitUpdate(record);
      return;
    }

    const ext = this._matchTrackedExtension(Channel);
    if (!ext) return; // not one of ours
    if (!Exten || Exten === 's' || Exten === ext) return; // nothing dialed yet / could be an inbound ring-target — leave it to _onNewstate

    const record = this._newRecord({
      id: Uniqueid,
      linkedid: Linkedid,
      operatorExtension: ext,
      direction: 'outgoing',
      source: 'manual',
      counterpartyNumber: Exten,
      startedAt: Date.now(),
    });
    record.state = 'ringing_destination';
    record.channels.operator = Channel;
    this.byUniqueid.set(Uniqueid, record.id);
    this._emitUpdate(record);
  }

  // Inbound call ringing a tracked extension: the inbound route's dialplan
  // Dial()s the extension, so its channel starts (at Newchannel, handled
  // above) with a generic Exten ("s") and no caller identity yet — Asterisk
  // only populates ConnectedLine* once the channel actually starts ringing,
  // which is here. No pending origination claims this channel and no Dial
  // event is coming (established for this PBX), so this Newstate is the
  // first reliable signal we get that it's actually inbound.
  _maybeDetectInboundFromNewstate(evt) {
    const { Channel, Uniqueid, Linkedid, Exten, ConnectedLineNum, ConnectedLineName, ChannelStateDesc } = evt;
    const ext = this._matchTrackedExtension(Channel);
    if (!ext) return;
    const connected = ConnectedLineNum && ConnectedLineNum !== '<unknown>' ? ConnectedLineNum : null;
    const name = ConnectedLineName && ConnectedLineName !== '<unknown>' ? ConnectedLineName : '';

    // Asterisk invariant: Linkedid is the Uniqueid of the channel that
    // STARTED the call. So when this extension's own channel is the linked
    // one, the operator dialed out from their phone (an outgoing call
    // _onNewchannel couldn't classify, e.g. Exten was still "s" there);
    // otherwise some other leg (trunk/queue) created it — inbound.
    const isOriginator = !!Linkedid && Linkedid === Uniqueid;
    if (isOriginator) {
      const dialed = (connected && connected !== ext) ? connected
        : (Exten && Exten !== 's' && Exten !== ext ? Exten : null);
      if (!dialed) return; // nothing identifies the destination yet
      const record = this._newRecord({
        id: Uniqueid,
        linkedid: Linkedid,
        operatorExtension: ext,
        direction: 'outgoing',
        source: 'manual',
        counterpartyNumber: dialed,
        startedAt: Date.now(),
      });
      record.channels.operator = Channel;
      this.byUniqueid.set(Uniqueid, record.id);
      if (ChannelStateDesc === 'Up') {
        record.state = 'answered';
        record.answeredAt = Date.now();
      } else {
        record.state = 'ringing_destination';
      }
      this._emitUpdate(record);
      return;
    }

    // Not populated yet, or just reflects the extension's own identity —
    // nothing to identify the caller by; a later Newstate will carry it.
    if (!connected || connected === ext) return;

    const record = this._newRecord({
      id: Uniqueid,
      linkedid: Linkedid,
      operatorExtension: ext,
      direction: 'incoming',
      source: 'manual',
      counterpartyNumber: connected,
      counterpartyName: name,
      startedAt: Date.now(),
    });
    record.channels.operator = Channel;
    this.byUniqueid.set(Uniqueid, record.id);

    if (ChannelStateDesc === 'Up') {
      // Caught this call already connected — this PBX doesn't always emit a
      // distinct "Ringing" transition before "Up" (seen live: straight
      // Down -> Up with nothing in between). No ring phase to screen-pop,
      // but we can still log it correctly and start the clock from here.
      record.state = 'answered';
      record.answeredAt = Date.now();
      this._emitUpdate(record);
    } else {
      record.state = 'ringing_operator';
      this._emitUpdate(record);
      this.emit('incoming', record);
    }
  }

  // Newexten fires for every extension/priority a channel executes; we only
  // care about it to recover the dialed number for calls we did NOT originate
  // ourselves (manual calls placed from a real phone).
  _onNewexten(evt) {
    if (!evt.Channel) return;
    this.lastExtenByChannel.set(evt.Channel, {
      exten: evt.Extension,
      context: evt.Context,
      app: evt.Application,
      appData: evt.AppData,
    });
  }

  _onDial(evt) {
    if (evt.SubEvent === 'Begin') return this._onDialBegin(evt);
    if (evt.SubEvent === 'End') return this._onDialEnd(evt);
  }

  _onDialBegin(evt) {
    const { Channel, Uniqueid, DestUniqueid, CallerIDNum, CallerIDName } = evt;
    const Destination = evt.DestChannel || evt.Destination; // 12+ vs legacy field name

    // Case 1: continuation of a call we originated (operator leg now dialing out).
    const existingId = this.byUniqueid.get(Uniqueid);
    if (existingId) {
      const record = this.records.get(existingId);
      if (record && !record.endedAt) {
        record.channels.destination = Destination;
        this.byUniqueid.set(DestUniqueid, record.id);
        this._emitUpdate(record);
      }
      return;
    }

    // Case 2: outgoing call placed manually (e.g. from MicroSIP), Channel is
    // one of our tracked extensions dialing out.
    const outExt = this._matchTrackedExtension(Channel);
    if (outExt) {
      const number = this._resolveDialedNumber(Channel, Destination, evt.DialString);
      const record = this._newRecord({
        id: Uniqueid,
        linkedid: evt.Linkedid,
        operatorExtension: outExt,
        direction: 'outgoing',
        source: 'manual',
        counterpartyNumber: number,
        startedAt: Date.now(),
      });
      record.state = 'ringing_destination';
      record.channels.operator = Channel;
      record.channels.destination = Destination;
      this.byUniqueid.set(Uniqueid, record.id);
      this.byUniqueid.set(DestUniqueid, record.id);
      this._emitUpdate(record);
      return;
    }

    // Case 3: inbound call — something is dialing one of our tracked
    // extensions (Destination), Channel is the caller/trunk leg. Guard
    // against a duplicate: _onNewchannel may have already claimed
    // DestUniqueid for this same inbound call (see there for why) — if so,
    // just enrich that record instead of creating a second one.
    const existingByDest = this.byUniqueid.get(DestUniqueid);
    if (existingByDest) {
      const record = this.records.get(existingByDest);
      if (record && !record.endedAt) {
        record.channels.other = record.channels.other || Channel;
        this.byUniqueid.set(Uniqueid, record.id);
        this._emitUpdate(record);
      }
      return;
    }

    const inExt = this._matchTrackedExtension(Destination);
    if (inExt) {
      const record = this._newRecord({
        id: DestUniqueid,
        linkedid: evt.Linkedid,
        operatorExtension: inExt,
        direction: 'incoming',
        source: 'manual',
        counterpartyNumber: CallerIDNum || 'неизвестно',
        counterpartyName: CallerIDName && CallerIDName !== '<unknown>' ? CallerIDName : '',
        startedAt: Date.now(),
      });
      record.state = 'ringing_operator';
      record.channels.operator = Destination;
      record.channels.other = Channel;
      this.byUniqueid.set(Uniqueid, record.id);
      this.byUniqueid.set(DestUniqueid, record.id);
      this._emitUpdate(record);
      this.emit('incoming', record);
    }
  }

  _onDialEnd(evt) {
    const recordId = this.byUniqueid.get(evt.Uniqueid) || this.byUniqueid.get(evt.DestUniqueid);
    if (!recordId) return;
    const record = this.records.get(recordId);
    if (!record || record.endedAt) return;

    if (evt.DialStatus === 'ANSWER') {
      // Newstate("Up") on the right leg usually got here first — keep the
      // earlier answer timestamp in that case.
      if (record.state === 'answered') return;
      record.state = 'answered';
      record.answeredAt = Date.now();
      this._emitUpdate(record);
      return;
    }

    // BUSY / NOANSWER / CANCEL / CONGESTION / CHANUNAVAIL. For an INBOUND
    // ring-group/queue call the losing members all get DialEnd(CANCEL) the
    // moment a colleague answers — that verdict belongs to Hangup, whose
    // cause 26 tells "answered elsewhere" apart from a real miss (see
    // _onHangup). For an outgoing call this is the definitive failure.
    if (record.direction !== 'outgoing') return;
    record.state = 'failed';
    record.disposition = evt.DialStatus || 'FAILED';
    record.endedAt = Date.now();
    // Only for calls we placed ourselves: a MicroSIP user who dialed by
    // hand expects their phone to behave like a phone (busy tone etc.),
    // not to be hung up from outside.
    if (record.source === 'click2call') this._hangupOperatorLegOnDialFailure(record);
    this._emitUpdate(record);
  }

  // The callee rejecting/cancelling/being busy only ends Dial() on the
  // operator's own channel — that channel's dialplan then typically falls
  // through to Busy()/Congestion() (or similar), which bridges a reorder/
  // busy tone into the operator's phone for its own configured timeout
  // (commonly 10-20s) before finally hanging up on its own. We already know
  // right here, the instant DialEnd arrives, that the call is over — so
  // hang up the operator's channel ourselves instead of leaving them
  // listening to that tone until the dialplan gets around to it. Only makes
  // sense for outgoing calls (an incoming call's "operator" channel IS the
  // one that needs to keep ringing/answerable) and only once we know which
  // channel that is.
  _hangupOperatorLegOnDialFailure(record) {
    if (record.direction !== 'outgoing') return;
    const channel = record.channels.operator;
    if (!channel || !this.ami) return;
    this.ami.send('Hangup', { Channel: channel }).catch((err) => {
      // Benign in the common case: the operator's channel may already be
      // gone (e.g. they hung up manually right as this fired).
      console.warn(`[call-store] auto-hangup of operator channel ${channel} after DialEnd (${record.disposition}) failed: ${err.message}`);
    });
  }

  // More fundamental than the Dial application event (which this PBX's
  // dialplan never emits over AMI, as established above) — every channel
  // reports its own state transitions here regardless of which dialplan app
  // is driving it. "Up" is our earliest reliable signal that a tracked call
  // actually connected, so we use it to start the "in a call" clock instead
  // of waiting for a DialEnd/ANSWER that never comes on this system.
  _onNewstate(evt) {
    const recordId = this.byUniqueid.get(evt.Uniqueid);
    if (!recordId) {
      // Don't gate on a specific state ("Ringing" was assumed, but this PBX
      // has been seen skipping straight from "Down" to "Up" with no
      // intermediate event) — run the inbound check on whatever the first
      // state transition we actually observe turns out to be.
      this._maybeDetectInboundFromNewstate(evt);
      return;
    }
    const record = this.records.get(recordId);
    if (!record || record.endedAt) return;

    // A record created from DialBegin (queue/ring-group leg) may have had
    // no usable caller id/name yet — Asterisk fills ConnectedLine* in by
    // the time the operator's channel actually rings, so pick it up here.
    if (record.direction === 'incoming') {
      const connected = evt.ConnectedLineNum;
      const connectedName = evt.ConnectedLineName && evt.ConnectedLineName !== '<unknown>' ? evt.ConnectedLineName : '';
      let changed = false;
      if (record.counterparty.number === 'неизвестно' && connected && connected !== '<unknown>' && connected !== record.operatorExtension) {
        record.counterparty.number = connected;
        changed = true;
      }
      if (!record.counterparty.name && connectedName && connectedName !== record.counterparty.number) {
        record.counterparty.name = connectedName;
        changed = true;
      }
      if (changed) this._emitUpdate(record);
    }

    if (evt.ChannelStateDesc !== 'Up') return;
    if (record.state === 'answered') return;

    // For a click2call outgoing call the operator's own leg going "Up" just
    // means the operator picked up their phone (we Originate'd it) — the
    // client hasn't answered yet at that point. Only the destination leg
    // (the second channel, registered in _onNewchannel once it appears)
    // going "Up" means the client actually answered; if we don't know the
    // destination leg yet, wait rather than guess.
    //
    // A MANUAL outgoing call (dialed on the operator's SIP phone) is
    // different: that leg is already off-hook from the start, so it only
    // goes "Up" when the dialplan bridges it — i.e. when the far end
    // answers. With a destination leg in sight we still prefer its "Up"
    // (more precise); without one — trunk legs aren't always visible over
    // AMI — the operator leg's own "Up" is the answer signal, consistent
    // with how _onHangup already judges single-leg calls.
    if (record.direction === 'outgoing') {
      if (record.channels.destination) {
        if (evt.Channel !== record.channels.destination) return;
      } else if (record.source !== 'manual') {
        return;
      }
    }

    record.state = 'answered';
    record.answeredAt = Date.now();
    this._emitUpdate(record);
  }

  _onHangup(evt) {
    this.lastExtenByChannel.delete(evt.Channel);
    const recordId = this.byUniqueid.get(evt.Uniqueid);
    // Safety net for a record that is no longer in memory (evicted, or the
    // backend restarted mid-call): the call's own Uniqueid is its record id,
    // so reload it from the DB and finalize it there instead of silently
    // dropping the Hangup and leaving the call "active" forever.
    const record = (recordId && this.records.get(recordId)) || this._reviveFromDb(recordId || evt.Uniqueid);
    if (!record || record.endedAt) return; // already finalized by a DialEnd/other leg

    record.endedAt = Date.now();
    // Normally a Dial "End"/ANSWER event flips state to 'answered' before
    // Hangup arrives. Some dialplans here don't emit that event at all, so
    // fall back to the Hangup event's own ChannelState (Asterisk numeric
    // channel state "6" = Up) as evidence the call actually connected — but
    // only trust that fallback from the destination leg (or the only leg,
    // e.g. inbound): the operator's own leg reports "Up" the whole time
    // they're on their phone, even if the client side never answered.
    const isDestinationLeg = record.channels.destination && evt.Channel === record.channels.destination;
    const isSingleLegCall = !record.channels.destination;
    const wasUp = record.state === 'answered' || ((isDestinationLeg || isSingleLegCall) && evt.ChannelState === '6');
    if (wasUp) {
      record.state = 'ended';
      record.disposition = 'ANSWER';
      if (!record.answeredAt) record.answeredAt = record.endedAt; // best guess: no exact answer time available
    } else if (evt.Cause === '26' && record.direction === 'incoming') {
      // Ring group / queue: this operator's phone rang but a colleague
      // picked up first. Not a missed call for anyone — kept as its own
      // disposition so stats/UI don't count it as "Пропущенные" (see
      // deriveStatus in db.js and amiRecordToEntry in js/app.js).
      record.state = 'failed';
      record.disposition = 'ANSWERED_ELSEWHERE';
    } else {
      record.state = 'failed';
      record.disposition = record.disposition || evt['Cause-txt'] || 'NOANSWER';
    }
    this._emitUpdate(record);
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                          */
  /* ---------------------------------------------------------------- */

  _resolveDialedNumber(channel, destinationChannel, dialString) {
    // Asterisk 12+ DialBegin carries the exact dial target, e.g.
    // "937277270@557056666" (number@trunk) or "PJSIP/937277270@trunk".
    if (dialString) {
      const local = String(dialString).split('@')[0].split('/').pop();
      if (/^\+?\d{3,}$/.test(local)) return local;
    }
    const meta = this.lastExtenByChannel.get(channel);
    if (meta && meta.exten && meta.exten !== 's') return meta.exten;
    if (meta && meta.app === 'Dial' && meta.appData) {
      const parts = String(meta.appData).split('/');
      const last = parts[parts.length - 1].split(',')[0];
      if (last) return last;
    }
    return destinationChannel || 'неизвестно';
  }

  _newRecord({ id, actionId, linkedid, operatorExtension, direction, source, counterpartyNumber, counterpartyName, startedAt }) {
    const record = {
      id,
      actionId: actionId || null,
      linkedid: linkedid || null,
      operatorExtension,
      direction,
      source,
      counterparty: { number: counterpartyNumber || 'неизвестно', name: counterpartyName || '' },
      state: 'ringing_operator',
      disposition: null,
      startedAt,
      answeredAt: null,
      endedAt: null,
      channels: { operator: null, destination: null, other: null },
    };
    this.records.set(id, record);
    this._pruneMemory();
    return record;
  }

  // Evicts the oldest FINISHED calls once over MAX_IN_MEMORY. A call that is
  // still in progress is never evicted: with every extension tracked, a busy
  // hour creates 300-450 records (each ring-group leg is its own record), so
  // the old "drop the oldest, whatever its state" rule threw out any
  // conversation longer than ~40 minutes while it was still going. Its
  // Hangup then found no record and was ignored — the call stayed "В
  // разговоре" in the UI and in the DB forever, and "Завершить" answered
  // "call not found". Unfinished records only go once they are absurdly old
  // (STALE_ACTIVE_MS), as a last-resort bound on memory; the periodic
  // reconcile in index.js closes those properly long before that.
  _pruneMemory() {
    if (this.records.size <= MAX_IN_MEMORY) return;
    const now = Date.now();
    const evictable = [...this.records.values()]
      .filter((r) => r.endedAt || now - r.startedAt > STALE_ACTIVE_MS)
      .sort((a, b) => a.startedAt - b.startedAt);
    const excess = this.records.size - MAX_IN_MEMORY;
    if (excess <= 0 || !evictable.length) return;
    const removed = new Set();
    for (let i = 0; i < evictable.length && i < excess; i++) {
      this.records.delete(evictable[i].id);
      removed.add(evictable[i].id);
    }
    // byUniqueid used to be append-only (a slow memory leak: ~680 MB after a
    // few days on prod). Entries pointing at evicted records are useless —
    // _onHangup falls back to the DB by the Uniqueid itself (see there).
    for (const [uid, recordId] of this.byUniqueid) {
      if (removed.has(recordId)) this.byUniqueid.delete(uid);
    }
    // Last dialplan step per channel: only needed while that channel is
    // alive; Hangup deletes it, this caps anything a missed Hangup left.
    if (this.lastExtenByChannel.size > MAX_EXTEN_CACHE) {
      const drop = this.lastExtenByChannel.size - MAX_EXTEN_CACHE;
      let i = 0;
      for (const key of this.lastExtenByChannel.keys()) {
        if (i++ >= drop) break;
        this.lastExtenByChannel.delete(key);
      }
    }
  }

  // Every state change is durably upserted to SQLite (not just terminal
  // ones) so a row already exists by the time an operator picks a post-call
  // outcome right after the client answers — well before hangup, when the
  // old JSONL-on-hangup-only persistence would still have nothing to attach
  // the outcome to. Persistence is best-effort; a DB hiccup shouldn't take
  // down the live call flow.
  _emitUpdate(record) {
    if (this.db) {
      try {
        // Also stamps the live record with the phone-matched contact (if
        // any) — upsertCallRecord already resolves this for storage, so
        // reusing its return value here is free. The frontend reads
        // record.contactId to decide whether to offer "Создать контакт" on
        // the post-call outcome picker, right when the client answers, and
        // record.contactCode to hand the client's code to 1C with the
        // incoming-call event (see notify1C in js/app.js).
        record.contactId = this.db.upsertCallRecord(record);
        const contact = record.contactId ? this.db.getContact(record.contactId) : null;
        record.contactCode = (contact && contact.code) || null;
      } catch (err) {
        console.error('[call-store] failed to persist call record:', err.message);
      }
    }
    this.emit('update', record);
  }

  // Brings an unfinished call back from SQLite into the live store (channels
  // unknown — they were never persisted). Returns null for unknown or
  // already-finished calls.
  _reviveFromDb(id) {
    if (!this.db || !id) return null;
    let record = null;
    try { record = this.db.getCallRow(id); } catch (err) { return null; }
    if (!record || record.endedAt || !record.startedAt) return null;
    this.records.set(record.id, record);
    this.byUniqueid.set(record.id, record.id);
    return record;
  }

  // Marks a call as over without a Hangup event (it was missed, or the call
  // had already vanished from Asterisk). `endedAt` defaults to now; callers
  // closing long-dead DB rows pass their own so the duration isn't inflated
  // by days. RECONCILED disposition keeps these out of talk-time stats.
  finalizeMissing(record, endedAt = Date.now()) {
    if (!record || record.endedAt) return false;
    record.state = record.state === 'answered' ? 'ended' : 'failed';
    record.disposition = record.disposition || 'RECONCILED';
    record.endedAt = Math.max(endedAt, record.answeredAt || 0, record.startedAt || 0);
    this._emitUpdate(record);
    return true;
  }

  _preloadFromDb() {
    if (!this.db) return;
    try {
      for (const record of this.db.listRecentRaw(MAX_IN_MEMORY)) {
        this.records.set(record.id, record);
      }
    } catch (err) {
      console.error('[call-store] failed to preload recent calls from DB:', err.message);
    }
  }
}

module.exports = CallStore;
