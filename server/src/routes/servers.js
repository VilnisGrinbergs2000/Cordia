const express = require('express');
const multer = require('multer');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query, withTransaction } = require('../pg/pool');
const { authRequired, extractToken, rateLimit, userFromTokenAsync } = require('../auth');
const {
  TransferError,
  exportServer,
  parseImportFiles,
  buildImportPlan,
  publicPlan,
  applyImport
} = require('../serverTransfer');
const { recordServerIconChange } = require('../serverIcons');
const { getMessageRow, serializeMessage } = require('../pg/readModel');
const { logEvent } = require('../events');
const { releaseCascade, channelAndThreadIds } = require('../messageCounters');
const {
  SUGGESTION_LIMIT,
  USER_SUGGESTION_LIMIT,
  listServerIconSuggestions,
  getServerIconSuggestion,
  countServerIconSuggestions,
  countUserIconSuggestions,
  findServerIconSuggestionByUrl,
  createServerIconSuggestion,
  toggleServerIconSuggestionVote,
  removeServerIconSuggestion
} = require('../iconSuggestions');
const {
  trim,
  publicUser,
  getMembership,
  buildServer,
  buildDm,
  uniqueInviteCode,
  sanitizeChannelName,
  isHexColor,
  isImageUpload,
  logAudit,
  blockedBetween,
  deleteUploadIfUnused,
  DISCOVER_CATEGORIES
} = require('../util');
const { emitToServerBots } = require('../bots');
const {
  getServerGroups,
  ensureDefaultGroups,
  normalizePermissions,
  hasServerPermission,
  getHighestGroupPosition,
  canManageGroup,
  canManageMember,
  setMemberGroups,
  nextGroupPosition,
  getChannelOverrides,
  parseChannelPermissionList,
  CHANNEL_PERMISSIONS
} = require('../permissions');
const { DEFAULT_MEMBER_PERMISSIONS } = require('../permissionCatalog');
const { rooms: voiceRooms } = require('../voiceState');
const { buildUnreadState } = require('../attention');
const { getServerTemplate, listServerTemplates } = require('../serverTemplates');
const {
  normalizeInviteCode,
  validateInviteCode,
  vanityStatus,
  claimInviteCode
} = require('../invites');

const router = express.Router();

// withTransaction rolls back by throwing, but a few handlers have to answer a
// conflict from inside one. Throwing this keeps the rollback and lets the
// handler unwrap the response outside the transaction.
class TransactionAbort extends Error {
  constructor(status, body) {
    super('transaction aborted');
    this.status = status;
    this.body = body;
  }
}

const suggestionLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  message: 'Too many icon ideas. Try again in a minute.'
});
const voteLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  message: 'Too many icon votes. Try again in a minute.'
});
// Joining answers 404 for an unknown code and 200 for a real one, so an
// unlimited endpoint is an invite-code oracle. Keyed per user *and* per IP:
// per user stops one account enumerating, per IP stops one host cycling accounts.
const joinLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  message: 'Too many join attempts. Try again in a minute.',
  key: (req) => `join:${req.user ? req.user.id : 'anon'}:${req.ip}`
});
const inviteInfoLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  message: 'Too many invite checks. Try again in a minute.',
  key: (req) => `invite-info:${req.ip}`
});

function inviteCodeFrom(value) {
  const raw = trim(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const match = url.pathname.match(/\/invite\/([^/]+)\/?$/i);
    if (match) return decodeURIComponent(match[1]).toLowerCase();
  } catch {
    // Not a URL; treat it as a bare code for older shared invites.
  }
  return raw.toLowerCase();
}

// A code can come from either the permanent servers.invite_code or a
// server_invites row. Both the preview and the join endpoint resolve through
// here, so a dead link cannot preview as live and then fail on accept.
async function resolveInvite(rawCode) {
  // Every caller may pass a code in any case; folding here means a link shared
  // before the switch to lowercase still opens, and a custom slug typed in caps
  // resolves too.
  const code = String(rawCode || '').trim().toLowerCase();
  const custom = (
    await query(
      `SELECT id, server_id, max_uses, uses, expires_at, revoked_at
         FROM server_invites WHERE lower(code) = $1`,
      [code]
    )
  ).rows[0];
  if (custom) {
    const dead =
      custom.revoked_at ||
      (custom.expires_at && Number(custom.expires_at) <= Date.now()) ||
      (Number(custom.max_uses) > 0 && Number(custom.uses) >= Number(custom.max_uses));
    return dead ? null : { serverId: Number(custom.server_id), inviteId: Number(custom.id) };
  }
  const legacy = (await query('SELECT id FROM servers WHERE lower(invite_code) = $1', [code])).rows[0];
  return legacy ? { serverId: Number(legacy.id), inviteId: null } : null;
}

function inviteStatus(row, now = Date.now()) {
  if (row.revoked_at) return 'revoked';
  if (row.expires_at && Number(row.expires_at) <= now) return 'expired';
  if (Number(row.max_uses) > 0 && Number(row.uses) >= Number(row.max_uses)) return 'spent';
  return 'active';
}

function serializeInvite(row, joined = []) {
  return {
    id: Number(row.id),
    code: row.code,
    uses: Number(row.uses),
    maxUses: Number(row.max_uses),
    expiresAt: row.expires_at ? Number(row.expires_at) : null,
    revokedAt: row.revoked_at ? Number(row.revoked_at) : null,
    createdAt: Number(row.created_at),
    creator: row.creator || '',
    status: inviteStatus(row),
    joinedCount: joined.length,
    // Only the newest few names travel with the list; the count is exact.
    joined: joined.slice(0, 5).map((entry) => ({
      username: entry.username,
      displayName: entry.display_name || entry.username,
      joinedAt: Number(entry.joined_at)
    }))
  };
}

// Files a cascade is about to orphan have to be read before the rows disappear,
// then reclaimed after the transaction commits. deleteUploadIfUnused re-checks
// every reference in the database, so a URL that is still used survives.
async function deleteUploadsAfterCommit(urls) {
  for (const url of new Set((urls || []).filter(Boolean))) await deleteUploadIfUnused(url);
}

async function attachmentUrlsForChannels(channelIds, threadIds = []) {
  const clauses = [];
  const params = [];
  const addClause = (column, ids) => {
    if (!ids.length) return;
    const start = params.length + 1;
    clauses.push(`${column} IN (${ids.map((_, index) => `$${start + index}`).join(',')})`);
    params.push(...ids.map(Number));
  };
  addClause('channel_id', channelIds);
  addClause('thread_id', threadIds);
  if (!clauses.length) return [];
  const { rows } = await query(
    `SELECT attachment_url FROM messages
     WHERE attachment_url IS NOT NULL AND (${clauses.join(' OR ')})`,
    params
  );
  return rows.map((row) => row.attachment_url);
}

function emitSuggestionChange(req, serverId, reason) {
  req.app
    .get('io')
    .to(`server:${serverId}`)
    .emit('server:icon-suggestions-changed', { serverId: Number(serverId), reason });
}

const transferUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) => {
    const name = String(file.originalname || '').toLowerCase();
    if (!name.endsWith('.json')) {
      return cb(new TransferError('Choose JSON export files.'));
    }
    cb(null, true);
  }
});

function receiveTransferFiles(req, res, next) {
  transferUpload.array('files', 8)(req, res, (error) => {
    if (!error) return next();
    if (error instanceof TransferError) {
      return res.status(error.status).json({ error: error.message });
    }
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Each import file must be 20 MB or smaller.' });
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: 'Choose up to 8 JSON files.' });
    }
    if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'Upload JSON files in the "files" field.' });
    }
    return res.status(400).json({ error: error.message || 'Could not read the import files.' });
  });
}

async function canImportServerData(serverId, user) {
  const membership = await getMembership(serverId, user.id);
  if (!membership) return false;
  return membership.role === 'owner' || membership.role === 'admin' || user.role === 'admin';
}

router.get('/bootstrap', authRequired, asyncHandler(async (req, res) => {
  const serverRows = (
    await query(
      `SELECT s.id FROM servers s JOIN server_members sm ON sm.server_id = s.id
       WHERE sm.user_id = $1 ORDER BY s.created_at ASC`,
      [req.user.id]
    )
  ).rows;

  const servers = [];
  for (const row of serverRows) {
    const server = await buildServer(row.id, req.user.id);
    if (server) servers.push(server);
  }

  const dmRows = (
    await query('SELECT * FROM dm_channels WHERE user_a = $1 OR user_b = $2', [
      req.user.id,
      req.user.id
    ])
  ).rows;
  const dms = [];
  for (const dm of dmRows) {
    // A blocked conversation is unreadable anyway; leaving it in the list just
    // offers a door that opens onto an error.
    if (await blockedBetween(req.user.id, dm.user_a === req.user.id ? dm.user_b : dm.user_a)) {
      continue;
    }
    dms.push(await buildDm(dm, req.user.id));
  }
  dms.sort((a, b) => {
    const aTime = a.lastMessage?.createdAt || a.createdAt;
    const bTime = b.lastMessage?.createdAt || b.createdAt;
    return bTime - aTime;
  });

  const users = (
    await query('SELECT * FROM users WHERE id <> $1 ORDER BY lower(display_name) ASC', [
      req.user.id
    ])
  ).rows.map(publicUser);

  res.json({ servers, dms, users, readState: await buildUnreadState(req.user.id) });
}));

router.get('/server-templates', authRequired, (req, res) => {
  res.json({ templates: listServerTemplates() });
});

router.post('/servers', authRequired, asyncHandler(async (req, res) => {
  const name = trim(req.body.name);
  if (name.length < 2 || name.length > 48) {
    return res.status(400).json({ error: 'Server name must be 2-48 characters.' });
  }
  const template = getServerTemplate(trim(req.body.templateId) || 'blank');
  if (!template) {
    return res.status(400).json({ error: 'Choose a valid server template.' });
  }
  const iconUrl = trim(req.body.iconUrl);
  if (iconUrl && !/^\/uploads\/[a-zA-Z0-9._-]+$/.test(iconUrl)) {
    return res.status(400).json({ error: 'Invalid server icon.' });
  }
  if (iconUrl && !isImageUpload(iconUrl)) {
    return res.status(400).json({ error: 'Server icon must be an uploaded image file.' });
  }

  const inviteCode = await uniqueInviteCode();
  const now = Date.now();
  const { serverId, firstChannelId } = await withTransaction(async () => {
    const result = await query(
      `INSERT INTO servers (name, icon_color, icon_url, owner_id, invite_code, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [name, template.color, iconUrl, req.user.id, inviteCode, now]
    );
    const newServerId = Number(result.rows[0].id);

    await query(
      'INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4)',
      [newServerId, req.user.id, 'owner', now]
    );
    await ensureDefaultGroups(newServerId);

    let channelPosition = 0;
    let firstTextChannelId = null;
    for (const [categoryIndex, category] of template.categories.entries()) {
      const categoryResult = await query(
        'INSERT INTO channel_categories (server_id, name, position, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
        [newServerId, category.name, categoryIndex, now]
      );
      const categoryId = Number(categoryResult.rows[0].id);
      for (const channel of category.channels) {
        const channelResult = await query(
          `INSERT INTO channels (server_id, category_id, name, type, position, created_at)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [newServerId, categoryId, channel.name, channel.type, channelPosition, now]
        );
        if (!firstTextChannelId && channel.type === 'text') {
          firstTextChannelId = Number(channelResult.rows[0].id);
        }
        channelPosition += 1;
      }
    }
    return { serverId: newServerId, firstChannelId: firstTextChannelId };
  });

  const server = await buildServer(serverId);
  req.app.get('io').in(`user:${req.user.id}`).socketsJoin(`server:${serverId}`);
  logEvent('server_created', { userId: req.user.id, serverId });
  res.status(201).json({ server, firstChannelId });
}));

