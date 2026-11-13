require('./pg/env');
const { withTransaction } = require('./pg/pool');

// A custom link is a slug a person types: short, lowercase, no punctuation.
const MIN_LENGTH = 3;
const MAX_LENGTH = 32;
const DAY_MS = 24 * 60 * 60 * 1000;

// Two clocks gate the feature. A brand-new account with a brand-new server is
// exactly the shape of a spam run: create, claim a memorable link, paste it
// everywhere. Seven days for the account and three for the server means a
// throwaway has to survive long enough to be reported, and a server has to
// outlive its first burst of invite spam. Both are policy, not security - the
// real gate is the unique index in claimInviteCode.
const ACCOUNT_MIN_AGE_DAYS = 7;
const SERVER_MIN_AGE_DAYS = 3;

// Paths the site already owns. A code cannot shadow them today (links live
// under /invite/), but reserving the names keeps a future cordia.ext.io/<code>
// vanity route possible and stops "api" or "admin" from looking official.
const RESERVED_CODES = new Set([
  'api',
  'app',
  'admin',
  'invite',
  'invites',
  'uploads',
  'assets',
  'static',
  'health',
  'socket',
  'login',
  'register',
  'logout',
  'settings',
  'join',
  'new',
  'about',
  'pricing',
  'terms',
  'privacy',
  'status',
  'downloads',
  'docs',
  'support',
  'help',
  'www',
  'cdn',
  'mail',
  'system',
  'root',
  'cordia'
]);

// One canonical form for storage and lookup. A pasted full link is accepted
// because that is what people copy out of the invite box.
function normalizeInviteCode(raw) {
  let value = String(raw || '').trim().toLowerCase();
  const fromUrl = value.match(/\/invite\/([^/?#]+)\/?$/);
  if (fromUrl) value = fromUrl[1];
  value = value.replace(/^[@:#]+/, '');
  value = value.replace(/[^a-z0-9-]+/g, '-');
  value = value.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return value.slice(0, MAX_LENGTH);
}

function validateInviteCode(code) {
  if (code.length < MIN_LENGTH) {
    return { ok: false, error: 'Custom links need at least 3 characters.' };
  }
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(code)) {
    return {
      ok: false,
      error: 'Use letters, numbers and dashes, starting and ending with a letter or number.'
    };
  }
  if (!/[a-z]/.test(code)) {
    return { ok: false, error: 'Include at least one letter so the link is readable.' };
  }
  if (RESERVED_CODES.has(code)) {
    return { ok: false, error: 'That word is reserved. Try another.' };
  }
  return { ok: true };
}

// The answer the settings card renders, so the rule is visible before somebody
// types a link and gets a 403. Admins skip the clocks: they already have every
// other switch.
function vanityStatus({ accountCreatedAt, accountRole, serverCreatedAt, now = Date.now() }) {
  if (accountRole === 'admin') {
    return {
      allowed: true,
      unlockAt: null,
      accountDays: ACCOUNT_MIN_AGE_DAYS,
      serverDays: SERVER_MIN_AGE_DAYS
    };
  }
  const accountReadyAt = (Number(accountCreatedAt) || 0) + ACCOUNT_MIN_AGE_DAYS * DAY_MS;
  const serverReadyAt = (Number(serverCreatedAt) || 0) + SERVER_MIN_AGE_DAYS * DAY_MS;
  const unlockAt = Math.max(accountReadyAt, serverReadyAt);
  return {
    allowed: unlockAt <= now,
    unlockAt,
    accountDays: ACCOUNT_MIN_AGE_DAYS,
    serverDays: SERVER_MIN_AGE_DAYS
  };
}

// Claiming a code is one transaction with an advisory lock on the slug, so the
// cross-table check and the write cannot interleave with another claim. The
// unique indexes are still the final word: if they fire, somebody won the race
// and this returns false instead of a 500.
async function claimInviteCode(serverId, code) {
  try {
    return await withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['cordia:invite:' + code]);
      const taken = await client.query(
        `SELECT 1 FROM servers WHERE lower(invite_code) = $1 AND id <> $2
         UNION ALL
         SELECT 1 FROM server_invites WHERE lower(code) = $1
         LIMIT 1`,
        [code, Number(serverId)]
      );
      if (taken.rows[0]) return false;
      await client.query(
        'UPDATE servers SET invite_code = $1, invite_code_custom = 1 WHERE id = $2',
        [code, Number(serverId)]
      );
      return true;
    });
  } catch (error) {
    if (error.code === '23505') return false;
    throw error;
  }
}

module.exports = {
  MIN_LENGTH,
  MAX_LENGTH,
  ACCOUNT_MIN_AGE_DAYS,
  SERVER_MIN_AGE_DAYS,
  RESERVED_CODES,
  normalizeInviteCode,
  validateInviteCode,
  vanityStatus,
  claimInviteCode
};
