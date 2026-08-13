'use strict';

const net = require('net');
const EventEmitter = require('events');

/**
 * Minimal Asterisk Manager Interface (AMI) client.
 *
 * Deliberately dependency-free (raw TCP + the plain-text AMI protocol) so the
 * whole thing is small enough to read end-to-end and audit. Handles login,
 * request/response correlation via ActionID, event fan-out, and automatic
 * reconnect with re-login.
 */
class AmiClient extends EventEmitter {
  constructor({ host, port, username, secret, reconnectDelayMs = 3000 }) {
    super();
    this.host = host;
    this.port = port;
    this.username = username;
    this.secret = secret;
    this.reconnectDelayMs = reconnectDelayMs;

    this.socket = null;
    this.buffer = '';
    this.bannerReceived = false;
    this.loggedIn = false;
    this.shouldRun = false;
    this.actionSeq = 0;
    this.pendingActions = new Map(); // actionId -> { resolve, reject, timer }
  }

  connect() {
    this.shouldRun = true;
    this._connect();
  }

  disconnect() {
    this.shouldRun = false;
    if (this.socket) this.socket.destroy();
  }

  _connect() {
    this.buffer = '';
    this.bannerReceived = false;
    this.loggedIn = false;

    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setEncoding('utf8');

    socket.on('data', (chunk) => this._onData(chunk));

    socket.on('error', (err) => {
      this.emit('error', err);
    });

    socket.on('close', () => {
      const wasLoggedIn = this.loggedIn;
      this.loggedIn = false;
      this._rejectAllPending(new Error('AMI connection closed'));
      if (wasLoggedIn) this.emit('disconnected');
      if (this.shouldRun) {
        setTimeout(() => this._connect(), this.reconnectDelayMs);
      }
    });
  }

  _rejectAllPending(err) {
    for (const { reject, timer } of this.pendingActions.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pendingActions.clear();
  }

  _onData(chunk) {
    this.buffer += chunk;

    if (!this.bannerReceived) {
      const idx = this.buffer.indexOf('\r\n');
      if (idx === -1) return;
      const banner = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.bannerReceived = true;
      this.emit('banner', banner);
      this._login();
    }

    let sepIdx;
    while ((sepIdx = this.buffer.indexOf('\r\n\r\n')) !== -1) {
      const raw = this.buffer.slice(0, sepIdx);
      this.buffer = this.buffer.slice(sepIdx + 4);
      if (raw.length) this._handlePacket(raw);
    }
  }

  _handlePacket(raw) {
    const packet = {};
    for (const line of raw.split('\r\n')) {
      const idx = line.indexOf(': ');
      if (idx === -1) continue;
      packet[line.slice(0, idx)] = line.slice(idx + 2);
    }

    if (packet.ActionID && this.pendingActions.has(packet.ActionID)) {
      const { resolve, timer } = this.pendingActions.get(packet.ActionID);
      clearTimeout(timer);
      this.pendingActions.delete(packet.ActionID);
      resolve(packet);
      // An action response can itself carry Event-like semantics (rare); fall
      // through so generic event listeners still see it if it has an Event field.
    }

    if (packet.Event) {
      this.emit('event', packet);
      this.emit('event:' + packet.Event, packet);
    }
  }

  _login() {
    this.send('Login', { Username: this.username, Secret: this.secret, Events: 'on' })
      .then((resp) => {
        if (resp.Response === 'Success') {
          this.loggedIn = true;
          this.emit('connected');
        } else {
          const err = new Error('AMI login failed: ' + (resp.Message || 'unknown reason'));
          this.emit('error', err);
          this.socket.destroy();
        }
      })
      .catch((err) => this.emit('error', err));
  }

  /** Send an AMI action and resolve with the matching response packet. */
  send(action, params = {}, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('AMI socket not connected'));
        return;
      }
      const actionId = 'a' + (++this.actionSeq) + '-' + Date.now();
      let payload = `Action: ${action}\r\nActionID: ${actionId}\r\n`;
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '') continue;
        payload += `${key}: ${value}\r\n`;
      }
      payload += '\r\n';

      const timer = setTimeout(() => {
        this.pendingActions.delete(actionId);
        reject(new Error(`AMI action "${action}" timed out`));
      }, timeoutMs);

      this.pendingActions.set(actionId, { resolve, reject, timer });
      this.socket.write(payload, 'utf8', (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingActions.delete(actionId);
          reject(err);
        }
      });
    });
  }

  /**
   * Action: CoreShowChannels — unlike a normal action, its response is a
   * whole burst of events (one CoreShowChannel per live channel, then a
   * CoreShowChannelsComplete marker), not a single reply send()'s
   * pendingActions bookkeeping is built for, so this collects them
   * directly. Used to reconcile our own idea of "still active" against
   * what Asterisk actually has right now — see call-store.js
   * reconcileWithAsterisk(), which exists because an AMI drop/reconnect
   * (this backend restarting, a network blip) can miss the one Hangup
   * event a call needed to ever be marked ended.
   */
  listActiveChannels(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('AMI socket not connected'));
        return;
      }
      const actionId = 'chans-' + (++this.actionSeq) + '-' + Date.now();
      const channels = [];

      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener('event:CoreShowChannel', onChannel);
        this.removeListener('event:CoreShowChannelsComplete', onComplete);
      };
      const onChannel = (evt) => {
        if (evt.ActionID !== actionId) return;
        channels.push(evt);
      };
      const onComplete = (evt) => {
        if (evt.ActionID !== actionId) return;
        cleanup();
        resolve(channels);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for CoreShowChannelsComplete'));
      }, timeoutMs);

      this.on('event:CoreShowChannel', onChannel);
      this.on('event:CoreShowChannelsComplete', onComplete);

      this.socket.write(`Action: CoreShowChannels\r\nActionID: ${actionId}\r\n\r\n`, 'utf8', (err) => {
        if (err) { cleanup(); reject(err); }
      });
    });
  }

  /**
   * Resolves with the next event named `eventName` for which `predicate`
   * returns true. For correlating an async follow-up event back to the
   * action that triggered it — e.g. Originate's immediate ack (already
   * covered by sendWithActionId's returned promise) only confirms the
   * request was queued; the real "did it actually answer" outcome arrives
   * later as a separate OriginateResponse event carrying the same ActionID.
   */
  waitForEvent(eventName, predicate, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const onEvent = (evt) => {
        if (!predicate(evt)) return;
        clearTimeout(timer);
        this.removeListener(eventName, onEvent);
        resolve(evt);
      };
      const timer = setTimeout(() => {
        this.removeListener(eventName, onEvent);
        reject(new Error(`Timed out waiting for ${eventName}`));
      }, timeoutMs);
      this.on(eventName, onEvent);
    });
  }

  /**
   * Same as send(), but lets the caller pick the ActionID (needed for
   * Originate, whose eventual "OriginateResponse" EVENT — separate from the
   * immediate action ack — echoes back the ActionID so we can correlate it).
   */
  sendWithActionId(action, actionId, params = {}, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('AMI socket not connected'));
        return;
      }
      let payload = `Action: ${action}\r\nActionID: ${actionId}\r\n`;
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null || value === '') continue;
        payload += `${key}: ${value}\r\n`;
      }
      payload += '\r\n';

      const timer = setTimeout(() => {
        this.pendingActions.delete(actionId);
        reject(new Error(`AMI action "${action}" timed out`));
      }, timeoutMs);

      this.pendingActions.set(actionId, { resolve, reject, timer });
      this.socket.write(payload, 'utf8', (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingActions.delete(actionId);
          reject(err);
        }
      });
    });
  }
}

module.exports = AmiClient;
