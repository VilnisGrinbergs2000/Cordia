const express = require('express');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query } = require('../pg/pool');
const { authRequired } = require('../auth');
const {
  getChannelRow,
  getDmRow,
  getMessageRow,
  assertChannelAccess,
  serializeMessage,
  markScopeRead,
  markScopeUnread,
  setScopeMuted,
  getCatchup
} = require('../pg/readModel');

const router = express.Router();

function isDmParticipant(dm, userId) {
  return !!dm && (Number(dm.user_a) === Number(userId) || Number(dm.user_b) === Number(userId));
}

async function resolveScope(req) {
  const scopeType = req.params.scopeType === 'dm' ? 'dm' : req.params.scopeType === 'channel' ? 'channel' : null;
  const scopeId = Number(req.params.scopeId);
  if (!scopeType || !Number.isInteger(scopeId) || scopeId <= 0) {
    return { error: 'Invalid conversation.', status: 400 };
  }
  if (scopeType === 'channel') {
    const access = await assertChannelAccess(scopeId, req.user.id);
    if (access.error) return access;
    if (access.channel.type !== 'text' && access.channel.type !== 'thread') {
      return { error: 'Read state is only available for text channels.', status: 400 };
    }
    return { scopeType, scopeId };
  }
  const dm = await getDmRow(scopeId);
  if (!isDmParticipant(dm, req.user.id)) {
    return { error: 'Conversation not found.', status: 404 };
  }
  return { scopeType, scopeId };
}

router.post('/read/:scopeType/:scopeId', authRequired, asyncHandler(async (req, res) => {
  const scope = await resolveScope(req);
  if (scope.error) return res.status(scope.status).json({ error: scope.error });
  res.json({ readState: await markScopeRead(req.user.id, scope.scopeType, scope.scopeId) });
}));

router.patch('/read/:scopeType/:scopeId/mute', authRequired, asyncHandler(async (req, res) => {
  const scope = await resolveScope(req);
  if (scope.error) return res.status(scope.status).json({ error: scope.error });
  const muted = !!req.body.muted;
  res.json({ readState: await setScopeMuted(req.user.id, scope.scopeType, scope.scopeId, muted) });
}));

router.post('/read/:scopeType/:scopeId/unread', authRequired, asyncHandler(async (req, res) => {
  const scope = await resolveScope(req);
  if (scope.error) return res.status(scope.status).json({ error: scope.error });
  const messageId = Number(req.body && req.body.messageId);
  if (!Number.isInteger(messageId) || messageId <= 0) {
    return res.status(400).json({ error: 'Invalid message.' });
  }
  res.json({ readState: await markScopeUnread(req.user.id, scope.scopeType, scope.scopeId, messageId) });
}));

router.post('/read/all', authRequired, asyncHandler(async (req, res) => {
  const uid = req.user.id;

  const channelIds = (
    await query(
      `SELECT c.id FROM channels c
       JOIN server_members sm ON sm.server_id = c.server_id AND sm.user_id = $1
       LEFT JOIN read_states rs
         ON rs.user_id = $2 AND rs.scope_type = 'channel' AND rs.scope_id = c.id
       WHERE c.type = 'text'
         AND COALESCE(rs.muted, 0) = 0
         AND EXISTS (
           SELECT 1 FROM messages m
           WHERE m.channel_id = c.id
             AND m.id > COALESCE(rs.last_read_message_id, 0)
             AND m.system_type IS NULL
             AND m.user_id <> $3
         )`,
      [uid, uid, uid]
    )
  ).rows.map((row) => Number(row.id));

  const dmIds = (
    await query(
      `SELECT d.id FROM dm_channels d
       LEFT JOIN read_states rs
         ON rs.user_id = $1 AND rs.scope_type = 'dm' AND rs.scope_id = d.id
       WHERE (d.user_a = $2 OR d.user_b = $3)
         AND COALESCE(rs.muted, 0) = 0
         AND EXISTS (
           SELECT 1 FROM messages m
           WHERE m.dm_id = d.id
             AND m.id > COALESCE(rs.last_read_message_id, 0)
             AND m.system_type IS NULL
             AND m.user_id <> $4
         )`,
      [uid, uid, uid, uid]
    )
  ).rows.map((row) => Number(row.id));

  const cleared = [];
  for (const id of channelIds) {
    await markScopeRead(uid, 'channel', id);
    cleared.push({ scopeType: 'channel', scopeId: id });
  }
  for (const id of dmIds) {
    await markScopeRead(uid, 'dm', id);
    cleared.push({ scopeType: 'dm', scopeId: id });
  }

  res.json({ cleared, count: cleared.length });
}));

