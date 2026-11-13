const express = require('express');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query, withTransaction } = require('../pg/pool');
const { authRequired, rateLimit } = require('../auth');
const {
  MESSAGE_SELECT,
  serializeMessage,
  getMessageRow,
  getChannelRow,
  getDmRow,
  isDmParticipant,
  assertChannelAccess,
  canModerateMessage,
  reactionsFor,
  deleteUploadIfUnused,
  validateVoiceDuration,
  blockedBetween,
  canInitiateDm,
  trim
} = require('../util');
const { hasServerPermission, hasChannelPermission } = require('../permissions');
const { awardBadge } = require('../badges');
const { createMentions, getCatchup } = require('../attention');
const { emitToServerBots, messageEvent, validateComponents } = require('../bots');
const { sendMessagePush } = require('../push');
const { checkAutomod } = require('../automod');
const { logEvent } = require('../events');
const { touchThread } = require('../threads');
const { releaseMessage, adjustUserCount } = require('../messageCounters');
const { checkMessage, recordEvent } = require('../safety');

const router = express.Router();

// One message every couple of seconds on average, with room for a burst: the
// upload, emote and soundboard routes already cap their own writes, so the
// message body itself was the only way to hammer the table.
const messageLimiter = rateLimit({
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

async function validateReply(value, channelId) {
  if (value === undefined || value === null || value === '') return { id: null };
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return { error: 'Invalid reply target.' };
  const parent = await getMessageRow(id);
  if (!parent || parent.channel_id !== Number(channelId)) {
    return { error: 'You can only reply to messages in this channel.' };
  }
  return { id };
}

const EMOTE_TOKEN_RE = /:([a-zA-Z0-9_]{2,32}):/g;

// Emote checks for message content, in one pass and one statement per message.
// A token can fail three ways:
//   - it names an emote of another server and this server blocks external emotes
//   - it names an emote of a server the sender is not in (an external emote is
//     only available through a server you actually belong to)
//   - it names a group-locked emote (emote_role_access) and the sender holds
//     none of the owning server's groups. The lock is a property of the emote,
//     not of the channel, so it applies to foreign emotes too.
// A token that matches no emote anywhere is plain text. Content without a token
// returns before touching the database.
async function checkEmoteTokens(serverId, userId, content) {
  const tokens = [];
  const seen = new Set();
  for (const match of content.matchAll(EMOTE_TOKEN_RE)) {
    const key = match[1].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push(match[1]);
  }
  if (!tokens.length) return null;

  // One statement resolves every token at once: which server owns a matching
  // emote, whether it is locked, whether the sender holds an allowed group of
  // that owning server, whether the sender is a member of it, and whether this
  // server accepts external emotes.
  const { rows } = await query(
    `SELECT e.name AS name, e.server_id AS server_id,
       (SELECT COUNT(*) FROM emote_role_access era WHERE era.emote_id = e.id) AS access_count,
       (SELECT COUNT(*) FROM emote_role_access era
          JOIN server_member_groups smg
            ON smg.group_id = era.group_id AND smg.server_id = e.server_id
         WHERE era.emote_id = e.id AND smg.user_id = $1) AS held_count,
       (SELECT COUNT(*) FROM server_members sm
         WHERE sm.server_id = e.server_id AND sm.user_id = $2) AS member,
       (SELECT allow_external_emotes FROM servers WHERE id = $3) AS allow_external
     FROM server_emotes e
     WHERE lower(e.name) IN (SELECT value FROM jsonb_array_elements_text($4::jsonb))`,
    [
      Number(userId),
      Number(userId),
      Number(serverId),
      JSON.stringify(tokens.map((token) => token.toLowerCase()))
    ]
  );
  if (!rows.length) return null;

  const allowExternal = !!rows[0].allow_external;
  const byName = new Map();
  for (const row of rows) {
    const key = String(row.name).toLowerCase();
    const entry = byName.get(key) || [];
    entry.push(row);
    byName.set(key, entry);
  }

  for (const token of tokens) {
    const entry = byName.get(token.toLowerCase());
    if (!entry) continue;
    // A same-named emote in this server always wins; otherwise the emote comes
    // from another server and has to be reachable through one of the sender's
    // own memberships.
    let reachable = entry.filter((row) => Number(row.server_id) === Number(serverId));
    if (!reachable.length) {
      if (!allowExternal) {
        return { status: 400, body: { error: 'This server only allows its own emotes.' } };
      }
      reachable = entry.filter((row) => Number(row.member) > 0);
      if (!reachable.length) {
        return { status: 400, body: { error: 'That emote is not available here.' } };
      }
    }
    // The lock is checked on every reachable row, not just the first one: the
    // token carries only a name, so which of the matching rows a client renders
    // is its own choice - a name that is gated anywhere the sender can reach it
    // is treated as gated.
    const locked = reachable.find(
      (row) => Number(row.access_count) > 0 && Number(row.held_count) === 0
    );
    if (locked) {
      return {
        status: 403,
        body: {
          error: 'You do not have access to that emote.',
          code: 'EMOTE_RESTRICTED',
          message: 'You do not have access to that emote.',
          token: `:${locked.name}:`
        }
      };
    }
  }
  return null;
}

async function broadcastRooms(message) {
  if (message.channelId) {
    const channel = await getChannelRow(message.channelId);
    const serverId = message.serverId || channel?.server_id;
    // Threads are private: their events only reach people in the thread room.
    // Forum posts stay public, the same way the forum itself is readable.
    if (channel?.type === 'thread') {
      const parent = channel.parent_channel_id
        ? await getChannelRow(channel.parent_channel_id)
        : null;
      if (!parent || parent.type !== 'forum') return [`thread:${channel.id}`];
    }
    return serverId ? [`server:${serverId}`] : [];
  }
  if (message.dmId) {
    const dm = await getDmRow(message.dmId);
    if (dm) return [`user:${dm.user_a}`, `user:${dm.user_b}`];
  }
  return [];
}

async function messagePinAccess(row, user) {
  if (row.channel_id) {
    const access = await assertChannelAccess(row.channel_id, user.id);
    if (access.error) return access;
    if (!(await hasServerPermission(row.server_id, user.id, 'pinMessages', user.role))) {
      return { error: "You don't have permission to pin messages here.", status: 403 };
    }
    return { channel: access.channel };
  }
  if (row.dm_id) {
    const dm = await getDmRow(row.dm_id);
    if (!isDmParticipant(dm, user.id)) {
      return { error: 'Conversation not found', status: 404 };
    }
    if (await blockedBetween(dm.user_a, dm.user_b)) {
      return { error: 'This conversation is unavailable.', status: 403 };
    }
    return { dm };
  }
  return { error: 'Message not found', status: 404 };
}

async function getPollRow(pollId) {
  const { rows } = await query('SELECT * FROM polls WHERE id = $1', [Number(pollId)]);
  return rows[0];
}

async function broadcastPoll(io, message) {
  const payload = {
    messageId: message.id,
    channelId: message.channelId,
    dmId: message.dmId,
    poll: message.poll
  };
  for (const room of await broadcastRooms(message)) io.to(room).emit('message:poll', payload);
}

function validatePollOptions(value) {
  if (!Array.isArray(value)) return { error: 'Add at least two poll options.' };
  const options = [];
  const seen = new Set();
  for (const entry of value) {
    const label = trim(entry).slice(0, 80);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push(label);
    if (options.length >= 10) break;
  }
  if (options.length < 2) return { error: 'Add at least two different poll options.' };
  return { options };
}

router.get('/channels/:id/messages', authRequired, asyncHandler(async (req, res) => {
  const access = await assertChannelAccess(req.params.id, req.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });

  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const before = Number(req.query.before) || null;
  const { rows } = before
    ? await query(`${MESSAGE_SELECT} WHERE m.channel_id = $1 AND m.id < $2 ORDER BY m.id DESC LIMIT $3`, [
        access.channel.id,
        before,
        limit
      ])
    : await query(`${MESSAGE_SELECT} WHERE m.channel_id = $1 ORDER BY m.id DESC LIMIT $2`, [
        access.channel.id,
        limit
      ]);

  rows.reverse();
  res.json({
    messages: await Promise.all(rows.map((row) => serializeMessage(row, req.user.id))),
    hasMore: rows.length === limit,
    catchup: before ? null : await getCatchup(req.user.id, 'channel', access.channel.id),
    channel: {
      id: access.channel.id,
      name: access.channel.name,
      type: access.channel.type,
      serverId: access.channel.server_id
    }
  });
}));

router.get('/channels/:id/pins', authRequired, asyncHandler(async (req, res) => {
  const access = await assertChannelAccess(req.params.id, req.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });

  const { rows } = await query(
    `${MESSAGE_SELECT} WHERE m.channel_id = $1 AND m.pinned_at IS NOT NULL
     ORDER BY m.pinned_at DESC, m.id DESC LIMIT 50`,
    [access.channel.id]
  );
  res.json({
    messages: await Promise.all(rows.map((row) => serializeMessage(row, req.user.id)))
  });
}));

