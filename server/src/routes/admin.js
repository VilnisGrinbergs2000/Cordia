const express = require('express');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query, withTransaction } = require('../pg/pool');
const { adminRequired } = require('../auth');
const { publicUser, logAudit, deleteUploadIfUnused, trim } = require('../util');
const { BADGES, badgesFor } = require('../badges');
const { onlineCount } = require('../presence');
const { rooms: voiceRooms } = require('../voiceState');
const { releaseCascade } = require('../messageCounters');
const { sendSuspension, originFor } = require('../email');
const { verifyTransport, publicOrigin } = require('../mail');
const { broadcast: broadcastTemplate } = require('../mailTemplates');
const { unsubscribeToken } = require('./email');
const { submit: submitIndexNow, pageUrls } = require('../indexnow');

const router = express.Router();

async function count(table) {
  const { rows } = await query(`SELECT COUNT(*) AS c FROM ${table}`);
  return Number(rows[0].c);
}

// Mirrors refreshBoostState() in routes/servers.js. Boost totals are denormalised
// onto the server row, so deleting a user's boost rows has to be followed by a
// recount for every server they had boosted.
const BOOST_TIERS = [
  { level: 3, boosts: 14 },
  { level: 2, boosts: 7 },
  { level: 1, boosts: 2 }
];

async function refreshBoostState(serverId) {
  const id = Number(serverId);
  const boostCount =
    Number(
      (
        await query(
          "SELECT COUNT(*) AS count FROM read_states WHERE scope_type = 'server_boost' AND scope_id = $1",
          [id]
        )
      ).rows[0].count
    ) || 0;
  let boostLevel = 0;
  for (const tier of BOOST_TIERS) {
    if (boostCount >= tier.boosts) {
      boostLevel = tier.level;
      break;
    }
  }
  await query('UPDATE servers SET boost_count = $1, boost_level = $2 WHERE id = $3', [
    boostCount,
    boostLevel,
    id
  ]);
}

async function deleteUploadsAfterCommit(urls) {
  for (const url of new Set((urls || []).filter(Boolean))) await deleteUploadIfUnused(url);
}

