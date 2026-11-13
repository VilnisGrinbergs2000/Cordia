require('./pg/env');
const { query } = require('./pg/pool');
const { deleteUploadIfUnused, logAudit } = require('./util');

const HISTORY_LIMIT = 12;

async function recordServerIconChange({
  serverId,
  actorId,
  previousIconUrl,
  nextIconUrl,
  serverName,
  actionDetail
}) {
  const id = Number(serverId);
  if (previousIconUrl === nextIconUrl) return;
  await query(
    `INSERT INTO server_icon_history (server_id, icon_url, changed_by, created_at)
     VALUES ($1, $2, $3, $4)`,
    [id, previousIconUrl || '', actorId, Date.now()]
  );
  const { rows: prunedIcons } = await query(
    `SELECT icon_url AS "iconUrl" FROM server_icon_history
     WHERE server_id = $1
       AND id NOT IN (
         SELECT id FROM server_icon_history
         WHERE server_id = $2
         ORDER BY created_at DESC, id DESC
         LIMIT $3
       )`,
    [id, id, HISTORY_LIMIT]
  );
  await query(
    `DELETE FROM server_icon_history
     WHERE server_id = $1
       AND id NOT IN (
         SELECT id FROM server_icon_history
         WHERE server_id = $2
         ORDER BY created_at DESC, id DESC
         LIMIT $3
       )`,
    [id, id, HISTORY_LIMIT]
  );
  for (const entry of prunedIcons) await deleteUploadIfUnused(entry.iconUrl);
  const detail =
    actionDetail ||
    (!nextIconUrl ? 'Icon removed' : previousIconUrl ? 'Icon replaced' : 'Icon added');
  await logAudit(actorId, 'server.icon', 'server', id, `${serverName}: ${detail}`);
}

module.exports = { HISTORY_LIMIT, recordServerIconChange };
