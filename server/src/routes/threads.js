const express = require('express');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query, withTransaction } = require('../pg/pool');
const { authRequired } = require('../auth');
const {
  MESSAGE_SELECT,
  serializeMessage,
  getChannelRow,
  getMessageRow,
  assertChannelAccess,
  getMembership,
  deleteUploadIfUnused,
  buildServer
} = require('../util');
const { hasServerPermission } = require('../permissions');
const { adjustUserCount, releaseCascade } = require('../messageCounters');
const {
  threadTitle,
  getThread,
  threadForMessage,
  createThreadRow,
  setArchived,
  renameThread,
  listThreadsForViewer,
  joinThread,
  isThreadMember,
  threadMembers
} = require('../threads');
const { readTagIds, replaceThreadTags } = require('../forumTags');

const router = express.Router();
const MAX_BODY = 4000;

async function publish(req, serverId) {
  const server = await buildServer(serverId);
  if (server) req.app.get('io').to(`server:${serverId}`).emit('server:updated', server);
  req.app.get('io').to(`server:${serverId}`).emit('server:threads-changed', { serverId });
  return server;
}

// A thread shows up in its parent channel as a system message with a "View
// thread" button - that is how people discover it and join in.
async function announceThread(req, thread, parentChannel) {
  const now = Date.now();
  const { rows } = await query(
    `INSERT INTO messages (channel_id, user_id, content, system_type, thread_id, created_at)
     VALUES ($1, $2, $3, 'thread', $4, $5) RETURNING id`,
    [parentChannel.id, req.user.id, thread.name, thread.id, now]
  );
  // The announcement is a real message row authored by the thread creator, so
  // it has to feed the same counter the delete path will take it out of.
  await adjustUserCount(req.user.id, 1);
  const row = await getMessageRow(rows[0].id);
  return serializeMessage(row, req.user.id);
}

function channelKind(channel) {
  if (channel.type === 'thread') return 'thread';
  if (channel.type === 'forum') return 'forum';
  // A stage is voice-like: it is not a place to hold conversations, so threads
  // and forum posts are rejected there exactly like they are in a voice channel.
  if (channel.type === 'voice' || channel.type === 'stage') return 'voice';
  return 'text';
}

// A thread lives under a text channel or a forum. Both share the same rules:
// you must be a member, you must be able to post, and the parent must still be
// around.
async function parentFor(channelId, userId, permission = 'startThreads') {
  const access = await assertChannelAccess(channelId, userId);
  if (access.error) return access;
  const kind = channelKind(access.channel);
  if (kind !== 'text' && kind !== 'forum') {
    return { error: 'Threads only live in text channels and forums.', status: 400 };
  }
  const allowed = await hasServerPermission(
    access.channel.server_id,
    userId,
    permission,
    access.membership.role
  );
  if (!allowed) {
    return {
      error:
        permission === 'startThreads'
          ? "You don't have permission to start threads here."
          : "You don't have permission to post here.",
      status: 403
    };
  }
  return access;
}

async function threadOwnerOrManager(thread, userId, role) {
  if (Number(thread.ownerId) === Number(userId)) return true;
  if (await hasServerPermission(thread.serverId, userId, 'manageChannels', role)) return true;
  return hasServerPermission(thread.serverId, userId, 'manageServer', role);
}

