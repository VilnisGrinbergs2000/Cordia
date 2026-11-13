'use strict';

const crypto = require('node:crypto');
const { query } = require('./pg/pool');
const { queueMail, publicOrigin } = require('./mail');
const templates = require('./mailTemplates');

// How long a link stays useful. Verification is generous because people open
// mail on a different device hours later; a reset link is short because it is
// the one token that can take an account away from its owner.
const VERIFY_TTL_MS = 24 * 3_600_000;
const RESET_TTL_MS = 60 * 60_000;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// A link in an email has to be absolute, and behind a TLS proxy the request's
// own idea of its origin is http://127.0.0.1:3002. PUBLIC_URL is the only
// source that is right from outside.
function originFor(req) {
  const configured = publicOrigin();
  if (configured) return configured;
  if (!req) return '';
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

async function issueToken({ userId, purpose, email, ttlMs }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  // One live link per purpose: a second request must invalidate the first, or
  // an attacker who stole an old message keeps a working key.
  await query('UPDATE email_tokens SET used_at = $1 WHERE user_id = $2 AND purpose = $3 AND used_at IS NULL', [
    now,
    userId,
    purpose
  ]);
  await query('DELETE FROM email_tokens WHERE expires_at <= $1', [now]);
  await query(
    `INSERT INTO email_tokens (user_id, purpose, token_hash, email, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, purpose, hashToken(token), String(email || '').toLowerCase(), now, now + ttlMs]
  );
  return token;
}

async function findToken(token, purpose) {
  const value = String(token || '').trim();
  if (!value || value.length > 200) return null;
  const row = (
    await query('SELECT * FROM email_tokens WHERE token_hash = $1 AND purpose = $2', [hashToken(value), purpose])
  ).rows[0];
  if (!row) return null;
  if (row.used_at || Number(row.expires_at) <= Date.now()) return null;
  return row;
}

async function burnToken(id) {
  await query('UPDATE email_tokens SET used_at = $1 WHERE id = $2', [Date.now(), id]);
}

async function sendVerification(req, user, { quiet = false } = {}) {
  if (!user || !user.email) return { sent: false };
  if (user.email_verified) return { sent: false, alreadyVerified: true };
  const origin = originFor(req);
  if (!origin) {
    console.error('[email] no origin: set PUBLIC_URL so verification links resolve');
    return { sent: false };
  }
  const token = await issueToken({
    userId: user.id,
    purpose: 'verify',
    email: user.email,
    ttlMs: VERIFY_TTL_MS
  });
  const url = `${origin}/api/email/verify?token=${encodeURIComponent(token)}`;
  const message = templates.verification({
    username: user.username,
    url,
    minutes: Math.round(VERIFY_TTL_MS / 60_000),
    origin
  });
  await queueMail({
    to: user.email,
    userId: user.id,
    kind: 'verify',
    subject: message.subject,
    html: message.html,
    text: message.text,
    headers: 'Auto-Submitted: auto-generated'
  });
  if (!quiet) console.log('[email] verification queued for', user.username);
  return { sent: true };
}

async function sendPasswordReset(req, user) {
  if (!user || !user.email) return { sent: false };
  const origin = originFor(req);
  if (!origin) return { sent: false };
  const token = await issueToken({
    userId: user.id,
    purpose: 'reset',
    email: user.email,
    ttlMs: RESET_TTL_MS
  });
  const url = `${origin}/api/email/reset?token=${encodeURIComponent(token)}`;
  const message = templates.passwordReset({
    username: user.username,
    url,
    minutes: Math.round(RESET_TTL_MS / 60_000),
    origin
  });
  await queueMail({
    to: user.email,
    userId: user.id,
    kind: 'reset',
    subject: message.subject,
    html: message.html,
    text: message.text,
    headers: 'Auto-Submitted: auto-generated'
  });
  return { sent: true };
}

async function sendSuspension(req, user, reason) {
  if (!user || !user.email) return { sent: false };
  const origin = originFor(req);
  const message = templates.suspension({
    username: user.username,
    reason: String(reason || '').slice(0, 1000),
    url: origin ? `${origin}/guidelines` : '',
    origin
  });
  await queueMail({
    to: user.email,
    userId: user.id,
    kind: 'suspension',
    subject: message.subject,
    html: message.html,
    text: message.text,
    headers: 'Auto-Submitted: auto-generated'
  });
  return { sent: true };
}

module.exports = {
  VERIFY_TTL_MS,
  RESET_TTL_MS,
  hashToken,
  originFor,
  issueToken,
  findToken,
  burnToken,
  sendVerification,
  sendPasswordReset,
  sendSuspension
};
