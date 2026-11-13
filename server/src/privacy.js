'use strict';
// Privacy flags read on hot paths (socket typing, presence). One small query
// per user per TTL instead of a lookup per keystroke, invalidated as soon as
// the user saves their settings.
require('./pg/env');
const { query } = require('./pg/pool');

const TTL_MS = 15000;
const cache = new Map();

const DEFAULTS = Object.freeze({
  dm_privacy: 'friends',
  friend_requests: 'anyone',
  profile_visibility: 'everyone',
  presence_visibility: 'everyone',
  show_typing: 1
});

async function privacyFlags(userId) {
  const id = Number(userId);
  const cached = cache.get(id);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.flags;
  const { rows } = await query(
    `SELECT dm_privacy, friend_requests, profile_visibility, presence_visibility, show_typing
     FROM users WHERE id = $1`,
    [id]
  );
  const flags = rows[0] || DEFAULTS;
  cache.set(id, { flags, at: Date.now() });
  return flags;
}

function invalidatePrivacy(userId) {
  cache.delete(Number(userId));
}

module.exports = { privacyFlags, invalidatePrivacy, PRIVACY_DEFAULTS: DEFAULTS };
