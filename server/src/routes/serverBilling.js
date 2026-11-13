'use strict';

const express = require('express');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query, withTransaction } = require('../pg/pool');
const { authRequired, rateLimit } = require('../auth');
const { getMembership } = require('../permissions');
const { hasServerPermission } = require('../permissions');
const { trim, isHexColor, logAudit, buildServer } = require('../util');

const router = express.Router();
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_PRICE_CENTS = 50;
const MAX_PRICE_CENTS = 500000;
const MAX_TIERS = 10;
const INTERVALS = ['month', 'year'];

const manageLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  message: 'Too many subscription changes. Try again in a minute.'
});

function periodEndFor(interval) {
  return Date.now() + (interval === 'year' ? 365 : 30) * DAY_MS;
}

function serializeTier(row, counts) {
  return {
    id: Number(row.id),
    serverId: Number(row.server_id),
    name: row.name,
    description: row.description || '',
    priceCents: Number(row.price_cents),
    interval: row.interval,
    color: row.color,
    groupId: row.group_id ? Number(row.group_id) : null,
    position: Number(row.position) || 0,
    createdAt: row.created_at,
    subscribers: counts ? Number(counts.get(Number(row.id)) || 0) : undefined
  };
}

function serializeSubscription(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    tierId: Number(row.tier_id),
    status: row.status,
    startedAt: row.started_at,
    currentPeriodEnd: Number(row.current_period_end),
    cancelAtPeriodEnd: !!row.cancel_at_period_end
  };
}

async function tierCounts(serverId) {
  const { rows } = await query(
    `SELECT tier_id, COUNT(*)::int AS n FROM server_subscriptions
      WHERE server_id = $1 AND status = 'active' GROUP BY tier_id`,
    [Number(serverId)]
  );
  const map = new Map();
  for (const row of rows) map.set(Number(row.tier_id), row.n);
  return map;
}

