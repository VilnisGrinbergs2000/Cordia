'use strict';
require('./pg/env');
const { query } = require('./pg/pool');

// Rate limits live in the database rather than in a Map, because the map was
// wrong in two ways that only show up in production: it reset on every deploy,
// and two processes each counted half the traffic.
//
// A fixed window, not a sliding one. One row per bucket bumped in place costs a
// single round trip; a burst straddling a window boundary is the price, and it is
// cheaper than storing every timestamp.

async function hit(key, windowMs, max) {
  const now = Date.now();
  const reset = now + windowMs;
  const { rows } = await query(
    `INSERT INTO rate_hits (key, count, reset) VALUES ($1, 1, $2)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_hits.reset <= $3 THEN 1 ELSE rate_hits.count + 1 END,
       reset = CASE WHEN rate_hits.reset <= $3 THEN $2 ELSE rate_hits.reset END
     RETURNING count, reset`,
    [key, reset, now]
  );
  const count = Number(rows[0].count);
  const until = Number(rows[0].reset);
  return { blocked: count > max, count, retryAfter: Math.max(0, until - now) };
}

// A successful sign-in should not spend the budget it was counted against.
async function refund(key) {
  await query('UPDATE rate_hits SET count = GREATEST(count - 1, 0) WHERE key = $1', [key]);
}

async function sweep() {
  await query('DELETE FROM rate_hits WHERE reset < $1', [Date.now()]);
}

module.exports = { hit, refund, sweep };