router.get('/admin/overview', adminRequired, asyncHandler(async (req, res) => {
  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - i);
    days.push(date);
  }
  const start = days[0].getTime();
  const userSeries = (
    await query(
      `SELECT to_char(to_timestamp((created_at / 1000.0)::double precision), 'YYYY-MM-DD') AS day, COUNT(*) AS c
       FROM users WHERE created_at >= $1 GROUP BY day`,
      [start]
    )
  ).rows;
  const messageSeries = (
    await query(
      `SELECT to_char(to_timestamp((created_at / 1000.0)::double precision), 'YYYY-MM-DD') AS day, COUNT(*) AS c
       FROM messages WHERE created_at >= $1 GROUP BY day`,
      [start]
    )
  ).rows;
  const userMap = Object.fromEntries(userSeries.map((row) => [row.day, Number(row.c)]));
  const messageMap = Object.fromEntries(messageSeries.map((row) => [row.day, Number(row.c)]));

  const series = days.map((date) => {
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
      date.getDate()
    ).padStart(2, '0')}`;
    return {
      label: date.toLocaleDateString(undefined, { weekday: 'short' }),
      users: userMap[key] || 0,
      messages: messageMap[key] || 0
    };
  });

  const recentUsers = (
    await query('SELECT * FROM users ORDER BY created_at DESC LIMIT 6')
  ).rows.map((row) => ({ ...publicUser(row), email: row.email, banned: !!row.banned }));

  const recentServers = (
    await query(
      `SELECT s.*, u.username AS owner_name,
        (SELECT COUNT(*) FROM server_members sm WHERE sm.server_id = s.id) AS member_count
       FROM servers s JOIN users u ON u.id = s.owner_id
       ORDER BY s.created_at DESC LIMIT 6`
    )
  ).rows.map((row) => ({
      id: row.id,
      name: row.name,
      iconColor: row.icon_color,
      iconUrl: row.icon_url || '',
      ownerName: row.owner_name,
      memberCount: Number(row.member_count),
      createdAt: row.created_at
    }));

  res.json({
    totals: {
      users: await count('users'),
      servers: await count('servers'),
      messages: await count('messages'),
      dms: await count('dm_channels'),
      badges: await count('user_badges'),
      banned: Number((await query('SELECT COUNT(*) AS c FROM users WHERE banned = 1')).rows[0].c),
      online: onlineCount()
    },
    series,
    recentUsers,
    recentServers
  });
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS = 30 * DAY_MS;

// The activation funnel, computed from the events table. Only the five steps
// that matter are counted; everything else in the table is ignored here.
router.get('/admin/activation', adminRequired, asyncHandler(async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
  const since = Date.now() - days * 24 * 60 * 60 * 1000;

  const { rows } = await query(
    `SELECT to_char(to_timestamp(created_at / 1000.0), 'YYYY-MM-DD') AS day, type,
       COUNT(*)::int AS count
       FROM events
      WHERE created_at >= $1 AND type IN
        ('user_created', 'server_created', 'invite_created', 'member_joined', 'first_message')
      GROUP BY day, type
      ORDER BY day ASC`,
    [since]
  );

  const empty = () => ({
    signups: 0,
    servers: 0,
    invites: 0,
    joins: 0,
    firstMessages: 0
  });
  const field = {
    user_created: 'signups',
    server_created: 'servers',
    invite_created: 'invites',
    member_joined: 'joins',
    first_message: 'firstMessages'
  };
  const funnel = empty();
  const byDay = new Map();
  for (const row of rows) {
    const key = field[row.type];
    if (!key) continue;
    funnel[key] += row.count;
    const day = byDay.get(row.day) || { day: row.day, ...empty() };
    day[key] += row.count;
    byDay.set(row.day, day);
  }

  // Retention needs session rows, which only exist once someone opens the app
  // again on a later day. The cohort reaches back 31 days even when the funnel
  // window is narrower, because a day-30 rate cannot be read off two weeks of
  // signups.
  const cohortSince = Math.min(since, Date.now() - 31 * 24 * 60 * 60 * 1000);
  const retention = (
    await query(
      `WITH signups AS (
         SELECT user_id, date_trunc('day', to_timestamp(created_at / 1000.0)) AS day
           FROM events WHERE type = 'user_created' AND created_at >= $1
       ),
       sessions AS (
         SELECT DISTINCT user_id, date_trunc('day', to_timestamp(created_at / 1000.0)) AS day
           FROM events WHERE type = 'session_started' AND created_at >= $1
       )
       SELECT
         COUNT(*)::int AS cohort,
         COUNT(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM sessions s
            WHERE s.user_id = su.user_id AND s.day = su.day + interval '1 day'
         ))::int AS d1,
         COUNT(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM sessions s
            WHERE s.user_id = su.user_id AND s.day = su.day + interval '7 day'
         ))::int AS d7,
         COUNT(*) FILTER (WHERE EXISTS (
           SELECT 1 FROM sessions s
            WHERE s.user_id = su.user_id AND s.day = su.day + interval '30 day'
         ))::int AS d30,
         COUNT(*) FILTER (
           WHERE su.day <= date_trunc('day', now()) - interval '30 day'
         )::int AS d30_eligible,
         (MIN(EXTRACT(EPOCH FROM su.day)) * 1000)::bigint AS cohort_start
       FROM signups su`,
      [cohortSince]
    )
  ).rows[0];

  // Time to value: signup to the first message that account ever sent. The
  // median hides the tail, so the 90th percentile ships next to it.
  const value = (
    await query(
      `SELECT COUNT(*)::int AS samples,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY m.created_at - u.created_at) AS median_ms,
         percentile_cont(0.9) WITHIN GROUP (ORDER BY m.created_at - u.created_at) AS p90_ms
         FROM events u
         JOIN LATERAL (
           SELECT MIN(created_at) AS created_at
             FROM events f
            WHERE f.type = 'first_message' AND f.user_id = u.user_id
         ) m ON m.created_at IS NOT NULL
        WHERE u.type = 'user_created' AND u.created_at >= $1`,
      [since]
    )
  ).rows[0];

  res.json({
    days,
    since,
    funnel,
    daily: [...byDay.values()],
    retention: {
      cohort: retention.cohort,
      d1: retention.d1,
      d7: retention.d7,
      d30: retention.d30,
      d30Eligible: retention.d30_eligible,
      // How long until the oldest signup in the cohort turns 30 days old, so
      // the panel can say "in 12 days" instead of "not yet".
      d30ReadyInDays:
        retention.cohort_start === null
          ? null
          : Math.max(0, Math.ceil((Number(retention.cohort_start) + THIRTY_DAYS - Date.now()) / DAY_MS)),
      cohortSince
    },
    timeToValue: {
      samples: value.samples,
      medianMinutes:
        value.median_ms === null || value.median_ms === undefined
          ? null
          : Math.round(Number(value.median_ms) / 60000),
      p90Minutes:
        value.p90_ms === null || value.p90_ms === undefined
          ? null
          : Math.round(Number(value.p90_ms) / 60000)
    }
  });

}));

router.get('/admin/users', adminRequired, asyncHandler(async (req, res) => {
  const search = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const like = `%${search}%`;
  const rows = (
    await query(
      `SELECT u.*,
        (SELECT COUNT(*) FROM server_members sm WHERE sm.user_id = u.id) AS server_count,
        (SELECT COUNT(*) FROM user_badges ub WHERE ub.user_id = u.id) AS badge_count
       FROM users u
       WHERE ($1 = '' OR u.username LIKE $2 OR u.display_name LIKE $3 OR u.email LIKE $4)
       ORDER BY u.created_at DESC LIMIT 200`,
      [search, like, like, like]
    )
  ).rows;

  res.json({
    users: await Promise.all(
      rows.map(async (row) => ({
        ...publicUser(row),
        email: row.email,
        banned: !!row.banned,
        messageCount: row.message_count,
        voiceSeconds: row.voice_seconds,
        serverCount: Number(row.server_count),
        badgeCount: Number(row.badge_count),
        badges: (await badgesFor(row.id)).map((badge) => badge.key)
      }))
    )
  });
}));

router.patch('/admin/users/:id', adminRequired, asyncHandler(async (req, res) => {
  const target = (await query('SELECT * FROM users WHERE id = $1', [Number(req.params.id)])).rows[0];
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot change your own admin status or suspension.' });
  }

  const updates = {};
  // Optional, and only meaningful when suspending. It goes into the email, so a
  // suspension is a decision the person can read and answer rather than a
  // screen that stops working.
  const suspendReason = trim(req.body.reason || '').slice(0, 1000);
  if (req.body.role !== undefined) {
    if (!['user', 'admin'].includes(req.body.role)) return res.status(400).json({ error: 'Invalid role.' });
    updates.role = req.body.role;
  }
  if (req.body.banned !== undefined) {
    if (typeof req.body.banned !== 'boolean') return res.status(400).json({ error: 'Invalid suspension value.' });
    if (req.body.banned && target.role === 'admin') {
      return res.status(400).json({ error: 'Demote this administrator before suspending them.' });
    }
    updates.banned = req.body.banned ? 1 : 0;
  }
  const fields = Object.keys(updates);
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });

  await query(
    `UPDATE users SET ${fields.map((f, index) => `${f} = $${index + 1}`).join(', ')} WHERE id = $${fields.length + 1}`,
    [...fields.map((f) => updates[f]), target.id]
  );
  const updated = (await query('SELECT * FROM users WHERE id = $1', [target.id])).rows[0];

  if (updates.role) {
    await logAudit(req.user.id, 'user.role', 'user', target.id, `${target.username} -> ${updates.role}`);
  }
  if (updates.banned !== undefined) {
    await logAudit(
      req.user.id,
      updates.banned ? 'user.suspend' : 'user.restore',
      'user',
      target.id,
      target.username
    );
  }

  const io = req.app.get('io');
  if (updates.banned) {
    io.in(`user:${target.id}`).disconnectSockets(true);
    // Only on the transition, not on every save of an already-suspended user:
    // re-saving the row must not mail the same person again.
    if (!target.banned) {
      await sendSuspension(req, target, suspendReason).catch((error) =>
        console.error('[admin] suspension mail failed', error.message)
      );
    }
  } else {
    io.emit('user:updated', publicUser(updated));
  }

  res.json({
    user: {
      ...publicUser(updated),
      email: updated.email,
      banned: !!updated.banned,
      messageCount: updated.message_count,
      voiceSeconds: updated.voice_seconds
    }
  });
}));

router.delete('/admin/users/:id', adminRequired, asyncHandler(async (req, res) => {
  const target = (await query('SELECT * FROM users WHERE id = $1', [Number(req.params.id)])).rows[0];
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account here.' });

  const io = req.app.get('io');
  const ownedServers = (await query('SELECT id FROM servers WHERE owner_id = $1', [target.id])).rows;
  for (const server of ownedServers) {
    io.to(`server:${server.id}`).emit('server:deleted', { serverId: server.id });
    const channels = (await query('SELECT id FROM channels WHERE server_id = $1', [server.id])).rows;
    for (const channel of channels) {
      const voiceRoom = voiceRooms.get(channel.id);
      if (!voiceRoom) continue;
      for (const participant of voiceRoom.values()) {
        io.to(participant.socketId).emit('voice:closed');
      }
      voiceRooms.delete(channel.id);
    }
  }
  io.in(`user:${target.id}`).disconnectSockets(true);
  io.emit('user:deleted', { userId: target.id });

  // Everything below is read before the delete: the cascade removes the rows
  // (their files, their boosts, their counters) but never the uploads, the
  // denormalised boost totals, or the per-author message counts.
  const ownedChannelIds = (
    await query(
      `SELECT id FROM channels
       WHERE server_id IN (SELECT id FROM servers WHERE owner_id = $1)`,
      [target.id]
    )
  ).rows.map((row) => Number(row.id));
  const boostedServerIds = (
    await query(
      "SELECT DISTINCT scope_id FROM read_states WHERE user_id = $1 AND scope_type = 'server_boost'",
      [target.id]
    )
  ).rows.map((row) => Number(row.scope_id));
  const doomedUploads = [
    target.avatar_url,
    ...(
      await query('SELECT attachment_url FROM messages WHERE user_id = $1 AND attachment_url IS NOT NULL', [
        target.id
      ])
    ).rows.map((row) => row.attachment_url),
    // Messages other people posted inside servers this user owned vanish with
    // those servers, so their attachments leak in exactly the same way.
    ...(
      await query(
        `SELECT attachment_url FROM messages
         WHERE attachment_url IS NOT NULL
           AND channel_id IN (
             SELECT id FROM channels WHERE server_id IN (
               SELECT id FROM servers WHERE owner_id = $1
             )
           )`,
        [target.id]
      )
    ).rows.map((row) => row.attachment_url)
  ];

  await withTransaction(async () => {
    // The owned servers (and their channels, threads and messages) are about to
    // be cascade-deleted, so their author counters are released first.
    await releaseCascade({ channelIds: ownedChannelIds });
    await query(
      "DELETE FROM read_states WHERE user_id = $1 AND scope_type = 'server_boost'",
      [target.id]
    );
    await query('DELETE FROM users WHERE id = $1', [target.id]);
  });

  for (const serverId of boostedServerIds) {
    if ((await query('SELECT 1 FROM servers WHERE id = $1', [serverId])).rows[0]) {
      await refreshBoostState(serverId);
    }
  }
  await deleteUploadsAfterCommit(doomedUploads);
  await logAudit(req.user.id, 'user.delete', 'user', target.id, target.username);
  res.json({ ok: true });
}));

router.post('/admin/users/:id/badges', adminRequired, asyncHandler(async (req, res) => {
  const target = (await query('SELECT * FROM users WHERE id = $1', [Number(req.params.id)])).rows[0];
  if (!target) return res.status(404).json({ error: 'User not found' });
  const badge = req.body.badge;
  if (!BADGES[badge]) return res.status(400).json({ error: 'Unknown badge.' });
  if (!BADGES[badge].grantable) {
    return res.status(400).json({ error: 'That badge is earned automatically and cannot be granted.' });
  }
  const result = await query(
    'INSERT INTO user_badges (user_id, badge, awarded_at) VALUES ($1, $2, $3) ON CONFLICT (user_id, badge) DO NOTHING',
    [target.id, badge, Date.now()]
  );
  if (result.rowCount > 0) {
    await logAudit(req.user.id, 'badge.grant', 'user', target.id, `${BADGES[badge].label} -> ${target.username}`);
    req.app
      .get('io')
      .to(`user:${target.id}`)
      .emit('badges:updated', { badges: await badgesFor(target.id) });
  }
  res.json({ badges: await badgesFor(target.id) });
}));

router.delete('/admin/users/:id/badges/:badge', adminRequired, asyncHandler(async (req, res) => {
  const target = (await query('SELECT * FROM users WHERE id = $1', [Number(req.params.id)])).rows[0];
  if (!target) return res.status(404).json({ error: 'User not found' });
  const badge = req.params.badge;
  if (!BADGES[badge] || !BADGES[badge].grantable) {
    return res.status(400).json({ error: 'That badge cannot be revoked here.' });
  }
  await query('DELETE FROM user_badges WHERE user_id = $1 AND badge = $2', [target.id, badge]);
  await logAudit(req.user.id, 'badge.revoke', 'user', target.id, `${badge} -> ${target.username}`);
  req.app
    .get('io')
    .to(`user:${target.id}`)
    .emit('badges:updated', { badges: await badgesFor(target.id) });
  res.json({ badges: await badgesFor(target.id) });
}));

router.get('/admin/servers', adminRequired, asyncHandler(async (req, res) => {
  const rows = (
    await query(
      `SELECT s.*, u.username AS owner_name,
        (SELECT COUNT(*) FROM server_members sm WHERE sm.server_id = s.id) AS member_count,
        (SELECT COUNT(*) FROM channels c WHERE c.server_id = s.id) AS channel_count,
        (SELECT COUNT(*) FROM messages m JOIN channels c2 ON c2.id = m.channel_id WHERE c2.server_id = s.id) AS message_count
       FROM servers s JOIN users u ON u.id = s.owner_id
       ORDER BY s.created_at DESC LIMIT 200`
    )
  ).rows;

  res.json({
    servers: rows.map((row) => ({
      id: row.id,
      name: row.name,
      iconColor: row.icon_color,
      iconUrl: row.icon_url || '',
      ownerName: row.owner_name,
      memberCount: Number(row.member_count),
      channelCount: Number(row.channel_count),
      messageCount: Number(row.message_count),
      createdAt: row.created_at
    }))
  });
}));

router.delete('/admin/servers/:id', adminRequired, asyncHandler(async (req, res) => {
  const server = (await query('SELECT * FROM servers WHERE id = $1', [Number(req.params.id)])).rows[0];
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const io = req.app.get('io');
  io.to(`server:${server.id}`).emit('server:deleted', { serverId: server.id });
  const channels = (await query('SELECT id FROM channels WHERE server_id = $1', [server.id])).rows;
  for (const channel of channels) {
    const voiceRoom = voiceRooms.get(channel.id);
    if (!voiceRoom) continue;
    for (const participant of voiceRoom.values()) {
      io.to(participant.socketId).emit('voice:closed');
    }
    voiceRooms.delete(channel.id);
  }
  await withTransaction(async () => {
    await releaseCascade({ channelIds: channels.map((row) => Number(row.id)) });
    await query('DELETE FROM servers WHERE id = $1', [server.id]);
  });
  await logAudit(req.user.id, 'server.delete', 'server', server.id, server.name);
  res.json({ ok: true });
}));

router.get('/admin/audit', adminRequired, asyncHandler(async (req, res) => {
  const rows = (
    await query(
      `SELECT a.*, u.username AS actor_name, u.display_name AS actor_display
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
       ORDER BY a.created_at DESC LIMIT 100`
    )
  ).rows;
  res.json({
    logs: rows.map((row) => ({
      id: row.id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      detail: row.detail,
      createdAt: row.created_at,
      actor: row.actor_name
        ? { username: row.actor_name, displayName: row.actor_display }
        : { username: 'system', displayName: 'System' }
    }))
  });
}));

// ── Safety queue ────────────────────────────────────────────────────────────
// Events raised by src/safety.js. They are signals, not verdicts: a moderator
// decides whether a burst was a person typing fast or a spam run.

const SAFETY_KINDS = {
  spam_flood: 'Message flood',
  spam_duplicate: 'Same message, many channels',
  spam_invites: 'Invite spam',
  mass_dm: 'Mass DMs',
  predatory_dm: 'Predatory DM patterns'
};


// Reviewing an application. There is no queue and no automated check — somebody
// with admin rights looks at it and says so, which is exactly as much trust as
// the badge claims.
router.get('/admin/applications', adminRequired, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT a.id, a.name, a.client_id, a.created_at, a.verified_at, a.owner_id,
            u.username AS owner_username,
            (SELECT COUNT(*)::int FROM application_installs i WHERE i.application_id = a.id) AS installs
       FROM applications a JOIN users u ON u.id = a.owner_id
      ORDER BY a.id DESC LIMIT 200`
  );
  res.json({
    applications: rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      clientId: row.client_id,
      createdAt: Number(row.created_at),
      verified: !!row.verified_at,
      owner: row.owner_username,
      installs: Number(row.installs)
    }))
  });
}));