// Granting is additive on purpose: a subscriber keeps every role they already
// had. Canceling removes only the row this subscription created, which is why
// the id is stored rather than re-derived from the tier.
async function grantTierRole(tier, userId) {
  if (!tier.group_id) return null;
  await query(
    `INSERT INTO server_member_groups (server_id, user_id, group_id, assigned_at)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [Number(tier.server_id), Number(userId), Number(tier.group_id), Date.now()]
  );
  return Number(tier.group_id);
}

async function revokeTierRole(serverId, userId, groupId) {
  if (!groupId) return;
  await query('DELETE FROM server_member_groups WHERE server_id = $1 AND user_id = $2 AND group_id = $3', [
    Number(serverId),
    Number(userId),
    Number(groupId)
  ]);
}

// Any member can read the tiers: a shop nobody can see is not a shop. The
// caller's own subscription rides along so the UI can show Manage instead of
// Subscribe without a second request.
router.get('/servers/:id/tiers', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  const membership = await getMembership(serverId, req.user.id);
  if (!membership) return res.status(403).json({ error: 'You are not a member of this server.' });
  const { rows } = await query(
    'SELECT * FROM server_tiers WHERE server_id = $1 ORDER BY position ASC, id ASC',
    [serverId]
  );
  const counts = await tierCounts(serverId);
  const { rows: mine } = await query(
    'SELECT * FROM server_subscriptions WHERE server_id = $1 AND user_id = $2 AND status = $3',
    [serverId, req.user.id, 'active']
  );
  res.json({
    tiers: rows.map((row) => serializeTier(row, counts)),
    subscription: serializeSubscription(mine[0])
  });
}));

router.get('/servers/:id/tiers/summary', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await hasServerPermission(serverId, req.user.id, 'manageServer', req.user.role))) {
    return res.status(403).json({ error: 'You need the Manage server permission.' });
  }
  const { rows } = await query(
    `SELECT t.id, t.price_cents, t.interval, COUNT(s.id)::int AS subscribers
       FROM server_tiers t
       LEFT JOIN server_subscriptions s
         ON s.tier_id = t.id AND s.status = 'active'
      WHERE t.server_id = $1
      GROUP BY t.id, t.price_cents, t.interval
      ORDER BY t.position ASC, t.id ASC`,
    [serverId]
  );
  let monthlyCents = 0;
  let subscribers = 0;
  const tiers = rows.map((row) => {
    const n = Number(row.subscribers) || 0;
    subscribers += n;
    monthlyCents += (row.interval === 'year' ? Number(row.price_cents) / 12 : Number(row.price_cents)) * n;
    return { tierId: Number(row.id), subscribers: n };
  });
  res.json({ subscribers, monthlyCents: Math.round(monthlyCents), tiers });
}));

function validateTier(body, existing) {
  const name = trim(body.name).slice(0, 40);
  if (name.length < 2) return { error: 'Tier name must be 2-40 characters.' };
  const description = trim(body.description).slice(0, 300);
  const price = Math.round(Number(body.priceCents));
  if (!Number.isInteger(price) || price < MIN_PRICE_CENTS || price > MAX_PRICE_CENTS) {
    return { error: `Price must be between ${MIN_PRICE_CENTS / 100} and ${MAX_PRICE_CENTS / 100}.` };
  }
  const interval = INTERVALS.includes(body.interval) ? body.interval : existing?.interval || 'month';
  const color = isHexColor(body.color) ? body.color : existing?.color || '#f59e0b';
  const groupId = body.groupId === null || body.groupId === undefined
    ? (existing ? existing.group_id : null)
    : Number(body.groupId);
  return { name, description, price, interval, color, groupId };
}

router.post('/servers/:id/tiers', authRequired, manageLimiter, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await hasServerPermission(serverId, req.user.id, 'manageServer', req.user.role))) {
    return res.status(403).json({ error: 'You need the Manage server permission.' });
  }
  const { rows: countRows } = await query(
    'SELECT COUNT(*)::int AS n FROM server_tiers WHERE server_id = $1',
    [serverId]
  );
  if (Number(countRows[0].n) >= MAX_TIERS) {
    return res.status(400).json({ error: `A server can have at most ${MAX_TIERS} tiers.` });
  }
  const draft = validateTier(req.body || {});
  if (draft.error) return res.status(400).json({ error: draft.error });
  if (draft.groupId) {
    const { rows } = await query('SELECT 1 FROM server_groups WHERE id = $1 AND server_id = $2', [
      draft.groupId,
      serverId
    ]);
    if (!rows[0]) return res.status(400).json({ error: 'That role is not in this server.' });
  }
  const { rows: posRows } = await query(
    'SELECT COALESCE(MAX(position), 0) AS position FROM server_tiers WHERE server_id = $1',
    [serverId]
  );
  try {
    await query(
      `INSERT INTO server_tiers (server_id, name, description, price_cents, interval, color, group_id, position, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        serverId,
        draft.name,
        draft.description,
        draft.price,
        draft.interval,
        draft.color,
        draft.groupId,
        Number(posRows[0].position) + 1,
        Date.now()
      ]
    );
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'This server already has a tier with that name.' });
    }
    throw error;
  }
  await logAudit(req.user.id, 'tier.create', 'server', serverId, draft.name);
  const { rows } = await query(
    'SELECT * FROM server_tiers WHERE server_id = $1 ORDER BY position ASC, id ASC',
    [serverId]
  );
  res.status(201).json({ tiers: rows.map((row) => serializeTier(row, new Map())) });
}));

router.patch('/servers/:id/tiers/:tierId', authRequired, manageLimiter, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await hasServerPermission(serverId, req.user.id, 'manageServer', req.user.role))) {
    return res.status(403).json({ error: 'You need the Manage server permission.' });
  }
  const { rows: found } = await query('SELECT * FROM server_tiers WHERE id = $1 AND server_id = $2', [
    Number(req.params.tierId),
    serverId
  ]);
  const existing = found[0];
  if (!existing) return res.status(404).json({ error: 'Tier not found.' });
  const draft = validateTier({ ...existing, ...req.body }, existing);
  if (draft.error) return res.status(400).json({ error: draft.error });
  if (draft.groupId) {
    const { rows } = await query('SELECT 1 FROM server_groups WHERE id = $1 AND server_id = $2', [
      draft.groupId,
      serverId
    ]);
    if (!rows[0]) return res.status(400).json({ error: 'That role is not in this server.' });
  }
  await query(
    `UPDATE server_tiers
        SET name = $1, description = $2, price_cents = $3, interval = $4, color = $5, group_id = $6
      WHERE id = $7`,
    [draft.name, draft.description, draft.price, draft.interval, draft.color, draft.groupId, existing.id]
  );
  const { rows } = await query(
    'SELECT * FROM server_tiers WHERE server_id = $1 ORDER BY position ASC, id ASC',
    [serverId]
  );
  const counts = await tierCounts(serverId);
  res.json({ tiers: rows.map((row) => serializeTier(row, counts)) });
}));

