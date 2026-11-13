const express = require('express');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query } = require('../pg/pool');
const { authRequired } = require('../auth');
const { getPublicKey, isPushEndpointAllowed, ready, sendToUsers } = require('../push');

const router = express.Router();

function validSubscription(value) {
  if (!value || typeof value !== 'object') return false;
  if (typeof value.endpoint !== 'string' || value.endpoint.length > 2048) return false;
  if (!isPushEndpointAllowed(value.endpoint)) return false;
  if (!value.keys || typeof value.keys !== 'object') return false;
  const { p256dh, auth } = value.keys;
  return (
    typeof p256dh === 'string' &&
    p256dh.length >= 40 &&
    p256dh.length <= 200 &&
    typeof auth === 'string' &&
    auth.length >= 8 &&
    auth.length <= 100
  );
}

router.get('/push/public-key', authRequired, asyncHandler(async (req, res) => {
  const publicKey = getPublicKey();
  if (!publicKey) return res.status(503).json({ error: 'Push notifications are not configured.' });
  res.json({ publicKey });
}));

router.post('/push/subscribe', authRequired, asyncHandler(async (req, res) => {
  if (!ready) return res.status(503).json({ error: 'Push notifications are not configured.' });
  if (!validSubscription(req.body)) {
    return res.status(400).json({ error: 'Invalid push subscription.' });
  }
  const { endpoint, keys } = req.body;
  await query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id,
       p256dh = excluded.p256dh,
       auth = excluded.auth`,
    [req.user.id, endpoint, keys.p256dh, keys.auth, Date.now()]
  );
  res.json({ ok: true });
}));

router.post('/push/unsubscribe', authRequired, asyncHandler(async (req, res) => {
  const endpoint = String(req.body.endpoint || '');
  if (!endpoint) return res.status(400).json({ error: 'Missing push endpoint.' });
  await query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [
    req.user.id,
    endpoint
  ]);
  res.json({ ok: true });
}));

router.post('/push/test', authRequired, asyncHandler(async (req, res) => {
  if (!ready) return res.status(503).json({ error: 'Push notifications are not configured.' });
  const sent = await sendToUsers([req.user.id], {
    title: 'Cordia background notifications are on',
    body: 'You will get alerts here when Cordia is closed.',
    tag: 'cordia-test',
    url: '/'
  });
  res.json({ ok: true, sent });
}));

module.exports = router;
