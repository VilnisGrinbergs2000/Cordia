const express = require('express');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query } = require('../pg/pool');
const { authRequired } = require('../auth');
const { trim, publicUser, getMembership, buildServer } = require('../util');
const { isOnline } = require('../presence');
const { DEFAULT_MEMBER_PERMISSIONS } = require('../permissionCatalog');

const router = express.Router();

const MAX_RESULTS = 60;

// Public directory: only servers that opted in, newest first. Counts are
// computed here because presence lives in memory, not in the database.
router.get('/discover', authRequired, asyncHandler(async (req, res) => {
  const category = trim(req.query.category);
  const searchTerm = trim(req.query.q).toLowerCase();

  const joinedIds = new Set(
    (
      await query('SELECT server_id FROM server_members WHERE user_id = $1', [req.user.id])
    ).rows.map((row) => row.server_id)
  );

  const rows = (
    await query('SELECT * FROM servers WHERE discoverable = 1 ORDER BY created_at DESC, id DESC')
  ).rows
    .filter((row) => !category || (row.discover_category || 'Community') === category)
    .filter(
      (row) =>
        !searchTerm ||
        row.name.toLowerCase().includes(searchTerm) ||
        (row.description || '').toLowerCase().includes(searchTerm)
    )
    // Boost perk: a server boosted to level 1 or higher is promoted above
    // unboosted servers in the directory. Inside each group the order is still
    // newest first, and the 60-row cap still applies to the promoted list.
    .sort((a, b) => {
      const boostRank = (row) => (Number(row.boost_level) > 0 ? 1 : 0);
      const byBoost = boostRank(b) - boostRank(a);
      if (byBoost) return byBoost;
      return b.created_at - a.created_at || b.id - a.id;
    })
    .slice(0, MAX_RESULTS);

  const servers = [];
  for (const row of rows) {
    const members = (
      await query('SELECT user_id FROM server_members WHERE server_id = $1', [row.id])
    ).rows;
    servers.push({
      id: row.id,
      name: row.name,
      description: row.description || '',
      iconUrl: row.icon_url || '',
      iconColor: row.icon_color,
      banner: row.banner || '',
      boostLevel: Number(row.boost_level) || 0,
      discoverCategory: row.discover_category || 'Community',
      memberCount: members.length,
      onlineCount: members.filter((member) => isOnline(member.user_id)).length,
      joined: joinedIds.has(row.id)
    });
  }

  res.json({ servers });
}));

// Joining from Discover is the invite join without the code: same row, same
// events, so the member's other sessions pick the server up immediately.
router.post('/discover/:id/join', authRequired, asyncHandler(async (req, res) => {
  const server = (
    await query('SELECT * FROM servers WHERE id = $1 AND discoverable = 1', [
      Number(req.params.id)
    ])
  ).rows[0];
  if (!server) return res.status(404).json({ error: 'That server is not listed in Discover.' });

  if (await getMembership(server.id, req.user.id)) {
    return res.status(409).json({ error: 'You are already a member of this server.' });
  }

  await query('INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4)', [
    server.id,
    req.user.id,
    'member',
    Date.now()
  ]);

  const joinedServer = await buildServer(server.id);
  const member =
    joinedServer?.members.find((entry) => entry.id === req.user.id) || {
      ...publicUser(req.user),
      serverRole: 'member',
      role: req.user.role,
      groups: [],
      permissions: DEFAULT_MEMBER_PERMISSIONS,
      highestGroupPosition: 0
    };
  const io = req.app.get('io');
  io.in(`user:${req.user.id}`).socketsJoin(`server:${server.id}`);
  io.to(`user:${req.user.id}`).emit('server:joined', { server: joinedServer });
  io.to(`server:${server.id}`).emit('server:member-joined', { serverId: server.id, member });

  res.json({ server: joinedServer });
}));

module.exports = router;
