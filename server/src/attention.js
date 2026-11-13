require('./pg/env');
const { query, withTransaction } = require('./pg/pool');
const { getChannelRow, getDmRow } = require('./util');

function scopeKey(scopeType, scopeId) {
  return `${scopeType === 'dm' ? 'dm' : 'ch'}:${Number(scopeId)}`;
}

async function getReadState(userId, scopeType, scopeId) {
  const { rows } = await query(
    `SELECT last_read_message_id, muted FROM read_states
     WHERE user_id = $1 AND scope_type = $2 AND scope_id = $3`,
    [Number(userId), scopeType, Number(scopeId)]
  );
  const row = rows[0];
  return {
    lastReadMessageId: row ? Number(row.last_read_message_id) : 0,
    muted: row ? !!row.muted : false
  };
}

async function maxScopeMessageId(scopeType, scopeId) {
  if (scopeType === 'dm') {
    const { rows } = await query('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE dm_id = $1', [
      Number(scopeId)
    ]);
    return Number(rows[0].id);
  }
  const { rows } = await query(
    'SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE channel_id = $1',
    [Number(scopeId)]
  );
  return Number(rows[0].id);
}

async function markScopeRead(userId, scopeType, scopeId) {
  const now = Date.now();
  const messageId = await maxScopeMessageId(scopeType, scopeId);
  await withTransaction(async () => {
    await query(
      `INSERT INTO read_states
         (user_id, scope_type, scope_id, last_read_message_id, muted, updated_at)
       VALUES ($1, $2, $3, 0, 0, $4) ON CONFLICT (user_id, scope_type, scope_id) DO NOTHING`,
      [Number(userId), scopeType, Number(scopeId), now]
    );
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
  });
  return { lastReadMessageId: messageId, ...(await getReadState(userId, scopeType, scopeId)), unread: 0 };
}

async function setScopeMuted(userId, scopeType, scopeId, muted) {
  const now = Date.now();
  await withTransaction(async () => {
    await query(
      `INSERT INTO read_states
         (user_id, scope_type, scope_id, last_read_message_id, muted, updated_at)
       VALUES ($1, $2, $3, 0, 0, $4) ON CONFLICT (user_id, scope_type, scope_id) DO NOTHING`,
      [Number(userId), scopeType, Number(scopeId), now]
    );
    await query(
      `UPDATE read_states SET muted = $1, updated_at = $2
       WHERE user_id = $3 AND scope_type = $4 AND scope_id = $5`,
      [muted ? 1 : 0, now, Number(userId), scopeType, Number(scopeId)]
    );
  });
  return { ...(await getReadState(userId, scopeType, scopeId)), muted: !!muted };
}

async function buildUnreadState(userId) {
  const state = {};
  const { rows: channelRows } = await query(
    `SELECT c.id,
      COALESCE(rs.last_read_message_id, 0) AS last_read,
      COALESCE(rs.muted, 0) AS muted,
      (SELECT COUNT(*) FROM messages m
       WHERE m.channel_id = c.id
         AND m.id > COALESCE(rs.last_read_message_id, 0)
         AND m.system_type IS NULL
         AND m.user_id <> $1) AS unread,
      (SELECT COUNT(*) FROM mentions mn
       JOIN messages m2 ON m2.id = mn.message_id
       WHERE mn.user_id = $2
         AND mn.scope_type = 'channel'
         AND mn.scope_id = c.id
         AND m2.id > COALESCE(rs.last_read_message_id, 0)) AS mentions
     FROM channels c
     JOIN server_members sm ON sm.server_id = c.server_id AND sm.user_id = $3
     LEFT JOIN read_states rs
       ON rs.user_id = $4 AND rs.scope_type = 'channel' AND rs.scope_id = c.id
     WHERE c.type = 'text'`,
    [Number(userId), Number(userId), Number(userId), Number(userId)]
  );

  for (const row of channelRows) {
    state[scopeKey('channel', row.id)] = {
      unread: Number(row.unread) || 0,
      mentions: Number(row.mentions) || 0,
      muted: !!row.muted,
      lastReadMessageId: Number(row.last_read) || 0
    };
  }

  const { rows: dmRows } = await query(
    `SELECT d.id,
      COALESCE(rs.last_read_message_id, 0) AS last_read,
      COALESCE(rs.muted, 0) AS muted,
      (SELECT COUNT(*) FROM messages m
       WHERE m.dm_id = d.id
         AND m.id > COALESCE(rs.last_read_message_id, 0)
         AND m.system_type IS NULL
         AND m.user_id <> $1) AS unread,
      (SELECT COUNT(*) FROM mentions mn
       JOIN messages m2 ON m2.id = mn.message_id
       WHERE mn.user_id = $2
         AND mn.scope_type = 'dm'
         AND mn.scope_id = d.id
         AND m2.id > COALESCE(rs.last_read_message_id, 0)) AS mentions
     FROM dm_channels d
     LEFT JOIN read_states rs
       ON rs.user_id = $3 AND rs.scope_type = 'dm' AND rs.scope_id = d.id
     WHERE d.user_a = $4 OR d.user_b = $5`,
    [Number(userId), Number(userId), Number(userId), Number(userId), Number(userId)]
  );

  for (const row of dmRows) {
    state[scopeKey('dm', row.id)] = {
      unread: Number(row.unread) || 0,
      mentions: Number(row.mentions) || 0,
      muted: !!row.muted,
      lastReadMessageId: Number(row.last_read) || 0
    };
  }

  return state;
}

