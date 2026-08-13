'use strict';

/**
 * Thin client for the CallFlow web panel (a separate system from AMI, on
 * port 80) — used only to fetch call recording audio. Logs in with a plain
 * username/password form, keeps the resulting session cookie in memory, and
 * transparently re-logs-in if the session has expired.
 *
 * Recording filenames are NOT reconstructed from a guessed template: the
 * date/time embedded in them is offset by a few seconds from the channel's
 * own Uniqueid (likely whenever MixMonitor actually starts, not when the
 * channel was created), so a computed guess doesn't reliably match. Instead
 * we ask CallFlow's own filtered call report for the day in question and
 * pick out the entry whose stream_file contains our Uniqueid — that part is
 * always present verbatim and is unique per call, so this is exact.
 */
class CallFlowClient {
  constructor({ baseUrl, username, password }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.username = username;
    this.password = password;
    this.cookie = null;
    this.loginPromise = null;
  }

  async login() {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      const res = await fetch(this.baseUrl + '/', {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ login: this.username, pass: this.password }).toString(),
      });
      const cookies = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
      if (!cookies.length) throw new Error('CallFlow login did not return a session cookie (bad credentials?)');
      this.cookie = cookies[0].split(';')[0];
    })();
    try {
      await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  async _fetchAuthed(path, { retry = true } = {}) {
    if (!this.cookie) await this.login();
    const res = await fetch(this.baseUrl + path, {
      headers: { Cookie: this.cookie },
      redirect: 'manual',
    });
    const contentType = res.headers.get('content-type') || '';
    // An expired session silently gets handed the login page back (200 OK,
    // text/html) instead of a 401 — detect that and re-auth once.
    if (contentType.includes('text/html') && retry) {
      this.cookie = null;
      await this.login();
      return this._fetchAuthed(path, { retry: false });
    }
    return res;
  }

  /**
   * Find the real recording filename for a call by searching the day's
   * filtered report. Returns null if this call has no recording.
   */
  async findRecordingFilename(uniqueid, extension, startedAtMs) {
    const tzDate = tashkentDate(startedAtMs);
    const qs = new URLSearchParams({
      date_from: `${tzDate}T00:00`,
      date_to: `${tzDate}T23:59`,
      type: 'all',
      internal: extension,
    });
    const res = await this._fetchAuthed('/?' + qs.toString());
    if (!res.ok) throw new Error('CallFlow report request failed: HTTP ' + res.status);
    const html = await res.text();
    const re = new RegExp('stream_file=([^&\'"\\s]*' + escapeRegExp(uniqueid) + '[^&\'"\\s]*)');
    const match = html.match(re);
    return match ? decodeURIComponent(match[1]) : null;
  }

  /** Fetch the actual recording audio for an already-known filename. */
  async fetchRecording(filename, dateStr) {
    const qs = new URLSearchParams({ stream_file: filename, d: dateStr });
    return this._fetchAuthed('/?' + qs.toString());
  }
}

function tashkentDate(ms) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms)); // "YYYY-MM-DD"
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = CallFlowClient;
module.exports.tashkentDate = tashkentDate;
