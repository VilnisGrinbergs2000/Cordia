const express = require('express');
const crypto = require('node:crypto');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query, withTransaction } = require('../pg/pool');
const { authRequired, rateLimit } = require('../auth');
const { keyHistory, recordKeyEvent } = require('../e2eeKeys');
const { validateBackup } = require('../e2eeBackup');
const { meUser, publicUser, canInitiateDm, trim } = require('../util');

const router = express.Router();

const MAX_PUBLIC_KEY = 2048;
const MAX_SIGNING_KEY = 2048;
const MAX_PREKEYS = 200;
const MAX_PREKEY_ID = 2147483647;

// Fetching a bundle burns one of the target's one-time prekeys, so the endpoint
// is a resource the caller does not own: keep it to a rate a real client (which
// only fetches when it starts a conversation) can never hit.
const bundleLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  message: 'Too many key requests. Try again in a minute.',
  key: (req) => `e2ee-bundle:${req.user.id}`
});

function validatePublicKey(value) {
  const publicKey = trim(value);
  if (!publicKey || publicKey.length > MAX_PUBLIC_KEY) {
    return { error: 'Invalid encryption public key.' };
  }
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(publicKey, 'base64'),
      format: 'der',
      type: 'spki'
    });
    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (key.asymmetricKeyType !== 'ec' || (curve !== 'prime256v1' && curve !== 'P-256')) {
      return { error: 'Encryption public key must use ECDH P-256.' };
    }
    return { publicKey };
  } catch {
    return { error: 'Invalid encryption public key.' };
  }
}

function validateSigningKey(value) {
  const publicKey = trim(value);
  if (!publicKey || publicKey.length > MAX_SIGNING_KEY) {
    return { error: 'Invalid signing public key.' };
  }
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(publicKey, 'base64'),
      format: 'der',
      type: 'spki'
    });
    const curve = key.asymmetricKeyDetails?.namedCurve;
    if (key.asymmetricKeyType !== 'ec' || (curve !== 'prime256v1' && curve !== 'P-256')) {
      return { error: 'Signing public key must use ECDSA P-256.' };
    }
    return { publicKey };
  } catch {
    return { error: 'Invalid signing public key.' };
  }
}

function signedPrekeyMessage(userId, prekeyId, publicKey) {
  return `cordia-signed-prekey-v1|${Number(userId)}|${Number(prekeyId)}|${publicKey}`;
}

function validateSignedPrekey(value, userId, signingPublicKey) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'Invalid signed prekey.' };
  }
  const id = Number(value.id);
  if (!Number.isInteger(id) || id < 1 || id > MAX_PREKEY_ID) {
    return { error: 'Invalid signed prekey.' };
  }
  const publicKey = validatePublicKey(value.publicKey);
  if (publicKey.error) return { error: 'Invalid signed prekey.' };
  const signature = trim(value.signature);
  if (!signature || signature.length > 512) {
    return { error: 'Invalid signed prekey signature.' };
  }
  try {
    const signatureBytes = Buffer.from(signature, 'base64');
    if (signatureBytes.length !== 64) {
      return { error: 'Invalid signed prekey signature.' };
    }
    const key = crypto.createPublicKey({
      key: Buffer.from(signingPublicKey, 'base64'),
      format: 'der',
      type: 'spki'
    });
    const valid = crypto.verify(
      'sha256',
      Buffer.from(signedPrekeyMessage(userId, id, publicKey.publicKey)),
      { key, dsaEncoding: 'ieee-p1363' },
      signatureBytes
    );
    if (!valid) return { error: 'Invalid signed prekey signature.' };
  } catch {
    return { error: 'Invalid signed prekey signature.' };
  }
  return {
    signedPrekey: {
      id,
      publicKey: publicKey.publicKey,
      signature,
      createdAt: Number(value.createdAt) || Date.now()
    }
  };
}

