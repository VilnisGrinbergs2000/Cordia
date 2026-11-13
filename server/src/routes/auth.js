const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query, withTransaction } = require('../pg/pool');
const { signToken, authRequired, setSessionCookie, clearSessionCookie, rateLimit } = require('../auth');
const { validateBackup } = require('../e2eeBackup');
const { issueUploadToken } = require('../uploads');
const { logEvent, logSession } = require('../events');
const { pick, trim, meUser, AVATAR_COLORS, BANNER_COLORS } = require('../util');
const { awardBadge, badgesFor, allBadges } = require('../badges');
const { GUIDELINES_VERSION } = require('../guidelines');
const { sendVerification, sendPasswordReset } = require('../email');

const router = express.Router();
const authLimiter = rateLimit({ windowMs: 60_000, max: 20, message: 'Too many attempts. Try again in a minute.' });
// The per-IP limiter above stops one machine from spraying many accounts. This
// one stops many machines from spraying one account. Failures are counted, not
// successes, so normal use never locks an account out.
const loginAccountLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  message: 'Too many failed sign-ins for this account. Try again in a few minutes.',
  onlyFailures: true,
  key: (req) =>
    `login:${trim(req.body && (req.body.login || req.body.username || req.body.email)).toLowerCase()}`
});
const recoveryLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  message: 'Too many recovery attempts. Try again in a minute.'
});
const RESET_TTL_MS = 10 * 60 * 1000;

function validateUsername(username) {
  return /^[a-zA-Z0-9._-]{3,24}$/.test(username);
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254;
}

async function sessionPayload(req, user, token) {
  const payload = {
    user: meUser(user),
    badges: await badgesFor(user.id),
    // Media elements cannot send headers, so the client needs this to render
    // /uploads assets. It unlocks uploads only.
    uploadToken: issueUploadToken(user.id).token
  };
  if (req.get('X-Cordia-Client') === 'native') payload.token = token;
  return payload;
}

function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function sameHex(left, right) {
  const a = Buffer.from(String(left || ''), 'hex');
  const b = Buffer.from(String(right || ''), 'hex');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function validateRecoveryVerifier(value) {
  const verifier = trim(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(verifier)) {
    return { error: 'Enter your username and recovery code.' };
  }
  return { verifier };
}

function recoveryUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    e2eePublicKey: user.e2ee_public_key || '',
    e2eeKeyVersion: Number(user.e2ee_key_version) || 0
  };
}

