const fs = require('node:fs');
const path = require('node:path');
require('./pg/env');
const { query } = require('./pg/pool');
const { uploadsDir } = require('./config');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// An upload younger than this may still be on its way into a message, so the
// orphan sweep leaves it alone.
const ORPHAN_UPLOAD_AGE_MS = 24 * HOUR_MS;

function envDays(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Matches landing/privacy.html → "How long we keep it":
// "Reports and moderation records — up to 12 months".
const AUDIT_RETENTION_DAYS = envDays('CORDIA_AUDIT_RETENTION_DAYS', 365);
const REPORT_RETENTION_DAYS = envDays('CORDIA_REPORT_RETENTION_DAYS', 365);
const PRUNE_INTERVAL_MS = envDays('CORDIA_PRUNE_HOURS', 6) * HOUR_MS;

let timer = null;
let running = false;

// Every column that can hold an /uploads/ path. Superset of the six the orphan
// sweep is defined on: server icon history and pending icon suggestions are
// still rendered in the UI, so deleting a file they point at would leave broken
// images behind. Kept in sync with deleteUploadIfUnused in util.js.
const UPLOAD_REFERENCE_SQL = `
  SELECT 1 FROM messages WHERE attachment_url = $1
  UNION ALL SELECT 1 FROM users WHERE avatar_url = $2
  UNION ALL SELECT 1 FROM servers WHERE icon_url = $3
  UNION ALL SELECT 1 FROM servers WHERE banner = $4
  UNION ALL SELECT 1 FROM server_emotes WHERE url = $5
  UNION ALL SELECT 1 FROM soundboard_sounds WHERE file = $6
  UNION ALL SELECT 1 FROM server_icon_history WHERE icon_url = $7
  UNION ALL SELECT 1 FROM server_icon_suggestions WHERE icon_url = $8
  LIMIT 1`;

// Uploads that were never attached to anything: the row is older than a day and
// no message, avatar, icon, banner, emote or sound points at it. Both the file
// and the row go, so the row list stays short on later passes.
async function pruneOrphanUploads(now = Date.now()) {
  const cutoff = now - ORPHAN_UPLOAD_AGE_MS;
  const { rows } = await query('SELECT name FROM uploads WHERE created_at < $1', [cutoff]);
  let removed = 0;
  for (const row of rows) {
    const url = `/uploads/${row.name}`;
    const { rows: usedRows } = await query(UPLOAD_REFERENCE_SQL, [
      url,
      url,
      url,
      url,
      url,
      url,
      url,
      url
    ]);
    if (usedRows[0]) continue;
    try {
      fs.unlinkSync(path.join(uploadsDir, path.basename(row.name)));
    } catch (error) {
      // Already gone: forget the row. Locked or unreadable: keep it and retry
      // on the next pass rather than losing track of a file still on disk.
      if (error.code !== 'ENOENT') continue;
    }
    await query('DELETE FROM uploads WHERE name = $1', [row.name]);
    removed += 1;
  }
  return removed;
}

async function pruneExpired(now = Date.now()) {
  const auditCutoff = now - AUDIT_RETENTION_DAYS * DAY_MS;
  const reportCutoff = now - REPORT_RETENTION_DAYS * DAY_MS;

  const auditLogs = (await query('DELETE FROM audit_logs WHERE created_at < $1', [auditCutoff])).rowCount;
  const reports = (await query('DELETE FROM reports WHERE created_at < $1', [reportCutoff])).rowCount;
  const uploads = await pruneOrphanUploads(now);

  return { auditLogs, reports, uploads };
}

function startRetention() {
  if (timer) return timer;

  // setInterval does not await its callback, so a slow pass could overlap the
  // next tick; the flag makes a tick a no-op while a pass is still running.
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await pruneExpired();
      if (result.auditLogs || result.reports || result.uploads) {
        console.log(
          `Retention: removed ${result.auditLogs} audit entries and ${result.reports} reports past their window, ${result.uploads} orphaned uploads.`
        );
      }
    } catch (error) {
      console.error('Retention pass failed:', error.message);
    } finally {
      running = false;
    }
  };

  run();
  timer = setInterval(run, PRUNE_INTERVAL_MS);
  if (timer.unref) timer.unref();
  return timer;
}

function stopRetention() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

module.exports = {
  AUDIT_RETENTION_DAYS,
  REPORT_RETENTION_DAYS,
  ORPHAN_UPLOAD_AGE_MS,
  pruneOrphanUploads,
  pruneExpired,
  startRetention,
  stopRetention
};