router.post('/channels/:channelId/threads', authRequired, asyncHandler(async (req, res) => {
  const access = await parentFor(req.params.channelId, req.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  const { channel } = access;
  if (channelKind(channel) === 'forum') {
    return res.status(400).json({ error: 'Forum channels hold posts, not message threads.' });
  }

  let parentMessageId = null;
  if (req.body?.messageId) {
    const message = await getMessageRow(Number(req.body.messageId));
    if (!message || Number(message.channel_id) !== Number(channel.id)) {
      return res.status(400).json({ error: 'That message is not in this channel.' });
    }
    const existing = await threadForMessage(message.id);
    if (existing) return res.status(409).json({ error: 'That message already has a thread.', thread: existing });
    parentMessageId = message.id;
  }

  const fallback = req.body?.messageId ? 'Thread' : 'New thread';
  // createThreadRow owns its own transaction (thread row + creator membership),
  // so it runs first and the announcement lands in a second one: the message row
  // and the author counter it feeds stay atomic together.
  const thread = await createThreadRow({
    serverId: channel.server_id,
    parentChannel: channel,
    name: threadTitle(req.body?.name, fallback),
    ownerId: req.user.id,
    parentMessageId
  });
  const message = await withTransaction(async () => announceThread(req, thread, channel));
  // The creator is a member from the start, so their live socket joins the room too.
  req.app.get('io').in(`user:${req.user.id}`).socketsJoin(`thread:${thread.id}`);
  // The announcement lives in the parent channel, so the whole server sees the pill.
  req.app.get('io').to(`server:${channel.server_id}`).emit('message:new', message);
  await publish(req, channel.server_id);
  res.status(201).json({ thread, message });
}));

// Joining only ever confirms a membership that already exists: a private thread
// is entered by being added to it (start it, post in it, be added by its owner),
// never by guessing its id. There is no thread invite table, so there is nothing
// that could authorise a stranger here - forum posts are public and stay joinable.
// TODO(product): if private threads should be shareable, add a thread invite row
// (thread_id, code/sponsor, expiry) and accept it here; until then this route is
// idempotent for members and 403 for everyone else.
router.post('/threads/:threadId/join', authRequired, asyncHandler(async (req, res) => {
  const thread = await getThread(req.params.threadId, req.user.id);
  if (!thread) return res.status(404).json({ error: 'Thread not found.' });
  const membership = await getMembership(thread.serverId, req.user.id);
  if (!membership) {
    return res.status(403).json({ error: 'You are not a member of this server' });
  }
  const allowed =
    thread.parentType === 'forum' ||
    (await isThreadMember(thread.id, req.user.id)) ||
    (await hasServerPermission(thread.serverId, req.user.id, 'manageChannels', membership.role));
  if (!allowed) {
    return res.status(403).json({ error: 'You have not been added to this thread.' });
  }
  await joinThread(thread.id, req.user.id);
  // Join the socket room first so the response cannot race the next event.
  const io = req.app.get('io');
  io.in(`user:${req.user.id}`).socketsJoin(`thread:${thread.id}`);
  res.json({ thread: await getThread(thread.id, req.user.id) });
}));

router.get('/threads/:threadId/members', authRequired, asyncHandler(async (req, res) => {
  const thread = await getThread(req.params.threadId, req.user.id);
  if (!thread) return res.status(404).json({ error: 'Thread not found.' });
  const access = await assertChannelAccess(thread.id, req.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  res.json({ members: await threadMembers(thread.id) });
}));

// Forum posts are threads with a first message, created in one request so a
// post can never exist without its body.
router.post('/channels/:channelId/posts', authRequired, asyncHandler(async (req, res) => {
  const access = await parentFor(req.params.channelId, req.user.id, 'sendMessages');
  if (access.error) return res.status(access.status).json({ error: access.error });
  const { channel } = access;
  if (channelKind(channel) !== 'forum') {
    return res.status(400).json({ error: 'Posts only exist in forum channels.' });
  }

  const title = threadTitle(req.body?.title, '');
  if (!title) return res.status(400).json({ error: 'Give the post a title.' });
  const body = String(req.body?.content || '').trim().slice(0, MAX_BODY);
  if (!body) return res.status(400).json({ error: 'Write something in the post.' });

  const tagAccess = await readTagIds(channel.id, req.body?.tagIds);
  if (tagAccess.error) return res.status(400).json({ error: tagAccess.error });

  const now = Date.now();
  // Same split as the thread route: the post row is created by its own
  // transactional helper, then the body message and its counter commit together.
  const thread = await createThreadRow({
    serverId: channel.server_id,
    parentChannel: channel,
    name: title,
    ownerId: req.user.id,
    messageCount: 1
  });
  const message = await withTransaction(async () => {
    const inserted = await query(
      'INSERT INTO messages (channel_id, user_id, content, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
      [thread.id, req.user.id, body, now]
    );
    // Forum bodies bypass the normal post route, so the author counter is bumped
    // here too - otherwise deleting the post would over-decrement.
    await adjustUserCount(req.user.id, 1);
    await query('UPDATE channels SET last_message_at = $1 WHERE id = $2', [now, thread.id]);
    if (tagAccess.provided) await replaceThreadTags(thread.id, tagAccess.ids);
    const row = await getMessageRow(inserted.rows[0].id);
    return serializeMessage(row, req.user.id);
  });

  req.app.get('io').in(`user:${req.user.id}`).socketsJoin(`thread:${thread.id}`);
  req.app
    .get('io')
    .to(`server:${channel.server_id}`)
    .emit('message:new', { ...message, serverId: channel.server_id });

  const server = await publish(req, channel.server_id);
  res.status(201).json({ thread: await getThread(thread.id), message, server });
}));

router.get('/servers/:serverId/threads', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.serverId);
  const { rows } = await query(
    "SELECT id FROM channels WHERE server_id = $1 AND type != 'thread' LIMIT 1",
    [serverId]
  );
  // No channel to anchor the membership check on is the same answer as a
  // channel that does not exist: the viewer cannot see this server.
  const access = await assertChannelAccess(rows[0] ? rows[0].id : null, req.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  res.json({ threads: await listThreadsForViewer(serverId, req.user.id) });
}));

