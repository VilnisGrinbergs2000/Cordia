'use strict';
// Reminders: "come back to this at a time I choose". A bookmark is a shelf; a
// reminder is a promise with a date, and it is finished when it fires.
const express = require('express');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query } = require('../pg/pool');
const { authRequired } = require('../auth');
const { assertChannelAccess, getMessageRow, getDmRow, isDmParticipant } = require('../util');

const router = express.Router();

// A person with two hundred reminders does not have reminders, they have a
// backlog. The cap is generous enough to never be noticed and small enough to
// keep the table honest.
const MAX_PENDING = 100;
const MIN_AHEAD_MS = 30 * 1000;
const MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;
const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

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

router.post('/messages/:id/remind', authRequired, asyncHandler(async (req, res) => {
  const message = await getMessageRow(req.params.id);
  if (!message) return res.status(404).json({ error: 'Message not found.' });
  if (!(await canRead(message, req.user.id))) {
    return res.status(403).json({ error: 'You cannot be reminded about this message.' });
  }
  const at = Number(req.body.at);
  const now = Date.now();
  if (!Number.isFinite(at) || at <= 0) {
    return res.status(400).json({ error: 'Pick a time to be reminded.' });
  }
  if (at < now + MIN_AHEAD_MS) {
    return res.status(400).json({ error: 'That time has already passed.' });
  }
  if (at > now + MAX_AHEAD_MS) {
    return res.status(400).json({ error: 'That is more than a year away.' });
  }
  const { rows: pending } = await query(
    'SELECT COUNT(*)::int AS c FROM reminders WHERE user_id = $1 AND delivered_at IS NULL',
    [req.user.id]
  );
  if (pending[0].c >= MAX_PENDING) {
    return res.status(409).json({ error: `You already have ${MAX_PENDING} reminders waiting.` });
  }
  const note = String(req.body.note || '').trim().slice(0, 200);
  const { rows } = await query(
    `INSERT INTO reminders (user_id, message_id, channel_id, dm_id, note, remind_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [req.user.id, message.id, message.channel_id, message.dm_id, note, at, now]
  );
  res.status(201).json({ reminder: { id: Number(rows[0].id), remindAt: at, note } });
}));

// Pending reminders, plus the ones that fired while the person was away: a
// reminder that only exists for a moment on screen is a reminder that was
// missed. Access is filtered in SQL, so a message in a server they left stops
// appearing rather than leaking its preview.
router.get('/reminders', authRequired, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT r.id, r.note, r.remind_at, r.created_at, r.delivered_at, r.event_id,
            m.id AS message_id, m.content, m.e2ee,
            u.display_name AS author_name, u.username AS author_username,
            c.name AS channel_name, c.server_id, s.name AS server_name,
            du.display_name AS dm_name, du.username AS dm_username,
            e.title AS event_title, e.starts_at AS event_starts, e.channel_id AS event_channel
       FROM reminders r
       LEFT JOIN server_events e ON e.id = r.event_id
       LEFT JOIN messages m ON m.id = r.message_id
       LEFT JOIN users u ON u.id = m.user_id
       LEFT JOIN channels c ON c.id = m.channel_id
       LEFT JOIN servers s ON s.id = c.server_id
       LEFT JOIN dm_channels d ON d.id = m.dm_id
       LEFT JOIN users du ON du.id = CASE WHEN d.user_a = $1 THEN d.user_b ELSE d.user_a END
      WHERE r.user_id = $1
        AND (r.delivered_at IS NULL OR r.delivered_at > $2)
        AND (
          m.id IS NULL
          OR (m.channel_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM server_members sm
                 WHERE sm.server_id = c.server_id AND sm.user_id = $1))
          OR (m.dm_id IS NOT NULL AND (d.user_a = $1 OR d.user_b = $1))
          OR (m.thread_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM thread_members tm
                 WHERE tm.thread_id = m.thread_id AND tm.user_id = $1))
        )
      ORDER BY r.remind_at ASC
      LIMIT 200`,
    [req.user.id, Date.now() - RECENT_MS]
  );
  res.json({
    reminders: rows.map((row) => ({
      id: Number(row.id),
      note: row.note || '',
      remindAt: Number(row.remind_at),
      createdAt: Number(row.created_at),
      deliveredAt: row.delivered_at ? Number(row.delivered_at) : null,
      event: row.event_title
        ? { id: Number(row.event_id), title: row.event_title, startsAt: Number(row.event_starts) }
        : null,
      message: row.message_id
        ? {
            id: Number(row.message_id),
            content: row.content || '',
            e2ee: !!row.e2ee,
            channelId: row.channel_id ? Number(row.channel_id) : null,
            dmId: row.dm_id ? Number(row.dm_id) : null,
            authorName: row.author_name || row.author_username || '',
            where: row.channel_name
              ? `#${row.channel_name}${row.server_name ? ' in ' + row.server_name : ''}`
              : row.dm_name || row.dm_username || 'a direct message'
          }
        : null
    }))
  });
}));

router.delete('/reminders/:id', authRequired, asyncHandler(async (req, res) => {
  await query('DELETE FROM reminders WHERE id = $1 AND user_id = $2', [
    Number(req.params.id),
    req.user.id
  ]);
  res.json({ ok: true });
}));

module.exports = router;
