'use strict';

// Read-only endpoints for 1C:
//   GET /api/reports/operators?from=<ms>&to=<ms>&tz=<minutes>
//       Aggregated operator statistics for the 1C report
//       "АналитикаОператоровТелефонии": one row per operator extension and one
//       row per day (whole call center), plus confirmed bookings (orders).
//   GET /api/call/:id/info
//       Call number + client code of the matching contact. Used by the 1C
//       operator window when the client code was not yet on the booking
//       button at the moment the operator clicked it.
//
// Counting rules (the same for operators and days):
//   - calls with status 'elsewhere' (ring group rang this operator, a
//     colleague answered) are not counted at all: they are not this
//     operator's calls;
//   - answered = status 'completed' (disposition ANSWER);
//   - talk time = ended_at - answered_at of answered calls, except calls
//     closed by reconcile after an AMI reconnect (disposition RECONCILED):
//     their end time is when the server noticed, not when they ended;
//   - wait time = answered_at - started_at of answered incoming calls;
//   - missed incoming / unanswered outgoing = status 'missed' or 'failed';
//   - orders = rows of the bookings table (POST /api/call/:id/booking from
//     1C), attributed to the operator of the call, dated by the call start.

function reinsertUniqueidDot(rawId) {
  if (!rawId || rawId.includes('.') || !/^\d{11,}$/.test(rawId)) return rawId;
  return rawId.slice(0, 10) + '.' + rawId.slice(10);
}

const CALL_AGGREGATES = `
  COUNT(*) AS total,
  SUM(direction = 'incoming') AS incoming,
  SUM(direction = 'outgoing') AS outgoing,
  SUM(direction = 'outgoing' AND source = 'click2call') AS outgoingClick2call,
  SUM(status = 'completed') AS answered,
  SUM(status = 'completed' AND direction = 'incoming') AS answeredIncoming,
  SUM(status = 'completed' AND direction = 'outgoing') AS answeredOutgoing,
  SUM(direction = 'incoming' AND status IN ('missed', 'failed')) AS missedIncoming,
  SUM(direction = 'outgoing' AND status IN ('missed', 'failed')) AS unansweredOutgoing,
  SUM(CASE WHEN status = 'completed' AND COALESCE(disposition, '') <> 'RECONCILED' AND ended_at >= answered_at THEN ended_at - answered_at ELSE 0 END) AS talkMs,
  MAX(CASE WHEN status = 'completed' AND COALESCE(disposition, '') <> 'RECONCILED' AND ended_at >= answered_at THEN ended_at - answered_at ELSE 0 END) AS maxTalkMs,
  SUM(CASE WHEN status = 'completed' AND direction = 'incoming' AND answered_at >= started_at THEN answered_at - started_at ELSE 0 END) AS waitMs,
  COUNT(DISTINCT CASE WHEN status = 'completed' THEN counterparty_number_norm END) AS uniqueClients,
  SUM(outcome = 'booking') AS outcomeBooking,
  SUM(outcome = 'declined') AS outcomeDeclined,
  SUM(outcome = 'callback') AS outcomeCallback,
  SUM(outcome = 'note') AS outcomeNote,
  SUM(outcome = 'contact') AS outcomeContact,
  SUM(status = 'completed' AND outcome IS NULL) AS noOutcome,
  MIN(started_at) AS firstCallAt,
  MAX(started_at) AS lastCallAt
`;

