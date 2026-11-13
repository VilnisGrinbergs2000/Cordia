'use strict';

const fs = require('node:fs');
const path = require('node:path');
require('./env');
const { query } = require('./pool');
const { uploadsDir } = require('../config');

// SQLite's migration 21 (see the retired server/data/backup/legacy/db.js) recomputed the denormalised
// counters once, because they are only ever moved by deltas: a crash between the
// row write and the counter write, a cascade delete, or a bulk import all leave
// them drifted. The Postgres baseline was translated from a snapshot taken at
// user_version=19, so that one-shot repair never ran here. Recomputing on boot
// gives Postgres the same post-startup state the SQLite server had, and heals
// any drift the delta path misses.
async function reconcileCounters() {
  await query(
    'UPDATE users SET message_count = (SELECT COUNT(*) FROM messages WHERE messages.user_id = users.id)'
  );
  // Boosts live as read_states rows with scope_type = 'server_boost', which is
  // exactly what refreshBoostState() counts.
  await query(
    `UPDATE servers SET boost_count = (
       SELECT COUNT(*) FROM read_states
       WHERE read_states.scope_type = 'server_boost' AND read_states.scope_id = servers.id
     )`
  );
  // Mirrors BOOST_TIERS / boostLevelFor() in routes/servers.js: 14 -> 3, 7 -> 2,
  // 2 -> 1, otherwise 0. Separate statement so it reads the fresh boost_count.
  await query(
    `UPDATE servers SET boost_level = CASE
       WHEN boost_count >= 14 THEN 3
       WHEN boost_count >= 7 THEN 2
       WHEN boost_count >= 2 THEN 1
       ELSE 0
     END`
  );
}

// The SQLite schema never stored a byte count; 004_billing added uploads.bytes
// defaulting to 0. Existing rows would therefore look weightless and never count
// against anyone's quota, so fill them once from the file on disk. Missing files
// (pruned, restored from a partial backup) are left at 0 and skipped.
async function reconcileUploadBytes() {
  const { rows } = await query('SELECT name FROM uploads WHERE bytes = 0');
  let filled = 0;
  for (const row of rows) {
    const filePath = path.join(uploadsDir, path.basename(row.name));
    let size;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      continue;
    }
    if (!Number.isFinite(size) || size <= 0) continue;
    await query('UPDATE uploads SET bytes = $1 WHERE name = $2 AND bytes = 0', [size, row.name]);
    filled += 1;
  }
  return filled;
}

module.exports = { reconcileCounters, reconcileUploadBytes };