router.post('/auth/register', authLimiter, asyncHandler(async (req, res) => {
  const username = trim(req.body.username);
    const email = trim(req.body.email).toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const displayName = trim(req.body.displayName) || username;

    if (!validateUsername(username)) {
      return res.status(400).json({ error: 'Username must be 3-24 characters (letters, numbers, dots, dashes).' });
    }
    if (!validateEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    if (displayName.length < 2 || displayName.length > 32) {
      return res.status(400).json({ error: 'Display name must be 2-32 characters.' });
    }
    // The checkbox is the point, not a formality: the version stored is the one
    // the server was serving when the account was created, so a later change to
    // the text can tell who agreed to what.
    if (req.body.acceptGuidelines !== true) {
      return res.status(400).json({ error: 'You must accept the Community Guidelines to create an account.' });
    }

    // Postgres is case-sensitive and the baseline schema has no UNIQUE on
    // username/email, so the lower() comparison keeps the old COLLATE NOCASE
    // behaviour instead of relying on a constraint that does not exist.
    const existing = (
      await query('SELECT id FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($2)', [
        username,
        email
      ])
    ).rows[0];
    if (existing) return res.status(409).json({ error: 'That username or email is already taken.' });

    // Hashing is deliberately outside the transaction: bcrypt at cost 11 holds a
    // connection for a long time. The count and the insert have to be atomic
    // though, or two simultaneous first registrations both see an empty table
    // and both become admin.
    const passwordHash = bcrypt.hashSync(password, 11);

    const userId = await withTransaction(async () => {
      const count = Number((await query('SELECT COUNT(*) AS c FROM users')).rows[0].c);
      const role = count === 0 ? 'admin' : 'user';
      const inserted = await query(
        `INSERT INTO users (username, email, display_name, password_hash, role, avatar_color, banner_color, created_at, guidelines_version, guidelines_accepted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          username,
          email,
          displayName,
          passwordHash,
          role,
          pick(AVATAR_COLORS),
          pick(BANNER_COLORS),
          Date.now(),
          GUIDELINES_VERSION,
          Date.now()
        ]
      );
      const id = Number(inserted.rows[0].id);
      if (count === 0) await awardBadge(id, 'founder');
      if (count < 50) await awardBadge(id, 'pioneer');
      return id;
    });

    const user = (await query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
    logEvent('user_created', { userId });
    // Best effort: a mail server that is down must never cost someone their
    // account. The address stays unverified and the settings page can resend.
    await sendVerification(req, user, { quiet: true }).catch((error) =>
      console.error('[auth] verification send failed', error.message)
    );
    const token = signToken(user);
    setSessionCookie(res, token);
    req.app.get('io').emit('user:new', meUser(user));

    res.status(201).json(await sessionPayload(req, user, token));
}));

router.post('/auth/login', authLimiter, loginAccountLimiter, asyncHandler(async (req, res) => {
  const login = trim(req.body.login || req.body.username || req.body.email);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!login || !password) return res.status(400).json({ error: 'Enter your username and password.' });

  const user = (
    await query('SELECT * FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($1)', [login])
  ).rows[0];
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  if (user.banned) return res.status(403).json({ error: 'This account has been suspended.' });

  const token = signToken(user);
  setSessionCookie(res, token);
  res.json(await sessionPayload(req, user, token));
}));

// Confirming an address is a nudge, not a gate: people can use Cordia with an
// unconfirmed email. Three requests per quarter hour covers a typo and still
// stops one account from being used to post mail at a stranger.
const verifyResendLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 3,
  message: 'A confirmation email was sent recently. Check your inbox before asking again.'
});
const passwordRequestLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 5,
  message: 'Too many reset requests. Try again in a few minutes.'
});

router.post('/auth/verify/resend', authRequired, verifyResendLimiter, asyncHandler(async (req, res) => {
  const user = (await query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (user.email_verified) return res.json({ ok: true, alreadyVerified: true });
  const result = await sendVerification(req, user);
  if (!result.sent) {
    return res.status(503).json({ error: 'Could not send the email right now. Try again shortly.' });
  }
  res.json({ ok: true });
}));

// The answer is the same whether or not the account exists. A different reply
// for "no such user" turns this endpoint into a list of who has an account here,
// and the address it is asked about is exactly the one an attacker wants.
router.post('/auth/password/request', authLimiter, passwordRequestLimiter, asyncHandler(async (req, res) => {
  const login = trim(req.body.login || req.body.email || req.body.username);
  const generic = { ok: true };
  if (!login) return res.json(generic);
  const user = (
    await query('SELECT * FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($1)', [login])
  ).rows[0];
  if (user && !user.banned && user.email) {
    await sendPasswordReset(req, user).catch((error) =>
      console.error('[auth] reset send failed', error.message)
    );
  }
  res.json(generic);
}));

router.post('/auth/recovery/verify', recoveryLimiter, asyncHandler(async (req, res) => {
    const login = trim(req.body.login || req.body.username || req.body.email);
    const verifier = validateRecoveryVerifier(req.body.verifier);
    if (!login || verifier.error) {
      return res.status(400).json({ error: 'Enter your username and recovery code.' });
    }

    const user = (
      await query('SELECT * FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($1)', [login])
    ).rows[0];
    if (
      !user ||
      user.banned ||
      !user.e2ee_recovery_backup ||
      !user.e2ee_recovery_verifier ||
      !sameHex(user.e2ee_recovery_verifier, verifier.verifier)
    ) {
      return res.status(401).json({ error: 'Invalid username or recovery code.' });
    }

    const now = Date.now();
    await query('DELETE FROM password_resets WHERE expires_at <= $1 OR used_at IS NOT NULL', [now]);
    await query('UPDATE password_resets SET used_at = $1 WHERE user_id = $2 AND used_at IS NULL', [
      now,
      user.id
    ]);
    const resetToken = crypto.randomBytes(32).toString('base64url');
    await query(
      `INSERT INTO password_resets (user_id, token_hash, created_at, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [user.id, hashResetToken(resetToken), now, now + RESET_TTL_MS]
    );

    res.json({
      resetToken,
      recoveryBackup: user.e2ee_recovery_backup,
      user: recoveryUser(user)
    });
}));

router.post('/auth/recovery/complete', recoveryLimiter, asyncHandler(async (req, res) => {
    const resetToken = trim(req.body.resetToken);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!resetToken || resetToken.length > 128) {
      return res.status(400).json({ error: 'Recovery session is invalid or expired.' });
    }
    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    const backup = validateBackup(req.body.keyBackup);
    if (backup.error) return res.status(400).json({ error: backup.error });
    const recoveryBackup = validateBackup(req.body.recoveryBackup);
    if (recoveryBackup.error) return res.status(400).json({ error: recoveryBackup.error });
    const verifier = validateRecoveryVerifier(req.body.recoveryVerifier);
    if (verifier.error) return res.status(400).json({ error: verifier.error });

    const tokenHash = hashResetToken(resetToken);
    const now = Date.now();
    const reset = (await query('SELECT * FROM password_resets WHERE token_hash = $1', [tokenHash])).rows[0];
    if (!reset || reset.used_at || Number(reset.expires_at) <= now) {
      return res.status(401).json({ error: 'Recovery session is invalid or expired.' });
    }
    const user = (await query('SELECT * FROM users WHERE id = $1', [reset.user_id])).rows[0];
    if (!user || user.banned) {
      return res.status(401).json({ error: 'Recovery session is invalid or expired.' });
    }

    const passwordHash = bcrypt.hashSync(password, 11);
    await withTransaction(async () => {
      await query(
        `UPDATE users SET password_hash = $1, e2ee_key_backup = $2,
           e2ee_recovery_backup = $3, e2ee_recovery_verifier = $4,
           e2ee_recovery_created_at = $5, token_version = token_version + 1
         WHERE id = $6`,
        [passwordHash, backup.backup, recoveryBackup.backup, verifier.verifier, now, user.id]
      );
      await query('UPDATE password_resets SET used_at = $1 WHERE user_id = $2 AND used_at IS NULL', [
        now,
        user.id
      ]);
    });

    const updated = (await query('SELECT * FROM users WHERE id = $1', [user.id])).rows[0];
    const token = signToken(updated);
    setSessionCookie(res, token);
    const io = req.app.get('io');
    if (io) io.in(`user:${user.id}`).disconnectSockets(true);
    res.json(await sessionPayload(req, updated, token));
}));

router.post('/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/auth/me', authRequired, asyncHandler(async (req, res) => {
  // Fire-and-forget: the response never waits on analytics.
  logSession(req.user.id);
  res.json({
    user: meUser(req.user),
    badges: await badgesFor(req.user.id),
    uploadToken: issueUploadToken(req.user.id).token
  });
}));

router.get('/badges', (req, res) => {
  res.json({ badges: allBadges() });
});

module.exports = router;