router.get('/invites/:code', inviteInfoLimiter, asyncHandler(async (req, res) => {
  const code = trim(req.params.code).toLowerCase();
  const invite = await resolveInvite(code);
  if (!invite) return res.status(404).json({ error: 'Invite link is invalid or expired.' });
  const server = (
    await query(
      `SELECT s.id, s.name, s.description, s.icon_color, s.icon_url,
         (SELECT COUNT(*)::int FROM server_members sm WHERE sm.server_id = s.id) AS member_count
       FROM servers s WHERE s.id = $1`,
      [invite.serverId]
    )
  ).rows[0];
  if (!server) return res.status(404).json({ error: 'Invite link is invalid or expired.' });

  const viewer = await userFromTokenAsync(extractToken(req));
  const alreadyMember = viewer ? !!(await getMembership(server.id, viewer.id)) : false;
  res.json({
    invite: {
      code,
      memberCount: Number(server.member_count) || 0,
      alreadyMember,
      server: {
        id: server.id,
        name: server.name,
        description: server.description || '',
        iconColor: server.icon_color,
        iconUrl: server.icon_url || ''
      }
    }
  });
}));

router.post('/servers/join', authRequired, joinLimiter, asyncHandler(async (req, res) => {
  const inviteCode = inviteCodeFrom(req.body.inviteCode ?? req.body.inviteLink ?? req.body.invite);
  if (!inviteCode) return res.status(400).json({ error: 'Paste an invite link to join.' });
  const invite = await resolveInvite(inviteCode);
  if (!invite) return res.status(404).json({ error: 'Invite link is invalid or expired.' });
  const server = (await query('SELECT * FROM servers WHERE id = $1', [invite.serverId])).rows[0];
  if (!server) return res.status(404).json({ error: 'Invite link is invalid or expired.' });

  const existing = await getMembership(server.id, req.user.id);
  if (existing) return res.json({ server: await buildServer(server.id) });

  const joinedAt = Date.now();
  const claimed = await withTransaction(async () => {
    // Claim a use before inserting the membership. The conditions are repeated
    // here because the link could have expired or run out between resolveInvite
    // and this transaction.
    if (invite.inviteId) {
      const use = await query(
        `UPDATE server_invites SET uses = uses + 1
          WHERE id = $1 AND revoked_at IS NULL
            AND (expires_at IS NULL OR expires_at > $2)
            AND (max_uses = 0 OR uses < max_uses)
          RETURNING id`,
        [invite.inviteId, joinedAt]
      );
      if (!use.rows[0]) return false;
    }
    await query(
      'INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4)',
      [server.id, req.user.id, 'member', joinedAt]
    );
    if (invite.inviteId) {
      await query(
        'INSERT INTO invite_joins (invite_id, user_id, joined_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [invite.inviteId, req.user.id, joinedAt]
      );
    }
    // A new member starts at "now", not at the beginning: with no read_state row
    // every channel's whole history counts as unread. Seeding the newest message
    // id makes only what is posted after joining count.
    await query(
      `INSERT INTO read_states
         (user_id, scope_type, scope_id, last_read_message_id, muted, updated_at)
       SELECT $1, 'channel', c.id,
         COALESCE((SELECT MAX(m.id) FROM messages m WHERE m.channel_id = c.id), 0),
         0, $2
       FROM channels c WHERE c.server_id = $3 AND c.type = 'text'
       ON CONFLICT (user_id, scope_type, scope_id) DO NOTHING`,
      [req.user.id, joinedAt, server.id]
    );
    return true;
  });
  if (!claimed) return res.status(404).json({ error: 'Invite link is invalid or expired.' });

  const joinedServer = await buildServer(server.id);
  const member =
    joinedServer?.members.find((entry) => entry.id === req.user.id) || {
      ...publicUser(req.user),
      serverRole: 'member',
      role: req.user.role,
      groups: [],
      permissions: DEFAULT_MEMBER_PERMISSIONS,
      highestGroupPosition: 0
    };
  const io = req.app.get('io');
  io.in(`user:${req.user.id}`).socketsJoin(`server:${server.id}`);
  // The client that called this route adds the server from the response. The
  // same account's other sessions - the desktop app while you join from a
  // browser - never saw the response and had no reason to refetch, so they only
  // learn about the new server from this event.
  io.to(`user:${req.user.id}`).emit('server:joined', { server: joinedServer });
  io.to(`server:${server.id}`).emit('server:member-joined', { serverId: server.id, member });
  emitToServerBots(io, server.id, 'members', 'MEMBER_JOIN', {
    serverId: Number(server.id),
    user: { id: Number(req.user.id), username: req.user.username, displayName: req.user.display_name }
  });
  await announcePresence(io, server, req.user, 'join');
  logEvent('member_joined', { userId: req.user.id, serverId: server.id });

  res.json({ server: joinedServer });
}));

// Join and leave lines give the timeline something to show and tell everyone
// else who just walked in or out. They go to the server's welcome channel when
// one is set, otherwise the first text channel. System messages are excluded
// from unread counts everywhere, so this cannot manufacture a badge.
const PRESENCE_LINES = {
  join: (name) => `${name} joined the server.`,
  left: (name) => `${name} left the server.`,
  kick: (name) => `${name} was removed from the server.`
};

