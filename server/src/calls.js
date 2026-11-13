const crypto = require('node:crypto');
require('./pg/env');
const { query } = require('./pg/pool');
const { isOnline } = require('./presence');
const {
  publicUser,
  blockedBetween,
  canInitiateDm,
  getMessageRow,
  serializeMessage
} = require('./util');
const { sendToUsers } = require('./push');

const sessions = new Map();
// userCalls means "this person is in a call". A callee only enters it when they
// accept: being rung is not being busy, so a ring never blocks their own
// outgoing call or their presence elsewhere.
const userCalls = new Map();
// rings maps a callee to the ringing call they have not answered yet.
const rings = new Map();
const RING_TIMEOUT = 35000;
const CALL_WINDOW_MS = 60_000;
const CALL_MAX_PER_WINDOW = 8;
const DECLINE_COOLDOWN_MS = 60_000;
const callHits = new Map();
const declineCooldowns = new Map();

// Per-caller budget: one call attempt every few seconds on average, so a held
// down client cannot ring somebody in a loop.
function callRateLimited(userId) {
  const now = Date.now();
  let entry = callHits.get(Number(userId));
  if (!entry || entry.reset <= now) {
    entry = { count: 0, reset: now + CALL_WINDOW_MS };
    callHits.set(Number(userId), entry);
  }
  entry.count += 1;
  return entry.count > CALL_MAX_PER_WINDOW ? Math.ceil((entry.reset - now) / 1000) : 0;
}

// A decline is an answer: the same caller cannot immediately ring again.
function declineCooldown(callerId, calleeId) {
  const key = `${Number(callerId)}:${Number(calleeId)}`;
  const until = declineCooldowns.get(key);
  if (!until) return 0;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    declineCooldowns.delete(key);
    return 0;
  }
  return Math.ceil(remaining / 1000);
}

