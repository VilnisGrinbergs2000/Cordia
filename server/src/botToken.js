'use strict';
// Bot token minting and lookup, kept out of bots.js so auth.js can require it
// without pulling in the gateway (and util.js with it) during module load.
require('./pg/env');
const crypto = require('node:crypto');
const { query } = require('./pg/pool');
const rateStore = require('./rateStore');

const TOKEN_PREFIX = 'cordia_';

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function mintToken() {
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token), hint: token.slice(-6) };
}

// Resolves "Bot <token>" to the application and its bot user. Tokens are stored
// as sha256, so a database read never yields a usable secret.
async function botFromTokenAsync(token) {
  const raw = String(token || '').trim();
  if (!raw.startsWith(TOKEN_PREFIX)) return null;
  const { rows } = await query(
    `SELECT a.*, u.id AS bot_user_id, u.username, u.display_name, u.avatar_color, u.avatar_url,
            u.banned, u.role, u.is_bot
       FROM applications a
       JOIN users u ON u.id = a.bot_user_id
      WHERE a.token_hash = $1`,
    [hashToken(raw)]
  );
  const row = rows[0];
  if (!row || row.banned) return null;
  return {
    application: row,
    user: {
      id: Number(row.bot_user_id),
      username: row.username,
      display_name: row.display_name,
      avatar_color: row.avatar_color,
      avatar_url: row.avatar_url || '',
      role: row.role,
      is_bot: 1
    }
  };
}

// Bots get their own budget instead of sharing the human one: a bot answering
// twenty interactions a second is normal, a person doing it is not. The counter
// is shared, so two processes cannot each give the same bot the full budget.
const RATE_WINDOW_MS = 10_000;
const RATE_LIMIT = 120;

async function checkBotRate(applicationId) {
  const result = await rateStore.hit('bot:' + Number(applicationId), RATE_WINDOW_MS, RATE_LIMIT);
  return { blocked: result.blocked, retryAfter: result.retryAfter };
}

module.exports = { TOKEN_PREFIX, hashToken, mintToken, botFromTokenAsync, checkBotRate };