router.delete('/servers/:id/tiers/:tierId', authRequired, manageLimiter, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await hasServerPermission(serverId, req.user.id, 'manageServer', req.user.role))) {
    return res.status(403).json({ error: 'You need the Manage server permission.' });
  }
  await query('DELETE FROM server_tiers WHERE id = $1 AND server_id = $2', [
    Number(req.params.tierId),
    serverId
  ]);
  const { rows } = await query(
    'SELECT * FROM server_tiers WHERE server_id = $1 ORDER BY position ASC, id ASC',
    [serverId]
  );
  res.json({ tiers: rows.map((row) => serializeTier(row, new Map())) });
}));

// Subscribing replaces whatever tier the member already held: one supporter
// subscription per person per server, which is the only rule that keeps the
// granted-role bookkeeping honest.
router.post('/servers/:id/tiers/:tierId/subscribe', authRequired, manageLimiter, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  const membership = await getMembership(serverId, req.user.id);
  if (!membership) return res.status(403).json({ error: 'You are not a member of this server.' });
  const { rows: found } = await query('SELECT * FROM server_tiers WHERE id = $1 AND server_id = $2', [
    Number(req.params.tierId),
    serverId
  ]);
  const tier = found[0];
  if (!tier) return res.status(404).json({ error: 'Tier not found.' });

  const now = Date.now();
  const end = periodEndFor(tier.interval);
  const { rows: current } = await query(
    'SELECT * FROM server_subscriptions WHERE server_id = $1 AND user_id = $2 AND status = $3',
    [serverId, req.user.id, 'active']
  );

  const granted = await withTransaction(async () => {
    if (current[0]) {
      await revokeTierRole(serverId, req.user.id, current[0].granted_group_id);
      await query('DELETE FROM server_subscriptions WHERE id = $1', [current[0].id]);
    }
    const grantedGroupId = await grantTierRole(tier, req.user.id);
    await query(
      `INSERT INTO server_subscriptions
         (tier_id, server_id, user_id, status, provider, granted_group_id, started_at, current_period_end, cancel_at_period_end, updated_at)
       VALUES ($1, $2, $3, 'active', 'mock', $4, $5, $6, false, $5)`,
      [tier.id, serverId, req.user.id, grantedGroupId, now, end]
    );
    return grantedGroupId;
  });

  await query(
    `INSERT INTO billing_events (user_id, kind, amount_cents, currency, payload, created_at)
     VALUES ($1, 'server_subscription_started', $2, 'usd', $3, $4)`,
    [req.user.id, Number(tier.price_cents), { serverId, tierId: Number(tier.id), interval: tier.interval }, now]
  );

  const server = await buildServer(serverId);
  req.app.get('io').to(`server:${serverId}`).emit('server:updated', server);
  const { rows: mine } = await query(
    'SELECT * FROM server_subscriptions WHERE server_id = $1 AND user_id = $2 AND status = $3',
    [serverId, req.user.id, 'active']
  );
  res.status(201).json({
    subscription: serializeSubscription(mine[0]),
    grantedGroupId: granted,
    server
  });
}));

router.delete('/servers/:id/tiers/:tierId/subscribe', authRequired, manageLimiter, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  const { rows } = await query(
    'SELECT * FROM server_subscriptions WHERE server_id = $1 AND user_id = $2 AND tier_id = $3 AND status = $4',
    [serverId, req.user.id, Number(req.params.tierId), 'active']
  );
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'You are not subscribed to that tier.' });
  await withTransaction(async () => {
    await revokeTierRole(serverId, req.user.id, row.granted_group_id);
    await query("UPDATE server_subscriptions SET status = 'canceled', updated_at = $2 WHERE id = $1", [
      row.id,
      Date.now()
    ]);
  });
  const server = await buildServer(serverId);
  req.app.get('io').to(`server:${serverId}`).emit('server:updated', server);
  res.json({ subscription: null, server });
}));

// Called from the housekeeping tick: a mock subscription has no provider to
// renew it, so it lapses at the period end exactly as a canceled one does.
async function expireServerSubscriptions(now = Date.now()) {
  const { rows } = await query(
    `UPDATE server_subscriptions SET status = 'expired', updated_at = $1
      WHERE status = 'active' AND current_period_end <= $1
      RETURNING id, server_id, user_id, granted_group_id`,
    [now]
  );
  for (const row of rows) {
    await revokeTierRole(row.server_id, row.user_id, row.granted_group_id);
  }
  return rows.length;
}

module.exports = router;
module.exports.expireServerSubscriptions = expireServerSubscriptions;