router.post('/admin/applications/:id/verify', adminRequired, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const verified = req.body.verified !== false;
  const { rows } = await query(
    'UPDATE applications SET verified_at = $1 WHERE id = $2 RETURNING id, name, verified_at',
    [verified ? Date.now() : null, id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Application not found.' });
  res.json({ ok: true, verified: !!rows[0].verified_at });
}));
router.get('/admin/safety', adminRequired, asyncHandler(async (req, res) => {
  const status = ['open', 'reviewed', 'all'].includes(req.query.status) ? req.query.status : 'open';
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const where =
    status === 'open' ? 'WHERE e.reviewed_at IS NULL' : status === 'reviewed' ? 'WHERE e.reviewed_at IS NOT NULL' : '';

  const { rows } = await query(
    `SELECT e.id, e.kind, e.severity, e.user_id, e.target_id, e.scope_type, e.scope_id,
            e.message_id, e.detail, e.created_at, e.reviewed_at,
            u.username, u.display_name, u.avatar_color, u.avatar_url,
            t.username AS target_username, t.display_name AS target_display,
            m.content AS message_content
     FROM safety_events e
     JOIN users u ON u.id = e.user_id
     LEFT JOIN users t ON t.id = e.target_id
     LEFT JOIN messages m ON m.id = e.message_id
     ${where}
     ORDER BY e.created_at DESC
     LIMIT $1`,
    [limit]
  );

  const counts = (
    await query(
      `SELECT COUNT(*) FILTER (WHERE reviewed_at IS NULL)::int AS open,
              COUNT(*)::int AS total
       FROM safety_events`
    )
  ).rows[0];

  res.json({
    counts: { open: counts.open, total: counts.total },
    events: rows.map((row) => ({
      id: Number(row.id),
      kind: row.kind,
      kindLabel: SAFETY_KINDS[row.kind] || row.kind,
      severity: row.severity,
      createdAt: Number(row.created_at),
      reviewedAt: row.reviewed_at ? Number(row.reviewed_at) : null,
      user: {
        id: Number(row.user_id),
        username: row.username,
        displayName: row.display_name,
        avatarColor: row.avatar_color,
        avatarUrl: row.avatar_url || ''
      },
      target: row.target_id
        ? {
            id: Number(row.target_id),
            username: row.target_username,
            displayName: row.target_display
          }
        : null,
      scopeType: row.scope_type,
      scopeId: row.scope_id ? Number(row.scope_id) : null,
      messageId: row.message_id ? Number(row.message_id) : null,
      excerpt: row.message_content ? String(row.message_content).slice(0, 400) : '',
      detail: row.detail || {}
    }))
  });
}));

