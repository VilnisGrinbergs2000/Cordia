require('./pg/env');
const { query, withTransaction } = require('./pg/pool');

// Threads and forum posts are channel rows with type 'thread'. Keeping them in
// the channels table means messages, reactions, read state, typing and
// attachments all work without a second implementation.
const NAME_LIMIT = 80;

function threadTitle(value, fallback = 'Thread') {
  const name = String(value || '').replace(/\s+/g, ' ').trim().slice(0, NAME_LIMIT);
  return name || fallback;
}

// `joined` is per viewer: a thread is only listed for people who started it,
// posted in it or joined it. Forum posts are public - the forum is useless
// otherwise.
const THREAD_SELECT = `
  SELECT t.*, p.name AS parent_name, p.type AS parent_type,
    EXISTS(
      SELECT 1 FROM thread_members tm WHERE tm.thread_id = t.id AND tm.user_id = $1
    ) AS joined,
    COALESCE((
      SELECT json_agg(json_build_object('id', ft.id, 'name', ft.name, 'color', ft.color)
             ORDER BY ft.position ASC, ft.id ASC)
      FROM thread_tags tt JOIN forum_tags ft ON ft.id = tt.tag_id
      WHERE tt.thread_id = t.id
    ), '[]'::json) AS tags
  FROM channels t
  LEFT JOIN channels p ON p.id = t.parent_channel_id
`;

function serializeThread(row) {
  if (!row) return null;
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    type: 'thread',
    parentChannelId: row.parent_channel_id ?? null,
    parentName: row.parent_name || '',
    parentType: row.parent_type || 'text',
    parentMessageId: row.parent_message_id ?? null,
    ownerId: row.owner_id ?? null,
    archived: !!row.archived,
    pinned: !!row.pinned,
    joined: !!row.joined,
    tags: Array.isArray(row.tags)
      ? row.tags.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color }))
      : [],
    messageCount: Number(row.message_count) || 0,
    lastMessageAt: row.last_message_at ?? null,
    createdAt: row.created_at
  };
}

async function joinThread(threadId, userId) {
  await query(
    'INSERT INTO thread_members (thread_id, user_id, joined_at) VALUES ($1, $2, $3) ON CONFLICT (thread_id, user_id) DO NOTHING',
    [Number(threadId), Number(userId), Date.now()]
  );
}

async function isThreadMember(threadId, userId) {
  const { rows } = await query(
    'SELECT 1 FROM thread_members WHERE thread_id = $1 AND user_id = $2',
    [Number(threadId), Number(userId)]
  );
  return !!rows[0];
}

async function threadMembers(threadId) {
  const { rows } = await query(
    `SELECT u.id, u.username, u.display_name, u.avatar_color, u.avatar_url
     FROM thread_members tm JOIN users u ON u.id = tm.user_id
     WHERE tm.thread_id = $1 ORDER BY tm.joined_at ASC`,
    [Number(threadId)]
  );
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarColor: row.avatar_color,
    avatarUrl: row.avatar_url || ''
  }));
}

// Active and archived both come back: the sidebar shows archived threads in
// their own quiet section so auto-archiving never hides a conversation.
async function listThreadsForViewer(serverId, userId) {
  const { rows } = await query(
    `${THREAD_SELECT}
     WHERE t.server_id = $2 AND t.type = 'thread'
       AND (p.type = 'forum' OR t.owner_id = $3 OR EXISTS(
         SELECT 1 FROM thread_members tm WHERE tm.thread_id = t.id AND tm.user_id = $4
       ))
     ORDER BY COALESCE(t.last_message_at, t.created_at) DESC`,
    [Number(userId), Number(serverId), Number(userId), Number(userId)]
  );
  return rows.map(serializeThread);
}

// Discord's rule: a thread with no activity for the server's window archives
// itself. Forum posts never do - a forum is a reference, not a chat.
async function archiveIdleThreads(now = Date.now()) {
  const { rows } = await query(
    `SELECT t.id, t.server_id FROM channels t
     JOIN channels p ON p.id = t.parent_channel_id
     JOIN servers s ON s.id = t.server_id
     WHERE t.type = 'thread' AND t.archived = 0 AND p.type != 'forum'
       AND s.thread_archive_minutes > 0
       AND COALESCE(t.last_message_at, t.created_at) < $1 - s.thread_archive_minutes * 60000`,
    [Number(now)]
  );
  if (!rows.length) return [];
  const servers = new Set();
  await withTransaction(async () => {
    for (const row of rows) {
      await query("UPDATE channels SET archived = 1 WHERE id = $1 AND type = 'thread'", [row.id]);
      servers.add(row.server_id);
    }
  });
  return [...servers];
}

async function getThread(threadId, viewerId = 0) {
  const { rows } = await query(
    `${THREAD_SELECT} WHERE t.id = $2 AND t.type = 'thread'`,
    [Number(viewerId), Number(threadId)]
  );
  return serializeThread(rows[0]);
}

async function threadForMessage(messageId) {
  const { rows } = await query(
    `${THREAD_SELECT} WHERE t.parent_message_id = $2 AND t.type = 'thread'`,
    [0, Number(messageId)]
  );
  return serializeThread(rows[0]);
}

async function createThreadRow({
  serverId,
  parentChannel,
  name,
  ownerId,
  parentMessageId = null,
  messageCount = 0
}) {
  const now = Date.now();
  const { rows: positionRows } = await query(
    'SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM channels WHERE server_id = $1',
    [Number(serverId)]
  );
  const position = positionRows[0].pos;
  const threadId = await withTransaction(async () => {
    const { rows } = await query(
      `INSERT INTO channels
        (server_id, category_id, name, type, position, created_at,
         parent_channel_id, parent_message_id, owner_id, archived, last_message_at, message_count)
       VALUES ($1, $2, $3, 'thread', $4, $5, $6, $7, $8, 0, $9, $10)
       RETURNING id`,
      [
        Number(serverId),
        parentChannel.category_id ?? null,
        threadTitle(name),
        position,
        now,
        Number(parentChannel.id),
        parentMessageId ? Number(parentMessageId) : null,
        Number(ownerId),
        now,
        Number(messageCount) || 0
      ]
    );
    await joinThread(rows[0].id, ownerId);
    return rows[0].id;
  });
  return getThread(threadId, ownerId);
}

// Called whenever a message lands in a thread so the sidebar can sort by
// activity without counting rows on every render. Posting also makes you a
// member - that is how a thread becomes visible to someone who was invited.
async function touchThread(channelId, userId) {
  // Posting into an archived thread revives it, the same way Discord does.
  await query(
    `UPDATE channels SET last_message_at = $1, message_count = message_count + 1, archived = 0
     WHERE id = $2 AND type = $3`,
    [Date.now(), Number(channelId), 'thread']
  );
  if (userId) await joinThread(channelId, userId);
}

async function setArchived(threadId, archived) {
  await query('UPDATE channels SET archived = $1 WHERE id = $2 AND type = $3', [
    archived ? 1 : 0,
    Number(threadId),
    'thread'
  ]);
  return getThread(threadId);
}

async function renameThread(threadId, name) {
  await query('UPDATE channels SET name = $1 WHERE id = $2 AND type = $3', [
    threadTitle(name),
    Number(threadId),
    'thread'
  ]);
  return getThread(threadId);
}

module.exports = {
  threadTitle,
  serializeThread,
  listThreadsForViewer,
  archiveIdleThreads,
  getThread,
  threadForMessage,
  createThreadRow,
  touchThread,
  setArchived,
  renameThread,
  joinThread,
  isThreadMember,
  threadMembers
};
