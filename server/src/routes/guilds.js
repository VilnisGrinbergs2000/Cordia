'use strict';
const express = require('express');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query } = require('../pg/pool');
const { authRequired } = require('../auth');
const { parsePermissions } = require('../permissions');

const router = express.Router();

// Read-only views of a server, for bots. A bot could hear about a message
// without being able to look up who sent it: the interaction payload names a
// user id and nothing else, and there was no endpoint that turned an id into a
// person. These routes close that.
//
// Everything is scoped to servers the application is actually installed in. A
// bot asking about a server it is not in gets 404, not 403 — whether a server
// exists is not a bot's business.

async function installed(applicationId, serverId) {
  const { rows } = await query(
    'SELECT 1 FROM application_installs WHERE application_id = $1 AND server_id = $2',
    [Number(applicationId), Number(serverId)]
  );
  return !!rows[0];
}

router.use('/guilds', authRequired, (req, res, next) => {
  if (!req.bot) return res.status(403).json({ error: 'This route requires a bot token.' });
  next();
});

function guildPayload(row) {
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description || '',
    createdAt: Number(row.created_at),
    memberCount: Number(row.member_count || 0),
    channelCount: Number(row.channel_count || 0)
  };
}

router.get('/guilds', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT s.id, s.name, s.description, s.created_at,
            (SELECT COUNT(*)::int FROM server_members m WHERE m.server_id = s.id) AS member_count,
            (SELECT COUNT(*)::int FROM channels c WHERE c.server_id = s.id AND c.type = 'text') AS channel_count
       FROM application_installs i
       JOIN servers s ON s.id = i.server_id
      WHERE i.application_id = $1
      ORDER BY s.id ASC`,
    [req.bot.id]
  );
  res.json({ guilds: rows.map(guildPayload) });
}));

router.get('/guilds/:id', asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!serverId || !(await installed(req.bot.id, serverId))) {
    return res.status(404).json({ error: 'Guild not found.' });
  }
  const { rows } = await query(
    `SELECT s.id, s.name, s.description, s.created_at,
            (SELECT COUNT(*)::int FROM server_members m WHERE m.server_id = s.id) AS member_count,
            (SELECT COUNT(*)::int FROM channels c WHERE c.server_id = s.id AND c.type = 'text') AS channel_count
       FROM servers s WHERE s.id = $1`,
    [serverId]
  );
  res.json({ guild: guildPayload(rows[0]) });
}));

// Paged by id rather than offset: a member list that shifts while you read it
// should not skip anybody.
router.get('/guilds/:id/members', asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!serverId || !(await installed(req.bot.id, serverId))) {
    return res.status(404).json({ error: 'Guild not found.' });
  }
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 200);
  const after = Number(req.query.after) || 0;

  const { rows } = await query(
    `SELECT m.user_id, m.role, m.joined_at,
            u.username, u.display_name, u.avatar_color, u.avatar_url, u.is_bot,
            COALESCE(
              (SELECT json_agg(g.id ORDER BY g.position DESC)
                 FROM server_member_groups mg
                 JOIN server_groups g ON g.id = mg.group_id
                WHERE mg.server_id = m.server_id AND mg.user_id = m.user_id),
              '[]'::json
            ) AS groups
       FROM server_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.server_id = $1 AND m.user_id > $2
      ORDER BY m.user_id ASC
      LIMIT $3`,
    [serverId, after, limit]
  );

  res.json({
    members: rows.map((row) => ({
      id: Number(row.user_id),
      username: row.username,
      displayName: row.display_name || row.username,
      bot: !!row.is_bot,
      avatarColor: row.avatar_color,
      avatarUrl: row.avatar_url || '',
      role: row.role,
      joinedAt: Number(row.joined_at),
      groups: row.groups || []
    })),
    next: rows.length === limit ? Number(rows[rows.length - 1].user_id) : null
  });
}));

router.get('/guilds/:id/channels', asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!serverId || !(await installed(req.bot.id, serverId))) {
    return res.status(404).json({ error: 'Guild not found.' });
  }
  const { rows } = await query(
    `SELECT id, name, type, position, category_id, parent_channel_id, archived
       FROM channels
      WHERE server_id = $1 AND (archived IS NULL OR archived = 0)
      ORDER BY position ASC, id ASC`,
    [serverId]
  );
  res.json({
    channels: rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      type: row.type,
      position: Number(row.position || 0),
      categoryId: row.category_id ? Number(row.category_id) : null,
      parentId: row.parent_channel_id ? Number(row.parent_channel_id) : null
    }))
  });
}));

// Roles, so a bot can decide about somebody other than the person who clicked.
// The interaction carries the invoker's permissions; this is how it finds out
// whether the person it is about to kick is senior to the person asking.
router.get('/guilds/:id/roles', asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!serverId || !(await installed(req.bot.id, serverId))) {
    return res.status(404).json({ error: 'Guild not found.' });
  }
  const { rows } = await query(
    `SELECT id, name, color, permissions, position, is_default
       FROM server_groups WHERE server_id = $1 ORDER BY position DESC, id ASC`,
    [serverId]
  );
  res.json({
    roles: rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      color: row.color,
      position: Number(row.position || 0),
      default: !!row.is_default,
      // Stored as JSON text, not jsonb: a group's permissions are a list inside a
      // string, and handing that string to a bot would be a trap.
      permissions: parsePermissions(row.permissions)
    }))
  });
}));

module.exports = router;
