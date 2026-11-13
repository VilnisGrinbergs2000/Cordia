require('./pg/env');
const { query } = require('./pg/pool');
const { deleteUploadIfUnused } = require('./util');

const SUGGESTION_LIMIT = 24;
const USER_SUGGESTION_LIMIT = 5;

const SUGGESTION_SELECT = `
  SELECT s.id, s.server_id AS "serverId", s.icon_url AS "iconUrl", s.created_at AS "createdAt",
         s.suggested_by AS "suggestedById",
         u.username AS "suggestedByUsername",
         u.display_name AS "suggestedByDisplayName",
         u.avatar_url AS "suggestedByAvatarUrl",
         u.avatar_color AS "suggestedByAvatarColor",
         (SELECT COUNT(*) FROM server_icon_suggestion_votes v
          WHERE v.suggestion_id = s.id) AS "voteCount",
         EXISTS(SELECT 1 FROM server_icon_suggestion_votes v
                WHERE v.suggestion_id = s.id AND v.user_id = $1) AS "myVote"
  FROM server_icon_suggestions s
  JOIN users u ON u.id = s.suggested_by
`;

function serializeSuggestion(row, viewerId) {
  return {
    id: row.id,
    serverId: row.serverId,
    iconUrl: row.iconUrl,
    createdAt: row.createdAt,
    voteCount: Number(row.voteCount) || 0,
    myVote: !!row.myVote,
    mine: Number(row.suggestedById) === Number(viewerId),
    suggestedBy: {
      id: row.suggestedById,
      username: row.suggestedByUsername,
      displayName: row.suggestedByDisplayName,
      avatarUrl: row.suggestedByAvatarUrl || '',
      avatarColor: row.suggestedByAvatarColor
    }
  };
}

async function listServerIconSuggestions(serverId, viewerId) {
  const { rows } = await query(
    `${SUGGESTION_SELECT}
     WHERE s.server_id = $2
     ORDER BY "voteCount" DESC, s.created_at DESC, s.id DESC
     LIMIT ${SUGGESTION_LIMIT}`,
    [Number(viewerId) || 0, Number(serverId)]
  );
  return rows.map((row) => serializeSuggestion(row, viewerId));
}

async function getServerIconSuggestion(serverId, suggestionId, viewerId) {
  const { rows } = await query(
    `${SUGGESTION_SELECT}
     WHERE s.server_id = $2 AND s.id = $3`,
    [Number(viewerId) || 0, Number(serverId), Number(suggestionId)]
  );
  return rows[0] ? serializeSuggestion(rows[0], viewerId) : null;
}

async function countServerIconSuggestions(serverId) {
  const { rows } = await query(
    'SELECT COUNT(*) AS count FROM server_icon_suggestions WHERE server_id = $1',
    [Number(serverId)]
  );
  return Number(rows[0].count);
}

async function countUserIconSuggestions(serverId, userId) {
  const { rows } = await query(
    'SELECT COUNT(*) AS count FROM server_icon_suggestions WHERE server_id = $1 AND suggested_by = $2',
    [Number(serverId), Number(userId)]
  );
  return Number(rows[0].count);
}

async function findServerIconSuggestionByUrl(serverId, iconUrl) {
  const { rows } = await query(
    'SELECT id FROM server_icon_suggestions WHERE server_id = $1 AND icon_url = $2',
    [Number(serverId), iconUrl]
  );
  return rows[0] || null;
}

async function createServerIconSuggestion({ serverId, userId, iconUrl }) {
  const { rows } = await query(
    `INSERT INTO server_icon_suggestions (server_id, icon_url, suggested_by, created_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [Number(serverId), iconUrl, Number(userId), Date.now()]
  );
  return getServerIconSuggestion(serverId, Number(rows[0].id), userId);
}

async function toggleServerIconSuggestionVote({ serverId, suggestionId, userId }) {
  const suggestion = await getServerIconSuggestion(serverId, suggestionId, userId);
  if (!suggestion) return null;
  const { rows: existingRows } = await query(
    'SELECT 1 FROM server_icon_suggestion_votes WHERE suggestion_id = $1 AND user_id = $2',
    [Number(suggestionId), Number(userId)]
  );
  const existing = existingRows[0];
  if (existing) {
    await query(
      'DELETE FROM server_icon_suggestion_votes WHERE suggestion_id = $1 AND user_id = $2',
      [Number(suggestionId), Number(userId)]
    );
  } else {
    await query(
      'INSERT INTO server_icon_suggestion_votes (suggestion_id, user_id, created_at) VALUES ($1, $2, $3)',
      [Number(suggestionId), Number(userId), Date.now()]
    );
  }
  return {
    voted: !existing,
    suggestion: await getServerIconSuggestion(serverId, suggestionId, userId)
  };
}

async function removeServerIconSuggestion(serverId, suggestionId) {
  const suggestion = await getServerIconSuggestion(serverId, suggestionId, 0);
  if (!suggestion) return null;
  await query('DELETE FROM server_icon_suggestion_votes WHERE suggestion_id = $1', [
    Number(suggestionId)
  ]);
  await query('DELETE FROM server_icon_suggestions WHERE id = $1 AND server_id = $2', [
    Number(suggestionId),
    Number(serverId)
  ]);
  await deleteUploadIfUnused(suggestion.iconUrl);
  return suggestion;
}

module.exports = {
  SUGGESTION_LIMIT,
  USER_SUGGESTION_LIMIT,
  listServerIconSuggestions,
  getServerIconSuggestion,
  countServerIconSuggestions,
  countUserIconSuggestions,
  findServerIconSuggestionByUrl,
  createServerIconSuggestion,
  toggleServerIconSuggestionVote,
  removeServerIconSuggestion
};
