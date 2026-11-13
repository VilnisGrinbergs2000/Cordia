const express = require('express');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query } = require('../pg/pool');
const { authRequired } = require('../auth');
const {
  trim,
  publicUser,
  meUser,
  isHexColor,
  relationship,
  canInitiateDm,
  canSendFriendRequest,
  canViewProfile,
  mutualFriends,
  THEMES,
  MODES,
  DM_PRIVACY,
  FRIEND_REQUESTS,
  PROFILE_VISIBILITY,
  PRESENCE_VISIBILITY
} = require('../util');
const { badgesFor } = require('../badges');
const { isOnline, isVisibleOnline, setPresenceHidden } = require('../presence');
const { invalidatePrivacy } = require('../privacy');

const router = express.Router();

// Social links and games are user-authored blobs, so both are normalised here
// rather than trusted: a link has to be http(s) with a host, and both lists are
// capped. Anything rejected is dropped instead of failing the whole save - a
// profile editor that refuses to save because one row is malformed is worse
// than one that silently keeps the good rows.
const SOCIAL_PLATFORMS = [
  'website', 'x', 'github', 'gitlab', 'youtube', 'twitch', 'bluesky',
  'mastodon', 'steam', 'spotify', 'itch', 'linkedin'
];
const MAX_SOCIAL_LINKS = 6;
const MAX_GAMES = 8;

function normalizeUrl(value) {
  const raw = trim(value);
  if (!raw || raw.length > 200) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return '';
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return '';
  if (!parsed.hostname.includes('.')) return '';
  return parsed.toString();
}

function normalizeSocialLinks(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const platform = trim(entry.platform).toLowerCase();
    const url = normalizeUrl(entry.url);
    if (!url) continue;
    const key = platform + '|' + url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      platform: SOCIAL_PLATFORMS.includes(platform) ? platform : 'website',
      label: trim(entry.label).slice(0, 24),
      url
    });
    if (out.length >= MAX_SOCIAL_LINKS) break;
  }
  return out;
}

function normalizeGames(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const name = trim(entry.name).slice(0, 48);
    if (name.length < 2) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const hours = Math.max(0, Math.min(100000, Math.round(Number(entry.hours) || 0)));
    out.push({ name, platform: trim(entry.platform).slice(0, 24), hours });
    if (out.length >= MAX_GAMES) break;
  }
  return out;
}

// What a viewer still gets when profile_visibility hides the details: enough
// for an avatar, a name and the action buttons, nothing personal.
function restrictedProfile(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarColor: row.avatar_color,
    avatarUrl: row.avatar_url || '',
    bannerColor: row.banner_color || '',
    statusText: row.status_text || '',
    bio: '',
    socialLinks: [],
    games: [],
    role: row.role || 'user',
    presence: row.presence || 'online',
    online: isVisibleOnline(row.id),
    createdAt: row.created_at
  };
}

router.get('/users/me', authRequired, asyncHandler(async (req, res) => {
  res.json({ user: meUser(req.user), badges: await badgesFor(req.user.id) });
}));