function validatePrekeyUpload(body, userId) {
  const signing = validateSigningKey(body.signingPublicKey);
  if (signing.error) return { error: signing.error };
  const signed = validateSignedPrekey(body.signedPrekey, userId, signing.publicKey);
  if (signed.error) return { error: signed.error };
  const input = Array.isArray(body.oneTimePrekeys) ? body.oneTimePrekeys : [];
  if (input.length > MAX_PREKEYS) {
    return { error: 'Too many one-time prekeys.' };
  }
  const seen = new Set();
  const oneTimePrekeys = [];
  for (const entry of input) {
    const id = Number(entry?.id);
    if (!Number.isInteger(id) || id < 1 || id > MAX_PREKEY_ID || seen.has(id)) {
      return { error: 'Invalid one-time prekey.' };
    }
    const publicKey = validatePublicKey(entry.publicKey);
    if (publicKey.error) return { error: 'Invalid one-time prekey.' };
    seen.add(id);
    oneTimePrekeys.push({ id, publicKey: publicKey.publicKey });
  }
  return {
    signingPublicKey: signing.publicKey,
    signedPrekey: signed.signedPrekey,
    oneTimePrekeys
  };
}

function validateRecoveryVerifier(value) {
  const verifier = trim(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(verifier)) {
    return { error: 'Invalid recovery verifier.' };
  }
  return { verifier };
}

async function invalidatePasswordResets(userId) {
  await query(
    'UPDATE password_resets SET used_at = $1 WHERE user_id = $2 AND used_at IS NULL',
    [Date.now(), userId]
  );
}

async function e2eeMetadata(user) {
  const { rows } = await query(
    'SELECT COUNT(*) AS count FROM e2ee_one_time_prekeys WHERE user_id = $1 AND used = 0',
    [user.id]
  );
  const prekeyCount = rows[0].count;
  return {
    publicKey: user.e2ee_public_key || '',
    keyVersion: Number(user.e2ee_key_version) || 0,
    keyCreatedAt: user.e2ee_key_created_at || null,
    signingPublicKey: user.e2ee_signing_public_key || '',
    signedPrekeyId: Number(user.e2ee_signed_prekey_id) || 0,
    signedPrekeyCreatedAt: user.e2ee_signed_prekey_created_at || null,
    prekeyCount: Number(prekeyCount) || 0,
    ratchetReady: !!user.e2ee_public_key && !!user.e2ee_signing_public_key && !!user.e2ee_signed_prekey_id,
    ready: !!user.e2ee_public_key && !!user.e2ee_key_backup,
    recoveryReady: !!user.e2ee_recovery_backup,
    recoveryResettable: !!user.e2ee_recovery_backup && !!user.e2ee_recovery_verifier,
    recoveryCreatedAt: user.e2ee_recovery_created_at || null
  };
}

router.get('/e2ee/me', authRequired, asyncHandler(async (req, res) => {
  res.json({
    e2ee: {
      ...(await e2eeMetadata(req.user)),
      keyBackup: req.user.e2ee_key_backup || '',
      recoveryBackup: req.user.e2ee_recovery_backup || ''
    }
  });
}));


