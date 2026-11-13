const jwt = require('jsonwebtoken');
require('./pg/env');
const { query } = require('./pg/pool');
const { secret, cookieName, sessionDays } = require('./config');
const { botFromTokenAsync, checkBotRate } = require('./botToken');
const rateStore = require('./rateStore');

function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), ver: Number(user.token_version) || 0 },
    secret,
    { expiresIn: `${sessionDays}d` }
  );
}

function readCookie(header, name) {
  if (!header) return null;
  const parts = header.split(';');
  for (const part of parts) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return null;
}

function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  if (req.cookies && req.cookies[cookieName]) return req.cookies[cookieName];
  return readCookie(req.headers.cookie, cookieName);
}

async function findUserById(id) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [Number(id)]);
  return rows[0] || null;
}

// Single lookup path for both HTTP auth and the socket handshake. There is no
// synchronous variant left: every caller awaits this one.
async function userFromTokenAsync(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, secret);
    const user = await findUserById(Number(payload.sub));
    if (!user) return null;
    if (Number(payload.ver || 0) !== (Number(user.token_version) || 0)) return null;
    return user;
  } catch {
    return null;
  }
}

// Express 4 does not catch rejected promises: an awaited lookup that throws has
// to be forwarded to next(err) by hand or the request hangs.
async function authRequired(req, res, next) {
  try {
    // Bots authenticate with "Authorization: Bot <token>" and never with a
    // cookie, so a stolen browser session can't be replayed as an application.
    const header = req.headers.authorization || '';
    if (header.startsWith('Bot ')) {
      const bot = await botFromTokenAsync(header.slice(4));
      if (!bot) return res.status(401).json({ error: 'Invalid bot token' });
      const rate = await checkBotRate(bot.application.id);
      if (rate.blocked) {
        res.set('Retry-After', String(Math.ceil(rate.retryAfter / 1000)));
        return res.status(429).json({ code: 'BOT_RATE_LIMIT', error: 'Slow down for a moment.' });
      }
      req.user = bot.user;
      req.bot = bot.application;
      return next();
    }
    const user = await userFromTokenAsync(extractToken(req));
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    if (user.banned) return res.status(403).json({ error: 'This account has been suspended' });
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

function adminRequired(req, res, next) {
  authRequired(req, res, (error) => {
    if (error) return next(error);
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    next();
  });
}

// A cookie that is not marked Secure can be replayed over plain HTTP, so the
// flag follows the request rather than NODE_ENV: HTTPS (direct or via a trusted
// proxy) and production both get it. Local http:// development keeps working.
function isSecureRequest(res) {
  if (process.env.NODE_ENV === 'production') return true;
  const req = res.req;
  if (!req) return false;
  if (req.secure) return true;
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return forwarded === 'https';
}

function setSessionCookie(res, token) {
  res.cookie(cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(res),
    maxAge: sessionDays * 24 * 60 * 60 * 1000,
    path: '/'
  });
}

function clearSessionCookie(res) {
  res.clearCookie(cookieName, { path: '/' });
}

// Express matches routes case-insensitively, so "/API/auth/login" reached the
// login handler while carrying a different bucket key than "/api/auth/login".
// Normalising the path (and dropping the query) keeps one route on one budget.
function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

function defaultKey(req) {
  return `${req.ip}:${normalizeKey(req.originalUrl || req.url || '')}`;
}

function rateLimit({
  windowMs = 60_000,
  max = 30,
  message = 'Too many requests, slow down.',
  key: keyFor,
  // Auth routes want failed sign-ins counted and successful ones not, otherwise
  // a busy account locks itself out just by being used.
  onlyFailures = false
} = {}) {
  return async (req, res, next) => {
    const key = normalizeKey(keyFor ? keyFor(req) : defaultKey(req));
    let entry;
    try {
      entry = await rateStore.hit(key, windowMs, max);
    } catch (error) {
      // A limiter that cannot reach the database must not take the API with it.
      // Allowing the request is the failure mode that keeps the product working;
      // the alternative is 500s during exactly the incident where you need it up.
      console.error('[rate] counter unavailable:', error.message);
      return next();
    }
    if (entry.blocked) {
      res.set('Retry-After', String(Math.ceil(entry.retryAfter / 1000)));
      return res.status(429).json({ error: message });
    }
    if (onlyFailures) {
      // A successful sign-in should not spend the budget: refund the hit.
      res.on('finish', () => {
        if (res.statusCode >= 400) return;
        rateStore.refund(key).catch(() => {});
      });
    }
    next();
  };
}

module.exports = {
  signToken,
  authRequired,
  adminRequired,
  setSessionCookie,
  clearSessionCookie,
  userFromTokenAsync,
  findUserById,
  readCookie,
  extractToken,
  rateLimit
};