async function announcePresence(io, server, member, kind) {
  // Servers can switch these off; anything unrecognised is a no-op rather than
  // a crash in the middle of a join or a kick.
  if (!PRESENCE_LINES[kind]) return null;
  if (Number(server.join_messages ?? 1) === 0) return null;
  try {
    const { rows } = await query(
      `SELECT id FROM channels
        WHERE server_id = $1 AND type = 'text'
        ORDER BY (id = $2) DESC, position ASC, id ASC
        LIMIT 1`,
      [server.id, Number(server.welcome_channel_id) || 0]
    );
    const channel = rows[0];
    if (!channel) return null;
    const name = member.display_name || member.username || 'Someone';
    const inserted = await query(
      `INSERT INTO messages (channel_id, user_id, content, system_type, created_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [channel.id, member.id, PRESENCE_LINES[kind](name), kind === 'join' ? 'join' : 'leave', Date.now()]
    );
    const message = await serializeMessage(await getMessageRow(Number(inserted.rows[0].id)), 0);
    io.to(`server:${server.id}`).emit('message:new', message);
    return message;
  } catch (error) {
    // A missing line is cosmetic; it must never fail the join, leave or kick.
    console.error('[servers] presence line failed:', error.message);
    return null;
  }
}

// Only live invites are listed: a revoked, expired, or exhausted row is gone
// from the manager the moment it stops working, which is what the UI promises.
router.get('/servers/:id/invites', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await hasServerPermission(serverId, req.user.id, 'manageServer', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to manage this server." });
  }
  // `includeInactive=1` is the history view: it keeps revoked, expired, and
  // spent links so an admin can see what happened, with the status computed
  // once here instead of in three places in the client.
  const includeInactive = req.query.includeInactive === '1';
  const now = Date.now();
  const rows = (
    await query(
      `SELECT i.id, i.code, i.max_uses, i.uses, i.expires_at, i.revoked_at,
              i.created_at, u.username AS creator
         FROM server_invites i LEFT JOIN users u ON u.id = i.creator_id
        WHERE i.server_id = $1
        ${
          includeInactive
            ? ''
            : `AND i.revoked_at IS NULL
               AND (i.expires_at IS NULL OR i.expires_at > $2)
               AND (i.max_uses = 0 OR i.uses < i.max_uses)`
        }
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT ${includeInactive ? 50 : 25}`,
      includeInactive ? [serverId] : [serverId, now]
    )
  ).rows;

  const ids = rows.map((row) => Number(row.id));
  const joinRows = ids.length
    ? (
        await query(
          `SELECT j.invite_id, j.joined_at, u.username, u.display_name
             FROM invite_joins j JOIN users u ON u.id = j.user_id
            WHERE j.invite_id = ANY($1::bigint[])
            ORDER BY j.joined_at DESC`,
          [ids]
        )
      ).rows
    : [];
  const byInvite = new Map();
  for (const join of joinRows) {
    const key = Number(join.invite_id);
    const list = byInvite.get(key) || [];
    list.push(join);
    byInvite.set(key, list);
  }
  res.json({ invites: rows.map((row) => serializeInvite(row, byInvite.get(Number(row.id)) || [])) });
}));

router.post('/servers/:id/invites', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await hasServerPermission(serverId, req.user.id, 'manageServer', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to manage this server." });
  }
  const maxUses = Math.trunc(Number(req.body.maxUses) || 0);
  const minutes = Math.trunc(Number(req.body.expiresInMinutes) || 0);
  if (maxUses < 0 || maxUses > 100) {
    return res.status(400).json({ error: 'Use limit must be between 0 and 100.' });
  }
  if (minutes < 0 || minutes > 129600) {
    return res.status(400).json({ error: 'Expiry must be between 30 minutes and 90 days.' });
  }
  const code = await uniqueInviteCode();
  const now = Date.now();
  const row = (
    await query(
      `INSERT INTO server_invites
         (server_id, code, creator_id, max_uses, uses, expires_at, created_at)
       VALUES ($1, $2, $3, $4, 0, $5, $6)
       RETURNING id, code, max_uses, uses, expires_at, created_at`,
      [serverId, code, req.user.id, maxUses, minutes ? now + minutes * 60000 : null, now]
    )
  ).rows[0];
  await logAudit(
    req.user.id,
    'invite.create',
    'server',
    serverId,
    `Invite ${code}${maxUses ? ` · ${maxUses} uses` : ''}${minutes ? ` · ${minutes}m` : ''}`
  );
  logEvent('invite_created', { userId: req.user.id, serverId });
  res.status(201).json({ invite: { ...serializeInvite(row), creator: req.user.username || '' } });
}));

router.delete('/invites/:inviteId', authRequired, asyncHandler(async (req, res) => {
  const inviteId = Number(req.params.inviteId);
  if (!Number.isInteger(inviteId) || inviteId <= 0) {
    return res.status(404).json({ error: 'Invite not found.' });
  }
  const row = (
    await query('SELECT id, server_id, code FROM server_invites WHERE id = $1', [inviteId])
  ).rows[0];
  if (!row) return res.status(404).json({ error: 'Invite not found.' });
  if (!(await hasServerPermission(row.server_id, req.user.id, 'manageServer', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to manage this server." });
  }
  await query('UPDATE server_invites SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL', [
    Date.now(),
    inviteId
  ]);
  await logAudit(req.user.id, 'invite.revoke', 'server', row.server_id, `Invite ${row.code}`);
  res.status(204).end();
}));

router.get('/servers/:id', authRequired, asyncHandler(async (req, res) => {
  const membership = await getMembership(req.params.id, req.user.id);
  if (!membership) return res.status(403).json({ error: 'You are not a member of this server' });
  const server = await buildServer(req.params.id, req.user.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  res.json({ server });
}));

router.get('/servers/:id/icon-history', authRequired, asyncHandler(async (req, res) => {
  if (!(await hasServerPermission(req.params.id, req.user.id, 'viewServerSettings', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to view this server's settings." });
  }
  const history = (
    await query(
      `SELECT h.id, h.icon_url AS "iconUrl", h.created_at AS "createdAt", u.username AS "changedBy"
       FROM server_icon_history h
       LEFT JOIN users u ON u.id = h.changed_by
       WHERE h.server_id = $1
       ORDER BY h.created_at DESC, h.id DESC
       LIMIT 12`,
      [Number(req.params.id)]
    )
  ).rows;
  res.json({ history });
}));

router.get('/servers/:id/icon-suggestions', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await getMembership(serverId, req.user.id))) {
    return res.status(403).json({ error: 'You are not a member of this server' });
  }
  res.json({ suggestions: await listServerIconSuggestions(serverId, req.user.id) });
}));

router.post('/servers/:id/icon-suggestions', authRequired, suggestionLimiter, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await getMembership(serverId, req.user.id))) {
    return res.status(403).json({ error: 'You are not a member of this server' });
  }
  const iconUrl = trim(req.body.iconUrl);
  if (!iconUrl || !/^\/uploads\/[a-zA-Z0-9._-]+$/.test(iconUrl)) {
    return res.status(400).json({ error: 'Invalid server icon.' });
  }
  if (!isImageUpload(iconUrl)) {
    return res.status(400).json({ error: 'Server icon must be an uploaded image file.' });
  }
  const currentServer = (await query('SELECT icon_url FROM servers WHERE id = $1', [serverId])).rows[0];
  if (!currentServer) return res.status(404).json({ error: 'Server not found' });
  if (currentServer.icon_url === iconUrl) {
    return res.status(400).json({ error: 'That icon is already the server icon.' });
  }
  if ((await countServerIconSuggestions(serverId)) >= SUGGESTION_LIMIT) {
    return res.status(400).json({
      error: `This server already has ${SUGGESTION_LIMIT} icon ideas. Vote on or remove one first.`
    });
  }
  if ((await countUserIconSuggestions(serverId, req.user.id)) >= USER_SUGGESTION_LIMIT) {
    return res.status(400).json({
      error: `You can have up to ${USER_SUGGESTION_LIMIT} icon ideas per server.`
    });
  }
  if (await findServerIconSuggestionByUrl(serverId, iconUrl)) {
    return res.status(409).json({ error: 'That icon has already been suggested.' });
  }
  const suggestion = await createServerIconSuggestion({
    serverId,
    userId: req.user.id,
    iconUrl
  });
  emitSuggestionChange(req, serverId, 'created');
  res.status(201).json({
    suggestion,
    suggestions: await listServerIconSuggestions(serverId, req.user.id)
  });
}));

router.post(
  '/servers/:id/icon-suggestions/:suggestionId/vote',
  authRequired,
  voteLimiter,
  asyncHandler(async (req, res) => {
    const serverId = Number(req.params.id);
    if (!(await getMembership(serverId, req.user.id))) {
      return res.status(403).json({ error: 'You are not a member of this server' });
    }
    const result = await toggleServerIconSuggestionVote({
      serverId,
      suggestionId: Number(req.params.suggestionId),
      userId: req.user.id
    });
    if (!result) return res.status(404).json({ error: 'Icon suggestion not found' });
    emitSuggestionChange(req, serverId, 'voted');
    res.json({
      voted: result.voted,
      suggestion: result.suggestion,
      suggestions: await listServerIconSuggestions(serverId, req.user.id)
    });
  })
);

router.post(
  '/servers/:id/icon-suggestions/:suggestionId/apply',
  authRequired,
  asyncHandler(async (req, res) => {
    const serverId = Number(req.params.id);
    if (!(await hasServerPermission(serverId, req.user.id, 'manageServer', req.user.role))) {
      return res.status(403).json({ error: "You don't have permission to manage this server." });
    }
    const suggestion = await getServerIconSuggestion(serverId, req.params.suggestionId, req.user.id);
    if (!suggestion) return res.status(404).json({ error: 'Icon suggestion not found' });
    const currentServer = (await query('SELECT * FROM servers WHERE id = $1', [serverId])).rows[0];
    if (!currentServer) return res.status(404).json({ error: 'Server not found' });
    if (currentServer.icon_url === suggestion.iconUrl) {
      return res.status(400).json({ error: 'That icon is already the server icon.' });
    }
    await query('UPDATE servers SET icon_url = $1 WHERE id = $2', [suggestion.iconUrl, serverId]);
    await recordServerIconChange({
      serverId,
      actorId: req.user.id,
      previousIconUrl: currentServer.icon_url,
      nextIconUrl: suggestion.iconUrl,
      serverName: currentServer.name,
      actionDetail: 'Icon applied from suggestion'
    });
    await removeServerIconSuggestion(serverId, suggestion.id);
    const server = await buildServer(serverId);
    req.app.get('io').to(`server:${serverId}`).emit('server:updated', server);
    emitSuggestionChange(req, serverId, 'applied');
    res.json({
      server,
      suggestions: await listServerIconSuggestions(serverId, req.user.id)
    });
  })
);

router.delete(
  '/servers/:id/icon-suggestions/:suggestionId',
  authRequired,
  asyncHandler(async (req, res) => {
    const serverId = Number(req.params.id);
    const suggestion = await getServerIconSuggestion(serverId, req.params.suggestionId, req.user.id);
    if (!suggestion) return res.status(404).json({ error: 'Icon suggestion not found' });
    const canManage = await hasServerPermission(
      serverId,
      req.user.id,
      'manageServer',
      req.user.role
    );
    if (!suggestion.mine && !canManage) {
      return res.status(403).json({ error: "You can't remove this icon suggestion." });
    }
    await removeServerIconSuggestion(serverId, suggestion.id);
    emitSuggestionChange(req, serverId, 'removed');
    res.json({ suggestions: await listServerIconSuggestions(serverId, req.user.id) });
  })
);

router.patch('/servers/:id', authRequired, asyncHandler(async (req, res) => {
  if (!(await hasServerPermission(req.params.id, req.user.id, 'manageServer', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to manage this server." });
  }
  const currentServer = (
    await query('SELECT * FROM servers WHERE id = $1', [Number(req.params.id)])
  ).rows[0];
  if (!currentServer) return res.status(404).json({ error: 'Server not found' });
  const updates = {};
  if (req.body.name !== undefined) {
    const name = trim(req.body.name);
    if (name.length < 2 || name.length > 48) {
      return res.status(400).json({ error: 'Server name must be 2-48 characters.' });
    }
    updates.name = name;
  }
  if (req.body.description !== undefined) {
    const description = trim(req.body.description);
    if (description.length > 280) {
      return res.status(400).json({ error: 'Server description must be 280 characters or fewer.' });
    }
    updates.description = description;
  }
  if (req.body.threadArchiveMinutes !== undefined) {
    const minutes = Number(req.body.threadArchiveMinutes);
    if (![0, 60, 1440, 4320, 10080].includes(minutes)) {
      return res.status(400).json({ error: 'Thread archive window must be 1 hour, 24 hours, 3 days, 1 week, or never.' });
    }
    updates.thread_archive_minutes = minutes;
  }
  if (req.body.allowExternalEmotes !== undefined) {
    const value = req.body.allowExternalEmotes;
    if (value !== true && value !== false && value !== 0 && value !== 1) {
      return res.status(400).json({ error: 'Invalid emote setting.' });
    }
    updates.allow_external_emotes = value === true || value === 1 ? 1 : 0;
  }
  if (req.body.joinMessages !== undefined) {
    const value = req.body.joinMessages;
    if (value !== true && value !== false && value !== 0 && value !== 1) {
      return res.status(400).json({ error: 'Invalid join message setting.' });
    }
    updates.join_messages = value === true || value === 1 ? 1 : 0;
  }
  if (req.body.discoverable !== undefined) {
    const value = req.body.discoverable;
    if (value !== true && value !== false && value !== 0 && value !== 1) {
      return res.status(400).json({ error: 'Invalid discovery setting.' });
    }
    updates.discoverable = value === true || value === 1 ? 1 : 0;
  }
  if (req.body.discoverCategory !== undefined) {
    const category = trim(req.body.discoverCategory);
    if (!DISCOVER_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Choose a valid discovery category.' });
    }
    updates.discover_category = category;
  }
  if (req.body.iconColor !== undefined) {
    if (!isHexColor(req.body.iconColor)) {
      return res.status(400).json({ error: 'Invalid icon color.' });
    }
    updates.icon_color = req.body.iconColor;
  }
  if (req.body.iconUrl !== undefined) {
    const iconUrl = trim(req.body.iconUrl);
    if (iconUrl && !/^\/uploads\/[a-zA-Z0-9._-]+$/.test(iconUrl)) {
      return res.status(400).json({ error: 'Invalid server icon.' });
    }
    if (iconUrl && iconUrl !== currentServer.icon_url && !isImageUpload(iconUrl)) {
      return res.status(400).json({ error: 'Server icon must be an uploaded image file.' });
    }
    updates.icon_url = iconUrl;
  }
  // A banner is the same kind of value as the icon: an /uploads/ path with the
  // empty string meaning "none", checked against the same name pattern and the
  // same image sniffing so a renamed .exe cannot be used as a banner.
  if (req.body.banner !== undefined) {
    const banner = trim(req.body.banner);
    if (banner && !/^\/uploads\/[a-zA-Z0-9._-]+$/.test(banner)) {
      return res.status(400).json({ error: 'Invalid server banner.' });
    }
    if (banner && banner !== currentServer.banner && !isImageUpload(banner)) {
      return res.status(400).json({ error: 'Server banner must be an uploaded image file.' });
    }
    updates.banner = banner;
  }
  if (req.body.welcomeEnabled !== undefined) {
    const value = req.body.welcomeEnabled;
    if (value !== true && value !== false && value !== 0 && value !== 1) {
      return res.status(400).json({ error: 'Invalid welcome setting.' });
    }
    updates.welcome_enabled = value === true || value === 1 ? 1 : 0;
  }
  if (req.body.welcomeChannelId !== undefined) {
    const raw = req.body.welcomeChannelId;
    if (raw === null || raw === '') {
      updates.welcome_channel_id = null;
    } else {
      const channelId = Number(raw);
      if (!Number.isInteger(channelId) || channelId <= 0) {
        return res.status(400).json({ error: 'Invalid welcome channel.' });
      }
      const channel = (await query('SELECT * FROM channels WHERE id = $1', [channelId])).rows[0];
      if (!channel || channel.server_id !== Number(req.params.id)) {
        return res.status(404).json({ error: 'That channel is not in this server.' });
      }
      if (channel.type !== 'text') {
        return res.status(400).json({ error: 'The welcome channel must be a text channel.' });
      }
      updates.welcome_channel_id = channelId;
    }
  }
  if (req.body.welcomeTitle !== undefined) {
    const welcomeTitle = trim(req.body.welcomeTitle);
    if (welcomeTitle.length > 80) {
      return res.status(400).json({ error: 'Welcome title must be 80 characters or fewer.' });
    }
    updates.welcome_title = welcomeTitle;
  }
  if (req.body.welcomeBody !== undefined) {
    const welcomeBody = trim(req.body.welcomeBody);
    if (welcomeBody.length > 1000) {
      return res.status(400).json({ error: 'Welcome message must be 1000 characters or fewer.' });
    }
    updates.welcome_body = welcomeBody;
  }
  // Rules are one per line. A client may send an array or a newline-separated
  // string; both are normalised to the stored form so the two shapes cannot
  // drift apart.
  if (req.body.welcomeRules !== undefined) {
    const raw = req.body.welcomeRules;
    const list = Array.isArray(raw) ? raw : String(raw ?? '').split('\n');
    const rules = list.map((rule) => trim(typeof rule === 'string' ? rule : '')).filter(Boolean);
    if (rules.length > 8) {
      return res.status(400).json({ error: 'A welcome screen can list up to 8 house rules.' });
    }
    if (rules.some((rule) => rule.length > 120)) {
      return res.status(400).json({ error: 'Each house rule must be 120 characters or fewer.' });
    }
    updates.welcome_rules = rules.join('\n');
  }
  const fields = Object.keys(updates);
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });

  const params = fields.map((field) => updates[field]);
  params.push(Number(req.params.id));
  await query(
    `UPDATE servers SET ${fields.map((field, index) => `${field} = $${index + 1}`).join(', ')}
     WHERE id = $${params.length}`,
    params
  );
  if (updates.icon_url !== undefined && updates.icon_url !== currentServer.icon_url) {
    await recordServerIconChange({
      serverId: req.params.id,
      actorId: req.user.id,
      previousIconUrl: currentServer.icon_url,
      nextIconUrl: updates.icon_url,
      serverName: currentServer.name
    });
  }
  // Nothing keeps a reference to a replaced banner (unlike icons, which live on
  // in server_icon_history), so the old file is orphaned unless we reclaim it.
  if (updates.banner !== undefined && currentServer.banner && currentServer.banner !== updates.banner) {
    await deleteUploadIfUnused(currentServer.banner);
  }
  const server = await buildServer(req.params.id);
  req.app.get('io').to(`server:${req.params.id}`).emit('server:updated', server);
  res.json({ server });
}));

// The onboarding screen a member sees once. The body is only served here so
// buildServer stays small; dismissed is per user and stored as a read_states row
// with its own scope type, which keeps it invisible to unread/mention queries
// (they all filter scope_type = 'channel' or 'dm').
// The onboarding checklist is per member, not per browser: dismissing it on a
// laptop should silence it on a phone too.
router.get('/servers/:id/onboarding', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await getMembership(serverId, req.user.id))) {
    return res.status(403).json({ error: 'You are not a member of this server.' });
  }
  const { rows } = await query(
    'SELECT dismissed_at FROM server_onboarding WHERE server_id = $1 AND user_id = $2',
    [serverId, req.user.id]
  );
  res.json({ dismissed: !!rows[0], dismissedAt: rows[0] ? Number(rows[0].dismissed_at) : null });
}));

router.post('/servers/:id/onboarding/dismiss', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await getMembership(serverId, req.user.id))) {
    return res.status(403).json({ error: 'You are not a member of this server.' });
  }
  await query(
    `INSERT INTO server_onboarding (user_id, server_id, dismissed_at) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, server_id) DO UPDATE SET dismissed_at = excluded.dismissed_at`,
    [req.user.id, serverId, Date.now()]
  );
  res.json({ dismissed: true });
}));

// The server's own numbers. The admin funnel answers "is the product working";
// this answers "is my community alive", which is the question owners actually
// ask. The events table only carries server_id for joins and invites, so
// messages and active people come straight from the messages table.
router.get('/servers/:id/insights', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await hasServerPermission(serverId, req.user.id, 'viewServerSettings', req.user.role))) {
    return res.status(403).json({ error: 'You cannot view these insights.' });
  }
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  // The same length again, ending where the current window starts. Every
  // "vs previous" number on the card is one subtraction away from these.
  const previousSince = since - (Date.now() - since);

  const totals = (
    await query(
      `SELECT
         (SELECT COUNT(*)::int FROM server_members
           WHERE server_id = $1 AND joined_at >= $2) AS joins,
         (SELECT COUNT(*)::int FROM server_members
           WHERE server_id = $1 AND joined_at >= $3 AND joined_at < $2) AS joins_prev,
         (SELECT COUNT(*)::int FROM server_invites
           WHERE server_id = $1 AND created_at >= $2) AS invites,
         (SELECT COUNT(*)::int FROM messages m JOIN channels c ON c.id = m.channel_id
           WHERE c.server_id = $1 AND m.created_at >= $2 AND m.system_type IS NULL) AS messages,
         (SELECT COUNT(*)::int FROM messages m JOIN channels c ON c.id = m.channel_id
           WHERE c.server_id = $1 AND m.created_at >= $3 AND m.created_at < $2
             AND m.system_type IS NULL) AS messages_prev,
         (SELECT COUNT(DISTINCT m.user_id)::int FROM messages m JOIN channels c ON c.id = m.channel_id
           WHERE c.server_id = $1 AND m.created_at >= $2 AND m.system_type IS NULL) AS active,
         (SELECT MAX(m.created_at) FROM messages m JOIN channels c ON c.id = m.channel_id
           WHERE c.server_id = $1 AND m.system_type IS NULL) AS last_message_at`,
      [serverId, since, previousSince]
    )
  ).rows[0];

  // One row per day even when nothing happened, so a quiet week looks quiet
  // instead of being interpolated away.
  const daily = (
    await query(
      `WITH span AS (
         SELECT generate_series(
           date_trunc('day', to_timestamp($2 / 1000.0)),
           date_trunc('day', to_timestamp($3 / 1000.0)),
           interval '1 day'
         ) AS day
       )
       SELECT to_char(span.day, 'YYYY-MM-DD') AS day,
         (SELECT COUNT(*)::int FROM server_members sm
           WHERE sm.server_id = $1
             AND date_trunc('day', to_timestamp(sm.joined_at / 1000.0)) = span.day) AS joins,
         (SELECT COUNT(*)::int FROM messages m JOIN channels c ON c.id = m.channel_id
           WHERE c.server_id = $1 AND m.system_type IS NULL
             AND date_trunc('day', to_timestamp(m.created_at / 1000.0)) = span.day) AS messages
       FROM span ORDER BY span.day ASC`,
      [serverId, since, Date.now()]
    )
  ).rows.map((row) => ({
    day: row.day,
    joins: row.joins,
    messages: row.messages
  }));

  // Busiest channels, so "nobody talks here" can be answered with "they talk in #x".
  const channels = (
    await query(
      `SELECT c.id, c.name, COUNT(m.id)::int AS messages, MAX(m.created_at) AS last_at
         FROM channels c JOIN messages m ON m.channel_id = c.id
        WHERE c.server_id = $1 AND m.created_at >= $2 AND m.system_type IS NULL
        GROUP BY c.id, c.name
        ORDER BY messages DESC
        LIMIT 5`,
      [serverId, since]
    )
  ).rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    messages: row.messages,
    lastAt: row.last_at === null ? null : Number(row.last_at)
  }));

  res.json({
    days,
    since,
    joins: totals.joins,
    joinsPrev: totals.joins_prev,
    invites: totals.invites,
    messages: totals.messages,
    messagesPrev: totals.messages_prev,
    active: totals.active,
    lastMessageAt: totals.last_message_at === null ? null : Number(totals.last_message_at),
    daily,
    channels
  });
}));
router.get('/servers/:id/welcome', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  const server = (await query('SELECT * FROM servers WHERE id = $1', [serverId])).rows[0];
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (!(await getMembership(serverId, req.user.id))) {
    return res.status(403).json({ error: 'You are not a member of this server.' });
  }
  const dismissed = !!(
    await query(
      "SELECT 1 FROM read_states WHERE user_id = $1 AND scope_type = 'server_welcome' AND scope_id = $2",
      [req.user.id, serverId]
    )
  ).rows[0];
  res.json({
    enabled: !!server.welcome_enabled,
    channelId: server.welcome_channel_id ?? null,
    title: server.welcome_title || '',
    body: server.welcome_body || '',
    rules: String(server.welcome_rules || '')
      .split('\n')
      .map((rule) => rule.trim())
      .filter(Boolean),
    dismissed
  });
}));

// Dismissing twice is not an error: the ON CONFLICT keeps the call idempotent
// so a client retrying after a dropped response still gets 200.
router.post('/servers/:id/welcome/dismiss', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await query('SELECT 1 FROM servers WHERE id = $1', [serverId])).rows[0]) {
    return res.status(404).json({ error: 'Server not found' });
  }
  if (!(await getMembership(serverId, req.user.id))) {
    return res.status(403).json({ error: 'You are not a member of this server.' });
  }
  await query(
    `INSERT INTO read_states
       (user_id, scope_type, scope_id, last_read_message_id, muted, updated_at)
     VALUES ($1, 'server_welcome', $2, 0, 0, $3)
     ON CONFLICT (user_id, scope_type, scope_id) DO NOTHING`,
    [req.user.id, serverId, Date.now()]
  );
  res.json({ ok: true, dismissed: true });
}));

// Boost tiers, checked from the top down. Stored on the server row so a read
// never has to count rows, and recomputed on every change.
const BOOST_TIERS = [
  { level: 3, boosts: 14 },
  { level: 2, boosts: 7 },
  { level: 1, boosts: 2 }
];

function boostLevelFor(boostCount) {
  const count = Number(boostCount) || 0;
  for (const tier of BOOST_TIERS) {
    if (count >= tier.boosts) return tier.level;
  }
  return 0;
}

// One row per (server, user) lives in read_states - its primary key is
// (user_id, scope_type, scope_id), so a second boost by the same user cannot
// insert a second row and the count cannot double.
async function refreshBoostState(serverId) {
  const id = Number(serverId);
  const boostCount =
    Number(
      (
        await query(
          "SELECT COUNT(*) AS count FROM read_states WHERE scope_type = 'server_boost' AND scope_id = $1",
          [id]
        )
      ).rows[0].count
    ) || 0;
  const boostLevel = boostLevelFor(boostCount);
  await query('UPDATE servers SET boost_count = $1, boost_level = $2 WHERE id = $3', [
    boostCount,
    boostLevel,
    id
  ]);
  return { boostCount, boostLevel };
}

async function handleBoost(req, res) {
  const serverId = Number(req.params.id);
  if (!(await query('SELECT 1 FROM servers WHERE id = $1', [serverId])).rows[0]) {
    return res.status(404).json({ error: 'Server not found' });
  }
  if (!(await getMembership(serverId, req.user.id))) {
    return res.status(403).json({ error: 'You are not a member of this server.' });
  }
  const action = trim(req.body.action);
  if (action !== 'add' && action !== 'remove') {
    return res.status(400).json({ error: "Choose 'add' or 'remove'." });
  }

  // Boosting is a member action; removing someone else's boost is not. A
  // manager can remove any, which is the moderation escape hatch.
  const targetId = req.body.userId === undefined ? req.user.id : Number(req.body.userId);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'Invalid member.' });
  }
  // A boost is an entitlement the boosting account owns, so it can only be given
  // by that account. There is no "boost on behalf of" entitlement in the product,
  // and manageServer must not be able to mint boost_level/emoteCap for free.
  if (action === 'add' && targetId !== req.user.id) {
    return res.status(403).json({ error: 'You can only boost for yourself.' });
  }
  if (targetId !== req.user.id) {
    if (!(await hasServerPermission(serverId, req.user.id, 'manageServer', req.user.role))) {
      return res.status(403).json({ error: "You can only remove your own boost." });
    }
    if (!(await getMembership(serverId, targetId))) {
      return res.status(404).json({ error: 'That user is not a member of this server.' });
    }
  }

  if (action === 'add') {
    await query(
      `INSERT INTO read_states
         (user_id, scope_type, scope_id, last_read_message_id, muted, updated_at)
       VALUES ($1, 'server_boost', $2, 0, 0, $3)
       ON CONFLICT (user_id, scope_type, scope_id) DO NOTHING`,
      [targetId, serverId, Date.now()]
    );
  } else {
    await query(
      "DELETE FROM read_states WHERE user_id = $1 AND scope_type = 'server_boost' AND scope_id = $2",
      [targetId, serverId]
    );
  }

  const { boostCount, boostLevel } = await refreshBoostState(serverId);
  await logAudit(
    req.user.id,
    action === 'add' ? 'server.boost.add' : 'server.boost.remove',
    'server',
    serverId,
    `user:${targetId} count:${boostCount} level:${boostLevel}`
  );
  await emitServerUpdate(req, serverId);
  // The broadcast payload is viewer-neutral; the reply is built for the caller
  // so `boosted` is right for the person who clicked.
  const server = await buildServer(serverId, req.user.id);
  res.json({
    server,
    boostCount,
    boostLevel,
    boosted: action === 'add' ? true : targetId === req.user.id ? false : undefined
  });
}

router.post('/servers/:id/boost', authRequired, asyncHandler(handleBoost));
router.patch('/servers/:id/boost', authRequired, asyncHandler(handleBoost));

// A broadcast rebuild hands every client a viewer-neutral server object, so
// the settings card cannot read "did I boost this" off the payload. It asks
// here instead. Count and tier come from the same helpers the boost handler
// uses, so the card and the button can never disagree.
router.get('/servers/:id/boost/me', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await query('SELECT 1 FROM servers WHERE id = $1', [serverId])).rows[0]) {
    return res.status(404).json({ error: 'Server not found' });
  }
  if (!(await getMembership(serverId, req.user.id))) {
    return res.status(403).json({ error: 'You are not a member of this server.' });
  }
  const boosted = !!(
    await query(
      "SELECT 1 FROM read_states WHERE user_id = $1 AND scope_type = 'server_boost' AND scope_id = $2",
      [req.user.id, serverId]
    )
  ).rows[0];
  const boostCount =
    Number(
      (
        await query(
          "SELECT COUNT(*) AS count FROM read_states WHERE scope_type = 'server_boost' AND scope_id = $1",
          [serverId]
        )
      ).rows[0].count
    ) || 0;
  res.json({ boosted, boostCount, level: boostLevelFor(boostCount) });
}));

// A custom link is a claim on a namespace shared by every server, so the
// database decides: the unique index on lower(invite_code) plus the advisory
// lock in claimInviteCode. Two managers typing "gaming" at the same moment get
// one winner and one 409, never two servers sharing a link.
router.put('/servers/:id/invite/code', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!Number.isInteger(serverId) || serverId <= 0) {
    return res.status(400).json({ error: 'Invalid server.' });
  }
  if (!(await hasServerPermission(serverId, req.user.id, 'manageServer', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to manage this server." });
  }
  const server = (
    await query('SELECT id, invite_code, created_at FROM servers WHERE id = $1', [serverId])
  ).rows[0];
  if (!server) return res.status(404).json({ error: 'Server not found.' });

  // Both clocks are checked here, not only in the UI: the client can be old,
  // and a request can be replayed after the payload it was rendered from.
  const gate = vanityStatus({
    accountCreatedAt: req.user.created_at,
    accountRole: req.user.role,
    serverCreatedAt: server.created_at
  });
  if (!gate.allowed) {
    return res.status(403).json({
      code: 'INVITE_VANITY_LOCKED',
      error: `Custom links unlock once your account is ${gate.accountDays} days old and the server is ${gate.serverDays} days old.`,
      unlockAt: gate.unlockAt,
      accountDays: gate.accountDays,
      serverDays: gate.serverDays
    });
  }

  const code = normalizeInviteCode(req.body.code);
  const check = validateInviteCode(code);
  if (!check.ok) {
    return res.status(400).json({ code: 'INVITE_INVALID', error: check.error });
  }

  // Saving the code a server already has is a no-op, not a conflict with itself.
  if (code === String(server.invite_code).toLowerCase()) {
    return res.json({ inviteCode: server.invite_code, server: await buildServer(serverId, req.user.id) });
  }

  if (!(await claimInviteCode(serverId, code))) {
    return res.status(409).json({
      code: 'INVITE_TAKEN',
      error: 'That link is already taken. Try another.'
    });
  }

  await logAudit(req.user.id, 'invite.custom', 'server', serverId, `Invite link set to ${code}`);
  const updated = await buildServer(serverId, req.user.id);
  req.app.get('io').to(`server:${serverId}`).emit('server:updated', await buildServer(serverId));
  res.json({ inviteCode: code, server: updated });
}));

router.post('/servers/:id/invite/regenerate', authRequired, asyncHandler(async (req, res) => {
  if (!(await hasServerPermission(req.params.id, req.user.id, 'manageServer', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to manage this server." });
  }
  const inviteCode = await uniqueInviteCode();
  // Regenerating means "give me a random link", so the custom flag goes back to
  // zero and the settings card stops offering the vanity field's saved state.
  await query('UPDATE servers SET invite_code = $1, invite_code_custom = 0 WHERE id = $2', [
    inviteCode,
    Number(req.params.id)
  ]);
  const server = await buildServer(req.params.id);
  req.app.get('io').to(`server:${req.params.id}`).emit('server:updated', server);
  res.json({ inviteCode, server });
}));

// Handing the server over is the one thing manageServer cannot do: a group
// that can rename a server still must not be able to give it away. Ownership is
// stored twice - servers.owner_id is the source of truth for who may transfer,
// and server_members.role drives every permission check - so a transfer has to
// move both in the same transaction or the two would disagree.
router.post('/servers/:id/transfer', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!Number.isInteger(serverId) || serverId <= 0) {
    return res.status(400).json({ error: 'Invalid server.' });
  }
  const server = (await query('SELECT * FROM servers WHERE id = $1', [serverId])).rows[0];
  if (!server) return res.status(404).json({ error: 'Server not found' });

  if (server.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'Only the server owner can transfer this server.' });
  }

  const targetId = Number(req.body.userId);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'Choose a member to transfer this server to.' });
  }
  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'You already own this server.' });
  }

  const target = (await query('SELECT id, username FROM users WHERE id = $1', [targetId])).rows[0];
  if (!target) return res.status(404).json({ error: 'That user does not exist.' });

  // The whole point of this check: Guilded handed a server to someone who had
  // never joined, and the server then vanished from the new owner's client.
  // Membership is a precondition of a transfer, never a side effect of one.
  if (!(await getMembership(serverId, targetId))) {
    const message =
      'That user is not a member of this server. Ask them to join before transferring ownership.';
    return res.status(403).json({ code: 'NOT_A_MEMBER', error: message, message });
  }

  const previousOwnerId = server.owner_id;
  try {
    await withTransaction(async () => {
      // The ownership check above ran outside the transaction: two transfers, or a
      // transfer racing a delete, could both pass it. Re-assert it as part of the
      // UPDATE so only one of them can win.
      const claimed = await query(
        'UPDATE servers SET owner_id = $1 WHERE id = $2 AND owner_id = $3',
        [targetId, serverId, previousOwnerId]
      );
      if (claimed.rowCount !== 1) {
        throw new TransactionAbort(409, {
          error: 'This server changed owners while you were transferring it. Reload and try again.'
        });
      }
      await query(
        "UPDATE server_members SET role = 'owner' WHERE server_id = $1 AND user_id = $2",
        [serverId, targetId]
      );
      // The previous owner stays in the server as a normal admin: they keep their
      // group rows and simply lose what ownership alone granted.
      await query(
        "UPDATE server_members SET role = 'admin' WHERE server_id = $1 AND user_id = $2",
        [serverId, previousOwnerId]
      );
    });
  } catch (error) {
    if (error instanceof TransactionAbort) {
      return res.status(error.status).json(error.body);
    }
    throw error;
  }

  await logAudit(
    req.user.id,
    'server.transfer',
    'server',
    serverId,
    req.user.username + ' -> ' + target.username
  );
  const updated = await buildServer(serverId);
  req.app.get('io').to('server:' + serverId).emit('server:updated', updated);
  res.json({ server: updated });
}));

// Membership alone does not grant access to threads: a thread is only visible
// to people in thread_members. Those rows (and the read state of the server's
// channels) have to go when someone is removed, otherwise an invite back would
// silently restore access to private threads they had joined before.
async function forgetServerAccess(serverId, userId) {
  await query(
    `DELETE FROM thread_members
     WHERE user_id = $1 AND thread_id IN (
       SELECT id FROM channels WHERE server_id = $2 AND type = 'thread'
     )`,
    [userId, serverId]
  );
  await query(
    `DELETE FROM read_states
     WHERE user_id = $1 AND scope_type = 'channel' AND scope_id IN (
       SELECT id FROM channels WHERE server_id = $2
     )`,
    [userId, serverId]
  );
  // A boost or a dismissed welcome screen belongs to the membership, not the
  // user: leaving the server drops both, and the boost totals are recomputed
  // because this user's boost row just went away.
  await query(
    `DELETE FROM read_states
     WHERE user_id = $1 AND scope_type IN ('server_boost', 'server_welcome') AND scope_id = $2`,
    [userId, serverId]
  );
  await refreshBoostState(serverId);
}

// Losing the membership row is not enough: sockets join thread:<id> rooms from
// thread_members at connect time and sit in a voiceRooms map entry, so a removed
// member would keep receiving private-thread messages and stay visible in voice.
async function evictServerSockets(io, serverId, userId) {
  const id = Number(userId);
  const channels = (
    await query('SELECT id, type FROM channels WHERE server_id = $1', [Number(serverId)])
  ).rows;
  const threadRooms = channels
    .filter((channel) => channel.type === 'thread')
    .map((channel) => `thread:${channel.id}`);
  const userRoom = `user:${id}`;
  if (threadRooms.length) io.in(userRoom).socketsLeave(threadRooms);
  io.in(userRoom).socketsLeave(`server:${Number(serverId)}`);

  for (const channel of channels) {
    const room = voiceRooms.get(channel.id);
    if (!room) continue;
    let removed = false;
    for (const [socketId, participant] of room) {
      if (Number(participant.id) !== id) continue;
      room.delete(socketId);
      removed = true;
      for (const other of room.values()) {
        io.to(other.socketId).emit('voice:peer-left', { socketId });
      }
    }
    if (removed && room.size === 0) voiceRooms.delete(channel.id);
  }
}

router.post('/servers/:id/leave', authRequired, asyncHandler(async (req, res) => {
  const membership = await getMembership(req.params.id, req.user.id);
  if (!membership) return res.status(404).json({ error: 'You are not in this server.' });
  if (membership.role === 'owner') {
    return res.status(400).json({ error: 'Transfer ownership or delete the server instead.' });
  }
  const serverId = Number(req.params.id);
  await withTransaction(async () => {
    await query('DELETE FROM server_member_groups WHERE server_id = $1 AND user_id = $2', [
      serverId,
      req.user.id
    ]);
    await query('DELETE FROM server_members WHERE server_id = $1 AND user_id = $2', [
      serverId,
      req.user.id
    ]);
    await forgetServerAccess(serverId, req.user.id);
  });
  const io = req.app.get('io');
  await evictServerSockets(io, serverId, req.user.id);
  io.to(`server:${serverId}`).emit('server:member-left', {
    serverId,
    userId: req.user.id
  });
  emitToServerBots(io, serverId, 'members', 'MEMBER_LEAVE', {
    serverId: Number(serverId),
    userId: Number(req.user.id)
  });
  const serverRow = (await query('SELECT * FROM servers WHERE id = $1', [serverId])).rows[0];
  if (serverRow) await announcePresence(io, serverRow, req.user, 'left');
  res.json({ ok: true });
}));

router.delete('/servers/:id', authRequired, asyncHandler(async (req, res) => {
  const server = (await query('SELECT * FROM servers WHERE id = $1', [Number(req.params.id)])).rows[0];
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (server.owner_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the server owner can delete this server.' });
  }
  const io = req.app.get('io');
  io.to(`server:${server.id}`).emit('server:deleted', { serverId: server.id });

  const serverChannels = (await query('SELECT id FROM channels WHERE server_id = $1', [server.id])).rows;
  for (const channel of serverChannels) {
    const voiceRoom = voiceRooms.get(channel.id);
    if (!voiceRoom) continue;
    for (const participant of voiceRoom.values()) {
      io.to(participant.socketId).emit('voice:closed');
    }
    voiceRooms.delete(channel.id);
  }

  // Every channel in the server (and their threads) goes with it.
  const doomedChannels = serverChannels.map((row) => Number(row.id));
  const doomedThreads = (
    await query("SELECT id FROM channels WHERE server_id = $1 AND type = 'thread'", [server.id])
  ).rows.map((row) => Number(row.id));
  // Foreign keys take the media rows with the server but never the files, so the
  // URLs are read first and reclaimed once the delete has committed.
  const doomedUploads = [
    server.icon_url,
    server.banner,
    ...(await query('SELECT url FROM server_emotes WHERE server_id = $1', [server.id])).rows.map(
      (row) => row.url
    ),
    ...(
      await query('SELECT file FROM soundboard_sounds WHERE server_id = $1', [server.id])
    ).rows.map((row) => row.file),
    ...(await attachmentUrlsForChannels(doomedChannels, doomedThreads))
  ];
  await withTransaction(async () => {
    await releaseCascade({ channelIds: doomedChannels });
    await query('DELETE FROM servers WHERE id = $1', [server.id]);
  });
  await deleteUploadsAfterCommit(doomedUploads);
  await logAudit(req.user.id, 'server.delete', 'server', server.id, server.name);
  res.json({ ok: true });
}));

async function categoryForServer(serverId, categoryId) {
  if (categoryId === null || categoryId === undefined || categoryId === '') return null;
  const id = Number(categoryId);
  if (!Number.isInteger(id) || id <= 0) return undefined;
  return (
    (
      await query('SELECT * FROM channel_categories WHERE id = $1 AND server_id = $2', [
        id,
        Number(serverId)
      ])
    ).rows[0] || undefined
  );
}

function categoryName(value) {
  return trim(value).replace(/\s+/g, ' ').slice(0, 48);
}

async function emitServerUpdate(req, serverId) {
  const server = await buildServer(serverId);
  if (server) req.app.get('io').to(`server:${serverId}`).emit('server:updated', server);
  return server;
}

router.post('/servers/:id/channels', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await hasServerPermission(serverId, req.user.id, 'manageChannels', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to manage channels." });
  }
  const name = sanitizeChannelName(req.body.name);
  const requested = req.body.type;
  // Stage channels are voice-like: they hold a room of listeners and join the
  // same voice room map, they just get a speaker/audience split on the client.
  // The tool channels — media, docs, lists, calendar — are ordinary channels
  // with a different view, which is what keeps permissions, ordering and
  // categories working without a second model.
  const CHANNEL_TYPES = ['voice', 'forum', 'stage', 'media', 'docs', 'list', 'calendar'];
  const type = CHANNEL_TYPES.includes(requested) ? requested : 'text';
  if (!name || name.length < 1) return res.status(400).json({ error: 'Give the channel a name.' });
  const category = await categoryForServer(serverId, req.body.categoryId);
  if (category === undefined) {
    return res.status(400).json({ error: 'That category does not belong to this server.' });
  }
  const duplicate = (
    await query(
      "SELECT 1 FROM channels WHERE server_id = $1 AND name = $2 AND type != 'thread'",
      [serverId, name]
    )
  ).rows[0];
  if (duplicate) return res.status(409).json({ error: 'A channel with that name already exists.' });

  const position = (
    await query(
      'SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM channels WHERE server_id = $1',
      [serverId]
    )
  ).rows[0].pos;
  const result = await query(
    `INSERT INTO channels (server_id, category_id, name, type, position, created_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [serverId, category?.id ?? null, name, type, position, Date.now()]
  );
  const channel = {
    id: Number(result.rows[0].id),
    serverId,
    categoryId: category?.id ?? null,
    name,
    type,
    position
  };
  req.app.get('io').to(`server:${serverId}`).emit('channel:created', channel);
  res.status(201).json({ channel });
}));

