'use strict';
require('./pg/env');
const { query } = require('./pg/pool');

// Who did what to an application. The "events" table is a funnel and drops any
// type it does not know, so it cannot hold this: an uninstall is not a step in a
// signup funnel, it is a fact somebody may need to look up later.
//
// Fire and forget: an audit row is worth having, but never worth failing the
// action it describes.

async function recordAudit(applicationId, action, { serverId = null, actorId = null, detail = null } = {}) {
  try {
    await query(
      `INSERT INTO application_audit (application_id, server_id, actor_id, action, detail, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [Number(applicationId), serverId, actorId, action, detail ? JSON.stringify(detail) : null, Date.now()]
    );
    return true;
  } catch (error) {
    console.error('[audit] could not record', action, error.message);
    return false;
  }
}

async function auditFor(applicationId, limit = 50) {
  const { rows } = await query(
    `SELECT a.id, a.action, a.server_id, a.actor_id, a.detail, a.created_at, u.username, u.display_name
       FROM application_audit a
       LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.application_id = $1
      ORDER BY a.created_at DESC
      LIMIT $2`,
    [Number(applicationId), Math.min(Math.max(Number(limit) || 50, 1), 200)]
  );
  return rows.map((row) => ({
    id: Number(row.id),
    action: row.action,
    serverId: row.server_id ? Number(row.server_id) : null,
    actorId: row.actor_id ? Number(row.actor_id) : null,
    actor: row.display_name || row.username || '',
    detail: row.detail || null,
    createdAt: Number(row.created_at)
  }));
}

module.exports = { recordAudit, auditFor };
