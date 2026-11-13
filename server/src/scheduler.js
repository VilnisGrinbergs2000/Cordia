'use strict';
// Drains the "send later" queue. A scheduled message is a promise the server
// makes to a user, so every delivery re-checks the things that could have
// changed since it was written: the channel, the membership, the permission and
// the automod rules. Anything that fails is dropped with a reason instead of
// posting into a room the author can no longer see.
require('./pg/env');
const { query } = require('./pg/pool');
const { getChannelRow, getMessageRow, serializeMessage } = require('./util');
const { hasServerPermission } = require('./permissions');
const { createMentions } = require('./attention');
const { sendMessagePush } = require('./push');
const { checkAutomod } = require('./automod');
const { touchThread } = require('./threads');
const { adjustUserCount } = require('./messageCounters');

const TICK_MS = 15000;
const BATCH = 20;

function roomsFor(message, channel) {
  // Threads are private, forum posts are not — the same rule the live route
  // applies when it decides who hears about a new message.
  if (channel.type === 'thread') return [`thread:${channel.id}`];
  return [`server:${channel.server_id}`];
}

async function drop(row, io, error) {
  await query('DELETE FROM scheduled_messages WHERE id = $1', [row.id]);
  io.to(`user:${row.user_id}`).emit('scheduled:failed', {
    id: Number(row.id),
    content: row.content,
    error
  });
}

async function deliver(row, io) {
  const channel = await getChannelRow(row.channel_id);
  if (!channel) return drop(row, io, 'The channel no longer exists.');

  const user = (await query('SELECT * FROM users WHERE id = $1', [row.user_id])).rows[0];
  if (!user || user.banned) return drop(row, io, 'This message could not be posted.');

  const member = (
    await query('SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2', [
      channel.server_id,
      user.id
    ])
  ).rows[0];
  if (!member) return drop(row, io, 'You are no longer a member of that server.');

  if (!(await hasServerPermission(channel.server_id, user.id, 'sendMessages', user.role))) {
    return drop(row, io, "You don't have permission to send messages there anymore.");
  }

  const blocked = await checkAutomod({
    serverId: channel.server_id,
    userId: user.id,
    channelId: channel.id,
    content: row.content,
    globalRole: user.role
  });
  if (blocked) return drop(row, io, blocked.message);

  const now = Date.now();
  const inserted = await query(
    'INSERT INTO messages (channel_id, user_id, content, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
    [channel.id, user.id, row.content, now]
  );
  await adjustUserCount(user.id, 1);
  if (channel.type === 'thread') await touchThread(channel.id);

  const messageRow = await getMessageRow(Number(inserted.rows[0].id));
  const message = await serializeMessage(messageRow, user.id);
  const mentioned = await createMentions(messageRow, io);

  for (const room of roomsFor(message, channel)) {
    io.to(room).emit('message:new', message);
  }
  sendMessagePush(message, mentioned).catch((error) => {
    console.error('[scheduler] push failed:', error.message);
  });

  await query('DELETE FROM scheduled_messages WHERE id = $1', [row.id]);
  io.to(`user:${user.id}`).emit('scheduled:sent', {
    id: Number(row.id),
    messageId: Number(message.id)
  });
}

async function tick(io) {
  const { rows } = await query(
    'SELECT * FROM scheduled_messages WHERE send_at <= $1 ORDER BY send_at ASC LIMIT $2',
    [Date.now(), BATCH]
  );
  for (const row of rows) {
    try {
      await deliver(row, io);
    } catch (error) {
      console.error('[scheduler] delivery failed:', error.message);
    }
  }
}

function startScheduler(io) {
  // Expired rate-limit rows are dead weight: the window has passed and nothing
  // will read them again.
  let swept = 0;
  const run = () => {
    tick(io).catch((error) => console.error('[scheduler] tick failed:', error.message));
    if (Date.now() - swept > 60_000) {
      swept = Date.now();
      require('./rateStore')
        .sweep()
        .catch((error) => console.error('[rate] sweep failed:', error.message));
    }
  };
  // A restart should not wait a full tick for messages that came due while the
  // process was down.
  setTimeout(run, 3000).unref?.();
  const timer = setInterval(run, TICK_MS);
  timer.unref?.();
  return timer;
}

module.exports = { startScheduler, tick };