router.get('/catchup/summary', authRequired, asyncHandler(async (req, res) => {
  const uid = req.user.id;
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 40);
  const exclude = String(req.query.exclude || '').trim();

  const channelRows = (
    await query(
      `SELECT c.id AS scope_id, c.name, c.server_id, s.name AS server_name,
              COALESCE(rs.muted, 0) AS muted
       FROM channels c
       JOIN server_members sm ON sm.server_id = c.server_id AND sm.user_id = $1
       JOIN servers s ON s.id = c.server_id
       LEFT JOIN read_states rs
         ON rs.user_id = $2 AND rs.scope_type = 'channel' AND rs.scope_id = c.id
       WHERE c.type = 'text'`,
      [uid, uid]
    )
  ).rows;

  const dmRows = (
    await query(
      `SELECT d.id AS scope_id, d.user_a, d.user_b, COALESCE(rs.muted, 0) AS muted
       FROM dm_channels d
       LEFT JOIN read_states rs
         ON rs.user_id = $1 AND rs.scope_type = 'dm' AND rs.scope_id = d.id
       WHERE d.user_a = $2 OR d.user_b = $3`,
      [uid, uid, uid]
    )
  ).rows;

  const scopes = [];

  for (const row of channelRows) {
    if (row.muted) continue;
    if (exclude === 'ch:' + row.scope_id) continue;
    const catchup = await getCatchup(uid, 'channel', row.scope_id);
    if (!catchup.count) continue;
    scopes.push({
      scopeType: 'channel',
      scopeId: row.scope_id,
      name: row.name,
      serverId: row.server_id,
      serverName: row.server_name,
      muted: !!row.muted,
      catchup
    });
  }

  for (const row of dmRows) {
    if (row.muted) continue;
    if (exclude === 'dm:' + row.scope_id) continue;
    const catchup = await getCatchup(uid, 'dm', row.scope_id);
    if (!catchup.count) continue;
    const otherId = Number(row.user_a) === uid ? row.user_b : row.user_a;
    const other = (await query('SELECT display_name FROM users WHERE id = $1', [otherId])).rows[0];
    scopes.push({
      scopeType: 'dm',
      scopeId: row.scope_id,
      name: (other && other.display_name) || 'Direct message',
      serverId: null,
      serverName: '',
      muted: !!row.muted,
      catchup
    });
  }

  scopes.sort((left, right) => right.catchup.lastUnreadId - left.catchup.lastUnreadId);
  const page = scopes.slice(0, limit);

  const conversations = [];
  for (const entry of page) {
    const row = (
      await query(
        `SELECT m.id, m.content, m.e2ee, m.created_at, m.user_id, u.display_name
         FROM messages m LEFT JOIN users u ON u.id = m.user_id
         WHERE m.id = $1`,
        [entry.catchup.lastUnreadId]
      )
    ).rows[0];
    conversations.push({
      scopeType: entry.scopeType,
      scopeId: entry.scopeId,
      name: entry.name,
      serverId: entry.serverId,
      serverName: entry.serverName,
      muted: entry.muted,
      unread: entry.catchup.count,
      mentions: entry.catchup.mentions,
      firstUnreadId: entry.catchup.firstUnreadId,
      lastUnreadId: entry.catchup.lastUnreadId,
      participants: entry.catchup.participants,
      lastMessage: row
        ? {
            id: row.id,
            authorId: row.user_id,
            authorName: row.display_name || 'Someone',
            createdAt: row.created_at,
            excerpt: row.e2ee ? 'Encrypted message' : String(row.content || '').slice(0, 140)
          }
        : null
    });
  }

  res.json({ conversations, total: scopes.length });
}));

router.get('/mentions', authRequired, asyncHandler(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 50);
  // Access is checked in SQL: a mention is a dead row once you are out of the
  // server or out of the thread, and it must not keep handing back content.
  const rows = (
    await query(
      `SELECT mn.id, mn.message_id, mn.scope_type, mn.scope_id, mn.created_at, mn.read_at
       FROM mentions mn
       LEFT JOIN channels c ON mn.scope_type = 'channel' AND c.id = mn.scope_id
       LEFT JOIN channels p ON p.id = c.parent_channel_id
       WHERE mn.user_id = $1
         AND (
           mn.scope_type = 'dm'
           OR (
             mn.scope_type = 'channel'
             AND c.id IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM server_members sm
               WHERE sm.server_id = c.server_id AND sm.user_id = mn.user_id
             )
             AND (
               c.type <> 'thread'
               OR p.type = 'forum'
               OR EXISTS (
                 SELECT 1 FROM thread_members tm
                 WHERE tm.thread_id = c.id AND tm.user_id = mn.user_id
               )
             )
           )
         )
       ORDER BY mn.id DESC LIMIT $2`,
      [req.user.id, limit]
    )
  ).rows;

  const mentions = [];
  for (const row of rows) {
    const messageRow = await getMessageRow(row.message_id);
    if (!messageRow) continue;
    let scopeName = '';
    let serverId = null;
    let serverName = '';
    if (row.scope_type === 'dm') {
      const dm = await getDmRow(row.scope_id);
      if (!dm) continue;
      const otherId = Number(dm.user_a) === Number(req.user.id) ? dm.user_b : dm.user_a;
      const other = (await query('SELECT display_name FROM users WHERE id = $1', [otherId])).rows[0];
      scopeName = (other && other.display_name) || 'Direct message';
    } else {
      const channel = await getChannelRow(row.scope_id);
      if (!channel) continue;
      scopeName = channel.name;
      serverId = channel.server_id;
      serverName = channel.server_name;
    }
    mentions.push({
      id: row.id,
      createdAt: row.created_at,
      readAt: row.read_at,
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      scopeName,
      serverId,
      serverName,
      message: await serializeMessage(messageRow, req.user.id)
    });
  }

  res.json({ mentions });
}));

module.exports = router;
