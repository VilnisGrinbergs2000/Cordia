'use strict';

// Postgres read model for the Phase 2a pilot.
//
// Mirrors the SQLite helpers in ../util.js and ../attention.js for the routes
// that have been converted so far (routes/read.js). Every function here is
// async and goes through pg/pool query(), so calls made inside
// withTransaction() join the caller's transaction through AsyncLocalStorage.
require('./env');
const { query } = require('./pool');
const { isOnline } = require('../presence');
const { DEFAULT_MEMBER_PERMISSIONS } = require('../permissionCatalog');

const MESSAGE_SELECT = `
  SELECT m.*, c.server_id AS server_id,
    u.username AS author_username, u.display_name AS author_display_name,
    u.avatar_color AS author_avatar_color, u.avatar_url AS author_avatar_url,
    u.status_text AS author_status_text, u.presence AS author_presence,
    u.bio AS author_bio, u.role AS author_role,
    u.e2ee_public_key AS author_e2ee_public_key,
    u.e2ee_key_version AS author_e2ee_key_version,
    r.content AS reply_content, r.attachment_name AS reply_attachment_name,
    r.e2ee AS reply_e2ee, r.e2ee_envelope AS reply_e2ee_envelope,
    r.user_id AS reply_user_id, ru.display_name AS reply_author_name,
    ru.avatar_color AS reply_author_color, ru.avatar_url AS reply_author_avatar_url,
    p.id AS poll_id, p.question AS poll_question,
    p.allow_multiple AS poll_allow_multiple, p.closes_at AS poll_closes_at,
    p.created_at AS poll_created_at, p.created_by AS poll_created_by,
    th.name AS thread_name, th.archived AS thread_archived
  FROM messages m
  JOIN users u ON u.id = m.user_id
  LEFT JOIN channels c ON c.id = m.channel_id
  LEFT JOIN messages r ON r.id = m.reply_to_id
  LEFT JOIN users ru ON ru.id = r.user_id
  LEFT JOIN polls p ON p.message_id = m.id
  LEFT JOIN channels th ON th.id = m.thread_id
`;

async function one(sql, params) {
  const { rows } = await query(sql, params);
  return rows[0] || null;
}

async function all(sql, params) {
  const { rows } = await query(sql, params);
  return rows;
}

