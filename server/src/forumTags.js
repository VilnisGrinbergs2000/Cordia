require('./pg/env');
const { query } = require('./pg/pool');

const MAX_TAGS_PER_POST = 5;

function normalizeTagName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 24);
}

function serializeTag(row) {
  if (!row) return null;
  return {
    id: row.id,
    channelId: row.channel_id,
    name: row.name,
    color: row.color,
    position: Number(row.position) || 0,
    createdAt: row.created_at
  };
}

async function listForumTags(channelId) {
  const { rows } = await query(
    'SELECT * FROM forum_tags WHERE channel_id = $1 ORDER BY position ASC, id ASC',
    [Number(channelId)]
  );
  return rows.map(serializeTag);
}

async function readTagIds(channelId, value) {
  if (value === undefined) return { provided: false, ids: [] };
  if (!Array.isArray(value)) return { error: 'Tags must be a list.' };
  const ids = [...new Set(value.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length > MAX_TAGS_PER_POST) {
    return { error: `Pick up to ${MAX_TAGS_PER_POST} tags.` };
  }
  if (!ids.length) return { provided: true, ids: [] };
  const { rows } = await query(
    'SELECT id FROM forum_tags WHERE channel_id = $1 AND id = ANY($2::bigint[])',
    [Number(channelId), ids]
  );
  if (rows.length !== ids.length) {
    return { error: 'One of those tags is not available in this forum.' };
  }
  return { provided: true, ids };
}

async function replaceThreadTags(threadId, tagIds) {
  await query('DELETE FROM thread_tags WHERE thread_id = $1', [Number(threadId)]);
  if (!tagIds.length) return;
  await query(
    `INSERT INTO thread_tags (thread_id, tag_id)
     SELECT $1, unnest($2::bigint[])
     ON CONFLICT (thread_id, tag_id) DO NOTHING`,
    [Number(threadId), tagIds.map(Number)]
  );
}

module.exports = {
  MAX_TAGS_PER_POST,
  normalizeTagName,
  serializeTag,
  listForumTags,
  readTagIds,
  replaceThreadTags
};
