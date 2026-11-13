const express = require('express');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query, withTransaction } = require('../pg/pool');
const { authRequired, rateLimit } = require('../auth');
const {
  MESSAGE_SELECT,
  buildDm,
  getDmRow,
  getMessageRow,
  isDmParticipant,
  serializeMessage,
  blockedBetween,
  canInitiateDm,
  relationship,
  validateVoiceDuration,
  trim
} = require('../util');
const { awardBadge } = require('../badges');
const { createMentions, getCatchup } = require('../attention');
const { sendMessagePush } = require('../push');
const { adjustUserCount } = require('../messageCounters');
const { checkMessage, checkNewDm, scanText, safetyLevel, recordEvent } = require('../safety');
const { emitToDmBots, messageEvent } = require('../bots');

const router = express.Router();

// Same budget as a channel send: the DM route writes to the same messages table,
// so leaving it uncapped would make the channel limiter pointless.
const dmMessageLimiter = rateLimit({
  windowMs: 10_000,
  max: 20,
  message: 'You are sending messages too quickly. Try again in a moment.',
  key: (req) => `message-send:${req.user.id}`
});

function validateAttachment(attachment) {
  if (!attachment) return null;
  if (typeof attachment !== 'object') return { error: 'Invalid attachment.' };
  const url = trim(attachment.url);
  const name = trim(attachment.name).slice(0, 200);
  const type = trim(attachment.type).slice(0, 100);
  if (!/^\/uploads\/[a-zA-Z0-9._-]+$/.test(url)) return { error: 'Invalid attachment.' };
  return { url, name: name || 'file', type: type || 'application/octet-stream' };
}

async function validateReply(value, dmId) {
  if (value === undefined || value === null || value === '') return { id: null };
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return { error: 'Invalid reply target.' };
  const parent = await getMessageRow(id);
  if (!parent || parent.dm_id !== Number(dmId)) {
    return { error: 'You can only reply to messages in this conversation.' };
  }
  return { id };
}

function validateEnvelope(value, dm, sender, recipient) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'Invalid encrypted message.' };
  }
  const v = Number(value.v);
  const dmId = Number(value.dmId);
  const senderId = Number(value.senderId);
  const senderKeyVersion = Number(value.senderKeyVersion);
  const recipientKeyVersion = Number(value.recipientKeyVersion);
  const iv = trim(value.iv);
  const ct = trim(value.ct);
  if (dmId !== dm.id || senderId !== sender.id) {
    return { error: 'Invalid encrypted message.' };
  }
  if (
    senderKeyVersion !== Number(sender.e2ee_key_version) ||
    recipientKeyVersion !== Number(recipient.e2ee_key_version)
  ) {
    return {
      code: 'E2EE_KEY_CHANGED',
      error: 'Encryption keys changed. Reload this conversation and try again.'
    };
  }
  if (!iv || !ct || iv.length > 128 || ct.length > 24000) {
    return { error: 'Invalid encrypted message.' };
  }

  if (v === 1 && value.alg === 'ECDH-P256-HKDF-SHA256-AES-256-GCM') {
    return {
      envelope: JSON.stringify({
        v: 1,
        alg: 'ECDH-P256-HKDF-SHA256-AES-256-GCM',
        dmId,
        senderId,
        senderKeyVersion,
        recipientKeyVersion,
        iv,
        ct
      })
    };
  }

  if (v !== 2 || value.alg !== 'X3DH-DOUBLE-RATCHET-P256-AES-256-GCM') {
    return { error: 'Invalid encrypted message.' };
  }
  const recipientId = Number(value.recipientId);
  if (recipientId !== recipient.id) {
    return { error: 'Invalid encrypted message.' };
  }
  const header = value.header;
  if (!header || typeof header !== 'object' || Array.isArray(header)) {
    return { error: 'Invalid encrypted message.' };
  }
  const dh = trim(header.dh);
  const pn = Number(header.pn);
  const n = Number(header.n);
  if (
    !dh ||
    dh.length > 256 ||
    !Number.isInteger(pn) ||
    pn < 0 ||
    pn > 1000000000 ||
    !Number.isInteger(n) ||
    n < 0 ||
    n > 1000000000
  ) {
    return { error: 'Invalid encrypted message.' };
  }

  let x3dh = null;
  if (value.x3dh != null) {
    const input = value.x3dh;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { error: 'Invalid encrypted message.' };
    }
    const identityKey = trim(input.identityKey);
    const ephemeralKey = trim(input.ephemeralKey);
    const signedPrekeyId = Number(input.signedPrekeyId);
    const oneTimePrekeyId =
      input.oneTimePrekeyId == null ? null : Number(input.oneTimePrekeyId);
    if (
      !identityKey ||
      identityKey.length > 256 ||
      !ephemeralKey ||
      ephemeralKey.length > 256 ||
      !Number.isInteger(signedPrekeyId) ||
      signedPrekeyId < 1 ||
      (oneTimePrekeyId != null &&
        (!Number.isInteger(oneTimePrekeyId) || oneTimePrekeyId < 1))
    ) {
      return { error: 'Invalid encrypted message.' };
    }
    x3dh = { identityKey, ephemeralKey, signedPrekeyId, oneTimePrekeyId };
  }

  return {
    envelope: JSON.stringify({
      v: 2,
      alg: 'X3DH-DOUBLE-RATCHET-P256-AES-256-GCM',
      dmId,
      senderId,
      recipientId,
      senderKeyVersion,
      recipientKeyVersion,
      header: { dh, pn, n },
      x3dh,
      iv,
      ct
    })
  };
}