function mountReports(app, { db, requireApiKey }) {
  const sql = db.db;

  app.get('/api/reports/operators', requireApiKey, (req, res) => {
    const from = Number(req.query.from);
    const to = Number(req.query.to);
    const tz = req.query.tz === undefined ? 300 : Number(req.query.tz);
    if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(tz) || from > to) {
      return res.status(400).json({ error: '"from" and "to" (epoch ms, from <= to) and optional "tz" (minutes) are required' });
    }
    const tzMs = tz * 60000;
    const dayExpr = (col) => `date((${col} + ${tzMs}) / 1000, 'unixepoch')`;
    const callsWhere = `
      FROM calls
      WHERE started_at >= ? AND started_at <= ?
        AND COALESCE(status, '') <> 'elsewhere'
    `;
    try {
      const operators = sql.prepare(`
        SELECT COALESCE(operator_extension, '') AS extension, ${CALL_AGGREGATES}
        ${callsWhere}
        GROUP BY COALESCE(operator_extension, '')
      `).all(from, to);
      const days = sql.prepare(`
        SELECT ${dayExpr('started_at')} AS day, ${CALL_AGGREGATES}
        ${callsWhere}
        GROUP BY day
        ORDER BY day
      `).all(from, to);
      const totals = sql.prepare(`SELECT ${CALL_AGGREGATES} ${callsWhere}`).get(from, to);

      const bookingsFrom = `
        FROM bookings b
        LEFT JOIN calls c ON c.id = b.call_id
        WHERE COALESCE(c.started_at, b.created_at) >= ? AND COALESCE(c.started_at, b.created_at) <= ?
      `;
      const bookingsByOperator = sql.prepare(`
        SELECT COALESCE(b.operator_extension, c.operator_extension, '') AS extension,
          COUNT(*) AS orders, SUM(b.amount) AS ordersAmount
        ${bookingsFrom}
        GROUP BY COALESCE(b.operator_extension, c.operator_extension, '')
      `).all(from, to);
      const bookingsByDay = sql.prepare(`
        SELECT ${dayExpr('COALESCE(c.started_at, b.created_at)')} AS day,
          COUNT(*) AS orders, SUM(b.amount) AS ordersAmount
        ${bookingsFrom}
        GROUP BY day
      `).all(from, to);

      // Merge orders into the call rows; an operator/day with orders but no
      // calls (e.g. an order for a call outside the tracked set) still shows.
      const merge = (rows, extra, key) => {
        const byKey = new Map(rows.map((r) => [r[key], r]));
        for (const b of extra) {
          let row = byKey.get(b[key]);
          if (!row) {
            row = { [key]: b[key], total: 0 };
            rows.push(row);
            byKey.set(b[key], row);
          }
          row.orders = b.orders;
          row.ordersAmount = b.ordersAmount || 0;
        }
        for (const r of rows) {
          r.orders = r.orders || 0;
          r.ordersAmount = r.ordersAmount || 0;
        }
        return rows;
      };
      merge(operators, bookingsByOperator, 'extension');
      merge(days, bookingsByDay, 'day');
      days.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
      totals.orders = operators.reduce((s, r) => s + r.orders, 0);
      totals.ordersAmount = operators.reduce((s, r) => s + r.ordersAmount, 0);

      res.json({ from, to, tz, generatedAt: Date.now(), totals, operators, days });
    } catch (err) {
      console.error('[reports] operators failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/call/:id/info', requireApiKey, (req, res) => {
    const callId = reinsertUniqueidDot(String(req.params.id || '').replace(/[^\d.]/g, ''));
    const call = sql.prepare(`
      SELECT id, operator_extension, direction, counterparty_number, counterparty_number_norm,
        counterparty_name, contact_id, status, started_at
      FROM calls WHERE id = ?
    `).get(callId);
    if (!call) return res.status(404).json({ error: 'call not found', id: callId });
    const norm = call.counterparty_number_norm || '';
    const contact = sql.prepare(`
      SELECT id, code, company_name FROM contacts
      WHERE id = ? OR (? <> '' AND (phone1_norm = ? OR phone2_norm = ? OR phone3_norm = ? OR phone4_norm = ?))
      ORDER BY (id = ?) DESC, (code IS NULL) ASC, updated_at DESC
      LIMIT 1
    `).get(call.contact_id || -1, norm, norm, norm, norm, norm, call.contact_id || -1);
    res.json({
      id: call.id,
      operatorExtension: call.operator_extension,
      direction: call.direction,
      number: call.counterparty_number,
      name: call.counterparty_name,
      status: call.status,
      startedAt: call.started_at,
      contactId: contact ? contact.id : null,
      contactCode: contact && contact.code ? contact.code : '',
      companyName: contact ? contact.company_name : '',
    });
  });
}

module.exports = { mountReports };
