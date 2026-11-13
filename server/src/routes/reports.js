const express = require('express');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query } = require('../pg/pool');
const { authRequired, adminRequired, rateLimit } = require('../auth');
const { trim, logAudit } = require('../util');

const router = express.Router();
const reportLimiter = rateLimit({
  windowMs: 60_000,
  max: 8,
  message: 'Too many reports. Try again in a minute.'
});

const REASONS = new Set([
  'harassment',
  'hate_speech',
  'threats',
  'spam',
  'sexual_content',
  'self_harm',
  'other'
]);
const STATUSES = new Set(['open', 'reviewing', 'resolved', 'dismissed']);
const MAX_DETAILS = 1000;
const MAX_EXCERPT = 4000;
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;

async function reportMessage(messageId) {
  const { rows } = await query(
    `SELECT m.id, m.user_id, m.content, m.attachment_name, m.attachment_type,
       m.e2ee, m.channel_id, m.dm_id, m.created_at,
       c.server_id, c.name AS channel_name, s.name AS server_name,
       d.user_a, d.user_b,
       u.username AS author_username, u.display_name AS author_display
     FROM messages m
     LEFT JOIN channels c ON c.id = m.channel_id
     LEFT JOIN servers s ON s.id = c.server_id
     LEFT JOIN dm_channels d ON d.id = m.dm_id
     JOIN users u ON u.id = m.user_id
     WHERE m.id = $1`,
    [Number(messageId)]
  );
  return rows[0];
}

async function canAccessMessage(message, userId) {
  if (message.channel_id) {
    const { rows } = await query(
      'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
      [message.server_id, userId]
    );
    return !!rows[0];
  }
  if (message.dm_id) {
    return message.user_a === userId || message.user_b === userId;
  }
  return false;
}

async function scopeLabel(message, userId) {
  if (message.channel_id) {
    return `#${message.channel_name} in ${message.server_name}`;
  }
  if (message.dm_id) {
    const peerId = message.user_a === userId ? message.user_b : message.user_a;
    const { rows } = await query('SELECT display_name FROM users WHERE id = $1', [peerId]);
    const peer = rows[0];
    return `Direct message with ${peer?.display_name || 'unknown user'}`;
  }
  return 'Message';
}

router.post('/reports', reportLimiter, authRequired, asyncHandler(async (req, res) => {
  const messageId = Number(req.body.messageId);
  if (!Number.isInteger(messageId) || messageId < 1) {
    return res.status(400).json({ error: 'Invalid message.' });
  }

  const message = await reportMessage(messageId);
  if (!message) return res.status(404).json({ error: 'Message not found.' });
  if (message.user_id === req.user.id) {
    return res.status(400).json({ error: "You can't report your own message." });
  }
  if (!(await canAccessMessage(message, req.user.id))) {
    return res.status(403).json({ error: 'You cannot report this message.' });
  }

  const reason = trim(req.body.reason).toLowerCase();
  if (!REASONS.has(reason)) {
    return res.status(400).json({ error: 'Choose a valid report reason.' });
  }
  const details = trim(req.body.details).slice(0, MAX_DETAILS);
  const evidence = message.e2ee ? trim(req.body.evidenceText).slice(0, MAX_EXCERPT) : '';
  const excerpt = message.e2ee
    ? evidence
    : trim(message.content).slice(0, MAX_EXCERPT);

  const now = Date.now();
  const duplicate = (
    await query(
      `SELECT id FROM reports
       WHERE reporter_id = $1 AND message_id = $2
         AND status IN ('open', 'reviewing') AND created_at > $3`,
      [req.user.id, message.id, now - DUPLICATE_WINDOW_MS]
    )
  ).rows[0];
  if (duplicate) {
    return res.status(409).json({
      error: 'You already reported this message.',
      reportId: Number(duplicate.id)
    });
  }

  const scopeType = message.channel_id ? 'channel' : 'dm';
  const inserted = (
    await query(
      `INSERT INTO reports
         (reporter_id, reported_user_id, message_id, server_id, channel_id, dm_id,
          scope_type, scope_label, reason, details, message_excerpt,
          message_encrypted, attachment_name, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'open', $14)
       RETURNING id`,
      [
        req.user.id,
        message.user_id,
        message.id,
        message.server_id || null,
        message.channel_id || null,
        message.dm_id || null,
        scopeType,
        await scopeLabel(message, req.user.id),
        reason,
        details,
        excerpt,
        message.e2ee ? 1 : 0,
        message.attachment_name || '',
        now
      ]
    )
  ).rows[0];

  const reportId = Number(inserted.id);
  await logAudit(req.user.id, 'report.create', 'report', reportId, `${reason} / message ${message.id}`);
  res.status(201).json({ ok: true, reportId });
}));

router.get('/admin/reports', adminRequired, asyncHandler(async (req, res) => {
  const requested = trim(req.query.status).toLowerCase();
  const status = STATUSES.has(requested) ? requested : 'all';
  const { rows } = await query(
    `SELECT r.*,
       reporter.username AS reporter_username,
       reporter.display_name AS reporter_display,
       reported.username AS reported_username,
       reported.display_name AS reported_display,
       reviewer.username AS reviewer_username,
       reviewer.display_name AS reviewer_display
     FROM reports r
     JOIN users reporter ON reporter.id = r.reporter_id
     JOIN users reported ON reported.id = r.reported_user_id
     LEFT JOIN users reviewer ON reviewer.id = r.reviewed_by
     WHERE ($1 = 'all' OR r.status = $2)
     ORDER BY r.created_at DESC LIMIT 200`,
    [status, status]
  );

  res.json({
    reports: rows.map((row) => ({
      id: row.id,
      reason: row.reason,
      details: row.details,
      excerpt: row.message_excerpt,
      encrypted: !!row.message_encrypted,
      attachmentName: row.attachment_name || '',
      scopeType: row.scope_type,
      scopeLabel: row.scope_label,
      status: row.status,
      actionTaken: row.action_taken,
      resolutionNote: row.resolution_note,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at,
      messageId: row.message_id,
      serverId: row.server_id,
      channelId: row.channel_id,
      dmId: row.dm_id,
      reporter: {
        id: row.reporter_id,
        username: row.reporter_username,
        displayName: row.reporter_display
      },
      reportedUser: {
        id: row.reported_user_id,
        username: row.reported_username,
        displayName: row.reported_display
      },
      reviewer: row.reviewer_username
        ? {
            id: row.reviewed_by,
            username: row.reviewer_username,
            displayName: row.reviewer_display
          }
        : null
    }))
  });
}));

router.patch('/admin/reports/:id', adminRequired, asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM reports WHERE id = $1', [Number(req.params.id)]);
  const report = rows[0];
  if (!report) return res.status(404).json({ error: 'Report not found.' });

  const status = trim(req.body.status).toLowerCase();
  if (!STATUSES.has(status)) {
    return res.status(400).json({ error: 'Choose a valid report status.' });
  }
  const actionTaken = trim(req.body.actionTaken).slice(0, 500);
  const resolutionNote = trim(req.body.resolutionNote).slice(0, MAX_DETAILS);
  const now = Date.now();

  await query(
    `UPDATE reports SET status = $1, action_taken = $2, resolution_note = $3,
       reviewed_by = $4, reviewed_at = $5 WHERE id = $6`,
    [status, actionTaken, resolutionNote, req.user.id, now, report.id]
  );

  await logAudit(
    req.user.id,
    'report.review',
    'report',
    report.id,
    `${status}${actionTaken ? ` / ${actionTaken}` : ''}`
  );
  res.json({ ok: true });
}));

module.exports = router;
