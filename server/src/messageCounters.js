require('./pg/env');
const { query } = require('./pg/pool');

// Two denormalised counters track messages:
//   users.message_count    - how many messages a person has authored (profile stat)
//   channels.message_count - replies in a row of type 'thread' (sidebar sorting)
// Plain text/forum channels never increment channels.message_count, so only
// thread rows are ever adjusted here. Every helper must run inside the same
// transaction as the INSERT or DELETE it belongs to: a delete that commits
// without its decrement is exactly the drift this module exists to prevent.
async function adjustUserCount(userId, delta) {
  if (!userId) return;
  await query('UPDATE users SET message_count = GREATEST(0, message_count + $1) WHERE id = $2', [
    Number(delta),
    Number(userId)
  ]);
}

async function adjustThreadCount(channelId, delta) {
  if (!channelId) return;
  await query(
    "UPDATE channels SET message_count = GREATEST(0, message_count + $1) WHERE id = $2 AND type = 'thread'",
    [Number(delta), Number(channelId)]
  );
}

// Single row: the author loses one message and, if it lived in a thread, the
// thread row loses one reply. The parent channel is deliberately untouched -
// a thread reply was never part of the parent channel's count.
async function releaseMessage(row) {
  if (!row) return;
  await adjustUserCount(row.user_id, -1);
  await adjustThreadCount(row.channel_id, -1);
}

async function authorCounts({ channelIds = [], threadIds = [] }) {
  const clauses = [];
  const params = [];
  let index = 0;
  if (channelIds.length) {
    const placeholders = channelIds.map(() => '$' + (++index)).join(',');
    clauses.push('channel_id IN (' + placeholders + ')');
    params.push(...channelIds.map(Number));
  }
  if (threadIds.length) {
    const placeholders = threadIds.map(() => '$' + (++index)).join(',');
    clauses.push('thread_id IN (' + placeholders + ')');
    params.push(...threadIds.map(Number));
  }
  if (!clauses.length) return [];
  const { rows } = await query(
    `SELECT user_id, COUNT(*) AS n FROM messages WHERE ${clauses.join(' OR ')} GROUP BY user_id`,
    params
  );
  return rows;
}

// Cascade deletes (channel, thread, server) remove messages through foreign
// keys, so the counts have to be read before the parent row goes away. Returns
// the per-author totals that were released, which the callers log.
async function releaseCascade({ channelIds = [], threadIds = [] }) {
  const counts = await authorCounts({ channelIds, threadIds });
  for (const row of counts) await adjustUserCount(row.user_id, -Number(row.n) || 0);
  return counts;
}

// Every channel row a delete will take with it: the channel itself plus any
// threads hanging off it.
async function channelAndThreadIds(channelId) {
  const ids = [Number(channelId)];
  const { rows } = await query('SELECT id FROM channels WHERE parent_channel_id = $1', [
    Number(channelId)
  ]);
  for (const child of rows) ids.push(Number(child.id));
  return ids;
}

module.exports = {
  adjustUserCount,
  adjustThreadCount,
  releaseMessage,
  releaseCascade,
  authorCounts,
  channelAndThreadIds
};
