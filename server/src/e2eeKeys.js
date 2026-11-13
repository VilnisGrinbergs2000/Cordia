const crypto = require('node:crypto');
require('./pg/env');
const { query } = require('./pg/pool');

function keyEventHash({ previousHash, userId, keyVersion, publicKey, eventType, createdAt }) {
  return crypto
    .createHash('sha256')
    .update(
      [
        previousHash || '',
        Number(userId),
        Number(keyVersion),
        publicKey || '',
        eventType || 'setup',
        Number(createdAt)
      ].join('|')
    )
    .digest('hex');
}

async function latestKeyEvent(userId) {
  const { rows } = await query(
    'SELECT * FROM e2ee_key_events WHERE user_id = $1 ORDER BY id DESC LIMIT 1',
    [Number(userId)]
  );
  return rows[0];
}

async function recordKeyEvent(userId, { keyVersion, publicKey, eventType = 'rotate', createdAt = Date.now() }) {
  const previous = await latestKeyEvent(userId);
  const previousHash = previous?.event_hash || '';
  const eventHash = keyEventHash({
    previousHash,
    userId,
    keyVersion,
    publicKey,
    eventType,
    createdAt
  });
  const { rows } = await query(
    `INSERT INTO e2ee_key_events
       (user_id, key_version, public_key, event_type, previous_hash, event_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      Number(userId),
      Number(keyVersion),
      publicKey,
      eventType,
      previousHash,
      eventHash,
      Number(createdAt)
    ]
  );
  return {
    id: Number(rows[0].id),
    userId: Number(userId),
    keyVersion: Number(keyVersion),
    publicKey,
    eventType,
    previousHash,
    eventHash,
    createdAt: Number(createdAt)
  };
}

async function keyHistory(userId, limit = 50) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  const { rows } = await query(
    `SELECT id, user_id AS "userId", key_version AS "keyVersion", public_key AS "publicKey",
       event_type AS "eventType", previous_hash AS "previousHash", event_hash AS "eventHash",
       created_at AS "createdAt"
     FROM e2ee_key_events WHERE user_id = $1 ORDER BY id DESC LIMIT $2`,
    [Number(userId), safeLimit]
  );
  return rows;
}

module.exports = { keyEventHash, latestKeyEvent, recordKeyEvent, keyHistory };
