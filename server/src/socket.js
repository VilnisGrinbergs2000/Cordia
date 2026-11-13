require('./pg/env');
const { query } = require('./pg/pool');
const { userFromTokenAsync, readCookie } = require('./auth');
const { cookieName } = require('./config');
const {
  addPresence,
  removePresence,
  isOnline,
  onlineIds,
  setPresenceHidden,
  isPresenceHidden
} = require('./presence');
const { privacyFlags } = require('./privacy');
const { awardBadge } = require('./badges');
const { rooms: voiceRooms } = require('./voiceState');
const voicePresence = require('./voicePresence');
const voiceBridge = require('./voiceBridge');

const { attachCallHandlers } = require('./calls');
const { getChannelRow, getDmRow, getMembership } = require('./util');
const { hasServerPermission } = require('./permissions');
const { emitToServerBots } = require('./bots');

function attachSocket(io) {
  voiceBridge.startVoiceBridge(io);
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token || readCookie(socket.handshake.headers.cookie, cookieName);
      const user = await userFromTokenAsync(token);
      if (!user) return next(new Error('unauthorized'));
      if (user.banned) return next(new Error('banned'));
      socket.user = user;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', async (socket) => {
    const user = socket.user;
    addPresence(user.id);
    socket.join(`user:${user.id}`);
    socket.on('voice:join', handleVoiceJoin);
    // The transport heartbeat fires every ~25s whether or not the app sends
    // anything. It is what keeps a voice row fresh, so a crashed process is
    // detected by three missed beats rather than by a timer that also kills
    // healthy participants.
    socket.conn.on('heartbeat', () => {
      if (!socket.data.voiceChannelId) return;
      voicePresence.touch(user.id, socket.id).catch(() => {});
    });

    // "Appear offline" keeps the socket counted for calls and push, but every
    // presence payload that leaves the server reports them as offline.
    let flags = null;
    try {
      flags = await privacyFlags(user.id);
    } catch (error) {
      console.error('[socket] privacy lookup failed:', error.message);
    }
    const invisible = (flags?.presence_visibility || 'everyone') === 'nobody';
    setPresenceHidden(user.id, invisible);

    // Every room has to be joined before presence:list goes out and the call
    // handlers attach: the lookups below are awaited, and anything emitted
    // during that window would otherwise be missed.
    let memberships;
    try {
      const { rows } = await query('SELECT server_id FROM server_members WHERE user_id = $1', [
        user.id
      ]);
      memberships = rows;
      for (const membership of memberships) await socket.join(`server:${membership.server_id}`);

      // Threads are private, so live events travel in their own room. Joining a
      // thread at runtime does the same with io.socketsJoin.
      const { rows: threads } = await query('SELECT thread_id FROM thread_members WHERE user_id = $1', [
        user.id
      ]);
      for (const thread of threads) await socket.join(`thread:${thread.thread_id}`);
    } catch (error) {
      console.error('[socket] room join failed:', error.message);
      removePresence(user.id);
      socket.disconnect(true);
      return;
    }

    function voiceOccupancy(room) {
      if (!room) return [];
      return [...room.values()].map((participant) => ({
        socketId: participant.socketId,
        id: participant.id,
        username: participant.username,
        displayName: participant.displayName,
        avatarColor: participant.avatarColor,
        avatarUrl: participant.avatarUrl,
        muted: participant.muted,
        video: participant.video,
        sharing: participant.sharing
      }));
    }

    // A bot cannot sit in a call — it has no audio to send and cannot answer a
    // WebRTC offer — but it can still see who is in one. That is what a
    // moderation bot needs, and it is the half of "bots in voice" that does not
    // break the call for everybody else.
    function emitVoiceState(channelId, serverId, participant, extra = {}) {
      if (!channelId || !serverId || !participant) return;
      emitToServerBots(io, serverId, 'members', 'VOICE_STATE_UPDATE', {
        channelId: Number(channelId),
        serverId: Number(serverId),
        user: {
          id: Number(participant.id),
          username: participant.username,
          displayName: participant.displayName
        },
        muted: !!participant.muted,
        video: !!participant.video,
        sharing: !!participant.sharing,
        ...extra
      });
    }

    // The list comes from Postgres, not from this process's Map: a participant
    // on another process is still in the channel, and a restart no longer
    // empties it. The Map stays as the fast path for signalling locally.
    async function broadcastVoiceOccupancy(channelId, serverId) {
      if (!channelId || !serverId) return;
      try {
        const participants = await voicePresence.listChannel(channelId);
        io.to(`server:${serverId}`).emit('voice:occupancy', { channelId, participants });
      } catch (error) {
        console.error('[socket] voice occupancy failed:', error.message);
      }
    }

    async function occupancySnapshot() {
      const serverIds = [...new Set(memberships.map((membership) => membership.server_id))];
      const snapshot = {};
      for (const serverId of serverIds) {
        const byChannel = await voicePresence.listServer(serverId);
        for (const [channelId, participants] of byChannel) snapshot[channelId] = participants;
      }
      return snapshot;
    }

    socket.emit('presence:list', onlineIds());
    try {
      socket.emit('voice:occupancy:init', await occupancySnapshot());
    } catch (error) {
      console.error('[socket] voice occupancy snapshot failed:', error.message);
    }
    if (!invisible) io.emit('presence:update', { userId: user.id, online: true });
    attachCallHandlers(io, socket, user);

    async function leaveVoice() {
      const channelId = socket.data.voiceChannelId;
      const serverId = socket.data.voiceServerId;
      if (!channelId) return;
      const room = voiceRooms.get(channelId);
      const leaving = room ? room.get(socket.id) : null;
      if (room) {
        room.delete(socket.id);
        if (room.size === 0) voiceRooms.delete(channelId);
      }
      socket.to('voice:' + channelId).emit('voice:peer-left', { socketId: socket.id });
      voiceBridge.notifyPeer({
        channelId,
        event: 'voice:peer-left',
        payload: { socketId: socket.id }
      });
      socket.leave('voice:' + channelId);
      await voicePresence.leave(channelId, user.id, socket.id);
      socket.data.voiceChannelId = null;
      socket.data.voiceServerId = null;

      if (socket.data.voiceJoinedAt) {
        const seconds = Math.floor((Date.now() - socket.data.voiceJoinedAt) / 1000);
        socket.data.voiceJoinedAt = null;
        if (seconds > 0) {
          const { rows } = await query(
            'UPDATE users SET voice_seconds = voice_seconds + $1 WHERE id = $2 RETURNING voice_seconds',
            [seconds, user.id]
          );
          const total = rows[0] ? rows[0].voice_seconds : 0;
          if (total >= 3600 && (await awardBadge(user.id, 'voice_veteran'))) {
            io.to(`user:${user.id}`).emit('badge:awarded', { badge: 'voice_veteran' });
          }
        }
      }
      broadcastVoiceOccupancy(channelId, serverId);
      emitVoiceState(channelId, serverId, leaving, { joined: false });
    }

    socket.on('typing', async (data) => {
      try {
        const scopeType = data?.scopeType;
        const scopeId = Number(data?.scopeId);
        if (!scopeId) return;
        // Checked per event, not per connection: the setting can change
        // mid-session and the cached read is cheap.
        const senderFlags = await privacyFlags(user.id);
        if (Number(senderFlags.show_typing) === 0) return;
        const payloadUser = { id: user.id, displayName: user.display_name };
        if (scopeType === 'channel') {
          const channel = await getChannelRow(scopeId);
          if (!channel) return;
          if (!(await getMembership(channel.server_id, user.id))) return;
          if (!(await hasServerPermission(channel.server_id, user.id, 'sendMessages', user.role))) {
            return;
          }
          // Typing in a private thread would reveal the thread to the server.
          if (channel.type === 'thread') {
            const parent = channel.parent_channel_id
              ? await getChannelRow(channel.parent_channel_id)
              : null;
            if (!parent || parent.type !== 'forum') {
              socket.to(`thread:${channel.id}`).emit('typing', {
                scopeType: 'channel',
                scopeId,
                user: payloadUser
              });
              return;
            }
          }
          socket.to(`server:${channel.server_id}`).emit('typing', {
            scopeType: 'channel',
            scopeId,
            user: payloadUser
          });
        } else if (scopeType === 'dm') {
          const dm = await getDmRow(scopeId);
          if (!dm || (dm.user_a !== user.id && dm.user_b !== user.id)) return;
          const otherId = dm.user_a === user.id ? dm.user_b : dm.user_a;
          socket.to(`user:${otherId}`).emit('typing', { scopeType: 'dm', scopeId, user: payloadUser });
        }
      } catch (error) {
        console.error('[socket] typing failed:', error.message);
      }
    });

    // Declared, not assigned, and registered at the top of the connection: a
    // client emits voice:join on the tick it connects, which is before this
    // async setup has finished. The listener used to be attached after the
    // first await, so that first join was silently dropped and the person sat
    // in a channel nobody could hear them in.
    async function handleVoiceJoin(data) {
      try {
        const channelId = Number(data?.channelId);
        const channel = channelId ? await getChannelRow(channelId) : null;
        // Stage channels share the voice room machinery; only the client draws
        // them differently (speakers vs audience).
        if (!channel || (channel.type !== 'voice' && channel.type !== 'stage')) {
          return socket.emit('voice:error', { error: 'Voice channel not found.' });
        }
        if (!(await getMembership(channel.server_id, user.id))) {
          return socket.emit('voice:error', { error: 'You are not a member of this server.' });
        }
        if (!(await hasServerPermission(channel.server_id, user.id, 'connectVoice', user.role))) {
          return socket.emit('voice:error', {
            error: "You don't have permission to join this voice channel."
          });
        }
        await leaveVoice();

        const canSpeak = await hasServerPermission(channel.server_id, user.id, 'speak', user.role);
        let room = voiceRooms.get(channelId);
        if (!room) {
          room = new Map();
          voiceRooms.set(channelId, room);
        }
        const participant = {
          socketId: socket.id,
          id: user.id,
          username: user.username,
          displayName: user.display_name,
          avatarColor: user.avatar_color,
          avatarUrl: user.avatar_url || '',
          muted: !canSpeak,
          video: false,
          sharing: false
        };
        room.set(socket.id, participant);
        socket.data.voiceChannelId = channelId;
        socket.data.voiceServerId = channel.server_id;
        socket.data.voiceJoinedAt = Date.now();
        await voicePresence.join({
          channelId,
          serverId: channel.server_id,
          userId: user.id,
          socketId: socket.id,
          muted: participant.muted,
          video: false,
          sharing: false
        });

        // The DB list includes anyone on another process, so a fresh joiner
        // sees the whole channel rather than only the local half of it.
        socket.emit('voice:participants', await voicePresence.listChannel(channelId));
        if (!canSpeak) {
          socket.emit('voice:force-mute', { reason: "You don't have permission to speak." });
        }
        // A socket.io room per channel is what lets one emit reach every
        // participant on this process; the bridge covers the other processes.
        socket.join('voice:' + channelId);
        socket.to('voice:' + channelId).emit('voice:peer-joined', participant);
        voiceBridge.notifyPeer({ channelId, event: 'voice:peer-joined', payload: participant });
        broadcastVoiceOccupancy(channelId, channel.server_id);
        emitVoiceState(channelId, channel.server_id, participant, { joined: true });
      } catch (error) {
        console.error('[socket] voice:join failed:', error.message);
      }
    }

    socket.on('voice:leave', async () => {
      try {
        await leaveVoice();
      } catch (error) {
        console.error('[socket] voice:leave failed:', error.message);
      }
    });

    socket.on('voice:state', async (data) => {
      try {
        const channelId = socket.data.voiceChannelId;
        if (!channelId) return;
        const room = voiceRooms.get(channelId);
        if (!room) return;
        const participant = room.get(socket.id);
        if (!participant) return;
        const canSpeak = await hasServerPermission(
          socket.data.voiceServerId,
          user.id,
          'speak',
          user.role
        );
        participant.muted = !canSpeak || !!data?.muted;
        participant.video = !!data?.video;
        participant.sharing = !!data?.sharing;
        await voicePresence.updateState(channelId, user.id, {
          muted: participant.muted,
          video: participant.video,
          sharing: participant.sharing
        });
        if (!canSpeak && !data?.muted) {
          socket.emit('voice:force-mute', { reason: "You don't have permission to speak." });
        }
        const statePayload = {
          socketId: socket.id,
          muted: participant.muted,
          video: participant.video,
          sharing: participant.sharing
        };
        socket.to('voice:' + channelId).emit('voice:peer-state', statePayload);
        voiceBridge.notifyPeer({ channelId, event: 'voice:peer-state', payload: statePayload });
        broadcastVoiceOccupancy(channelId, socket.data.voiceServerId);
        emitVoiceState(channelId, socket.data.voiceServerId, participant, { joined: true });
      } catch (error) {
        console.error('[socket] voice:state failed:', error.message);
      }
    });

    socket.on('webrtc:signal', (data) => {
      const target = data?.to;
      const channelId = socket.data.voiceChannelId;
      if (!target || !channelId) return;
      const room = voiceRooms.get(channelId);
      // Fast path: the peer is on this process, so the offer never leaves it.
      // Otherwise the payload goes through Postgres NOTIFY, which is the only
      // way a socket on another process can be reached.
      if (room && room.has(target)) {
        io.to(target).emit('webrtc:signal', { from: socket.id, data: data.data });
        return;
      }
      voiceBridge.notifySignal({ to: target, sender: socket.id, data: data.data });
    });

    socket.on('disconnect', async () => {
      try {
        await leaveVoice();
      } catch (error) {
        console.error('[socket] voice cleanup failed:', error.message);
      }
      removePresence(user.id);
      if (!isOnline(user.id) && !isPresenceHidden(user.id)) {
        io.emit('presence:update', { userId: user.id, online: false });
      }
    });
  });
}

module.exports = { attachSocket };