function mentionedUsernames(content) {
  const names = new Set();
  for (const match of String(content || '').matchAll(/(?:^|[\s([{])@([a-zA-Z0-9._-]{3,24})\b/g)) {
    names.add(match[1].toLowerCase());
  }
  return [...names];
}

async function createMentions(message, io) {
  if (!message || message.e2ee) return [];
  const scopeType = message.dm_id ? 'dm' : 'channel';
  const scopeId = Number(message.dm_id || message.channel_id);
  if (!scopeId) return [];

  const candidates = new Set();
  const names = mentionedUsernames(message.content);
  if (scopeType === 'dm') {
    const dm = await getDmRow(scopeId);
    if (dm && names.length) {
      const otherId = dm.user_a === message.user_id ? dm.user_b : dm.user_a;
      const { rows } = await query('SELECT id, username FROM users WHERE id = $1', [otherId]);
      const other = rows[0];
      if (other && names.includes(String(other.username).toLowerCase())) {
        candidates.add(Number(other.id));
      }
    }
  } else {
    const channel = await getChannelRow(scopeId);
    if (channel && names.length) {
      const placeholders = names.map((_, index) => '$' + (index + 2)).join(', ');
      const { rows } = await query(
        `SELECT u.id FROM users u
         JOIN server_members sm ON sm.user_id = u.id AND sm.server_id = $1
         WHERE lower(u.username) IN (${placeholders}) AND u.id <> $${names.length + 2}`,
        [channel.server_id, ...names, message.user_id]
      );
      for (const row of rows) candidates.add(Number(row.id));
    }
  }

  if (message.reply_to_id) {
    const { rows } = await query('SELECT user_id FROM messages WHERE id = $1', [
      Number(message.reply_to_id)
    ]);
    const parent = rows[0];
    if (parent && parent.user_id !== message.user_id) candidates.add(Number(parent.user_id));
  }

  const created = [];
  for (const userId of candidates) {
    if (userId === message.user_id) continue;
    const result = await query(
      `INSERT INTO mentions
         (message_id, user_id, scope_type, scope_id, created_at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (message_id, user_id) DO NOTHING`,
      [message.id, userId, scopeType, scopeId, message.created_at || Date.now()]
    );
    if (result.rowCount) {
      created.push(userId);
      io?.to(`user:${userId}`).emit('mention:new', {
        messageId: message.id,
        scopeType,
        scopeId,
        createdAt: message.created_at
      });
    }
  }
  return created;
}

async function markScopeUnread(userId, scopeType, scopeId, messageId) {
  const uid = Number(userId);
  const sid = Number(scopeId);
  const target = Number(messageId);
  const column = scopeType === 'dm' ? 'dm_id' : 'channel_id';
  const { rows: existsRows } = await query(
    `SELECT id FROM messages WHERE id = $1 AND ${column} = $2`,
    [target, sid]
  );
  if (!existsRows[0]) return { ...(await getReadState(uid, scopeType, sid)), unread: 0 };

  const marker = Math.max(target - 1, 0);
  const now = Date.now();
  await withTransaction(async () => {
    await query(
      `INSERT INTO read_states
         (user_id, scope_type, scope_id, last_read_message_id, muted, updated_at)
       VALUES ($1, $2, $3, 0, 0, $4) ON CONFLICT (user_id, scope_type, scope_id) DO NOTHING`,
      [uid, scopeType, sid, now]
    );
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
  });

  const { rows: unreadRows } = await query(
    `SELECT COUNT(*) AS total FROM messages WHERE ${column} = $1 AND id > $2 AND user_id != $3`,
    [sid, marker, uid]
  );

  return { ...(await getReadState(uid, scopeType, sid)), unread: Number(unreadRows[0]?.total || 0) };
}

async function getCatchup(userId, scopeType, scopeId) {
  const uid = Number(userId);
  const sid = Number(scopeId);
  const isDm = scopeType === 'dm';
  const column = isDm ? 'dm_id' : 'channel_id';
  const { lastReadMessageId } = await getReadState(uid, scopeType, sid);

  const { rows: spanRows } = await query(
    `SELECT MIN(id) AS "firstId", MAX(id) AS "lastId",
            SUM(CASE WHEN user_id != $1 THEN 1 ELSE 0 END) AS others
     FROM messages WHERE ${column} = $2 AND id > $3 AND system_type IS NULL`,
    [uid, sid, lastReadMessageId]
  );
  const span = spanRows[0];

  const count = Number(span?.others || 0);
  if (!count) {
    return { count: 0, firstUnreadId: null, lastUnreadId: null, participants: [], mentions: 0 };
  }

  const { rows: participantRows } = await query(
    `SELECT u.id AS id, u.display_name AS "displayName", COUNT(*) AS total
     FROM messages m JOIN users u ON u.id = m.user_id
     WHERE m.${column} = $1 AND m.id > $2 AND m.user_id != $3 AND m.system_type IS NULL
     GROUP BY u.id ORDER BY total DESC, u.display_name ASC LIMIT 4`,
    [sid, lastReadMessageId, uid]
  );
  const participants = participantRows.map((row) => ({
    id: Number(row.id),
    displayName: row.displayName,
    count: Number(row.total)
  }));

  const { rows: mentionRows } = await query(
    `SELECT COUNT(*) AS total FROM mentions
     WHERE user_id = $1 AND scope_type = $2 AND scope_id = $3 AND read_at IS NULL`,
    [uid, scopeType, sid]
  );

  return {
    count,
    firstUnreadId: Number(span?.firstId || 0) || null,
    lastUnreadId: Number(span?.lastId || 0) || null,
    participants,
    mentions: Number(mentionRows[0]?.total || 0)
  };
}

module.exports = {
  scopeKey,
  getReadState,
  markScopeRead,
  setScopeMuted,
  buildUnreadState,
  createMentions,
  getCatchup,
  markScopeUnread
};
