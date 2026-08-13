'use strict';

/**
 * Periodic one-way import from an external client list (XML, served by
 * some other system at CONTACTS_XML_URL — a flat list of
 * `<contact name="..." number="..." info="..."/>` elements) into our own
 * `contacts` table.
 *
 * Deliberately additive-only: a contact already present (matched by
 * normalized phone number, same as everywhere else — see db.js
 * normalizePhone) is left completely alone, even if its name/info here
 * differs from what's in the feed. This is what "add new contacts" means —
 * operators may have already edited a contact's company/manager/comment
 * since it first appeared here, and a sync shouldn't stomp that.
 *
 * No XML library dependency: the feed's shape has been confirmed simple and
 * flat (one self-closing <contact .../> per line, plain attributes), so a
 * small regex-based extractor is more than enough and keeps this dependency-
 * free — consistent with using node:sqlite instead of a native DB module
 * elsewhere in this backend.
 */

function decodeXmlEntities(str) {
  return str
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseContactsXml(xml) {
  const contacts = [];
  const contactRe = /<contact\s+([^>]*?)\/?>/g;
  const attrRe = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = contactRe.exec(xml))) {
    const attrs = {};
    let am;
    attrRe.lastIndex = 0;
    while ((am = attrRe.exec(m[1]))) {
      attrs[am[1]] = decodeXmlEntities(am[2]);
    }
    if (attrs.name && attrs.number) {
      contacts.push({ name: attrs.name, number: attrs.number, info: attrs.info || '' });
    }
  }
  return contacts;
}

async function fetchContactsXml(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

async function syncContactsFromXml(db, { url, timeoutMs = 15000 }) {
  let xml;
  try {
    xml = await fetchContactsXml(url, timeoutMs);
  } catch (err) {
    console.error('[contacts-sync] fetch failed:', err.message);
    return { ok: false, error: err.message };
  }

  const parsed = parseContactsXml(xml);
  let added = 0;
  for (const c of parsed) {
    if (db.resolveContactIdForNumber(c.number)) continue; // already known — leave it alone
    try {
      db.createContact({ phonePrimary: c.number, companyName: c.name, comment: c.info });
      added++;
    } catch (err) {
      console.error(`[contacts-sync] failed to add "${c.name}" (${c.number}):`, err.message);
    }
  }
  console.log(`[contacts-sync] checked ${parsed.length} contact(s) from feed, added ${added} new`);
  return { ok: true, checked: parsed.length, added };
}

// Runs once immediately, then every `intervalMs`. Returns the interval
// handle (unused today, but lets a future graceful-shutdown path clear it).
function startContactsSync(db, { url, intervalMs }) {
  if (!url) {
    console.warn('[contacts-sync] no URL configured — skipping (set CONTACTS_XML_URL in .env to enable)');
    return null;
  }
  syncContactsFromXml(db, { url }).catch((err) => console.error('[contacts-sync] unexpected error:', err.message));
  return setInterval(() => {
    syncContactsFromXml(db, { url }).catch((err) => console.error('[contacts-sync] unexpected error:', err.message));
  }, intervalMs);
}

module.exports = { parseContactsXml, syncContactsFromXml, startContactsSync };