router.post('/admin/safety/:id/review', adminRequired, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  const action = req.body?.action === 'dismissed' ? 'dismissed' : 'resolved';
  const row = (await query('SELECT id, user_id, kind FROM safety_events WHERE id = $1', [id])).rows[0];
  if (!row) return res.status(404).json({ error: 'Event not found.' });
  await query('UPDATE safety_events SET reviewed_at = $1, reviewed_by = $2 WHERE id = $3', [
    Date.now(),
    req.user.id,
    id
  ]);
  await logAudit(req.user.id, 'safety.review', 'safety', id, `${row.kind} / ${action}`);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

const BROADCAST_SEGMENTS = {
  // Verified only by default: an unconfirmed address is a typo as often as it
  // is a person, and bouncing a campaign is what teaches a mail provider to
  // distrust the domain.
  verified: "email_verified = true AND banned = 0 AND email_optout = false",
  everyone: "banned = 0 AND email_optout = false",
  admins: "role = 'admin' AND banned = 0"
};

function segmentFor(name) {
  return BROADCAST_SEGMENTS[String(name || 'verified')] || BROADCAST_SEGMENTS.verified;
}

router.get('/admin/mail', adminRequired, asyncHandler(async (req, res) => {
  const stats = (
    await query(`SELECT
        COUNT(*) FILTER (WHERE sent_at IS NULL AND failed_at IS NULL) AS pending,
        COUNT(*) FILTER (WHERE sent_at IS NOT NULL) AS sent,
        COUNT(*) FILTER (WHERE failed_at IS NOT NULL) AS failed
      FROM email_outbox`)
  ).rows[0];
  const recent = (
    await query(
      `SELECT id, to_email, kind, subject, created_at, sent_at, failed_at, attempts, last_error
         FROM email_outbox ORDER BY id DESC LIMIT 25`
    )
  ).rows;
  const transport = await verifyTransport();
  res.json({
    transport,
    origin: publicOrigin() || originFor(req),
    pending: Number(stats.pending),
    sent: Number(stats.sent),
    failed: Number(stats.failed),
    recent: recent.map((row) => ({
      id: Number(row.id),
      to: row.to_email,
      kind: row.kind,
      subject: row.subject,
      createdAt: Number(row.created_at),
      sentAt: row.sent_at ? Number(row.sent_at) : null,
      failedAt: row.failed_at ? Number(row.failed_at) : null,
      attempts: Number(row.attempts),
      error: row.last_error || ''
    }))
  });
}));

router.post('/admin/broadcast/preview', adminRequired, asyncHandler(async (req, res) => {
  const where = segmentFor(req.body.segment);
  const row = (await query(`SELECT COUNT(*) AS c FROM users WHERE ${where}`)).rows[0];
  res.json({ recipients: Number(row.c), segment: req.body.segment || 'verified' });
}));

router.post('/admin/broadcast', adminRequired, asyncHandler(async (req, res) => {
  const subject = trim(req.body.subject).slice(0, 160);
  const message = String(req.body.message || '').trim().slice(0, 8000);
  if (subject.length < 3) return res.status(400).json({ error: 'Give the message a subject.' });
  if (message.length < 10) return res.status(400).json({ error: 'Write something in the message body.' });

  const where = segmentFor(req.body.segment);
  const recipients = (
    await query(`SELECT id, username, email FROM users WHERE ${where} ORDER BY id`)
  ).rows.filter((row) => row.email);
  if (!recipients.length) return res.status(400).json({ error: 'Nobody is in that segment.' });

  const origin = publicOrigin() || originFor(req);
  const now = Date.now();
  // Chunked multi-row insert: one round trip per hundred recipients instead of
  // one per recipient, and still small enough to stay under Postgres' 65,535
  // bind-parameter ceiling.
  const CHUNK = 100;
  let queued = 0;
  for (let start = 0; start < recipients.length; start += CHUNK) {
    const slice = recipients.slice(start, start + CHUNK);
    const rows = [];
    const params = [];
    for (const row of slice) {
      const base = params.length;
      const unsubscribeUrl = origin
        ? `${origin}/api/email/unsubscribe?u=${row.id}&t=${unsubscribeToken(row.id)}`
        : '';
      const rendered = broadcastTemplate({ username: row.username, subject, message, origin, unsubscribeUrl });
      rows.push(
        `($${base + 1}, $${base + 2}, 'broadcast', $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`
      );
      params.push(
        row.id,
        String(row.email).toLowerCase(),
        subject,
        rendered.html,
        rendered.text,
        `List-Unsubscribe: <${unsubscribeUrl}>\nList-Unsubscribe-Post: List-Unsubscribe=One-Click`,
        now,
        now
      );
    }
    await query(
      `INSERT INTO email_outbox (user_id, to_email, kind, subject, html, text, headers, created_at, next_attempt_at)
       VALUES ${rows.join(', ')}`,
      params
    );
    queued += slice.length;
  }

  await logAudit(req.user.id, 'mail.broadcast', 'user', null, `${queued} recipients / ${subject}`);
  res.json({ queued });
}));

// Manual trigger for the same notification the server sends at boot when the
// pages changed. Useful right after fixing a page without restarting.
router.post('/admin/seo/indexnow', adminRequired, asyncHandler(async (req, res) => {
  const origin = publicOrigin() || originFor(req);
  const urls = Array.isArray(req.body && req.body.urls) ? req.body.urls : pageUrls(origin);
  const result = await submitIndexNow({ origin, urls });
  await logAudit(req.user.id, 'seo.indexnow', 'site', null, `${result.urls || 0} urls / ${result.detail}`);
  res.status(result.ok ? 200 : 502).json(result);
}));

module.exports = router;