router.post('/dms', authRequired, asyncHandler(async (req, res) => {
  const targetId = Number(req.body.userId);
  if (!targetId || targetId === req.user.id) return res.status(400).json({ error: 'Pick someone to talk to.' });
  const target = (await query('SELECT * FROM users WHERE id = $1', [targetId])).rows[0];
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (await blockedBetween(req.user.id, targetId)) {
    return res.status(403).json({ error: 'This conversation is unavailable.' });
  }

  const a = Math.min(req.user.id, targetId);
  const b = Math.max(req.user.id, targetId);
  let dm = (await query('SELECT * FROM dm_channels WHERE user_a = $1 AND user_b = $2', [a, b])).rows[0];
  if (!dm) {
    // Opening conversations in bulk is the first move of a DM spammer, so the
    // budget is spent per new person rather than per message.
    const guard = checkNewDm(req.user.id, target.id);
    if (guard.blocked) {
      recordEvent({
        kind: 'mass_dm',
        severity: 'high',
        userId: req.user.id,
        targetId: target.id,
        detail: { flags: guard.flags }
      }).catch((error) => console.error('[safety] event failed:', error.message));
      return res.status(429).json({
        code: 'SAFETY_THROTTLE',
        error: guard.error,
        retryAfter: guard.retryAfter
      });
    }
    if (!(await canInitiateDm(req.user.id, target))) {
      return res.status(403).json({
        code: 'DM_PRIVACY',
        error: 'This person only accepts messages from friends. Add them as a friend first.'
      });
    }
    const result = await query(
      'INSERT INTO dm_channels (user_a, user_b, created_at) VALUES ($1, $2, $3) RETURNING id',
      [a, b, Date.now()]
    );
    dm = await getDmRow(Number(result.rows[0].id));
  } else if (dm.closed_by_a || dm.closed_by_b) {
    await query('UPDATE dm_channels SET closed_by_a = 0, closed_by_b = 0 WHERE id = $1', [dm.id]);
    dm = await getDmRow(dm.id);
  }

  const io = req.app.get('io');
  const forMe = await buildDm(dm, req.user.id);
  const forTarget = await buildDm(dm, targetId);
  io.to(`user:${targetId}`).emit('dm:new', forTarget);
  io.to(`user:${req.user.id}`).emit('dm:new', forMe);
  res.json({ dm: forMe });
}));

router.post('/dms/:id/close', authRequired, asyncHandler(async (req, res) => {
  const dm = await getDmRow(req.params.id);
  if (!isDmParticipant(dm, req.user.id)) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  const column = dm.user_a === req.user.id ? 'closed_by_a' : 'closed_by_b';
  await query(`UPDATE dm_channels SET ${column} = 1 WHERE id = $1`, [dm.id]);
  res.json({ ok: true });
}));

router.get('/dms/:id/messages', authRequired, asyncHandler(async (req, res) => {
  const dm = await getDmRow(req.params.id);
  if (!isDmParticipant(dm, req.user.id)) return res.status(404).json({ error: 'Conversation not found' });
  if (await blockedBetween(dm.user_a, dm.user_b)) {
    return res.status(403).json({ error: 'This conversation is unavailable.' });
  }

  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const before = Number(req.query.before) || null;
  const rows = before
    ? (
        await query(`${MESSAGE_SELECT} WHERE m.dm_id = $1 AND m.id < $2 ORDER BY m.id DESC LIMIT $3`, [
          dm.id,
          before,
          limit
        ])
      ).rows
    : (await query(`${MESSAGE_SELECT} WHERE m.dm_id = $1 ORDER BY m.id DESC LIMIT $2`, [dm.id, limit])).rows;
  rows.reverse();
  res.json({
    messages: await Promise.all(rows.map((row) => serializeMessage(row, req.user.id))),
    hasMore: rows.length === limit,
    catchup: before ? null : await getCatchup(req.user.id, 'dm', dm.id)
  });
}));