function formatCallDuration(seconds) {
  const total = Math.max(1, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`;
}

async function callDm(call) {
  const { rows } = await query(
    `SELECT * FROM dm_channels
     WHERE (user_a = $1 AND user_b = $2) OR (user_a = $3 AND user_b = $4)`,
    [
      Math.min(call.callerId, call.calleeId),
      Math.max(call.callerId, call.calleeId),
      Math.min(call.callerId, call.calleeId),
      Math.max(call.callerId, call.calleeId)
    ]
  );
  return rows[0];
}

async function callName(userId) {
  const { rows } = await query('SELECT display_name, username FROM users WHERE id = $1', [userId]);
  const user = rows[0];
  return (user && (user.display_name || user.username)) || 'Someone';
}

// One row, serialised once, pushed to the two user rooms - the same shape the
// call summary has always used, so the client's system-pill renderer needs no
// changes. Only the conversation's own participants are in those rooms.
async function addCallLine(io, dm, authorId, content) {
  if (!dm) return null;
  try {
    const { rows } = await query(
      `INSERT INTO messages (dm_id, user_id, content, system_type, created_at)
       VALUES ($1, $2, $3, 'call', $4)
       RETURNING id`,
      [dm.id, authorId, content, Date.now()]
    );
    const message = await serializeMessage(await getMessageRow(Number(rows[0].id)), 0);
    io.to(`user:${dm.user_a}`).to(`user:${dm.user_b}`).emit('message:new', message);
    return message;
  } catch (error) {
    console.error('[calls] system message failed:', error.message);
    return null;
  }
}

async function addCallSummary(io, call, reason) {
  const dm = await callDm(call);
  if (!dm) return;

  const name = await callName(call.callerId);
  let content;
  if (call.answeredAt) {
    const seconds = Math.max(1, Math.round((Date.now() - call.answeredAt) / 1000));
    content = `Call ended - ${formatCallDuration(seconds)}.`;
  } else if (reason === 'declined') {
    content = `${name} started a call that was declined.`;
  } else if (reason === 'unanswered') {
    content = `${name} started a call that was not answered.`;
  } else {
    content = `${name} started a call that was cancelled.`;
  }

  await addCallLine(io, dm, call.callerId, content);
}

function attachCallHandlers(io, socket, user) {
  async function endCall(call, reason) {
    if (!sessions.has(call.id)) return;
    sessions.delete(call.id);
    if (userCalls.get(call.callerId) === call.id) userCalls.delete(call.callerId);
    if (userCalls.get(call.calleeId) === call.id) userCalls.delete(call.calleeId);
    if (rings.get(call.calleeId) === call.id) rings.delete(call.calleeId);
    if (reason === 'declined') {
      declineCooldowns.set(
        `${Number(call.callerId)}:${Number(call.calleeId)}`,
        Date.now() + DECLINE_COOLDOWN_MS
      );
    }
    clearTimeout(call.timer);
    await addCallSummary(io, call, reason);
    const payload = { callId: call.id, reason };
    io.to(`user:${call.callerId}`).emit('call:ended', payload);
    io.to(`user:${call.calleeId}`).emit('call:ended', payload);
  }

  function callForUser(userId) {
    const callId = userCalls.get(userId);
    return callId ? sessions.get(callId) : null;
  }

  socket.on('call:start', async (data) => {
    const targetId = Number(data?.userId);
    if (!targetId || targetId === user.id) {
      return socket.emit('call:unavailable', { error: 'That call cannot be started.' });
    }
    const retryAfter = callRateLimited(user.id);
    if (retryAfter) {
      return socket.emit('call:unavailable', {
        error: 'Too many call attempts. Try again in a minute.',
        retryAfter
      });
    }
    const cooldown = declineCooldown(user.id, targetId);
    if (cooldown) {
      return socket.emit('call:unavailable', {
        error: 'They declined your last call. Try again shortly.',
        retryAfter: cooldown
      });
    }
    const { rows: targetRows } = await query('SELECT * FROM users WHERE id = $1', [targetId]);
    const target = targetRows[0];
    if (!target || target.banned) {
      return socket.emit('call:unavailable', { error: 'This person is not available.' });
    }
    if (await blockedBetween(user.id, targetId)) {
      return socket.emit('call:unavailable', { error: 'You cannot call this person.' });
    }
    // Calling someone is a DM. If no conversation exists yet the recipient's
    // privacy setting decides; an existing channel keeps the rules it already
    // has (blockedBetween above).
    const { rows: existingDmRows } = await query(
      'SELECT 1 FROM dm_channels WHERE user_a = $1 AND user_b = $2',
      [Math.min(user.id, targetId), Math.max(user.id, targetId)]
    );
    const existingDm = existingDmRows[0];
    if (!existingDm && !(await canInitiateDm(user.id, target))) {
      return socket.emit('call:unavailable', { error: 'You cannot call this person.' });
    }
    const targetOnline = isOnline(targetId);
    if (callForUser(user.id)) {
      return socket.emit('call:unavailable', { error: 'You are already in a call.' });
    }
    // A ringing callee already has an offer in front of them; two rings at once
    // would race for the same answer.
    if (callForUser(targetId) || rings.has(targetId)) {
      return socket.emit('call:unavailable', { error: 'They are on another call.' });
    }

    const callId = crypto.randomUUID();
    const startedAt = Date.now();
    const call = {
      id: callId,
      callerId: user.id,
      calleeId: targetId,
      callerSocketId: socket.id,
      calleeSocketId: null,
      state: 'ringing',
      startedAt,
      timer: null
    };
    call.timer = setTimeout(() => endCall(call, 'unanswered'), RING_TIMEOUT);
    sessions.set(callId, call);
    // The caller is committed to the attempt; the callee is only ringing, so they
    // are not marked busy until call:accept.
    userCalls.set(user.id, callId);
    rings.set(targetId, callId);

    socket.emit('call:ringing', {
      callId,
      peer: publicUser(target),
      startedAt
    });
    io.to(`user:${targetId}`).emit('call:incoming', {
      callId,
      from: publicUser(user),
      startedAt
    });

    if (!targetOnline) {
      const { rows: dmRows } = await query(
        `SELECT * FROM dm_channels
         WHERE (user_a = $1 AND user_b = $2) OR (user_a = $3 AND user_b = $4)`,
        [
          Math.min(user.id, targetId),
          Math.max(user.id, targetId),
          Math.min(user.id, targetId),
          Math.max(user.id, targetId)
        ]
      );
      const dm = dmRows[0];
      sendToUsers(
        [targetId],
        {
          title: `Incoming call from ${user.display_name || user.username}`,
          body: 'Open Cordia to answer.',
          tag: `call-${callId}`,
          scopeType: dm ? 'dm' : 'call',
          scopeId: dm ? dm.id : null,
          url: '/'
        },
        { urgency: 'high', TTL: 45 }
      ).catch((error) => console.error('[push] call push failed:', error.message));
    }
  });

  socket.on('call:accept', async (data) => {
    const call = sessions.get(data?.callId);
    if (!call || call.calleeId !== user.id || call.state !== 'ringing') return;
    if (rings.get(user.id) === call.id) rings.delete(user.id);
    userCalls.set(user.id, call.id);
    call.state = 'active';
    call.calleeSocketId = socket.id;
    call.answeredAt = Date.now();
    clearTimeout(call.timer);
    call.timer = null;

    socket.to(`user:${user.id}`).emit('call:handled', { callId: call.id });
    io.to(`user:${call.callerId}`).emit('call:accepted', {
      callId: call.id,
      peer: publicUser(user),
      startedAt: call.answeredAt
    });

    // Answered calls get a start line; ringing that never connects is already
    // covered by the missed/declined/cancelled summary, so it is not repeated.
    await addCallLine(io, await callDm(call), call.callerId, `${await callName(call.callerId)} started a call.`);
  });

  socket.on('call:decline', async (data) => {
    const call = sessions.get(data?.callId);
    if (!call || call.calleeId !== user.id) return;
    await endCall(call, 'declined');
  });

  socket.on('call:end', async (data) => {
    const call = sessions.get(data?.callId);
    if (!call) return;
    if (call.callerId !== user.id && call.calleeId !== user.id) return;
    await endCall(call, call.state === 'ringing' ? 'cancelled' : 'ended');
  });

  socket.on('call:signal', (data) => {
    const call = sessions.get(data?.callId);
    if (!call || call.state !== 'active') return;
    let targetSocketId = null;
    if (socket.id === call.callerSocketId) targetSocketId = call.calleeSocketId;
    else if (socket.id === call.calleeSocketId) targetSocketId = call.callerSocketId;
    if (!targetSocketId) return;
    io.to(targetSocketId).emit('call:signal', {
      callId: call.id,
      from: socket.id,
      data: data.data
    });
  });

  const pendingId = rings.get(user.id);
  const pending = pendingId ? sessions.get(pendingId) : null;
  if (pending && pending.calleeId === user.id && pending.state === 'ringing') {
    query('SELECT * FROM users WHERE id = $1', [pending.callerId])
      .then(({ rows }) => {
        const caller = rows[0];
        if (caller) {
          socket.emit('call:incoming', {
            callId: pending.id,
            from: publicUser(caller),
            startedAt: pending.startedAt
          });
        }
      })
      .catch((error) => console.error('[calls] pending call lookup failed:', error.message));
  }

  socket.on('disconnect', async () => {
    const call = callForUser(user.id);
    if (!call) return;
    if (call.callerSocketId !== socket.id && call.calleeSocketId !== socket.id) return;
    await endCall(call, call.state === 'ringing' ? 'cancelled' : 'disconnected');
  });
}

module.exports = { attachCallHandlers };