router.patch('/threads/:threadId', authRequired, asyncHandler(async (req, res) => {
  const thread = await getThread(req.params.threadId);
  if (!thread) return res.status(404).json({ error: 'Thread not found.' });
  const membership = await assertChannelAccess(thread.id, req.user.id);
  if (membership.error) return res.status(membership.status).json({ error: membership.error });
  if (!(await threadOwnerOrManager(thread, req.user.id, membership.membership.role))) {
    return res.status(403).json({ error: "You can't edit this thread." });
  }

  let next = thread;
  if (req.body?.name !== undefined) {
    const name = threadTitle(req.body.name, '');
    if (!name) return res.status(400).json({ error: 'Give the thread a name.' });
    next = await renameThread(thread.id, name);
  }
  if (req.body?.archived !== undefined) {
    next = await setArchived(thread.id, !!req.body.archived);
  }
  if (req.body?.pinned !== undefined) {
    await query('UPDATE channels SET pinned = $1 WHERE id = $2 AND type = $3', [
      req.body.pinned ? 1 : 0,
      thread.id,
      'thread'
    ]);
    next = await getThread(thread.id, req.user.id);
  }
  if (req.body?.tagIds !== undefined) {
    if (thread.parentType !== 'forum') {
      return res.status(400).json({ error: 'Tags only exist on forum posts.' });
    }
    const tagAccess = await readTagIds(thread.parentChannelId, req.body.tagIds);
    if (tagAccess.error) return res.status(400).json({ error: tagAccess.error });
    await withTransaction(async () => replaceThreadTags(thread.id, tagAccess.ids));
    next = await getThread(thread.id, req.user.id);
  }
  await publish(req, thread.serverId);
  res.json({ thread: next });
}));

router.delete('/threads/:threadId', authRequired, asyncHandler(async (req, res) => {
  const thread = await getThread(req.params.threadId);
  if (!thread) return res.status(404).json({ error: 'Thread not found.' });
  const access = await assertChannelAccess(thread.id, req.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  if (!(await threadOwnerOrManager(thread, req.user.id, access.membership.role))) {
    return res.status(403).json({ error: "You can't delete this thread." });
  }
  // The announcement in the parent channel is a child of the thread: drop it
  // with the thread instead of leaving a pill that points nowhere.
  const announcements = (
    await query('SELECT id, channel_id FROM messages WHERE thread_id = $1', [thread.id])
  ).rows;
  // Attachments are files on disk with no other owner. They have to be read
  // before the rows go away - after the delete there is nothing left to point at
  // them - and unlinked only once the delete has committed.
  const attachments = (
    await query(
      `SELECT DISTINCT attachment_url FROM messages
       WHERE (channel_id = $1 OR thread_id = $2) AND attachment_url IS NOT NULL`,
      [thread.id, thread.id]
    )
  ).rows.map((row) => row.attachment_url);
  // Three sets of rows go at once: the thread's own messages (foreign key
  // cascade), its announcement in the parent channel (deleted below) and the
  // thread row itself. Counters move inside the same transaction so a failure
  // cannot leave them pointing at messages that no longer exist.
  await withTransaction(async () => {
    await releaseCascade({ channelIds: [thread.id], threadIds: [thread.id] });
    await query('DELETE FROM messages WHERE thread_id = $1', [thread.id]);
    await query('DELETE FROM channels WHERE id = $1', [thread.id]);
  });
  for (const url of attachments) await deleteUploadIfUnused(url);
  const io = req.app.get('io');
  for (const row of announcements) {
    io.to(`server:${thread.serverId}`).emit('message:deleted', {
      messageId: row.id,
      channelId: row.channel_id,
      dmId: null
    });
  }
  await publish(req, thread.serverId);
  res.json({ ok: true });
}));

module.exports = router;
