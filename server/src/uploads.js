const crypto = require('node:crypto');
const { secret } = require('./config');

// /uploads used to be a public static mount: every attachment, avatar and server
// icon was readable by anyone holding the URL, forever. <img>, <video> and
// <audio> cannot send an Authorization header, so the client cannot just call
// those routes like the rest of the API. Instead the server mints a scoped,
// expiring token that the client appends to asset URLs. It unlocks /uploads and
// nothing else, so a leaked image URL is not a usable session.
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function signature(userId, expires) {
  return crypto
    .createHmac('sha256', secret)
    .update(`uploads:${userId}:${expires}`)
    .digest('base64url');
}

function issueUploadToken(userId, ttlMs = TOKEN_TTL_MS) {
  const expires = Date.now() + ttlMs;
  return {
    token: `${Number(userId)}.${expires}.${signature(Number(userId), expires)}`,
    expiresAt: expires
  };
}

function verifyUploadToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const userId = Number(parts[0]);
  const expires = Number(parts[1]);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  if (!Number.isSafeInteger(expires) || expires <= Date.now()) return null;
  const given = Buffer.from(parts[2]);
  const expected = Buffer.from(signature(userId, expires));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  return { userId, expires };
}

module.exports = { issueUploadToken, verifyUploadToken, TOKEN_TTL_MS };
