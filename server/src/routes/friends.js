const express = require('express');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query } = require('../pg/pool');
const { authRequired } = require('../auth');
const { trim, publicUser, canSendFriendRequest } = require('../util');

const router = express.Router();

function notify(io, a, b) {
  io.to(`user:${Number(a)}`).to(`user:${Number(b)}`).emit('friends:changed');
}

async function userById(id) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [Number(id)]);
  return rows[0];
}

router.get('/friends', authRequired, asyncHandler(async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM friendships WHERE requester_id = $1 OR addressee_id = $2',
    [req.user.id, req.user.id]
  );

  const friends = [];
  const incoming = [];
  const outgoing = [];
  const blocked = [];

  for (const row of rows) {
    const otherId = row.requester_id === req.user.id ? row.addressee_id : row.requester_id;
    const other = await userById(otherId);
    if (!other) continue;
    const entry = { user: publicUser(other) };
    if (row.blocked_by) {
      if (row.blocked_by === req.user.id) blocked.push(entry);
      continue;
    }
    if (row.status === 'accepted') {
      friends.push({ ...entry, since: row.updated_at });
    } else if (row.status === 'pending') {
      if (row.requester_id === req.user.id) outgoing.push({ ...entry, requestId: row.id, createdAt: row.created_at });
      else incoming.push({ ...entry, requestId: row.id, createdAt: row.created_at });
    }
  }

  friends.sort((a, b) => {
    if (a.user.online !== b.user.online) return a.user.online ? -1 : 1;
    return a.user.displayName.localeCompare(b.user.displayName);
  });
  incoming.sort((a, b) => b.createdAt - a.createdAt);

  res.json({ friends, incoming, outgoing, blocked });
}));

router.post('/friends/requests', authRequired, asyncHandler(async (req, res) => {
  let target = null;
  if (req.body.username) {
    target = (await query('SELECT * FROM users WHERE username = $1', [trim(req.body.username)])).rows[0];
  } else if (req.body.userId) {
    target = await userById(req.body.userId);
  }
  if (!target) return res.status(404).json({ error: 'No user found with that name.' });
  if (target.id === req.user.id || target.banned) {
    return res.status(400).json({ error: 'You cannot send a request to this user.' });
  }

  const existing = (
    await query(
      `SELECT * FROM friendships
       WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $3 AND addressee_id = $4)`,
      [req.user.id, target.id, target.id, req.user.id]
    )
  ).rows[0];

  if (existing) {
    if (existing.blocked_by) return res.status(403).json({ error: 'This user is blocked.' });
    if (existing.status === 'accepted') return res.status(409).json({ error: 'You are already friends.' });
    if (existing.requester_id === req.user.id) return res.status(409).json({ error: 'Request already sent.' });
    await query('UPDATE friendships SET status = $1, updated_at = $2 WHERE id = $3', [
      'accepted',
      Date.now(),
      existing.id
    ]);
    notify(req.app.get('io'), req.user.id, target.id);
    return res.json({ ok: true, status: 'accepted' });
  }

  // The target's policy only gates new requests; accepting one they already
  // sent is handled above and always allowed.
  if (!(await canSendFriendRequest(req.user.id, target))) {
    const policy = target.friend_requests || 'anyone';
    return res.status(403).json({
      code: 'FRIEND_REQUESTS',
      error:
        policy === 'nobody'
          ? 'This person is not accepting friend requests.'
          : 'This person only accepts requests from friends of friends.'
    });
  }

  await query(
    'INSERT INTO friendships (requester_id, addressee_id, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)',
    [req.user.id, target.id, 'pending', Date.now(), Date.now()]
  );
  notify(req.app.get('io'), req.user.id, target.id);
  res.status(201).json({ ok: true, status: 'pending' });
}));

router.post('/friends/requests/:id/accept', authRequired, asyncHandler(async (req, res) => {
  const row = (await query('SELECT * FROM friendships WHERE id = $1', [Number(req.params.id)])).rows[0];
  if (!row || row.addressee_id !== req.user.id) return res.status(404).json({ error: 'Request not found' });
  if (row.blocked_by) return res.status(403).json({ error: 'This request is blocked.' });
  if (row.status !== 'pending') return res.status(400).json({ error: 'This request is no longer pending.' });

  await query('UPDATE friendships SET status = $1, updated_at = $2 WHERE id = $3', [
    'accepted',
    Date.now(),
    row.id
  ]);
  notify(req.app.get('io'), row.requester_id, row.addressee_id);
  res.json({ ok: true });
}));

router.delete('/friends/requests/:id', authRequired, asyncHandler(async (req, res) => {
  const row = (await query('SELECT * FROM friendships WHERE id = $1', [Number(req.params.id)])).rows[0];
  if (!row || (row.requester_id !== req.user.id && row.addressee_id !== req.user.id)) {
    return res.status(404).json({ error: 'Request not found' });
  }
  if (row.status === 'accepted') {
    return res.status(400).json({ error: 'Use the remove friend action instead.' });
  }
  await query('DELETE FROM friendships WHERE id = $1', [row.id]);
  notify(req.app.get('io'), row.requester_id, row.addressee_id);
  res.json({ ok: true });
}));

router.delete('/friends/:userId', authRequired, asyncHandler(async (req, res) => {
  const otherId = Number(req.params.userId);
  const row = (
    await query(
      `SELECT * FROM friendships WHERE status = 'accepted' AND
       ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $3 AND addressee_id = $4))`,
      [req.user.id, otherId, otherId, req.user.id]
    )
  ).rows[0];
  if (!row) return res.status(404).json({ error: 'Friendship not found' });
  await query('DELETE FROM friendships WHERE id = $1', [row.id]);
  notify(req.app.get('io'), req.user.id, otherId);
  res.json({ ok: true });
}));

router.post('/friends/block', authRequired, asyncHandler(async (req, res) => {
  const targetId = Number(req.body.userId);
  if (!targetId || targetId === req.user.id) return res.status(400).json({ error: 'Invalid user.' });
  const target = await userById(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const existing = (
    await query(
      `SELECT * FROM friendships
       WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $3 AND addressee_id = $4)`,
      [req.user.id, targetId, targetId, req.user.id]
    )
  ).rows[0];

  if (existing) {
    await query('UPDATE friendships SET blocked_by = $1, status = $2, updated_at = $3 WHERE id = $4', [
      req.user.id,
      'blocked',
      Date.now(),
      existing.id
    ]);
  } else {
    await query(
      'INSERT INTO friendships (requester_id, addressee_id, status, blocked_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [req.user.id, targetId, 'blocked', req.user.id, Date.now(), Date.now()]
    );
  }
  notify(req.app.get('io'), req.user.id, targetId);
  res.json({ ok: true });
}));

router.delete('/friends/block/:userId', authRequired, asyncHandler(async (req, res) => {
  const targetId = Number(req.params.userId);
  const row = (
    await query(
      `SELECT * FROM friendships WHERE blocked_by = $1 AND
       ((requester_id = $2 AND addressee_id = $3) OR (requester_id = $4 AND addressee_id = $5))`,
      [req.user.id, req.user.id, targetId, targetId, req.user.id]
    )
  ).rows[0];
  if (!row) return res.status(404).json({ error: 'Block not found' });
  await query('DELETE FROM friendships WHERE id = $1', [row.id]);
  notify(req.app.get('io'), req.user.id, targetId);
  res.json({ ok: true });
}));

module.exports = router;