router.get('/e2ee/prekeys', authRequired, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT prekey_id AS id, public_key AS "publicKey"
     FROM e2ee_one_time_prekeys
     WHERE user_id = $1 AND used = 0 ORDER BY prekey_id`,
    [req.user.id]
  );
  const prekeys = rows.map((prekey) => ({
    id: Number(prekey.id),
    publicKey: prekey.publicKey
  }));
  res.json({
    signedPrekeyId: Number(req.user.e2ee_signed_prekey_id) || 0,
    prekeys
  });
}));

router.post('/e2ee/prekeys', authRequired, asyncHandler(async (req, res) => {
  if (!req.user.e2ee_public_key || !req.user.e2ee_key_backup) {
    return res.status(409).json({
      code: 'E2EE_NOT_SETUP',
      error: 'Set up encrypted messages first.'
    });
  }
  const upload = validatePrekeyUpload(req.body || {}, req.user.id);
  if (upload.error) return res.status(400).json({ error: upload.error });

  await withTransaction(async () => {
    if (
      req.user.e2ee_signed_prekey_id &&
      Number(req.user.e2ee_signed_prekey_id) !== upload.signedPrekey.id
    ) {
      await query('DELETE FROM e2ee_one_time_prekeys WHERE user_id = $1 AND used = 0', [
        req.user.id
      ]);
    }
    await query(
      `UPDATE users SET e2ee_signing_public_key = $1, e2ee_signed_prekey_id = $2,
         e2ee_signed_prekey_public = $3, e2ee_signed_prekey_signature = $4,
         e2ee_signed_prekey_created_at = $5 WHERE id = $6`,
      [
        upload.signingPublicKey,
        upload.signedPrekey.id,
        upload.signedPrekey.publicKey,
        upload.signedPrekey.signature,
        upload.signedPrekey.createdAt,
        req.user.id
      ]
    );
    const now = Date.now();
    for (const prekey of upload.oneTimePrekeys) {
      await query(
        `INSERT INTO e2ee_one_time_prekeys
         (user_id, prekey_id, public_key, used, created_at) VALUES ($1, $2, $3, 0, $4)
         ON CONFLICT (user_id, prekey_id) DO NOTHING`,
        [req.user.id, prekey.id, prekey.publicKey, now]
      );
    }
  });

  const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const updated = rows[0];
  res.json({ ok: true, e2ee: await e2eeMetadata(updated) });
}));

router.get('/e2ee/users/:id/bundle', authRequired, bundleLimiter, asyncHandler(async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isInteger(targetId) || targetId < 1) {
    return res.status(400).json({ error: 'Invalid user.' });
  }
  const { rows: targetRows } = await query(
    `SELECT id, dm_privacy, e2ee_public_key, e2ee_key_version, e2ee_signing_public_key,
       e2ee_signed_prekey_id, e2ee_signed_prekey_public,
       e2ee_signed_prekey_signature, e2ee_signed_prekey_created_at
     FROM users WHERE id = $1`,
    [targetId]
  );
  const target = targetRows[0];
  if (!target) return res.status(404).json({ error: 'User not found.' });
  // A bundle is only useful to someone who can actually message this person.
  // Without this check any account could walk the user ids and burn every
  // one-time prekey in the database.
  const { rows: dmRows } = await query(
    'SELECT 1 FROM dm_channels WHERE user_a = $1 AND user_b = $2',
    [Math.min(req.user.id, targetId), Math.max(req.user.id, targetId)]
  );
  const existingDm = dmRows[0];
  if (!existingDm && !(await canInitiateDm(req.user.id, target))) {
    return res.status(403).json({
      code: 'DM_PRIVACY',
      error: 'This person only accepts messages from friends. Add them as a friend first.'
    });
  }
  if (
    !target.e2ee_public_key ||
    !target.e2ee_signing_public_key ||
    !target.e2ee_signed_prekey_id ||
    !target.e2ee_signed_prekey_public ||
    !target.e2ee_signed_prekey_signature
  ) {
    return res.status(409).json({
      code: 'E2EE_BUNDLE_NOT_READY',
      error: 'This contact has not published forward-secret prekeys yet.'
    });
  }

  let oneTimePrekey = null;
  await withTransaction(async () => {
    const { rows } = await query(
      `SELECT prekey_id AS id, public_key AS "publicKey"
       FROM e2ee_one_time_prekeys
       WHERE user_id = $1 AND used = 0 ORDER BY prekey_id LIMIT 1`,
      [targetId]
    );
    oneTimePrekey = rows[0];
    if (oneTimePrekey) {
      await query(
        'UPDATE e2ee_one_time_prekeys SET used = 1 WHERE user_id = $1 AND prekey_id = $2',
        [targetId, oneTimePrekey.id]
      );
    }
  });

  res.json({
    bundle: {
      userId: target.id,
      identityPublicKey: target.e2ee_public_key,
      identityKeyVersion: Number(target.e2ee_key_version) || 0,
      signingPublicKey: target.e2ee_signing_public_key,
      signedPrekey: {
        id: Number(target.e2ee_signed_prekey_id),
        publicKey: target.e2ee_signed_prekey_public,
        signature: target.e2ee_signed_prekey_signature,
        createdAt: target.e2ee_signed_prekey_created_at
      },
      oneTimePrekey: oneTimePrekey
        ? { id: Number(oneTimePrekey.id), publicKey: oneTimePrekey.publicKey }
        : null
    }
  });
}));

router.post('/e2ee/setup', authRequired, asyncHandler(async (req, res) => {
  const publicKey = validatePublicKey(req.body.publicKey);
  if (publicKey.error) return res.status(400).json({ error: publicKey.error });
  const backup = validateBackup(req.body.keyBackup);
  if (backup.error) return res.status(400).json({ error: backup.error });

  if (req.user.e2ee_public_key && req.user.e2ee_public_key !== publicKey.publicKey) {
    return res.status(409).json({
      code: 'E2EE_EXISTS',
      error: 'Encryption keys already exist for this account.'
    });
  }

  const now = Date.now();
  const hadKey = !!req.user.e2ee_public_key;
  const keyVersion = Math.max(1, Number(req.user.e2ee_key_version) || 1);
  const keyCreatedAt = req.user.e2ee_key_created_at || now;
  await query(
    `UPDATE users SET e2ee_public_key = $1, e2ee_key_backup = $2,
       e2ee_key_version = $3, e2ee_key_created_at = $4 WHERE id = $5`,
    [publicKey.publicKey, backup.backup, keyVersion, keyCreatedAt, req.user.id]
  );
  if (!hadKey) {
    await recordKeyEvent(req.user.id, {
      keyVersion,
      publicKey: publicKey.publicKey,
      eventType: 'setup',
      createdAt: keyCreatedAt
    });
  }

  const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const updated = rows[0];
  req.app.get('io').emit('user:updated', publicUser(updated));
  res.status(201).json({ e2ee: await e2eeMetadata(updated), user: meUser(updated) });
}));

router.put('/e2ee/backup', authRequired, asyncHandler(async (req, res) => {
  if (!req.user.e2ee_public_key) {
    return res.status(409).json({
      code: 'E2EE_NOT_SETUP',
      error: 'Set up encrypted messages first.'
    });
  }
  const backup = validateBackup(req.body.keyBackup);
  if (backup.error) return res.status(400).json({ error: backup.error });

  await query('UPDATE users SET e2ee_key_backup = $1 WHERE id = $2', [
    backup.backup,
    req.user.id
  ]);
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const updated = rows[0];
  res.json({ ok: true, e2ee: await e2eeMetadata(updated) });
}));

router.post('/e2ee/recovery', authRequired, asyncHandler(async (req, res) => {
  if (!req.user.e2ee_public_key || !req.user.e2ee_key_backup) {
    return res.status(409).json({
      code: 'E2EE_NOT_SETUP',
      error: 'Set up encrypted messages first.'
    });
  }
  const backup = validateBackup(req.body.keyBackup);
  if (backup.error) return res.status(400).json({ error: backup.error });
  const verifier = validateRecoveryVerifier(req.body.recoveryVerifier);
  if (verifier.error) return res.status(400).json({ error: verifier.error });

  const now = Date.now();
  await query(
    `UPDATE users SET e2ee_recovery_backup = $1, e2ee_recovery_verifier = $2,
       e2ee_recovery_created_at = $3 WHERE id = $4`,
    [backup.backup, verifier.verifier, now, req.user.id]
  );
  await invalidatePasswordResets(req.user.id);
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const updated = rows[0];
  req.app.get('io').emit('user:updated', publicUser(updated));
  res.status(201).json({ e2ee: await e2eeMetadata(updated), user: meUser(updated) });
}));

router.delete('/e2ee/recovery', authRequired, asyncHandler(async (req, res) => {
  if (!req.user.e2ee_recovery_backup) {
    return res.status(409).json({
      code: 'E2EE_NO_RECOVERY',
      error: 'No recovery code is configured.'
    });
  }
  await query(
    `UPDATE users SET e2ee_recovery_backup = '', e2ee_recovery_verifier = '',
       e2ee_recovery_created_at = NULL WHERE id = $1`,
    [req.user.id]
  );
  await invalidatePasswordResets(req.user.id);
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const updated = rows[0];
  req.app.get('io').emit('user:updated', publicUser(updated));
  res.json({ ok: true, e2ee: await e2eeMetadata(updated), user: meUser(updated) });
}));

router.post('/e2ee/rotate', authRequired, asyncHandler(async (req, res) => {
  if (!req.user.e2ee_public_key || !req.user.e2ee_key_backup) {
    return res.status(409).json({
      code: 'E2EE_NOT_SETUP',
      error: 'Set up encrypted messages first.'
    });
  }
  if (req.body.confirm !== 'ROTATE') {
    return res.status(400).json({
      code: 'E2EE_CONFIRM_REQUIRED',
      error: 'Key rotation requires explicit confirmation.'
    });
  }
  const publicKey = validatePublicKey(req.body.publicKey);
  if (publicKey.error) return res.status(400).json({ error: publicKey.error });
  const backup = validateBackup(req.body.keyBackup);
  if (backup.error) return res.status(400).json({ error: backup.error });
  if (publicKey.publicKey === req.user.e2ee_public_key) {
    return res.status(409).json({
      code: 'E2EE_SAME_KEY',
      error: 'That encryption key is already active.'
    });
  }

  const keyVersion = Math.max(1, Number(req.user.e2ee_key_version) || 1) + 1;
  const now = Date.now();
  await query(
    `UPDATE users SET e2ee_public_key = $1, e2ee_key_backup = $2,
       e2ee_key_version = $3, e2ee_key_created_at = $4,
       e2ee_recovery_backup = '', e2ee_recovery_verifier = '',
       e2ee_recovery_created_at = NULL,
       e2ee_signing_public_key = '', e2ee_signed_prekey_id = NULL,
       e2ee_signed_prekey_public = '', e2ee_signed_prekey_signature = '',
       e2ee_signed_prekey_created_at = NULL
     WHERE id = $5`,
    [publicKey.publicKey, backup.backup, keyVersion, now, req.user.id]
  );
  await invalidatePasswordResets(req.user.id);
  await query('DELETE FROM e2ee_one_time_prekeys WHERE user_id = $1', [req.user.id]);
  await recordKeyEvent(req.user.id, {
    keyVersion,
    publicKey: publicKey.publicKey,
    eventType: 'rotate',
    createdAt: now
  });
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const updated = rows[0];
  req.app.get('io').emit('user:updated', publicUser(updated));
  res.json({ e2ee: await e2eeMetadata(updated), user: meUser(updated) });
}));

router.get('/e2ee/users/:id/key-history', authRequired, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT id, e2ee_public_key, e2ee_key_version, e2ee_key_created_at
     FROM users WHERE id = $1`,
    [Number(req.params.id)]
  );
  const target = rows[0];
  if (!target) return res.status(404).json({ error: 'User not found' });
  const events = (await keyHistory(target.id, 50)).reverse();
  res.json({
    userId: target.id,
    publicKey: target.e2ee_public_key || '',
    keyVersion: Number(target.e2ee_key_version) || 0,
    keyCreatedAt: target.e2ee_key_created_at || null,
    headHash: events[events.length - 1]?.eventHash || '',
    events
  });
}));

router.get('/e2ee/users/:id/key', authRequired, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT id, e2ee_public_key, e2ee_key_version, e2ee_key_created_at
     FROM users WHERE id = $1`,
    [Number(req.params.id)]
  );
  const target = rows[0];
  if (!target) return res.status(404).json({ error: 'User not found' });
  res.json({
    userId: target.id,
    publicKey: target.e2ee_public_key || '',
    keyVersion: Number(target.e2ee_key_version) || 0,
    keyCreatedAt: target.e2ee_key_created_at || null,
    ready: !!target.e2ee_public_key
  });
}));

module.exports = router;