router.get('/users/:id/profile', authRequired, asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [Number(req.params.id)]);
  const target = rows[0];
  if (!target) return res.status(404).json({ error: 'User not found' });

  // profile_visibility decides whether the bio, badges and mutual servers go
  // out at all. Identity and actions stay so the viewer can still
  // block, accept, or add the person.
  const visible = await canViewProfile(req.user.id, target);

  const mutualServers = visible
    ? (
        await query(
          `SELECT s.id, s.name, s.icon_color AS "iconColor", s.icon_url AS "iconUrl" FROM servers s
           JOIN server_members a ON a.server_id = s.id AND a.user_id = $1
           JOIN server_members b ON b.server_id = s.id AND b.user_id = $2
           ORDER BY s.name ASC`,
          [req.user.id, target.id]
        )
      ).rows
    : [];

  const relation = await relationship(req.user.id, target.id);
  const existingDm = (
    await query('SELECT 1 FROM dm_channels WHERE user_a = $1 AND user_b = $2', [
      Math.min(req.user.id, target.id),
      Math.max(req.user.id, target.id)
    ])
  ).rows[0];
  const canMessage =
    req.user.id === target.id ||
    (!['blocked', 'blockedBy'].includes(relation) &&
      (!!existingDm || (await canInitiateDm(req.user.id, target))));

  // A per-server bio is written by the member for one server only, so it is
  // fetched per view rather than carried on the user row. Asking for a server
  // the target is not in is not an error, it just has no bio.
  const serverId = Number(req.query.serverId) || 0;
  let serverBio = '';
  if (visible && serverId) {
    const { rows: bioRows } = await query(
      'SELECT bio FROM server_members WHERE server_id = $1 AND user_id = $2',
      [serverId, target.id]
    );
    serverBio = bioRows[0]?.bio || '';
  }

  // Real counters, not a self-reported badge: messages and voice seconds are
  // already accumulated by the app, and the server count is a COUNT.
  const { rows: statRows } = await query(
    'SELECT COUNT(*)::int AS servers FROM server_members WHERE user_id = $1',
    [target.id]
  );
  const stats = visible
    ? {
        servers: Number(statRows[0]?.servers) || 0,
        messages: Number(target.message_count) || 0,
        voiceSeconds: Number(target.voice_seconds) || 0,
        joinedAt: target.created_at
      }
    : null;

  res.json({
    user: visible ? publicUser(target) : restrictedProfile(target),
    serverBio,
    stats,
    restricted: !visible,
    restrictedReason: visible ? null : target.profile_visibility || 'everyone',
    badges: visible ? await badgesFor(target.id) : [],
    relationship: relation,
    canMessage,
    canRequestFriend: relation === 'none' && (await canSendFriendRequest(req.user.id, target)),
    mutualFriendCount: (await mutualFriends(req.user.id, target.id)).length,
    memberSince: target.created_at,
    mutualServers
  });
}));