router.put('/servers/:id/channels/order', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await hasServerPermission(serverId, req.user.id, 'manageChannels', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to manage channels." });
  }
  const channels = (
    await query('SELECT id FROM channels WHERE server_id = $1 ORDER BY position ASC, id ASC', [
      serverId
    ])
  ).rows;
  const requested = Array.isArray(req.body.channels) ? req.body.channels : null;
  if (!requested || requested.length !== channels.length) {
    return res.status(400).json({ error: 'Include every channel exactly once.' });
  }
  const known = new Set(channels.map((channel) => channel.id));
  const seen = new Set();
  const ordered = [];
  for (const entry of requested) {
    const id = Number(entry?.id);
    if (!known.has(id) || seen.has(id)) {
      return res.status(400).json({ error: 'Include every channel exactly once.' });
    }
    const category = await categoryForServer(serverId, entry?.categoryId ?? null);
    if (category === undefined) {
      return res.status(400).json({ error: 'That category does not belong to this server.' });
    }
    seen.add(id);
    ordered.push({ id, categoryId: category?.id ?? null });
  }
  await withTransaction(async () => {
    for (const [index, entry] of ordered.entries()) {
      await query(
        'UPDATE channels SET category_id = $1, position = $2 WHERE id = $3 AND server_id = $4',
        [entry.categoryId, index, entry.id, serverId]
      );
    }
  });
  const server = await emitServerUpdate(req, serverId);
  res.json({ server });
}));