router.get('/dms/:id/pins', authRequired, asyncHandler(async (req, res) => {
  const dm = await getDmRow(req.params.id);
  if (!isDmParticipant(dm, req.user.id)) return res.status(404).json({ error: 'Conversation not found' });
  if (await blockedBetween(dm.user_a, dm.user_b)) {
    return res.status(403).json({ error: 'This conversation is unavailable.' });
  }

  const { rows } = await query(
    `${MESSAGE_SELECT} WHERE m.dm_id = $1 AND m.pinned_at IS NOT NULL
     ORDER BY m.pinned_at DESC, m.id DESC LIMIT 50`,
    [dm.id]
  );
  res.json({
    messages: await Promise.all(rows.map((row) => serializeMessage(row, req.user.id)))
  });
}));

router.post('/dms/:id/messages', authRequired, dmMessageLimiter, asyncHandler(async (req, res) => {
  const dm = await getDmRow(req.params.id);
  if (!isDmParticipant(dm, req.user.id)) return res.status(404).json({ error: 'Conversation not found' });
  if (await blockedBetween(dm.user_a, dm.user_b)) {
    return res.status(403).json({ error: 'This conversation is unavailable.' });
  }

  const content = trim(req.body.content).slice(0, 4000);
  const attachment = validateAttachment(req.body.attachment);
  if (attachment?.error) return res.status(400).json({ error: attachment.error });
  const voice = validateVoiceDuration(req.body.voiceDurationMs, attachment);
  if (voice.error) return res.status(400).json({ error: voice.error });
  const reply = await validateReply(req.body.replyToId, dm.id);
  if (reply.error) return res.status(400).json({ error: reply.error });

  const otherId = dm.user_a === req.user.id ? dm.user_b : dm.user_a;
  const other = (
    await query(
      'SELECT id, dm_privacy, is_bot, e2ee_public_key, e2ee_key_version, e2ee_key_backup FROM users WHERE id = $1',
      [otherId]
    )
  ).rows[0];
  // The friends-only rule is a property of the recipient, and it does not stop
  // applying because the conversation already exists - losing a friendship must
  // close the door on an open DM too.
  // A bot answering inside a conversation a person opened is not a stranger
  // messaging them: a bot cannot start a DM at all, because nothing gives it the
  // id of somebody to start one with. Everyone else still obeys the rule.
  if (!req.bot && !(await canInitiateDm(req.user.id, other))) {
    return res.status(403).json({
      code: 'DM_PRIVACY',
      error: 'This person only accepts messages from friends. Add them as a friend first.'
    });
  }
  const bothReady = !!(
    req.user.e2ee_public_key &&
    req.user.e2ee_key_backup &&
    other?.e2ee_public_key &&
    other?.e2ee_key_backup
  );
  const hasEnvelope = req.body.e2eeEnvelope !== undefined && req.body.e2eeEnvelope !== null;
  let encrypted = false;
  let envelope = null;
  if (hasEnvelope) {
    const checked = validateEnvelope(req.body.e2eeEnvelope, dm, req.user, other || {});
    if (checked.error) {
      return res.status(checked.code === 'E2EE_KEY_CHANGED' ? 409 : 400).json({
        code: checked.code,
        error: checked.error
      });
    }
    encrypted = true;
    envelope = checked.envelope;
  }
  if (bothReady && !encrypted) {
    return res.status(409).json({
      code: 'E2EE_REQUIRED',
      error: 'This conversation requires an encrypted message.'
    });
  }
  if (encrypted && !bothReady) {
    return res.status(400).json({
      code: 'E2EE_NOT_READY',
      error: 'Both people need encrypted messages set up first.'
    });
  }
  if (encrypted && content) {
    return res.status(400).json({
      code: 'E2EE_INVALID',
      error: 'Encrypted messages cannot include plaintext content.'
    });
  }
  if (!encrypted && !content && !attachment) {
    return res.status(400).json({ error: 'Message cannot be empty.' });
  }

  const guard = checkMessage(req.user.id, { scopeType: 'dm', scopeId: dm.id, content });
  if (guard.blocked) {
    recordEvent({
      kind: guard.flags.includes('duplicate')
        ? 'spam_duplicate'
        : guard.flags.includes('invites')
          ? 'spam_invites'
          : 'spam_flood',
      severity: 'medium',
      userId: req.user.id,
      targetId: otherId,
      scopeType: 'dm',
      scopeId: dm.id,
      detail: { flags: guard.flags, excerpt: content.slice(0, 200) }
    }).catch((error) => console.error('[safety] event failed:', error.message));
    return res.status(429).json({
      code: 'SAFETY_THROTTLE',
      error: guard.error,
      retryAfter: guard.retryAfter
    });
  }

  const io = req.app.get('io');
  // The message row, the reopen of a closed conversation, the author counter and
  // the mention rows commit as one unit - a partial commit is counter drift.
  let message;
  let mentioned;
  let reopenedDm = null;
  let awardedBadge = false;
  await withTransaction(async () => {
    const result = await query(
      `INSERT INTO messages (dm_id, user_id, content, attachment_url, attachment_name, attachment_type, reply_to_id, e2ee, e2ee_envelope, voice_duration_ms, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        dm.id,
        req.user.id,
        encrypted ? '' : content,
        attachment ? attachment.url : null,
        attachment ? attachment.name : null,
        attachment ? attachment.type : null,
        reply.id,
        encrypted ? 1 : 0,
        envelope,
        voice.duration,
        Date.now()
      ]
    );

    if (dm.closed_by_a || dm.closed_by_b) {
      await query('UPDATE dm_channels SET closed_by_a = 0, closed_by_b = 0 WHERE id = $1', [dm.id]);
      reopenedDm = await getDmRow(dm.id);
    }

    await adjustUserCount(req.user.id, 1);
    const count = (await query('SELECT message_count FROM users WHERE id = $1', [req.user.id])).rows[0]
      .message_count;
    awardedBadge = count >= 100 && (await awardBadge(req.user.id, 'chatterbox'));

    const row = await getMessageRow(Number(result.rows[0].id));
    message = await serializeMessage(row, 0);
    mentioned = await createMentions(row, io);
  });

  if (reopenedDm) {
    io.to(`user:${dm.user_a}`).emit('dm:new', await buildDm(reopenedDm, dm.user_a));
    io.to(`user:${dm.user_b}`).emit('dm:new', await buildDm(reopenedDm, dm.user_b));
  }
  if (awardedBadge) {
    io.to(`user:${req.user.id}`).emit('badge:awarded', { badge: 'chatterbox' });
  }
  // Predatory patterns are only interesting from a stranger: friends say
  // "add me on insta" and "don't tell my mum" to each other all day. The notice
  // goes to the recipient only — the sender is not told they were scanned.
  let safetyNotice = null;
  if (!encrypted && content) {
    const relation = await relationship(req.user.id, otherId);
    if (relation !== 'friends') {
      const scan = scanText(content);
      const level = safetyLevel(scan.categories, scan.score);
      if (level) {
        safetyNotice = { level, categories: scan.categories };
        await query('UPDATE messages SET safety_level = $1, safety_categories = $2 WHERE id = $3', [
          level,
          scan.categories.join(','),
          message.id
        ]);
        recordEvent({
          kind: 'predatory_dm',
          severity: level,
          userId: req.user.id,
          targetId: otherId,
          scopeType: 'dm',
          scopeId: dm.id,
          messageId: message.id,
          detail: { categories: scan.categories, excerpt: content.slice(0, 200) }
        }).catch((error) => console.error('[safety] event failed:', error.message));
      }
    }
  }

  const recipientPayload = safetyNotice ? { ...message, safety: safetyNotice } : message;
  io.to(`user:${dm.user_a}`).emit('message:new', dm.user_a === otherId ? recipientPayload : message);
  io.to(`user:${dm.user_b}`).emit('message:new', dm.user_b === otherId ? recipientPayload : message);
  // Encrypted messages are not forwarded: a bot has no keys, so a bot in an
  // encrypted conversation would be handed ciphertext it cannot read.
  if (!encrypted) emitToDmBots(io, dm.id, 'MESSAGE_CREATE', messageEvent(message));
  sendMessagePush(message, mentioned).catch((error) => {
    console.error('[push] message push failed:', error.message);
  });
  res.status(201).json({ message });
}));

module.exports = router;