function parseE2eeEnvelope(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parsePermissions(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function reactionsFor(messageId, viewerId) {
  const rows = await all(
    `SELECT emoji, COUNT(*) AS count, string_agg(user_id::text, ',') AS users,
        MAX(CASE WHEN user_id = $1 THEN 1 ELSE 0 END) AS me
       FROM reactions WHERE message_id = $2 GROUP BY emoji ORDER BY MIN(created_at) ASC`,
    [Number(viewerId), Number(messageId)]
  );
  return rows.map((row) => ({
    emoji: row.emoji,
    count: Number(row.count),
    users: row.users ? String(row.users).split(',').map(Number) : [],
    me: !!row.me
  }));
}

async function pollForMessage(row, viewerId) {
  if (!row || !row.poll_id) return null;
  const viewer = Number(viewerId) || 0;
  const options = await all(
    `SELECT o.id, o.label, o.position,
        COUNT(v.user_id) AS count,
        string_agg(v.user_id::text, ',') AS users,
        MAX(CASE WHEN v.user_id = $1 THEN 1 ELSE 0 END) AS me
       FROM poll_options o
       LEFT JOIN poll_votes v ON v.option_id = o.id
       WHERE o.poll_id = $2
       GROUP BY o.id
       ORDER BY o.position ASC, o.id ASC`,
    [viewer, row.poll_id]
  );
  const totals = await one(
    'SELECT COUNT(*) AS votes, COUNT(DISTINCT user_id) AS voters FROM poll_votes WHERE poll_id = $1',
    [row.poll_id]
  );
  const closesAt = row.poll_closes_at ? Number(row.poll_closes_at) : null;
  return {
    id: row.poll_id,
    question: row.poll_question,
    allowMultiple: !!row.poll_allow_multiple,
    closesAt,
    closed: !!closesAt && closesAt <= Date.now(),
    createdAt: row.poll_created_at,
    createdBy: row.poll_created_by,
    totalVotes: Number(totals && totals.votes) || 0,
    voterCount: Number(totals && totals.voters) || 0,
    options: options.map((option) => ({
      id: option.id,
      label: option.label,
      count: Number(option.count) || 0,
      users: option.users ? String(option.users).split(',').map(Number) : [],
      me: !!option.me
    }))
  };
}

async function serializeMessage(row, viewerId) {
  if (!row) return null;
  const encrypted = !!row.e2ee;
  return {
    id: row.id,
    channelId: row.channel_id,
    serverId: row.server_id,
    dmId: row.dm_id,
    content: encrypted ? '' : row.content,
    encrypted,
    envelope: encrypted ? parseE2eeEnvelope(row.e2ee_envelope) : null,
    attachment: row.attachment_url
      ? { url: row.attachment_url, name: row.attachment_name, type: row.attachment_type }
      : null,
    voiceDurationMs: Number(row.voice_duration_ms) || 0,
    forwarded: row.forwarded_from
      ? { from: Number(row.forwarded_from), author: row.forwarded_author || '' }
      : null,
    replyTo: row.reply_to_id
      ? {
          id: row.reply_to_id,
          authorId: row.reply_user_id,
          authorName: row.reply_author_name || 'Unknown user',
          authorColor: row.reply_author_color || '#6366f1',
          authorAvatarUrl: row.reply_author_avatar_url || '',
          content: row.reply_e2ee ? '' : row.reply_content || '',
          encrypted: !!row.reply_e2ee,
          envelope: row.reply_e2ee ? parseE2eeEnvelope(row.reply_e2ee_envelope) : null,
          hasAttachment: !!row.reply_attachment_name
        }
      : null,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    systemType: row.system_type || null,
    threadId: row.thread_id || null,
    thread: row.thread_id
      ? { id: row.thread_id, name: row.thread_name || 'Thread', archived: !!row.thread_archived }
      : null,
    poll: await pollForMessage(row, viewerId),
    reactions: await reactionsFor(row.id, viewerId),
    author: {
      id: row.user_id,
      username: row.author_username,
      displayName: row.author_display_name,
      avatarColor: row.author_avatar_color,
      avatarUrl: row.author_avatar_url || '',
      statusText: row.author_status_text || '',
      presence: row.author_presence || 'online',
      bio: row.author_bio || '',
      role: row.author_role || 'user',
      online: isOnline(row.user_id),
      e2eePublicKey: row.author_e2ee_public_key || '',
      e2eeKeyVersion: Number(row.author_e2ee_key_version) || 0,
      e2eeReady: !!row.author_e2ee_public_key
    }
  };
}

function getMessageRow(messageId) {
  return one(MESSAGE_SELECT + ' WHERE m.id = $1', [Number(messageId)]);
}

function getChannelRow(channelId) {
  return one(
    'SELECT c.*, s.name AS server_name FROM channels c JOIN servers s ON s.id = c.server_id WHERE c.id = $1',
    [Number(channelId)]
  );
}

function getDmRow(dmId) {
  return one('SELECT * FROM dm_channels WHERE id = $1', [Number(dmId)]);
}

function getMembership(serverId, userId) {
  return one('SELECT * FROM server_members WHERE server_id = $1 AND user_id = $2', [
    Number(serverId),
    Number(userId)
  ]);
}

// manageChannels lives in server_groups.permissions; ../permissions.js still
// reads SQLite, so resolve the same rule here against Postgres. Only used for
// the thread fallback below.
async function canManageChannels(serverId, userId, membership) {
  if (membership && (membership.role === 'owner' || membership.role === 'admin')) return true;
  const user = await one('SELECT role FROM users WHERE id = $1', [Number(userId)]);
  if (user && user.role === 'admin') return true;
  const groups = await all(
    'SELECT permissions, is_default FROM server_groups WHERE server_id = $1 ORDER BY position DESC, id ASC',
    [Number(serverId)]
  );
  const assigned = await all(
    `SELECT g.permissions FROM server_member_groups smg
       JOIN server_groups g ON g.id = smg.group_id
       WHERE smg.server_id = $1 AND smg.user_id = $2`,
    [Number(serverId), Number(userId)]
  );
  const base = groups.find((group) => group.is_default);
  const allowed = new Set(base ? parsePermissions(base.permissions) : DEFAULT_MEMBER_PERMISSIONS);
  for (const group of assigned) {
    for (const permission of parsePermissions(group.permissions)) allowed.add(permission);
  }
  return allowed.has('manageChannels');
}

async function assertChannelAccess(channelId, userId) {
  const channel = await getChannelRow(channelId);
  if (!channel) return { error: 'Channel not found', status: 404 };
  const membership = await getMembership(channel.server_id, userId);
  if (!membership) return { error: 'You are not a member of this server', status: 403 };
  // Threads are private: you only get in by starting one, posting in it or
  // joining it. Forum posts stay public - a forum nobody can read is useless.
  if (channel.type === 'thread') {
    const parent = channel.parent_channel_id ? await getChannelRow(channel.parent_channel_id) : null;
    const isForumPost = parent && parent.type === 'forum';
    if (!isForumPost) {
      const joined = await one('SELECT 1 AS ok FROM thread_members WHERE thread_id = $1 AND user_id = $2', [
        channel.id,
        Number(userId)
      ]);
      const canManage = joined ? true : await canManageChannels(channel.server_id, userId, membership);
      if (!canManage) return { error: 'Join this thread to see it', status: 403 };
    }
  }
  return { channel, membership };
}

async function getReadState(userId, scopeType, scopeId) {
  const row = await one(
    'SELECT last_read_message_id, muted FROM read_states WHERE user_id = $1 AND scope_type = $2 AND scope_id = $3',
    [Number(userId), scopeType, Number(scopeId)]
  );
  return {
    lastReadMessageId: row ? Number(row.last_read_message_id) : 0,
    muted: row ? !!row.muted : false
  };
}

async function maxScopeMessageId(scopeType, scopeId) {
  const column = scopeType === 'dm' ? 'dm_id' : 'channel_id';
  const row = await one('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE ' + column + ' = $1', [
    Number(scopeId)
  ]);
  return Number(row.id);
}

function ensureReadState(userId, scopeType, scopeId, now) {
  return query(
    `INSERT INTO read_states (user_id, scope_type, scope_id, last_read_message_id, muted, updated_at)
     VALUES ($1, $2, $3, 0, 0, $4)
     ON CONFLICT (user_id, scope_type, scope_id) DO NOTHING`,
    [Number(userId), scopeType, Number(scopeId), now]
  );
}

async function markScopeRead(userId, scopeType, scopeId) {
  const now = Date.now();
  const messageId = await maxScopeMessageId(scopeType, scopeId);
  await ensureReadState(userId, scopeType, scopeId, now);
  await query(
    `UPDATE read_states SET last_read_message_id = $1, updated_at = $2
     WHERE user_id = $3 AND scope_type = $4 AND scope_id = $5`,
    [messageId, now, Number(userId), scopeType, Number(scopeId)]
  );
  await query(
    `UPDATE mentions SET read_at = $1
     WHERE user_id = $2 AND scope_type = $3 AND scope_id = $4 AND read_at IS NULL`,
    [now, Number(userId), scopeType, Number(scopeId)]
  );
  return { lastReadMessageId: messageId, ...(await getReadState(userId, scopeType, scopeId)), unread: 0 };
}

async function setScopeMuted(userId, scopeType, scopeId, muted) {
  const now = Date.now();
  await ensureReadState(userId, scopeType, scopeId, now);
  await query(
    `UPDATE read_states SET muted = $1, updated_at = $2
     WHERE user_id = $3 AND scope_type = $4 AND scope_id = $5`,
    [muted ? 1 : 0, now, Number(userId), scopeType, Number(scopeId)]
  );
  return { ...(await getReadState(userId, scopeType, scopeId)), muted: !!muted };
}

async function markScopeUnread(userId, scopeType, scopeId, messageId) {
  const uid = Number(userId);
  const sid = Number(scopeId);
  const target = Number(messageId);
  const column = scopeType === 'dm' ? 'dm_id' : 'channel_id';
  const exists = await one('SELECT id FROM messages WHERE id = $1 AND ' + column + ' = $2', [target, sid]);
  if (!exists) return { ...(await getReadState(uid, scopeType, sid)), unread: 0 };

  const marker = Math.max(target - 1, 0);
  const now = Date.now();
  await ensureReadState(uid, scopeType, sid, now);
  await query(
    `UPDATE read_states SET last_read_message_id = $1, updated_at = $2
     WHERE user_id = $3 AND scope_type = $4 AND scope_id = $5`,
    [marker, now, uid, scopeType, sid]
  );
  await query(
    `UPDATE mentions SET read_at = NULL
     WHERE user_id = $1 AND scope_type = $2 AND scope_id = $3 AND message_id >= $4`,
    [uid, scopeType, sid, target]
  );

  const unread = await one(
    'SELECT COUNT(*) AS total FROM messages WHERE ' + column + ' = $1 AND id > $2 AND user_id <> $3',
    [sid, marker, uid]
  );
  return { ...(await getReadState(uid, scopeType, sid)), unread: Number((unread && unread.total) || 0) };
}

async function getCatchup(userId, scopeType, scopeId) {
  const uid = Number(userId);
  const sid = Number(scopeId);
  const column = scopeType === 'dm' ? 'dm_id' : 'channel_id';
  const { lastReadMessageId } = await getReadState(uid, scopeType, sid);

  const span = await one(
    `SELECT MIN(id) AS "firstId", MAX(id) AS "lastId",
        SUM(CASE WHEN user_id <> $1 THEN 1 ELSE 0 END) AS others
       FROM messages WHERE ` + column + ` = $2 AND id > $3 AND system_type IS NULL`,
    [uid, sid, lastReadMessageId]
  );

  const count = Number((span && span.others) || 0);
  if (!count) {
    return { count: 0, firstUnreadId: null, lastUnreadId: null, participants: [], mentions: 0 };
  }

  const participants = (
    await all(
      `SELECT u.id AS id, u.display_name AS "displayName", COUNT(*) AS total
       FROM messages m JOIN users u ON u.id = m.user_id
       WHERE m.` + column + ` = $1 AND m.id > $2 AND m.user_id <> $3 AND m.system_type IS NULL
       GROUP BY u.id, u.display_name ORDER BY total DESC, u.display_name ASC LIMIT 4`,
      [sid, lastReadMessageId, uid]
    )
  ).map((row) => ({ id: Number(row.id), displayName: row.displayName, count: Number(row.total) }));

  const mentionRow = await one(
    `SELECT COUNT(*) AS total FROM mentions
     WHERE user_id = $1 AND scope_type = $2 AND scope_id = $3 AND read_at IS NULL`,
    [uid, scopeType, sid]
  );

  return {
    count,
    firstUnreadId: Number((span && span.firstId) || 0) || null,
    lastUnreadId: Number((span && span.lastId) || 0) || null,
    participants,
    mentions: Number((mentionRow && mentionRow.total) || 0)
  };
}

module.exports = {
  getMessageRow,
  getChannelRow,
  getDmRow,
  assertChannelAccess,
  serializeMessage,
  reactionsFor,
  pollForMessage,
  getReadState,
  markScopeRead,
  setScopeMuted,
  markScopeUnread,
  getCatchup
};