router.patch('/channels/:id', authRequired, asyncHandler(async (req, res) => {
  const channel = (await query('SELECT * FROM channels WHERE id = $1', [Number(req.params.id)])).rows[0];
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (!(await hasServerPermission(channel.server_id, req.user.id, 'manageChannels', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to manage channels." });
  }

  const updates = [];
  const values = [];
  if (Object.prototype.hasOwnProperty.call(req.body, 'categoryId')) {
    const category = await categoryForServer(channel.server_id, req.body.categoryId);
    if (category === undefined) {
      return res.status(400).json({ error: 'That category does not belong to this server.' });
    }
    values.push(category?.id ?? null);
    updates.push(`category_id = $${values.length}`);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'name')) {
    const name = sanitizeChannelName(req.body.name);
    if (!name) return res.status(400).json({ error: 'Give the channel a name.' });
    const duplicate = (
      await query('SELECT 1 FROM channels WHERE server_id = $1 AND name = $2 AND id <> $3', [
        channel.server_id,
        name,
        channel.id
      ])
    ).rows[0];
    if (duplicate) return res.status(409).json({ error: 'A channel with that name already exists.' });
    values.push(name);
    updates.push(`name = $${values.length}`);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'guidelines')) {
    const guidelines = trim(req.body.guidelines).slice(0, 500);
    values.push(guidelines);
    updates.push(`guidelines = $${values.length}`);
  }
  if (!updates.length) return res.status(400).json({ error: 'Nothing to update.' });

  values.push(channel.id);
  await query(`UPDATE channels SET ${updates.join(', ')} WHERE id = $${values.length}`, values);
  const server = await emitServerUpdate(req, channel.server_id);
  res.json({ server });
}));

