'use strict';
// Personal bookmarks. A saved message is private to the person who saved it and
// never affects the channel's pins, so saving works in any conversation the
// user can already read — including DMs and private threads.
const express = require('express');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query } = require('../pg/pool');
const { authRequired } = require('../auth');
const { assertChannelAccess, getMessageRow, getDmRow, isDmParticipant } = require('../util');

const router = express.Router();

async function canRead(message, userId) {
  if (message.channel_id) {
    const access = await assertChannelAccess(message.channel_id, userId);
    return !access.error;
  }
  if (message.dm_id) {
    return isDmParticipant(await getDmRow(message.dm_id), userId);
  }
  return false;
}

router.post('/messages/:id/save', authRequired, asyncHandler(async (req, res) => {
  const message = await getMessageRow(req.params.id);
  if (!message) return res.status(404).json({ error: 'Message not found.' });
  if (!(await canRead(message, req.user.id))) {
    return res.status(403).json({ error: 'You cannot save this message.' });
  }
  await query(
    `INSERT INTO saved_messages (user_id, message_id, created_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, message_id) DO NOTHING`,
    [req.user.id, message.id, Date.now()]
  );
  res.status(201).json({ ok: true });
}));

router.delete('/messages/:id/save', authRequired, asyncHandler(async (req, res) => {
  await query('DELETE FROM saved_messages WHERE user_id = $1 AND message_id = $2', [
    req.user.id,
    Number(req.params.id)
  ]);
  res.json({ ok: true });
}));

router.get('/saved', authRequired, asyncHandler(async (req, res) => {
  // Access is filtered in SQL rather than per row: a saved message from a server
  // the user left, or a thread they were removed from, simply stops appearing.
  const { rows } = await query(
    `SELECT sm.id AS saved_id, sm.created_at AS saved_at,
            m.id AS message_id, m.content, m.e2ee, m.channel_id, m.dm_id, m.created_at,
            u.id AS author_id, u.username, u.display_name, u.avatar_color, u.avatar_url,
            c.name AS channel_name, c.server_id, s.name AS server_name,
            du.display_name AS dm_name, du.username AS dm_username
     FROM saved_messages sm
     JOIN messages m ON m.id = sm.message_id
     JOIN users u ON u.id = m.user_id
     LEFT JOIN channels c ON c.id = m.channel_id
     LEFT JOIN servers s ON s.id = c.server_id
     LEFT JOIN dm_channels d ON d.id = m.dm_id
     LEFT JOIN users du ON du.id = CASE WHEN d.user_a = $1 THEN d.user_b ELSE d.user_a END
     WHERE sm.user_id = $1
       AND (m.channel_id IS NULL OR EXISTS (
             SELECT 1 FROM server_members smem
             WHERE smem.server_id = c.server_id AND smem.user_id = $1))
       AND (m.channel_id IS NULL OR c.type <> 'thread' OR EXISTS (
             SELECT 1 FROM thread_members tm
             WHERE tm.thread_id = c.id AND tm.user_id = $1))
       AND (m.dm_id IS NULL OR d.user_a = $1 OR d.user_b = $1)
     ORDER BY sm.created_at DESC
     LIMIT 100`,
    [req.user.id]
  );

  res.json({
    saved: rows.map((row) => ({
      id: Number(row.saved_id),
      savedAt: Number(row.saved_at),
      messageId: Number(row.message_id),
      scopeType: row.dm_id ? 'dm' : 'channel',
      scopeId: Number(row.dm_id || row.channel_id),
      serverId: row.server_id ? Number(row.server_id) : null,
      channelName: row.dm_id ? row.dm_name || 'Direct message' : row.channel_name,
      serverName: row.server_name || null,
      content: row.e2ee ? '' : row.content,
      encrypted: !!row.e2ee,
      createdAt: Number(row.created_at),
      author: {
        id: Number(row.author_id),
        username: row.username,
        displayName: row.display_name,
        avatarColor: row.avatar_color,
        avatarUrl: row.avatar_url || ''
      }
    }))
  });
}));

module.exports = router;