router.patch('/users/me', authRequired, asyncHandler(async (req, res) => {
  const updates = {};
  const body = req.body || {};

  if (body.displayName !== undefined) {
    const displayName = trim(body.displayName);
    if (displayName.length < 2 || displayName.length > 32) {
      return res.status(400).json({ error: 'Display name must be 2-32 characters.' });
    }
    updates.display_name = displayName;
  }
  if (body.bio !== undefined) {
    const bio = trim(body.bio);
    if (bio.length > 190) return res.status(400).json({ error: 'Bio must be 190 characters or fewer.' });
    updates.bio = bio;
  }
  if (body.socialLinks !== undefined) {
    const links = normalizeSocialLinks(body.socialLinks);
    if (!links) return res.status(400).json({ error: 'socialLinks must be a list.' });
    updates.social_links = JSON.stringify(links);
  }
  if (body.games !== undefined) {
    const games = normalizeGames(body.games);
    if (!games) return res.status(400).json({ error: 'games must be a list.' });
    updates.games = JSON.stringify(games);
  }
  if (body.statusText !== undefined) {
    const statusText = trim(body.statusText);
    if (statusText.length > 80) return res.status(400).json({ error: 'Status must be 80 characters or fewer.' });
    updates.status_text = statusText;
  }
  if (body.presence !== undefined) {
    if (!['online', 'idle', 'dnd'].includes(body.presence)) {
      return res.status(400).json({ error: 'Invalid presence.' });
    }
    updates.presence = body.presence;
  }
  if (body.avatarColor !== undefined) {
    if (!isHexColor(body.avatarColor)) return res.status(400).json({ error: 'Invalid avatar color.' });
    updates.avatar_color = body.avatarColor;
  }
  if (body.bannerColor !== undefined) {
    if (!isHexColor(body.bannerColor)) return res.status(400).json({ error: 'Invalid banner color.' });
    updates.banner_color = body.bannerColor;
  }
  if (body.avatarUrl !== undefined) {
    const avatarUrl = trim(body.avatarUrl);
    if (avatarUrl && !/^\/uploads\/[a-zA-Z0-9._-]+$/.test(avatarUrl)) {
      return res.status(400).json({ error: 'Invalid avatar image.' });
    }
    updates.avatar_url = avatarUrl;
  }
  if (body.bannerUrl !== undefined) {
    const bannerUrl = trim(body.bannerUrl);
    if (bannerUrl && !/^\/uploads\/[a-zA-Z0-9._-]+$/.test(bannerUrl)) {
      return res.status(400).json({ error: 'Invalid banner image.' });
    }
    updates.banner_url = bannerUrl;
  }
  if (body.theme !== undefined) {
    if (!THEMES.includes(body.theme)) return res.status(400).json({ error: 'Unknown theme.' });
    updates.theme = body.theme;
  }
  if (body.mode !== undefined) {
    if (!MODES.includes(body.mode)) return res.status(400).json({ error: 'Unknown display mode.' });
    updates.mode = body.mode;
  }
  if (body.dmPrivacy !== undefined) {
    if (!DM_PRIVACY.includes(body.dmPrivacy)) return res.status(400).json({ error: 'Invalid message privacy.' });
    updates.dm_privacy = body.dmPrivacy;
  }
  if (body.friendRequests !== undefined) {
    if (!FRIEND_REQUESTS.includes(body.friendRequests)) {
      return res.status(400).json({ error: 'Invalid friend request privacy.' });
    }
    updates.friend_requests = body.friendRequests;
  }
  if (body.profileVisibility !== undefined) {
    if (!PROFILE_VISIBILITY.includes(body.profileVisibility)) {
      return res.status(400).json({ error: 'Invalid profile visibility.' });
    }
    updates.profile_visibility = body.profileVisibility;
  }
  if (body.presenceVisibility !== undefined) {
    if (!PRESENCE_VISIBILITY.includes(body.presenceVisibility)) {
      return res.status(400).json({ error: 'Invalid presence visibility.' });
    }
    updates.presence_visibility = body.presenceVisibility;
  }
  if (body.showTyping !== undefined) {
    updates.show_typing = body.showTyping ? 1 : 0;
  }

  const fields = Object.keys(updates);
  if (fields.length === 0) return res.status(400).json({ error: 'Nothing to update.' });

  // jsonb columns travel as text and are cast here, because node-postgres
  // renders a JS array as a Postgres array literal rather than JSON.
  const JSONB_FIELDS = new Set(['social_links', 'games']);
  const sql = `UPDATE users SET ${fields
    .map((field, index) => `${field} = $${index + 1}${JSONB_FIELDS.has(field) ? '::jsonb' : ''}`)
    .join(', ')} WHERE id = $${fields.length + 1}`;
  await query(sql, [...fields.map((field) => updates[field]), req.user.id]);
  invalidatePrivacy(req.user.id);
  const updated = (await query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];

  if (body.presenceVisibility !== undefined) {
    const hidden = updated.presence_visibility === 'nobody';
    setPresenceHidden(updated.id, hidden);
    // Everyone gets the new answer immediately; an invisible user never
    // announces themselves online.
    if (hidden || isOnline(updated.id)) {
      req.app.get('io').emit('presence:update', { userId: updated.id, online: !hidden });
    }
  }

  req.app.get('io').emit('user:updated', publicUser(updated));
  res.json({ user: meUser(updated), badges: await badgesFor(updated.id) });
}));

// ── Private notes ───────────────────────────────────────────────────────────
// A note is written by the viewer about someone else and is never returned to
// anyone but its author. No read-access check beyond "both users exist": a note
// is useful precisely for people you may have blocked.

router.get('/users/:id/note', authRequired, asyncHandler(async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'Invalid user.' });
  }
  const { rows } = await query('SELECT note, updated_at FROM user_notes WHERE owner_id = $1 AND target_id = $2', [
    req.user.id,
    targetId
  ]);
  res.json({ note: rows[0]?.note || '', updatedAt: rows[0]?.updated_at || null });
}));

router.put('/users/:id/note', authRequired, asyncHandler(async (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isInteger(targetId) || targetId <= 0 || targetId === req.user.id) {
    return res.status(400).json({ error: 'Invalid user.' });
  }
  const note = trim(req.body.note).slice(0, 500);
  const now = Date.now();
  if (!note) {
    await query('DELETE FROM user_notes WHERE owner_id = $1 AND target_id = $2', [req.user.id, targetId]);
    return res.json({ note: '', updatedAt: null });
  }
  await query(
    `INSERT INTO user_notes (owner_id, target_id, note, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (owner_id, target_id)
     DO UPDATE SET note = EXCLUDED.note, updated_at = EXCLUDED.updated_at`,
    [req.user.id, targetId, note, now]
  );
  res.json({ note, updatedAt: now });
}));

module.exports = router;