router.post('/servers/:id/categories', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await hasServerPermission(serverId, req.user.id, 'manageChannels', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to manage channels." });
  }
  const name = categoryName(req.body.name);
  if (!name) return res.status(400).json({ error: 'Give the category a name.' });
  const duplicate = (
    await query('SELECT 1 FROM channel_categories WHERE server_id = $1 AND lower(name) = lower($2)', [
      serverId,
      name
    ])
  ).rows[0];
  if (duplicate) return res.status(409).json({ error: 'A category with that name already exists.' });
  const position = (
    await query(
      'SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM channel_categories WHERE server_id = $1',
      [serverId]
    )
  ).rows[0].pos;
  const result = await query(
    'INSERT INTO channel_categories (server_id, name, position, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
    [serverId, name, position, Date.now()]
  );
  const category = (
    await query('SELECT * FROM channel_categories WHERE id = $1', [Number(result.rows[0].id)])
  ).rows[0];
  await logAudit(req.user.id, 'server.category.create', 'server', serverId, name);
  const server = await emitServerUpdate(req, serverId);
  res.status(201).json({
    category: {
      id: category.id,
      serverId: category.server_id,
      name: category.name,
      position: category.position,
      createdAt: category.created_at
    },
    server
  });
}));

router.patch('/servers/:id/categories/:categoryId', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await hasServerPermission(serverId, req.user.id, 'manageChannels', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to manage channels." });
  }
  const category = (
    await query('SELECT * FROM channel_categories WHERE id = $1 AND server_id = $2', [
      Number(req.params.categoryId),
      serverId
    ])
  ).rows[0];
  if (!category) return res.status(404).json({ error: 'Category not found' });
  const name = categoryName(req.body.name);
  if (!name) return res.status(400).json({ error: 'Give the category a name.' });
  const duplicate = (
    await query(
      'SELECT 1 FROM channel_categories WHERE server_id = $1 AND lower(name) = lower($2) AND id <> $3',
      [serverId, name, category.id]
    )
  ).rows[0];
  if (duplicate) return res.status(409).json({ error: 'A category with that name already exists.' });
  await query('UPDATE channel_categories SET name = $1 WHERE id = $2', [name, category.id]);
  await logAudit(req.user.id, 'server.category.update', 'server', serverId, name);
  const server = await emitServerUpdate(req, serverId);
  res.json({ server });
}));

router.put('/servers/:id/categories/order', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await hasServerPermission(serverId, req.user.id, 'manageChannels', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to manage channels." });
  }
  const categories = (
    await query(
      'SELECT id FROM channel_categories WHERE server_id = $1 ORDER BY position ASC, id ASC',
      [serverId]
    )
  ).rows;
  const requested = Array.isArray(req.body.categoryIds)
    ? req.body.categoryIds.map((value) => Number(value))
    : null;
  if (
    !requested ||
    requested.length !== categories.length ||
    new Set(requested).size !== requested.length ||
    requested.some((id) => !categories.some((category) => category.id === id))
  ) {
    return res.status(400).json({ error: 'Include every category exactly once.' });
  }
  await withTransaction(async () => {
    for (const [index, id] of requested.entries()) {
      await query('UPDATE channel_categories SET position = $1 WHERE id = $2', [index, id]);
    }
  });
  const server = await emitServerUpdate(req, serverId);
  res.json({ server });
}));

router.delete('/servers/:id/categories/:categoryId', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await hasServerPermission(serverId, req.user.id, 'manageChannels', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to manage channels." });
  }
  const category = (
    await query('SELECT * FROM channel_categories WHERE id = $1 AND server_id = $2', [
      Number(req.params.categoryId),
      serverId
    ])
  ).rows[0];
  if (!category) return res.status(404).json({ error: 'Category not found' });
  await withTransaction(async () => {
    await query('UPDATE channels SET category_id = NULL WHERE category_id = $1', [category.id]);
    await query('DELETE FROM channel_categories WHERE id = $1', [category.id]);
  });
  await logAudit(req.user.id, 'server.category.delete', 'server', serverId, category.name);
  const server = await emitServerUpdate(req, serverId);
  res.json({ server });
}));

// ── Per-channel overrides ───────────────────────────────────────────────────
// One row per (channel, target). The route is a PUT because an override is a
// complete statement - the allow and deny lists replace whatever was there.
async function channelForOverride(req, res, permission) {
  const channelId = Number(req.params.id);
  if (!Number.isInteger(channelId) || channelId <= 0) {
    res.status(400).json({ error: 'Invalid channel.' });
    return null;
  }
  const { rows } = await query('SELECT id, server_id, name, type FROM channels WHERE id = $1', [channelId]);
  const channel = rows[0];
  if (!channel) {
    res.status(404).json({ error: 'Channel not found.' });
    return null;
  }
  if (!(await getMembership(channel.server_id, req.user.id))) {
    res.status(403).json({ error: 'You are not a member of this server.' });
    return null;
  }
  if (!(await hasServerPermission(channel.server_id, req.user.id, permission, req.user.role))) {
    res.status(403).json({ error: 'You do not have permission to manage this channel.' });
    return null;
  }
  return channel;
}

router.get('/channels/:id/overrides', authRequired, asyncHandler(async (req, res) => {
  const channel = await channelForOverride(req, res, 'viewServerSettings');
  if (!channel) return;
  const map = await getChannelOverrides(channel.server_id);
  const rows = map.get(Number(channel.id)) || [];
  res.json({
    channelId: Number(channel.id),
    permissions: CHANNEL_PERMISSIONS,
    overrides: rows.map((row) => ({
      targetType: row.targetType,
      targetId: row.targetId,
      allow: row.allow,
      deny: row.deny
    }))
  });
}));

router.put('/channels/:id/overrides/:targetType/:targetId', authRequired, asyncHandler(async (req, res) => {
  const channel = await channelForOverride(req, res, 'manageChannels');
  if (!channel) return;
  const targetType = String(req.params.targetType);
  if (!['group', 'member'].includes(targetType)) {
    return res.status(400).json({ error: 'Target must be a group or a member.' });
  }
  const targetId = Number(req.params.targetId);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ error: 'Invalid target.' });
  }
  if (targetType === 'group') {
    const { rows } = await query('SELECT 1 FROM server_groups WHERE id = $1 AND server_id = $2', [
      targetId,
      channel.server_id
    ]);
    if (!rows[0]) return res.status(404).json({ error: 'That group is not in this server.' });
  } else {
    const { rows } = await query('SELECT 1 FROM server_members WHERE user_id = $1 AND server_id = $2', [
      targetId,
      channel.server_id
    ]);
    if (!rows[0]) return res.status(404).json({ error: 'That member is not in this server.' });
  }

  const allow = parseChannelPermissionList(JSON.stringify(Array.isArray(req.body.allow) ? req.body.allow : []));
  const deny = parseChannelPermissionList(JSON.stringify(Array.isArray(req.body.deny) ? req.body.deny : []));
  // A permission cannot be both allowed and denied in one row; deny wins, so
  // the stored row says what the resolver would have done anyway.
  const denied = new Set(deny);
  const cleanAllow = allow.filter((permission) => !denied.has(permission));

  if (!cleanAllow.length && !deny.length) {
    await query('DELETE FROM channel_overrides WHERE channel_id = $1 AND target_type = $2 AND target_id = $3', [
      channel.id,
      targetType,
      targetId
    ]);
    return res.json({ override: null, cleared: true });
  }

  await query(
    `INSERT INTO channel_overrides (channel_id, target_type, target_id, allow, deny, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (channel_id, target_type, target_id)
     DO UPDATE SET allow = EXCLUDED.allow, deny = EXCLUDED.deny, updated_at = EXCLUDED.updated_at`,
    [channel.id, targetType, targetId, JSON.stringify(cleanAllow), JSON.stringify(deny), Date.now()]
  );
  await logAudit(
    req.user.id,
    'channel.override',
    'channel',
    channel.id,
    `${targetType}:${targetId} on #${channel.name}`
  );
  req.app.get('io').to(`server:${channel.server_id}`).emit('server:updated', await buildServer(channel.server_id));
  res.json({ override: { targetType, targetId, allow: cleanAllow, deny } });
}));

router.delete('/channels/:id/overrides/:targetType/:targetId', authRequired, asyncHandler(async (req, res) => {
  const channel = await channelForOverride(req, res, 'manageChannels');
  if (!channel) return;
  await query('DELETE FROM channel_overrides WHERE channel_id = $1 AND target_type = $2 AND target_id = $3', [
    channel.id,
    String(req.params.targetType),
    Number(req.params.targetId)
  ]);
  req.app.get('io').to(`server:${channel.server_id}`).emit('server:updated', await buildServer(channel.server_id));
  res.status(204).end();
}));

