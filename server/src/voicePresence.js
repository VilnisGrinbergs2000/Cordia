'use strict';
// Voice occupancy, in Postgres.
//
// The in-process Map is still what a socket uses to signal its own peers, but
// it is no longer the record of who is in a channel: a restart used to empty
// every voice channel and a second process could not see the first one's
// participants at all. Every read below comes from the table, so the sidebar
// count, the participant list and the peer list agree across processes.
require('./pg/env');
const { query } = require('./pg/pool');

// A participant whose process died never sends a leave. Ninety seconds is
// three missed transport heartbeats, which is the same budget the gateway uses
// before it calls a socket stale.
const STALE_MS = 90_000;

async function join({ channelId, serverId, userId, socketId, muted, video, sharing }) {
  const now = Date.now();
  await query(
    `INSERT INTO voice_participants
       (channel_id, user_id, server_id, socket_id, muted, video, sharing, joined_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     ON CONFLICT (channel_id, user_id) DO UPDATE SET
       socket_id = EXCLUDED.socket_id,
       server_id = EXCLUDED.server_id,
       muted = EXCLUDED.muted,
       video = EXCLUDED.video,
       sharing = EXCLUDED.sharing,
       updated_at = EXCLUDED.updated_at`,
    [
      Number(channelId),
      Number(userId),
      Number(serverId),
      String(socketId),
      !!muted,
      !!video,
      !!sharing,
      now
    ]
  );
}

async function updateState(channelId, userId, { muted, video, sharing }) {
  await query(
    `UPDATE voice_participants SET muted = $3, video = $4, sharing = $5, updated_at = $6
      WHERE channel_id = $1 AND user_id = $2`,
    [Number(channelId), Number(userId), !!muted, !!video, !!sharing, Date.now()]
  );
}

// Scoped to the socket that is leaving: one person can be in the same channel
// from two devices, and the second device closing must not remove the first.
// The row itself is per (channel, user), so the last device to leave wins.
async function leave(channelId, userId, socketId) {
  if (socketId) {
    await query(
      'DELETE FROM voice_participants WHERE channel_id = $1 AND user_id = $2 AND socket_id = $3',
      [Number(channelId), Number(userId), String(socketId)]
    );
    return;
  }
  await query('DELETE FROM voice_participants WHERE channel_id = $1 AND user_id = $2', [
    Number(channelId),
    Number(userId)
  ]);
}

async function leaveSocket(socketId) {
  await query('DELETE FROM voice_participants WHERE socket_id = $1', [String(socketId)]);
}

async function touch(userId, socketId) {
  await query('UPDATE voice_participants SET updated_at = $1 WHERE user_id = $2 AND socket_id = $3', [
    Date.now(),
    Number(userId),
    String(socketId)
  ]);
}

async function listChannel(channelId) {
  const { rows } = await query(
    `SELECT vp.channel_id, vp.user_id, vp.socket_id, vp.muted, vp.video, vp.sharing,
            u.username, u.display_name, u.avatar_color, u.avatar_url
       FROM voice_participants vp
       JOIN users u ON u.id = vp.user_id
      WHERE vp.channel_id = $1 AND vp.updated_at > $2
      ORDER BY vp.joined_at ASC`,
    [Number(channelId), Date.now() - STALE_MS]
  );
  return rows.map((row) => ({
    socketId: row.socket_id,
    id: Number(row.user_id),
    username: row.username,
    displayName: row.display_name,
    avatarColor: row.avatar_color,
    avatarUrl: row.avatar_url || '',
    muted: !!row.muted,
    video: !!row.video,
    sharing: !!row.sharing
  }));
}

// Every occupied channel in a server, keyed by channel id. One query rather
// than one per channel: the sidebar asks for this on every connect.
async function listServer(serverId) {
  const { rows } = await query(
    `SELECT vp.channel_id, vp.user_id, vp.socket_id, vp.muted, vp.video, vp.sharing,
            u.username, u.display_name, u.avatar_color, u.avatar_url
       FROM voice_participants vp
       JOIN users u ON u.id = vp.user_id
      WHERE vp.server_id = $1 AND vp.updated_at > $2
      ORDER BY vp.joined_at ASC`,
    [Number(serverId), Date.now() - STALE_MS]
  );
  const byChannel = new Map();
  for (const row of rows) {
    const key = Number(row.channel_id);
    if (!byChannel.has(key)) byChannel.set(key, []);
    byChannel.get(key).push({
      socketId: row.socket_id,
      id: Number(row.user_id),
      username: row.username,
      displayName: row.display_name,
      avatarColor: row.avatar_color,
      avatarUrl: row.avatar_url || '',
      muted: !!row.muted,
      video: !!row.video,
      sharing: !!row.sharing
    });
  }
  return byChannel;
}

async function expireStale(now = Date.now()) {
  const { rowCount } = await query('DELETE FROM voice_participants WHERE updated_at <= $1', [
    now - STALE_MS
  ]);
  return rowCount;
}

module.exports = {
  STALE_MS,
  join,
  updateState,
  leave,
  leaveSocket,
  touch,
  listChannel,
  listServer,
  expireStale
};