router.post('/channels/:id/messages', authRequired, messageLimiter, asyncHandler(async (req, res) => {
  const access = await assertChannelAccess(req.params.id, req.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  // A gallery is a text channel that is read differently, so it takes messages
  // like one. Voice, stage, forum, docs and list channels do not.
  if (!['text', 'thread', 'media'].includes(access.channel.type)) {
    return res.status(400).json({ error: 'You cannot send messages in this channel.' });
  }
  if (!(await hasServerPermission(access.channel.server_id, req.user.id, 'sendMessages', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to send messages here." });
  }
  if (
    !(await hasChannelPermission(
      access.channel.server_id,
      access.channel.id,
      req.user.id,
      'sendMessages',
      access.membership.role
    ))
  ) {
    return res.status(403).json({ error: 'This channel is read-only for you.' });
  }

  const content = trim(req.body.content).slice(0, 4000);
  const attachment = validateAttachment(req.body.attachment);
  if (attachment?.error) return res.status(400).json({ error: attachment.error });
  if (
    attachment &&
    !(await hasServerPermission(access.channel.server_id, req.user.id, 'attachFiles', req.user.role))
  ) {
    return res.status(403).json({ error: "You don't have permission to attach files here." });
  }
  const voice = validateVoiceDuration(req.body.voiceDurationMs, attachment);
  if (voice.error) return res.status(400).json({ error: voice.error });
  const reply = await validateReply(req.body.replyToId, access.channel.id);
  if (reply.error) return res.status(400).json({ error: reply.error });
  if (!content && !attachment) return res.status(400).json({ error: 'Message cannot be empty.' });

  // Bots are exempt from the human-facing filters: automod and the spam windows
  // exist to constrain people, and a bot that posts on a schedule would trip
  // them constantly. Channel access and sendMessages still apply above.
  const isBot = !!Number(req.user.is_bot || 0);
  // Only bots can attach interactive components; a person typing JSON into the
  // composer should never be able to render a button in someone else's client.
  let components = null;
  if (isBot && req.body.components) {
    const parsed = validateComponents(req.body.components);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    components = parsed.components;
  }

  const emoteBlock = isBot ? null : await checkEmoteTokens(access.channel.server_id, req.user.id, content);
  if (emoteBlock) return res.status(emoteBlock.status).json(emoteBlock.body);

  const blocked = isBot ? null : await checkAutomod({
    serverId: access.channel.server_id,
    userId: req.user.id,
    channelId: access.channel.id,
    content,
    globalRole: req.user.role
  });
  if (blocked) {
    return res.status(400).json({ error: blocked.message, code: 'AUTOMOD', rule: blocked.rule });
  }

  // Cross-scope spam: a flood, the same text pasted into several channels, or
  // one invite link sprayed everywhere. Per-server automod cannot see any of it.
  const guard = isBot
    ? { blocked: false }
    : checkMessage(req.user.id, {
        scopeType: 'channel',
        scopeId: access.channel.id,
        content
      });
  if (guard.blocked) {
    recordEvent({
      kind: guard.flags.includes('duplicate')
        ? 'spam_duplicate'
        : guard.flags.includes('invites')
          ? 'spam_invites'
          : 'spam_flood',
      severity: 'medium',
      userId: req.user.id,
      scopeType: 'channel',
      scopeId: access.channel.id,
      detail: { flags: guard.flags, excerpt: content.slice(0, 200) }
    }).catch((error) => console.error('[safety] event failed:', error.message));
    return res.status(429).json({
      code: 'SAFETY_THROTTLE',
      error: guard.error,
      retryAfter: guard.retryAfter
    });
  }

  const now = Date.now();
  const io = req.app.get('io');
  // The row, the author counter, the thread counter and the mention rows are one
  // unit of work: a crash between them is exactly the counter drift the
  // messageCounters contract exists to prevent.
  const { message, mentioned, awardedBadge } = await withTransaction(async () => {
    const inserted = await query(
      `INSERT INTO messages (channel_id, user_id, content, attachment_url, attachment_name, attachment_type, reply_to_id, voice_duration_ms, created_at, components)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        access.channel.id,
        req.user.id,
        content,
        attachment ? attachment.url : null,
        attachment ? attachment.name : null,
        attachment ? attachment.type : null,
        reply.id,
        voice.duration,
        now,
        components ? JSON.stringify(components) : null
      ]
    );

    await adjustUserCount(req.user.id, 1);
    const count = Number(
      (await query('SELECT message_count FROM users WHERE id = $1', [req.user.id])).rows[0]
        .message_count
    );
    // adjustUserCount has already run, so the first message is the one that
    // lands on a count of exactly 1.
    if (count === 1) {
      logEvent('first_message', { userId: req.user.id, serverId: access.channel.server_id });
    }
    const badge = count >= 100 ? await awardBadge(req.user.id, 'chatterbox') : false;

    if (access.channel.type === 'thread') await touchThread(access.channel.id);
    const row = await getMessageRow(Number(inserted.rows[0].id));
    const serialized = await serializeMessage(row, req.user.id);
    const mentionedIds = await createMentions(row, io);
    return { message: serialized, mentioned: mentionedIds, awardedBadge: badge };
  });
  if (awardedBadge) {
    io.to(`user:${req.user.id}`).emit('badge:awarded', { badge: 'chatterbox' });
  }
  for (const room of await broadcastRooms(message)) {
    io.to(room).emit('message:new', message);
  }
  // The bot gateway is a separate namespace, so it needs its own fan-out. The
  // author is included: a bot sees its own message, exactly like a client does.
  emitToServerBots(io, access.channel.server_id, 'messages', 'MESSAGE_CREATE', messageEvent(message));
  sendMessagePush(message, mentioned).catch((error) => {
    console.error('[push] message push failed:', error.message);
  });
  res.status(201).json({ message });
}));

// Forwarding copies the body, the attachment and the voice duration into a new
// row authored by the forwarder. Deliberately NOT copied:
//   - the poll: polls are their own rows keyed to the source message, so a copy
//     never inherits options or votes
//   - reactions, mentions, reply/thread linkage and edited_at: they belong to
//     the conversation the message was originally posted in
//   - e2ee envelopes: the ciphertext is bound to one conversation, so encrypted
//     messages are refused instead of copied as unreadable noise
// Both ends are checked: the source must be readable by the caller (a private
// thread is not a forwarding shortcut) and the target must accept their
// messages, otherwise a forward becomes a leak vector.
router.post('/messages/:id/forward', authRequired, messageLimiter, asyncHandler(async (req, res) => {
  const source = await getMessageRow(req.params.id);
  if (!source) return res.status(404).json({ error: 'Message not found' });
  if (source.e2ee) {
    return res.status(400).json({
      code: 'E2EE_FORWARD_UNSUPPORTED',
      error: 'Encrypted messages cannot be forwarded.'
    });
  }

  const rawChannel = req.body.channelId;
  const rawConversation = req.body.conversationId;
  const channelId =
    rawChannel === undefined || rawChannel === null || rawChannel === ''
      ? null
      : Number(rawChannel);
  const conversationId =
    rawConversation === undefined || rawConversation === null || rawConversation === ''
      ? null
      : Number(rawConversation);
  if ((channelId === null) === (conversationId === null)) {
    return res.status(400).json({ error: 'Pick one destination: a channel or a conversation.' });
  }
  if (channelId !== null && (!Number.isInteger(channelId) || channelId <= 0)) {
    return res.status(400).json({ error: 'Invalid channel.' });
  }
  if (conversationId !== null && (!Number.isInteger(conversationId) || conversationId <= 0)) {
    return res.status(400).json({ error: 'Invalid conversation.' });
  }

  if (source.channel_id) {
    const sourceAccess = await assertChannelAccess(source.channel_id, req.user.id);
    if (sourceAccess.error) {
      return res.status(sourceAccess.status).json({ error: sourceAccess.error });
    }
  } else if (source.dm_id) {
    if (!isDmParticipant(await getDmRow(source.dm_id), req.user.id)) {
      return res.status(403).json({ error: 'You cannot forward this message.' });
    }
  } else {
    return res.status(400).json({ error: 'This message cannot be forwarded.' });
  }

  if (channelId !== null && source.channel_id === channelId) {
    return res.status(400).json({ error: 'That message is already in this channel.' });
  }
  if (conversationId !== null && source.dm_id === conversationId) {
    return res.status(400).json({ error: 'That message is already in this conversation.' });
  }

  let targetChannel = null;
  let targetDm = null;
  if (channelId !== null) {
    const targetAccess = await assertChannelAccess(channelId, req.user.id);
    if (targetAccess.error) {
      return res.status(targetAccess.status).json({ error: targetAccess.error });
    }
    targetChannel = targetAccess.channel;
    if (targetChannel.type !== 'text' && targetChannel.type !== 'thread') {
      return res.status(400).json({ error: 'You cannot forward messages into a voice channel.' });
    }
    if (
      !(await hasServerPermission(
        targetChannel.server_id,
        req.user.id,
        'sendMessages',
        req.user.role
      ))
    ) {
      return res.status(403).json({ error: "You don't have permission to send messages here." });
    }
    if (
      source.attachment_url &&
      !(await hasServerPermission(
        targetChannel.server_id,
        req.user.id,
        'attachFiles',
        req.user.role
      ))
    ) {
      return res.status(403).json({ error: "You don't have permission to attach files here." });
    }
    // A restricted or foreign emote must not ride into a server that refuses it.
    const emoteBlock = await checkEmoteTokens(
      targetChannel.server_id,
      req.user.id,
      source.content || ''
    );
    if (emoteBlock) return res.status(emoteBlock.status).json(emoteBlock.body);
  } else {
    targetDm = await getDmRow(conversationId);
    if (!isDmParticipant(targetDm, req.user.id)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    if (await blockedBetween(targetDm.user_a, targetDm.user_b)) {
      return res.status(403).json({ error: 'This conversation is unavailable.' });
    }
    // A forward is a message sent into that DM, so it has to pass the same
    // recipient privacy gate as POST /dms/:id/messages: friends-only does not
    // stop applying just because the copy came from somewhere else.
    const recipientId = targetDm.user_a === req.user.id ? targetDm.user_b : targetDm.user_a;
    const { rows: recipientRows } = await query(
      'SELECT id, dm_privacy FROM users WHERE id = $1',
      [recipientId]
    );
    if (!(await canInitiateDm(req.user.id, recipientRows[0]))) {
      return res.status(403).json({
        code: 'DM_PRIVACY',
        error: 'This person only accepts messages from friends. Add them as a friend first.'
      });
    }
  }

  // A forward of a forward keeps the ORIGINAL author snapshot: the copy points
  // at the row it came from, but the name never drifts to the previous
  // forwarder.
  const forwardedAuthor =
    source.forwarded_author || source.author_display_name || 'Unknown user';
  const io = req.app.get('io');
  // Same unit of work as a normal send: row, author counter and thread counter
  // commit together or not at all.
  const { message, awardedBadge } = await withTransaction(async () => {
    const inserted = await query(
      `INSERT INTO messages (channel_id, dm_id, user_id, content, attachment_url, attachment_name,
         attachment_type, voice_duration_ms, forwarded_from, forwarded_author, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        targetChannel ? targetChannel.id : null,
        targetDm ? targetDm.id : null,
        req.user.id,
        source.content || '',
        source.attachment_url,
        source.attachment_name,
        source.attachment_type,
        Number(source.voice_duration_ms) || 0,
        source.id,
        forwardedAuthor,
        Date.now()
      ]
    );

    await adjustUserCount(req.user.id, 1);
    const count = Number(
      (await query('SELECT message_count FROM users WHERE id = $1', [req.user.id])).rows[0]
        .message_count
    );
    const badge = count >= 100 ? await awardBadge(req.user.id, 'chatterbox') : false;
    if (targetChannel && targetChannel.type === 'thread') await touchThread(targetChannel.id);

    const row = await getMessageRow(Number(inserted.rows[0].id));
    const serialized = await serializeMessage(row, req.user.id);
    return { message: serialized, awardedBadge: badge };
  });
  if (awardedBadge) {
    io.to(`user:${req.user.id}`).emit('badge:awarded', { badge: 'chatterbox' });
  }
  for (const room of await broadcastRooms(message)) {
    io.to(room).emit('message:new', message);
  }
  if (message.serverId) {
    emitToServerBots(io, message.serverId, 'messages', 'MESSAGE_CREATE', messageEvent(message));
  }
  res.status(201).json({ message });
}));

router.post('/channels/:id/polls', authRequired, messageLimiter, asyncHandler(async (req, res) => {
  const access = await assertChannelAccess(req.params.id, req.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  if (access.channel.type !== 'text') {
    return res.status(400).json({ error: 'Polls can only be posted in text channels.' });
  }
  if (!(await hasServerPermission(access.channel.server_id, req.user.id, 'sendMessages', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to send messages here." });
  }

  const question = trim(req.body.question).slice(0, 200);
  if (question.length < 3) {
    return res.status(400).json({ error: 'Poll question must be at least 3 characters.' });
  }
  const optionResult = validatePollOptions(req.body.options);
  if (optionResult.error) return res.status(400).json({ error: optionResult.error });

  const emoteBlock = await checkEmoteTokens(access.channel.server_id, req.user.id, question);
  if (emoteBlock) return res.status(emoteBlock.status).json(emoteBlock.body);

  let closesAt = null;
  if (req.body.closesAt !== undefined && req.body.closesAt !== null && req.body.closesAt !== '') {
    const value = Number(req.body.closesAt);
    if (!Number.isFinite(value) || value <= Date.now()) {
      return res.status(400).json({ error: 'Poll close time must be in the future.' });
    }
    closesAt = Math.round(value);
  }

  const blocked = await checkAutomod({
    serverId: access.channel.server_id,
    userId: req.user.id,
    channelId: access.channel.id,
    content: question,
    globalRole: req.user.role
  });
  if (blocked) {
    return res.status(400).json({ error: blocked.message, code: 'AUTOMOD', rule: blocked.rule });
  }

  const now = Date.now();
  const { messageId, awardedBadge } = await withTransaction(async () => {
    const inserted = await query(
      `INSERT INTO messages (channel_id, user_id, content, created_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [access.channel.id, req.user.id, question, now]
    );
    const newMessageId = Number(inserted.rows[0].id);
    const pollInserted = await query(
      `INSERT INTO polls
         (message_id, server_id, channel_id, created_by, question, allow_multiple, closes_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        newMessageId,
        access.channel.server_id,
        access.channel.id,
        req.user.id,
        question,
        req.body.allowMultiple ? 1 : 0,
        closesAt,
        now
      ]
    );
    const pollId = Number(pollInserted.rows[0].id);
    for (let index = 0; index < optionResult.options.length; index += 1) {
      await query('INSERT INTO poll_options (poll_id, label, position) VALUES ($1, $2, $3)', [
        pollId,
        optionResult.options[index],
        index
      ]);
    }
    // The poll's message row is a message: its author counter belongs to the
    // same transaction as the insert and the poll rows.
    await adjustUserCount(req.user.id, 1);
    const count = Number(
      (await query('SELECT message_count FROM users WHERE id = $1', [req.user.id])).rows[0]
        .message_count
    );
    const badge = count >= 100 ? await awardBadge(req.user.id, 'chatterbox') : false;
    return { messageId: newMessageId, awardedBadge: badge };
  });

  const io = req.app.get('io');
  if (awardedBadge) {
    io.to(`user:${req.user.id}`).emit('badge:awarded', { badge: 'chatterbox' });
  }

  const row = await getMessageRow(messageId);
  const message = await serializeMessage(row, req.user.id);
  const mentioned = await createMentions(row, io);
  for (const room of await broadcastRooms(message)) {
    io.to(room).emit('message:new', message);
  }
  if (message.serverId) {
    emitToServerBots(io, message.serverId, 'messages', 'MESSAGE_CREATE', messageEvent(message));
  }
  sendMessagePush(message, mentioned).catch((error) => {
    console.error('[push] message push failed:', error.message);
  });
  res.status(201).json({ message });
}));

router.post('/polls/:id/vote', authRequired, asyncHandler(async (req, res) => {
  const poll = await getPollRow(req.params.id);
  if (!poll) return res.status(404).json({ error: 'Poll not found.' });
  const access = await assertChannelAccess(poll.channel_id, req.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  if (!(await hasServerPermission(poll.server_id, req.user.id, 'sendMessages', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to vote in this poll." });
  }
  if (poll.closes_at && Number(poll.closes_at) <= Date.now()) {
    return res.status(400).json({ error: 'This poll is closed.' });
  }

  const raw = Array.isArray(req.body.optionIds)
    ? req.body.optionIds
    : req.body.optionId !== undefined
      ? [req.body.optionId]
      : [];
  const optionIds = [
    ...new Set(
      raw
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  ];
  if (!poll.allow_multiple && optionIds.length > 1) {
    return res.status(400).json({ error: 'This poll only allows one choice.' });
  }
  const { rows: optionRows } = await query('SELECT id FROM poll_options WHERE poll_id = $1', [
    poll.id
  ]);
  const validOptions = new Set(optionRows.map((row) => Number(row.id)));
  if (optionIds.some((id) => !validOptions.has(id))) {
    return res.status(400).json({ error: 'Invalid poll option.' });
  }

  const now = Date.now();
  await withTransaction(async () => {
    await query('DELETE FROM poll_votes WHERE poll_id = $1 AND user_id = $2', [
      poll.id,
      req.user.id
    ]);
    for (const optionId of optionIds) {
      await query(
        'INSERT INTO poll_votes (poll_id, option_id, user_id, created_at) VALUES ($1, $2, $3, $4)',
        [poll.id, optionId, req.user.id, now]
      );
    }
  });

  const row = await getMessageRow(poll.message_id);
  const message = await serializeMessage(row, req.user.id);
  await broadcastPoll(req.app.get('io'), message);
  res.json({ poll: message.poll });
}));

router.post('/polls/:id/close', authRequired, asyncHandler(async (req, res) => {
  const poll = await getPollRow(req.params.id);
  if (!poll) return res.status(404).json({ error: 'Poll not found.' });
  const row = await getMessageRow(poll.message_id);
  if (!(await canModerateMessage(row, req.user))) {
    return res.status(403).json({ error: 'You cannot close this poll.' });
  }
  await query('UPDATE polls SET closes_at = $1 WHERE id = $2', [Date.now(), poll.id]);
  const updated = await getMessageRow(poll.message_id);
  const message = await serializeMessage(updated, req.user.id);
  await broadcastPoll(req.app.get('io'), message);
  res.json({ poll: message.poll });
}));

router.patch('/messages/:id', authRequired, asyncHandler(async (req, res) => {
  const row = await getMessageRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Message not found' });
  if (row.user_id !== req.user.id) return res.status(403).json({ error: 'You can only edit your own messages.' });
  if (row.channel_id) {
    const access = await assertChannelAccess(row.channel_id, req.user.id);
    if (access.error) return res.status(access.status).json({ error: access.error });
  }
  if (row.e2ee) {
    return res.status(400).json({
      code: 'E2EE_IMMUTABLE',
      error: 'Encrypted messages cannot be edited.'
    });
  }
  if (
    row.channel_id &&
    !(await hasServerPermission(row.server_id, req.user.id, 'sendMessages', req.user.role))
  ) {
    return res.status(403).json({ error: "You don't have permission to send messages here." });
  }

  const { rows: pollRows } = await query('SELECT 1 FROM polls WHERE message_id = $1', [row.id]);
  if (pollRows[0]) {
    return res.status(400).json({ error: 'Poll messages cannot be edited.' });
  }

  const content = trim(req.body.content).slice(0, 4000);
  if (!content) return res.status(400).json({ error: 'Message cannot be empty.' });

  if (row.channel_id) {
    const emoteBlock = await checkEmoteTokens(row.server_id, req.user.id, content);
    if (emoteBlock) return res.status(emoteBlock.status).json(emoteBlock.body);
  }

  if (row.channel_id) {
    const blocked = await checkAutomod({
      serverId: row.server_id,
      userId: req.user.id,
      channelId: row.channel_id,
      content,
      globalRole: req.user.role,
      excludeMessageId: row.id
    });
    if (blocked) {
      return res.status(400).json({ error: blocked.message, code: 'AUTOMOD', rule: blocked.rule });
    }
  }

  // The previous text is kept before it is overwritten: "(edited)" is a fact,
  // and the thing people want when a conversation stops making sense is what
  // the message said first.
  const editedAt = Date.now();
  await withTransaction(async () => {
    await query('UPDATE messages SET content = $1, edited_at = $2 WHERE id = $3', [
      content,
      editedAt,
      row.id
    ]);
    await query(
      'INSERT INTO message_edits (message_id, editor_id, before, after, at) VALUES ($1, $2, $3, $4, $5)',
      [row.id, req.user.id, row.content || '', content, editedAt]
    );
  });
  const updated = await getMessageRow(row.id);
  const message = await serializeMessage(updated, 0);
  const io = req.app.get('io');
  const payload = {
    messageId: message.id,
    channelId: message.channelId,
    dmId: message.dmId,
    content: message.content,
    editedAt: message.editedAt
  };
  for (const room of await broadcastRooms(message)) io.to(room).emit('message:updated', payload);
  if (message.serverId) {
    emitToServerBots(io, message.serverId, 'messages', 'MESSAGE_UPDATE', messageEvent(message));
  }
  res.json({ message: await serializeMessage(updated, req.user.id) });
}));

// The history of a message is readable by anyone who can read the message. The
// edit already happened in front of them; hiding what it said before only hides
// it from the people who saw the original.
router.get('/messages/:id/edits', authRequired, asyncHandler(async (req, res) => {
  const row = await getMessageRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Message not found' });
  if (row.channel_id) {
    const access = await assertChannelAccess(row.channel_id, req.user.id);
    if (access.error) return res.status(access.status).json({ error: access.error });
  } else if (row.dm_id) {
    if (!isDmParticipant(await getDmRow(row.dm_id), req.user.id)) {
      return res.status(403).json({ error: 'You cannot read this message.' });
    }
  } else {
    return res.status(404).json({ error: 'Message not found' });
  }
  const { rows } = await query(
    `SELECT e.id, e.before, e.after, e.at, u.id AS editor_id, u.username, u.display_name
       FROM message_edits e
       LEFT JOIN users u ON u.id = e.editor_id
      WHERE e.message_id = $1
      ORDER BY e.id ASC
      LIMIT 50`,
    [row.id]
  );
  res.json({
    original: rows.length ? rows[0].before : row.content || '',
    current: row.content || '',
    edits: rows.map((edit) => ({
      id: Number(edit.id),
      before: edit.before,
      after: edit.after,
      at: Number(edit.at),
      editor: edit.editor_id
        ? { id: Number(edit.editor_id), username: edit.username, displayName: edit.display_name }
        : null
    }))
  });
}));

router.delete('/messages/:id', authRequired, asyncHandler(async (req, res) => {
  const row = await getMessageRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Message not found' });
  if (!(await canModerateMessage(row, req.user))) {
    return res.status(403).json({ error: 'You cannot delete this message.' });
  }

  // The row and the counters it fed have to move together: committing the
  // delete alone is what left users.message_count inflated.
  await withTransaction(async () => {
    await query('DELETE FROM messages WHERE id = $1', [row.id]);
    await releaseMessage(row);
  });
  // Attachments are files on disk with no other owner: once the message that
  // referenced them is gone the upload is garbage.
  if (row.attachment_url) await deleteUploadIfUnused(row.attachment_url);
  const message = { channelId: row.channel_id, dmId: row.dm_id };
  const io = req.app.get('io');
  const payload = { messageId: row.id, channelId: row.channel_id, dmId: row.dm_id };
  for (const room of await broadcastRooms(message)) io.to(room).emit('message:deleted', payload);
  if (row.channel_id) {
    const channel = await getChannelRow(row.channel_id);
    if (channel) {
      emitToServerBots(io, channel.server_id, 'messages', 'MESSAGE_DELETE', {
        id: Number(row.id),
        channelId: Number(row.channel_id),
        serverId: Number(channel.server_id)
      });
    }
  }
  res.json({ ok: true });
}));

router.post('/messages/:id/reactions', authRequired, asyncHandler(async (req, res) => {
  const row = await getMessageRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Message not found' });
  if (row.channel_id) {
    const channel = await getChannelRow(row.channel_id);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    const access = await assertChannelAccess(channel.id, req.user.id);
    if (access.error) return res.status(access.status).json({ error: access.error });
    if (
      !(await hasServerPermission(channel.server_id, req.user.id, 'addReactions', req.user.role))
    ) {
      return res.status(403).json({ error: "You don't have permission to add reactions here." });
    }
  } else if (row.dm_id) {
    const dm = await getDmRow(row.dm_id);
    if (!dm || (dm.user_a !== req.user.id && dm.user_b !== req.user.id)) {
      return res.status(403).json({ error: 'You cannot react in this conversation.' });
    }
  }

  const emoji = trim(req.body.emoji);
  const customEmote = /^:[a-zA-Z0-9_]{2,32}:$/.test(emoji);
  if (!emoji || (!customEmote && [...emoji].length > 4)) {
    return res.status(400).json({ error: 'Invalid reaction.' });
  }
  if (customEmote) {
    const name = emoji.slice(1, -1);
    // In a channel the emote has to belong to that server, and a restricted one
    // also needs the reactor to hold one of its groups. In a DM there is no
    // server, so any emote from a server the reactor is a member of is fair game
    // and emote gating does not apply.
    const known = row.channel_id
      ? (
          await query(
            `SELECT e.name AS name,
               (SELECT COUNT(*) FROM emote_role_access era WHERE era.emote_id = e.id) AS access_count,
               (SELECT COUNT(*) FROM emote_role_access era
                  JOIN server_member_groups smg
                    ON smg.group_id = era.group_id AND smg.server_id = e.server_id
                 WHERE era.emote_id = e.id AND smg.user_id = $1) AS held_count
             FROM server_emotes e
             WHERE e.server_id = $2 AND lower(e.name) = lower($3)`,
            [req.user.id, (await getChannelRow(row.channel_id))?.server_id, name]
          )
        ).rows[0]
      : (
          await query(
            `SELECT 1 FROM server_emotes e
             JOIN server_members sm ON sm.server_id = e.server_id
             WHERE sm.user_id = $1 AND lower(e.name) = lower($2)`,
            [req.user.id, name]
          )
        ).rows[0];
    if (!known) return res.status(400).json({ error: 'That emote is not available here.' });
    if (row.channel_id && Number(known.access_count) > 0 && Number(known.held_count) === 0) {
      return res.status(403).json({
        error: 'You do not have access to that emote.',
        code: 'EMOTE_RESTRICTED',
        message: 'You do not have access to that emote.',
        token: `:${known.name}:`
      });
    }
  }

  const { rows: existingRows } = await query(
    'SELECT 1 FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
    [row.id, req.user.id, emoji]
  );
  if (existingRows[0]) {
    await query('DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3', [
      row.id,
      req.user.id,
      emoji
    ]);
  } else {
    await query(
      'INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES ($1, $2, $3, $4)',
      [row.id, req.user.id, emoji, Date.now()]
    );
  }

  const reactions = await reactionsFor(row.id, 0);
  const message = { channelId: row.channel_id, dmId: row.dm_id };
  const io = req.app.get('io');
  const payload = { messageId: row.id, channelId: row.channel_id, dmId: row.dm_id, reactions };
  for (const room of await broadcastRooms(message)) io.to(room).emit('message:reactions', payload);
  if (row.channel_id) {
    const channel = await getChannelRow(row.channel_id);
    if (channel) {
      emitToServerBots(io, channel.server_id, 'reactions', existingRows[0] ? 'REACTION_REMOVE' : 'REACTION_ADD', {
        messageId: Number(row.id),
        channelId: Number(row.channel_id),
        serverId: Number(channel.server_id),
        emoji,
        userId: Number(req.user.id)
      });
    }
  }
  res.json({ reactions });
}));

router.post('/messages/:id/pin', authRequired, asyncHandler(async (req, res) => {
  const row = await getMessageRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Message not found' });
  const access = await messagePinAccess(row, req.user);
  if (access.error) return res.status(access.status).json({ error: access.error });

  if (row.pinned_at) {
    return res.json({ message: await serializeMessage(row, req.user.id) });
  }

  await query('UPDATE messages SET pinned_at = $1, pinned_by = $2 WHERE id = $3', [
    Date.now(),
    req.user.id,
    row.id
  ]);
  const updated = await getMessageRow(row.id);
  const message = await serializeMessage(updated, req.user.id);
  const payload = {
    messageId: message.id,
    channelId: message.channelId,
    dmId: message.dmId,
    pinnedAt: message.pinnedAt,
    pinnedBy: message.pinnedBy
  };
  const io = req.app.get('io');
  for (const room of await broadcastRooms(message)) io.to(room).emit('message:pinned', payload);
  res.json({ message });
}));

router.delete('/messages/:id/pin', authRequired, asyncHandler(async (req, res) => {
  const row = await getMessageRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Message not found' });
  const access = await messagePinAccess(row, req.user);
  if (access.error) return res.status(access.status).json({ error: access.error });

  if (!row.pinned_at) {
    return res.json({ message: await serializeMessage(row, req.user.id) });
  }

  await query('UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = $1', [row.id]);
  const updated = await getMessageRow(row.id);
  const message = await serializeMessage(updated, req.user.id);
  const payload = {
    messageId: message.id,
    channelId: message.channelId,
    dmId: message.dmId,
    pinnedAt: null,
    pinnedBy: null
  };
  const io = req.app.get('io');
  for (const room of await broadcastRooms(message)) io.to(room).emit('message:unpinned', payload);
  res.json({ message });
}));

router.get('/channels/:id', authRequired, asyncHandler(async (req, res) => {
  const access = await assertChannelAccess(req.params.id, req.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  res.json({
    channel: {
      id: access.channel.id,
      name: access.channel.name,
      type: access.channel.type,
      serverId: access.channel.server_id,
      serverName: access.channel.server_name
    }
  });
}));


// ── Send later ──────────────────────────────────────────────────────────────
// Text-only and channel-only: an attachment is uploaded now but should not
// appear in storage before the message exists, and an E2EE envelope is bound to
// the conversation it was encrypted for. DMs would also need a second
// permission model, so they stay out for now. Delivery lives in
// src/scheduler.js, which re-checks access because a member can be removed
// between scheduling and sending.

const SCHEDULE_MIN_AHEAD_MS = 60 * 1000;
const SCHEDULE_MAX_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

async function assertSchedulable(req) {
  const access = await assertChannelAccess(req.params.id, req.user.id);
  if (access.error) return { error: access.error, status: access.status };
  if (!['text', 'thread', 'media'].includes(access.channel.type)) {
    return { error: 'You cannot schedule messages in this channel.', status: 400 };
  }
  if (!(await hasServerPermission(access.channel.server_id, req.user.id, 'sendMessages', req.user.role))) {
    return { error: "You don't have permission to send messages here.", status: 403 };
  }
  return { channel: access.channel };
}

router.post('/channels/:id/scheduled', authRequired, messageLimiter, asyncHandler(async (req, res) => {
  const access = await assertSchedulable(req);
  if (access.error) return res.status(access.status).json({ error: access.error });

  const content = trim(req.body.content).slice(0, 4000);
  if (!content) return res.status(400).json({ error: 'Message cannot be empty.' });

  const sendAt = Number(req.body.sendAt);
  if (!Number.isFinite(sendAt)) return res.status(400).json({ error: 'Pick a time for this message.' });
  const now = Date.now();
  if (sendAt < now + SCHEDULE_MIN_AHEAD_MS) {
    return res.status(400).json({ error: 'Pick a time at least a minute from now.' });
  }
  if (sendAt > now + SCHEDULE_MAX_AHEAD_MS) {
    return res.status(400).json({ error: 'Messages can be scheduled up to 30 days ahead.' });
  }

  // The same gates as a normal send, applied now rather than at delivery: a
  // scheduled slur is still a slur.
  const emoteBlock = await checkEmoteTokens(access.channel.server_id, req.user.id, content);
  if (emoteBlock) return res.status(emoteBlock.status).json(emoteBlock.body);
  const blocked = await checkAutomod({
    serverId: access.channel.server_id,
    userId: req.user.id,
    channelId: access.channel.id,
    content,
    globalRole: req.user.role
  });
  if (blocked) {
    return res.status(400).json({ error: blocked.message, code: 'AUTOMOD', rule: blocked.rule });
  }

  const { rows } = await query(
    `INSERT INTO scheduled_messages (user_id, channel_id, content, send_at, created_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, send_at`,
    [req.user.id, access.channel.id, content, sendAt, now]
  );
  res.status(201).json({
    scheduled: {
      id: Number(rows[0].id),
      channelId: access.channel.id,
      content,
      sendAt: Number(rows[0].send_at)
    }
  });
}));

router.get('/scheduled', authRequired, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT sm.id, sm.channel_id, sm.content, sm.send_at, sm.created_at,
            c.name AS channel_name, c.server_id, s.name AS server_name
     FROM scheduled_messages sm
     JOIN channels c ON c.id = sm.channel_id
     JOIN servers s ON s.id = c.server_id
     WHERE sm.user_id = $1
     ORDER BY sm.send_at ASC
     LIMIT 100`,
    [req.user.id]
  );
  res.json({
    scheduled: rows.map((row) => ({
      id: Number(row.id),
      channelId: Number(row.channel_id),
      channelName: row.channel_name,
      serverId: Number(row.server_id),
      serverName: row.server_name,
      content: row.content,
      sendAt: Number(row.send_at),
      createdAt: Number(row.created_at)
    }))
  });
}));

router.delete('/scheduled/:id', authRequired, asyncHandler(async (req, res) => {
  const row = (
    await query('SELECT id FROM scheduled_messages WHERE id = $1 AND user_id = $2', [
      Number(req.params.id),
      req.user.id
    ])
  ).rows[0];
  if (!row) return res.status(404).json({ error: 'Scheduled message not found.' });
  await query('DELETE FROM scheduled_messages WHERE id = $1', [row.id]);
  res.json({ ok: true });
}));

module.exports = router;