router.delete('/channels/:id', authRequired, asyncHandler(async (req, res) => {
  const channel = (await query('SELECT * FROM channels WHERE id = $1', [Number(req.params.id)])).rows[0];
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  if (!(await hasServerPermission(channel.server_id, req.user.id, 'manageChannels', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to manage channels." });
  }
  const io = req.app.get('io');

  const voiceRoom = voiceRooms.get(channel.id);
  if (voiceRoom) {
    for (const participant of voiceRoom.values()) {
      io.to(participant.socketId).emit('voice:closed');
    }
    voiceRooms.delete(channel.id);
  }

  // Foreign keys take the channel's messages (and any child threads') with it,
  // so the author counters have to be released in the same transaction - and the
  // attachment files read before the rows vanish, to be reclaimed after commit.
  const doomedChannels = await channelAndThreadIds(channel.id);
  const doomedThreads = channel.type === 'thread' ? [channel.id] : doomedChannels.slice(1);
  const doomedUploads = await attachmentUrlsForChannels(doomedChannels, doomedThreads);
  await withTransaction(async () => {
    await releaseCascade({
      channelIds: doomedChannels,
      threadIds: channel.type === 'thread' ? [channel.id] : []
    });
    await query('DELETE FROM channels WHERE id = $1', [channel.id]);
  });
  await deleteUploadsAfterCommit(doomedUploads);
  io.to(`server:${channel.server_id}`).emit('channel:deleted', {
    channelId: channel.id,
    serverId: channel.server_id
  });
  res.json({ ok: true });
}));

router.get('/servers/:id/groups', authRequired, asyncHandler(async (req, res) => {
  if (!(await getMembership(req.params.id, req.user.id))) {
    return res.status(403).json({ error: 'You are not a member of this server.' });
  }
  res.json({ groups: await getServerGroups(req.params.id) });
}));

// ── Role categories ─────────────────────────────────────────────────────────
// A category is a heading in the roles list. It carries no permissions and no
// order of its own beyond display, which is why deleting one only nulls the
// column on the groups inside it.
async function readGroupCategories(serverId) {
  const { rows } = await query(
    'SELECT id, server_id, name, color, position, created_at FROM group_categories WHERE server_id = $1 ORDER BY position ASC, id ASC',
    [Number(serverId)]
  );
  return rows.map((row) => ({
    id: Number(row.id),
    serverId: Number(row.server_id),
    name: row.name,
    color: row.color || '#7a8798',
    position: Number(row.position) || 0,
    createdAt: row.created_at
  }));
}

router.get('/servers/:id/group-categories', authRequired, asyncHandler(async (req, res) => {
  if (!(await getMembership(req.params.id, req.user.id))) {
    return res.status(403).json({ error: 'You are not a member of this server.' });
  }
  res.json({ categories: await readGroupCategories(req.params.id) });
}));

router.post('/servers/:id/group-categories', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await hasServerPermission(serverId, req.user.id, 'manageGroups', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to manage groups." });
  }
  const name = trim(req.body.name);
  if (name.length < 1 || name.length > 32) {
    return res.status(400).json({ error: 'Category name must be 1-32 characters.' });
  }
  const { rows: existing } = await query(
    'SELECT COUNT(*)::int AS n FROM group_categories WHERE server_id = $1',
    [serverId]
  );
  if (Number(existing[0].n) >= 20) {
    return res.status(400).json({ error: 'A server can have at most 20 role categories.' });
  }
  const { rows } = await query(
    'SELECT COALESCE(MAX(position), 0) AS position FROM group_categories WHERE server_id = $1',
    [serverId]
  );
  const color = isHexColor(req.body.color) ? req.body.color : '#7a8798';
  await query(
    'INSERT INTO group_categories (server_id, name, color, position, created_at) VALUES ($1, $2, $3, $4, $5)',
    [serverId, name, color, Number(rows[0].position) + 1, Date.now()]
  );
  const categories = await readGroupCategories(serverId);
  const server = await buildServer(serverId);
  req.app.get('io').to(`server:${serverId}`).emit('server:updated', server);
  res.status(201).json({ categories, server });
}));

router.patch('/servers/:id/group-categories/:categoryId', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await hasServerPermission(serverId, req.user.id, 'manageGroups', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to manage groups." });
  }
  const categoryId = Number(req.params.categoryId);
  const { rows: found } = await query(
    'SELECT id FROM group_categories WHERE id = $1 AND server_id = $2',
    [categoryId, serverId]
  );
  if (!found[0]) return res.status(404).json({ error: 'Category not found.' });
  const updates = {};
  if (req.body.name !== undefined) {
    const name = trim(req.body.name);
    if (name.length < 1 || name.length > 32) {
      return res.status(400).json({ error: 'Category name must be 1-32 characters.' });
    }
    updates.name = name;
  }
  if (req.body.color !== undefined) {
    if (!isHexColor(req.body.color)) {
      return res.status(400).json({ error: 'Category colour must be a hex value.' });
    }
    updates.color = req.body.color;
  }
  if (req.body.position !== undefined) {
    const position = Number(req.body.position);
    if (!Number.isInteger(position) || position < 0) {
      return res.status(400).json({ error: 'Invalid position.' });
    }
    updates.position = position;
  }
  const fields = Object.keys(updates);
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });
  const params = fields.map((field) => updates[field]);
  params.push(categoryId);
  await query(
    `UPDATE group_categories SET ${fields.map((field, index) => `${field} = $${index + 1}`).join(', ')} WHERE id = $${params.length}`,
    params
  );
  const categories = await readGroupCategories(serverId);
  const server = await buildServer(serverId);
  req.app.get('io').to(`server:${serverId}`).emit('server:updated', server);
  res.json({ categories, server });
}));

router.delete('/servers/:id/group-categories/:categoryId', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await hasServerPermission(serverId, req.user.id, 'manageGroups', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to manage groups." });
  }
  await query('DELETE FROM group_categories WHERE id = $1 AND server_id = $2', [
    Number(req.params.categoryId),
    serverId
  ]);
  const categories = await readGroupCategories(serverId);
  const server = await buildServer(serverId);
  req.app.get('io').to(`server:${serverId}`).emit('server:updated', server);
  res.json({ categories, server });
}));

router.post('/servers/:id/groups', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  const actor = await getMembership(serverId, req.user.id);
  if (!actor) return res.status(403).json({ error: 'You are not a member of this server.' });
  if (!(await hasServerPermission(serverId, req.user.id, 'manageGroups', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to manage groups." });
  }

  const name = trim(req.body.name);
  if (name.length < 1 || name.length > 32) {
    return res.status(400).json({ error: 'Group name must be 1-32 characters.' });
  }
  const color = isHexColor(req.body.color) ? req.body.color : '#7a8798';
  const permissions = normalizePermissions(req.body.permissions, DEFAULT_MEMBER_PERMISSIONS);
  if (req.body.displaySeparately !== undefined && typeof req.body.displaySeparately !== 'boolean') {
    return res.status(400).json({ error: 'Display separately must be true or false.' });
  }
  const displaySeparately = req.body.displaySeparately === true ? 1 : 0;
  const privileged = actor.role === 'owner' || req.user.role === 'admin';
  if (!privileged) {
    for (const permission of permissions) {
      if (!(await hasServerPermission(serverId, req.user.id, permission, req.user.role))) {
        return res.status(403).json({ error: 'You cannot grant permissions you do not have.' });
      }
    }
  }

  const ceiling = await getHighestGroupPosition(serverId, req.user.id, req.user.role);
  const position = await nextGroupPosition(serverId, req.user.id, req.user.role);
  if (!privileged && position >= ceiling) {
    return res.status(403).json({ error: 'You cannot create a group above your own rank.' });
  }

  let result;
  try {
    result = await query(
      `INSERT INTO server_groups
           (server_id, name, color, permissions, position, is_default, display_separately, created_at)
         VALUES ($1, $2, $3, $4, $5, 0, $6, $7) RETURNING id`,
      [
        serverId,
        name,
        color,
        JSON.stringify(permissions),
        position,
        displaySeparately,
        Date.now()
      ]
    );
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A group with that name already exists.' });
    }
    throw error;
  }

  await logAudit(req.user.id, 'server.group.create', 'server', serverId, name);
  const server = await buildServer(serverId);
  const group = server.groups.find((entry) => entry.id === Number(result.rows[0].id));
  req.app.get('io').to(`server:${serverId}`).emit('server:updated', server);
  res.status(201).json({ group, server });
}));

router.put('/servers/:id/groups/order', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  const actor = await getMembership(serverId, req.user.id);
  if (!actor) return res.status(403).json({ error: 'You are not a member of this server.' });
  const privileged = actor.role === 'owner' || actor.role === 'admin' || req.user.role === 'admin';
  if (!privileged) {
    return res.status(403).json({ error: 'Only server owners and admins can reorder groups.' });
  }

  const groups = await getServerGroups(serverId);
  const requested = Array.isArray(req.body.groupIds)
    ? req.body.groupIds.map((value) => Number(value))
    : null;
  if (!requested || requested.length !== groups.length) {
    return res.status(400).json({ error: 'Include every group exactly once.' });
  }
  if (new Set(requested).size !== requested.length) {
    return res.status(400).json({ error: 'Include every group exactly once.' });
  }
  const groupMap = new Map(groups.map((group) => [group.id, group]));
  if (requested.some((id) => !groupMap.has(id))) {
    return res.status(400).json({ error: 'One or more groups do not belong to this server.' });
  }
  const defaultGroup = groups.find((group) => group.isDefault);
  if (defaultGroup && requested[requested.length - 1] !== defaultGroup.id) {
    return res.status(400).json({ error: 'The default group must stay last.' });
  }

  const ordered = requested
    .map((id) => groupMap.get(id))
    .filter((group) => !group.isDefault);
  const updates = ordered.map((group, index) => ({
    id: group.id,
    position: (ordered.length - index) * 1000
  }));
  if (defaultGroup) updates.push({ id: defaultGroup.id, position: 0 });

  await withTransaction(async () => {
    for (const entry of updates) {
      await query('UPDATE server_groups SET position = $1 WHERE id = $2 AND server_id = $3', [
        entry.position,
        entry.id,
        serverId
      ]);
    }
  });

  const orderDetail = requested.map((id) => groupMap.get(id).name).join(' > ');
  await logAudit(req.user.id, 'server.group.reorder', 'server', serverId, orderDetail);
  const server = await buildServer(serverId);
  req.app.get('io').to(`server:${serverId}`).emit('server:updated', server);
  res.json({ server });
}));

