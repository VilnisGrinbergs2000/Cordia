const express = require('express');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query } = require('../pg/pool');
const { authRequired } = require('../auth');
const { trim, getMembership } = require('../util');

const router = express.Router();

router.get('/search', authRequired, asyncHandler(async (req, res) => {
  const searchTerm = trim(req.query.q);
  if (searchTerm.length < 2) return res.status(400).json({ error: 'Search for at least 2 characters.' });
  if (searchTerm.length > 100) return res.status(400).json({ error: 'Search query is too long.' });

  const serverId = Number(req.query.serverId) || null;
  const channelId = Number(req.query.channelId) || null;
  if (serverId && !(await getMembership(serverId, req.user.id))) {
    return res.status(403).json({ error: 'You are not a member of this server.' });
  }
  const needle = `%${searchTerm.replace(/[%_]/g, '')}%`;

  let sql = `
    SELECT m.id, m.content, m.created_at, m.channel_id, c.name AS channel_name,
      c.server_id, s.name AS server_name, u.id AS author_id, u.display_name AS author_name,
      u.avatar_color AS author_color, u.avatar_url AS author_avatar
    FROM messages m
    JOIN channels c ON c.id = m.channel_id
    JOIN servers s ON s.id = c.server_id
    JOIN users u ON u.id = m.user_id
    JOIN server_members sm ON sm.server_id = c.server_id AND sm.user_id = $1
    LEFT JOIN channels p ON p.id = c.parent_channel_id
    WHERE LOWER(m.content) LIKE LOWER($2)
      AND m.system_type IS NULL`;
  // A message inside a private thread is only searchable for thread members.
  // Forum posts are public, exactly like reading them.
  sql += ` AND (
      c.type != 'thread'
      OR p.type = 'forum'
      OR EXISTS (
        SELECT 1 FROM thread_members tm WHERE tm.thread_id = c.id AND tm.user_id = $3
      )
    )`;
  const params = [req.user.id, needle, req.user.id];

  if (serverId) {
    sql += ` AND c.server_id = $${params.length + 1}`;
    params.push(serverId);
  }
  if (channelId) {
    sql += ` AND m.channel_id = $${params.length + 1}`;
    params.push(channelId);
  }
  sql += ' ORDER BY m.id DESC LIMIT 30';

  const { rows } = await query(sql, params);
  res.json({
    results: rows.map((row) => ({
      id: row.id,
      content: row.content,
      createdAt: row.created_at,
      channelId: row.channel_id,
      channelName: row.channel_name,
      serverId: row.server_id,
      serverName: row.server_name,
      author: {
        id: row.author_id,
        displayName: row.author_name,
        avatarColor: row.author_color,
        avatarUrl: row.author_avatar || ''
      }
    }))
  });
}));

module.exports = router;