router.patch('/servers/:id/groups/:groupId', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  const group = (
    await query('SELECT * FROM server_groups WHERE id = $1 AND server_id = $2', [
      Number(req.params.groupId),
      serverId
    ])
  ).rows[0];
  if (!group) return res.status(404).json({ error: 'Group not found.' });
  const serialized = (await getServerGroups(serverId)).find((entry) => entry.id === group.id);
  if (!(await canManageGroup(serverId, req.user.id, serialized, req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to manage this group." });
  }

  const updates = {};
  if (req.body.name !== undefined) {
    const name = trim(req.body.name);
    if (name.length < 1 || name.length > 32) {
      return res.status(400).json({ error: 'Group name must be 1-32 characters.' });
    }
    updates.name = name;
  }
  if (req.body.color !== undefined) {
    if (!isHexColor(req.body.color)) return res.status(400).json({ error: 'Invalid group color.' });
    updates.color = req.body.color;
  }
  if (req.body.displaySeparately !== undefined) {
    if (serialized.isDefault) {
      return res.status(400).json({ error: 'The default group is always shown with everyone.' });
    }
    if (typeof req.body.displaySeparately !== 'boolean') {
      return res.status(400).json({ error: 'Display separately must be true or false.' });
    }
    updates.display_separately = req.body.displaySeparately ? 1 : 0;
  }
  if (req.body.permissions !== undefined) {
    const permissions = normalizePermissions(req.body.permissions, serialized.permissions);
    const privileged =
      (await getMembership(serverId, req.user.id))?.role === 'owner' || req.user.role === 'admin';
    if (!privileged) {
      for (const permission of permissions) {
        if (!(await hasServerPermission(serverId, req.user.id, permission, req.user.role))) {
          return res.status(403).json({ error: 'You cannot grant permissions you do not have.' });
        }
      }
    }
    updates.permissions = JSON.stringify(permissions);
  }
  if (req.body.categoryId !== undefined) {
    if (req.body.categoryId === null) {
      updates.category_id = null;
    } else {
      const categoryId = Number(req.body.categoryId);
      const { rows: found } = await query(
        'SELECT 1 FROM group_categories WHERE id = $1 AND server_id = $2',
        [categoryId, serverId]
      );
      if (!found[0]) return res.status(400).json({ error: 'That category is not in this server.' });
      updates.category_id = categoryId;
    }
  }
  if (req.body.position !== undefined) {
    const position = Number(req.body.position);
    if (!Number.isInteger(position) || position < 0) {
      return res.status(400).json({ error: 'Invalid group position.' });
    }
    const ceiling = await getHighestGroupPosition(serverId, req.user.id, req.user.role);
    const privileged =
      (await getMembership(serverId, req.user.id))?.role === 'owner' || req.user.role === 'admin';
    if (!privileged && position >= ceiling) {
      return res.status(403).json({ error: 'You cannot move a group above your own rank.' });
    }
    updates.position = position;
  }

  const fields = Object.keys(updates);
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });
  try {
    const params = fields.map((field) => updates[field]);
    params.push(group.id);
    await query(
      `UPDATE server_groups SET ${fields.map((field, index) => `${field} = $${index + 1}`).join(', ')}
       WHERE id = $${params.length}`,
      params
    );
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A group with that name already exists.' });
    }
    throw error;
  }

  await logAudit(req.user.id, 'server.group.update', 'server', serverId, serialized.name);
  const server = await buildServer(serverId);
  const updated = server.groups.find((entry) => entry.id === group.id);
  req.app.get('io').to(`server:${serverId}`).emit('server:updated', server);
  res.json({ group: updated, server });
}));

router.delete('/servers/:id/groups/:groupId', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  const group = (
    await query('SELECT * FROM server_groups WHERE id = $1 AND server_id = $2', [
      Number(req.params.groupId),
      serverId
    ])
  ).rows[0];
  if (!group) return res.status(404).json({ error: 'Group not found.' });
  const serialized = (await getServerGroups(serverId)).find((entry) => entry.id === group.id);
  if (serialized.isDefault) {
    return res.status(400).json({ error: 'The default group cannot be deleted.' });
  }
  if (!(await canManageGroup(serverId, req.user.id, serialized, req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to manage this group." });
  }

  // emote_role_access rows cascade with the group, and "no rows" means the emote
  // is open to everyone. Deleting the last group gating an emote would therefore
  // unlock it for the whole server, so that case is refused rather than guessed
  // at (reassigning the emote to another group is a product decision).
  try {
    await withTransaction(async () => {
      const unlocked = (
        await query(
          `SELECT e.name FROM server_emotes e
           WHERE e.server_id = $1
             AND EXISTS (SELECT 1 FROM emote_role_access a WHERE a.emote_id = e.id AND a.group_id = $2)
             AND (SELECT COUNT(*) FROM emote_role_access x WHERE x.emote_id = e.id) = 1
           ORDER BY lower(e.name) ASC`,
          [serverId, group.id]
        )
      ).rows;
      if (unlocked.length) {
        const names = unlocked.slice(0, 5).map((row) => row.name).join(', ');
        const more = unlocked.length > 5 ? ` and ${unlocked.length - 5} more` : '';
        throw new TransactionAbort(409, {
          error:
            `This group is the only one with access to ${unlocked.length} emote(s) (${names}${more}). ` +
            'Deleting it would make them usable by everyone - give those emotes another group first.'
        });
      }
      await query('DELETE FROM server_groups WHERE id = $1', [group.id]);
    });
  } catch (error) {
    if (error instanceof TransactionAbort) {
      return res.status(error.status).json(error.body);
    }
    throw error;
  }
  await logAudit(req.user.id, 'server.group.delete', 'server', serverId, serialized.name);
  const server = await buildServer(serverId);
  req.app.get('io').to(`server:${serverId}`).emit('server:updated', server);
  res.json({ server });
}));

router.put('/servers/:id/members/:userId/groups', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  const targetId = Number(req.params.userId);
  const actor = await getMembership(serverId, req.user.id);
  if (!actor) return res.status(403).json({ error: 'You are not a member of this server.' });
  if (!(await hasServerPermission(serverId, req.user.id, 'manageGroups', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to manage groups." });
  }

  const target = await getMembership(serverId, targetId);
  if (!target) return res.status(404).json({ error: 'Member not found.' });
  if (target.role === 'owner' && targetId !== req.user.id) {
    return res.status(400).json({ error: "The owner's groups can only be changed by the owner." });
  }

  const privileged = actor.role === 'owner' || req.user.role === 'admin';
  if (!privileged) {
    if (targetId === req.user.id) {
      return res.status(403).json({ error: 'You cannot change your own groups.' });
    }
    if (!(await canManageMember(serverId, req.user.id, targetId, 'manageGroups', req.user.role))) {
      return res.status(403).json({ error: "You don't have permission to manage this member." });
    }
  }

  const groups = await getServerGroups(serverId);
  const groupMap = new Map(groups.map((group) => [group.id, group]));
  const requested = Array.isArray(req.body.groupIds) ? req.body.groupIds : [];
  const selected = [];
  for (const value of requested) {
    const group = groupMap.get(Number(value));
    if (!group) return res.status(400).json({ error: 'One of those groups does not exist.' });
    if (!group.isDefault) selected.push(group);
  }

  if (!privileged) {
    const ceiling = await getHighestGroupPosition(serverId, req.user.id, req.user.role);
    if (selected.some((group) => group.position >= ceiling)) {
      return res.status(403).json({ error: 'You cannot assign a group above your own rank.' });
    }
  }

  await setMemberGroups(serverId, targetId, selected.map((group) => group.id));
  await logAudit(
    req.user.id,
    'server.member.groups',
    'server',
    serverId,
    `${targetId}:${selected.map((group) => group.name).join(',')}`
  );
  const server = await buildServer(serverId);
  req.app.get('io').to(`server:${serverId}`).emit('server:updated', server);
  res.json({ server });
}));

// Your own bio, scoped to one server. Discord has no equivalent: the same
// person wants a different introduction in a work server than in a games one.
// Written by the member for themselves only - no permission gate, because the
// only row it can touch is your own.
router.patch('/servers/:id/members/me/bio', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  const membership = await getMembership(serverId, req.user.id);
  if (!membership) return res.status(403).json({ error: 'You are not a member of this server.' });
  const bio = trim(req.body.bio).slice(0, 190);
  await query('UPDATE server_members SET bio = $1 WHERE server_id = $2 AND user_id = $3', [
    bio,
    serverId,
    req.user.id
  ]);
  res.json({ serverId, bio });
}));

router.patch('/servers/:id/members/:userId', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  const targetId = Number(req.params.userId);
  const actor = await getMembership(serverId, req.user.id);
  if (!actor) return res.status(403).json({ error: 'You are not a member of this server.' });
  if (!(await hasServerPermission(serverId, req.user.id, 'manageGroups', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to manage groups." });
  }

  const target = await getMembership(serverId, targetId);
  if (!target) return res.status(404).json({ error: 'Member not found.' });
  if (target.role === 'owner') {
    return res.status(400).json({ error: 'The owner role cannot be changed.' });
  }

  const privileged = actor.role === 'owner' || req.user.role === 'admin';
  if (!privileged && !(await canManageMember(serverId, req.user.id, targetId, 'manageGroups', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to manage this member." });
  }

  const groups = await getServerGroups(serverId);
  const adminGroup = groups.find((group) => group.name.toLowerCase() === 'admin');
  const role = req.body.role === 'admin' ? 'admin' : 'member';
  if (role === 'admin' && !adminGroup) {
    return res.status(400).json({ error: 'The Admin group is missing.' });
  }
  if (!privileged && role === 'admin') {
    const ceiling = await getHighestGroupPosition(serverId, req.user.id, req.user.role);
    if (adminGroup.position >= ceiling) {
      return res.status(403).json({ error: 'You cannot assign a group above your own rank.' });
    }
  }

  await setMemberGroups(serverId, targetId, role === 'admin' ? [adminGroup.id] : []);
  const server = await buildServer(serverId);
  req.app.get('io').to(`server:${serverId}`).emit('server:updated', server);
  res.json({ server });
}));

router.delete('/servers/:id/members/:userId', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  const targetId = Number(req.params.userId);
  const actorMembership = await getMembership(serverId, req.user.id);
  if (!actorMembership) return res.status(403).json({ error: 'You are not in this server.' });

  const isSelf = targetId === req.user.id;
  const targetMembership = await getMembership(serverId, targetId);
  if (!targetMembership) return res.status(404).json({ error: 'Member not found' });
  if (targetMembership.role === 'owner') return res.status(400).json({ error: 'The owner cannot be removed.' });
  if (!isSelf && !(await canManageMember(serverId, req.user.id, targetId, 'kickMembers', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to remove this member." });
  }

  await withTransaction(async () => {
    await query('DELETE FROM server_member_groups WHERE server_id = $1 AND user_id = $2', [serverId, targetId]);
    await query('DELETE FROM server_members WHERE server_id = $1 AND user_id = $2', [serverId, targetId]);
    await forgetServerAccess(serverId, targetId);
  });
  const io = req.app.get('io');
  // Emit before dropping the room: the kicked user's own sockets are still in
  // server:<id> (and always in user:<id>), so this is the only way their client
  // hears that they were removed. io.to(...).to(...) delivers once per socket.
  io.to(`user:${targetId}`).to(`server:${serverId}`).emit('server:member-left', {
    serverId,
    userId: targetId
  });
  emitToServerBots(io, serverId, 'members', 'MEMBER_LEAVE', {
    serverId: Number(serverId),
    userId: Number(targetId)
  });
  await evictServerSockets(io, serverId, targetId);
  const [serverRow, targetUser] = await Promise.all([
    query('SELECT * FROM servers WHERE id = $1', [serverId]),
    query('SELECT * FROM users WHERE id = $1', [targetId])
  ]);
  if (serverRow.rows[0] && targetUser.rows[0]) {
    await announcePresence(io, serverRow.rows[0], targetUser.rows[0], 'kick');
  }
  res.json({ ok: true });
}));

router.get('/servers/:id/export', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await hasServerPermission(serverId, req.user.id, 'manageServer', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to export this server." });
  }
  try {
    const includeMessages = req.query.messages !== '0';
    const data = await exportServer(serverId, { includeMessages });
    const filename =
      String(data.server.name || 'cordia-server')
        .replace(/[^a-z0-9._-]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48) || 'cordia-server';
    await logAudit(
      req.user.id,
      'server.export',
      'server',
      serverId,
      includeMessages ? 'with messages' : 'without messages'
    );
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.cordia.json"`);
    res.send(JSON.stringify(data, null, 2));
  } catch (error) {
    if (error instanceof TransferError) {
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  }
}));

router.post('/servers/:id/import/preview', authRequired, receiveTransferFiles, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await canImportServerData(serverId, req.user))) {
    return res.status(403).json({ error: 'Only server owners and admins can import server data.' });
  }
  try {
    const parsed = parseImportFiles(req.files);
    const plan = await buildImportPlan(serverId, parsed);
    res.json({ plan: publicPlan(plan) });
  } catch (error) {
    if (error instanceof TransferError) {
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  }
}));

router.post('/servers/:id/import', authRequired, receiveTransferFiles, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await canImportServerData(serverId, req.user))) {
    return res.status(403).json({ error: 'Only server owners and admins can import server data.' });
  }
  try {
    const parsed = parseImportFiles(req.files);
    const result = await applyImport(serverId, parsed);
    await logAudit(
      req.user.id,
      'server.import',
      'server',
      serverId,
      `categories:${result.imported.categories} channels:${result.imported.channels} groups:${result.imported.groups} emotes:${result.imported.emotes} messages:${result.imported.messages}`
    );
    const server = await emitServerUpdate(req, serverId);
    res.json({ server, imported: result.imported, plan: result.plan });
  } catch (error) {
    if (error instanceof TransferError) {
      return res.status(error.status).json({ error: error.message });
    }
    throw error;
  }
}));

module.exports = router;
