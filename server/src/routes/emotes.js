const express = require('express');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query, withTransaction } = require('../pg/pool');
const { authRequired, rateLimit } = require('../auth');
const { hasServerPermission } = require('../permissions');
const {
  getMembership,
  buildServer,
  attachEmoteAccess,
  trim,
  isImageUpload,
  logAudit,
  deleteUploadIfUnused
} = require('../util');
const {
  EMOTE_NAME_RE,
  EMOTE_KINDS,
  KIND_LIMITS,
  UPLOAD_URL_RE,
  listServerEmotes,
  getServerEmote,
  findEmoteByName,
  countEmotes,
  normalizeName
} = require('../emotes');

const router = express.Router();

const manageLimiter = rateLimit({
  windowMs: 60_000,
  max: 40,
  message: 'Too many emote changes. Try again in a minute.'
});

async function publish(req, serverId) {
  const server = await buildServer(serverId);
  if (server) req.app.get('io').to(`server:${serverId}`).emit('server:updated', server);
  return server;
}

// Boosting buys extra slots for both kinds: every boost level adds the same
// number on top of KIND_LIMITS. Level 0 has to stay exactly KIND_LIMITS so an
// unboosted server keeps the numbers it had before boosts existed.
const SLOTS_PER_BOOST_LEVEL = { emote: 25, sticker: 12 };

async function emoteCap(serverId, kind) {
  const { rows } = await query('SELECT boost_level FROM servers WHERE id = $1', [Number(serverId)]);
  const boostLevel = Math.max(0, Math.min(3, Number(rows[0]?.boost_level) || 0));
  return KIND_LIMITS[kind] + boostLevel * (SLOTS_PER_BOOST_LEVEL[kind] || 0);
}

async function guard(req, res) {
  const serverId = Number(req.params.id);
  if (!Number.isInteger(serverId) || serverId <= 0) {
    res.status(400).json({ error: 'Invalid server.' });
    return null;
  }
  const membership = await getMembership(serverId, req.user.id);
  if (!membership) {
    res.status(403).json({ error: 'You are not a member of this server.' });
    return null;
  }
  return serverId;
}

// An emote can only be locked to groups of the server that owns it. A group id
// from another server is rejected instead of silently dropped: quietly ignoring
// it would leave an emote looking restricted while it is still open to everyone.
async function readRestrictedGroupIds(value, serverId) {
  if (value === undefined) return { provided: false, ids: [] };
  if (!Array.isArray(value)) {
    return { provided: true, error: 'restrictedGroupIds must be an array of group ids.' };
  }
  const ids = [];
  const seen = new Set();
  for (const entry of value) {
    const id = Number(entry);
    if (!Number.isInteger(id) || id <= 0) {
      return { provided: true, error: 'Invalid group id.' };
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (!ids.length) return { provided: true, ids };
  const owned = new Set(
    (
      await query(
        `SELECT id FROM server_groups
         WHERE server_id = $1 AND id IN (SELECT (value)::bigint FROM jsonb_array_elements_text($2::jsonb))`,
        [Number(serverId), JSON.stringify(ids)]
      )
    ).rows.map((row) => Number(row.id))
  );
  const foreign = ids.filter((id) => !owned.has(id));
  if (foreign.length) {
    return {
      provided: true,
      error: `These groups do not belong to this server: ${foreign.join(', ')}.`
    };
  }
  return { provided: true, ids };
}

async function replaceEmoteAccess(emoteId, groupIds) {
  await query('DELETE FROM emote_role_access WHERE emote_id = $1', [Number(emoteId)]);
  for (const groupId of groupIds) {
    await query(
      'INSERT INTO emote_role_access (emote_id, group_id) VALUES ($1, $2) ON CONFLICT (emote_id, group_id) DO NOTHING',
      [Number(emoteId), Number(groupId)]
    );
  }
}

// getServerEmote() returns the shared serialisation, which has no access data;
// decorate it so create/patch responses look like the list payload.
async function decorate(emote) {
  return emote ? (await attachEmoteAccess([emote]))[0] : emote;
}

// Every emote the caller can see, across every server they belong to. This is
// what makes custom emoji usable outside a message box: a bio, a doc, a channel
// topic - anywhere the picker opens, the pool is the same one the composer uses.
// Restricted emotes are included only when the caller holds one of the groups
// the owning server gated them to; a name that exists in several servers keeps
// the first (lowest server id) so the reply is stable between calls.
router.get('/emotes/mine', authRequired, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT e.id, e.server_id, e.name, e.kind, e.url, s.name AS server_name
       FROM server_emotes e
       JOIN servers s ON s.id = e.server_id
       JOIN server_members m ON m.server_id = e.server_id AND m.user_id = $1
      ORDER BY e.server_id ASC, e.kind ASC, lower(e.name) ASC
      LIMIT 2000`,
    [req.user.id]
  );
  const mine = await attachEmoteAccess(rows.map((row) => ({
    id: Number(row.id),
    serverId: Number(row.server_id),
    serverName: row.server_name,
    name: row.name,
    kind: row.kind,
    url: row.url
  })));
  const { rows: held } = await query(
    'SELECT server_id, group_id FROM server_member_groups WHERE user_id = $1',
    [req.user.id]
  );
  const heldByServer = new Map();
  for (const row of held) {
    const key = Number(row.server_id);
    if (!heldByServer.has(key)) heldByServer.set(key, new Set());
    heldByServer.get(key).add(Number(row.group_id));
  }
  const seen = new Set();
  const emotes = [];
  for (const emote of mine) {
    if (emote.restricted) {
      const groups = heldByServer.get(emote.serverId);
      if (!groups || !emote.groupIds.some((id) => groups.has(id))) continue;
    }
    const key = String(emote.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    emotes.push(emote);
  }
  res.json({ emotes });
}));

router.get('/servers/:id/emotes', authRequired, asyncHandler(async (req, res) => {
  const serverId = await guard(req, res);
  if (!serverId) return;
  res.json({ emotes: await attachEmoteAccess(await listServerEmotes(serverId)) });
}));

router.post('/servers/:id/emotes', authRequired, manageLimiter, asyncHandler(async (req, res) => {
  const serverId = await guard(req, res);
  if (!serverId) return;
  if (!(await hasServerPermission(serverId, req.user.id, 'manageServer', req.user.role))) {
    return res.status(403).json({ error: 'You need the Manage server permission.' });
  }

  const name = normalizeName(req.body.name);
  const kind = EMOTE_KINDS.includes(trim(req.body.kind)) ? trim(req.body.kind) : 'emote';
  const url = trim(req.body.url);

  if (!EMOTE_NAME_RE.test(name)) {
    return res.status(400).json({
      error: 'Names are 2-32 characters and can only use letters, numbers, and underscores.'
    });
  }
  if (!UPLOAD_URL_RE.test(url) || !isImageUpload(url)) {
    return res.status(400).json({ error: 'Upload a PNG, JPG, GIF, WebP, or AVIF image first.' });
  }
  if (await findEmoteByName(serverId, name)) {
    return res.status(409).json({ error: `This server already has an emote named :${name}:` });
  }
  const cap = await emoteCap(serverId, kind);
  if ((await countEmotes(serverId, kind)) >= cap) {
    return res.status(400).json({
      error: `This server has reached its limit of ${cap} ${kind}s. Boost the server to add more emote slots.`
    });
  }

  const access = await readRestrictedGroupIds(req.body.restrictedGroupIds, serverId);
  if (access.error) return res.status(400).json({ error: access.error });

  const now = Date.now();
  let emoteId;
  try {
    emoteId = await withTransaction(async () => {
      const { rows } = await query(
        `INSERT INTO server_emotes (server_id, name, kind, url, uploaded_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [serverId, name, kind, url, req.user.id, now]
      );
      const id = Number(rows[0].id);
      await replaceEmoteAccess(id, access.ids);
      return id;
    });
  } catch (error) {
    // UNIQUE (server_id, name): a concurrent create won the race after the
    // name check above, so answer with the same 409 the check would have.
    if (error.code === '23505') {
      return res.status(409).json({ error: `This server already has an emote named :${name}:` });
    }
    throw error;
  }

  await logAudit(req.user.id, 'emote.create', 'server_emote', emoteId, `:${name}:`);

  const emote = await decorate(await getServerEmote(serverId, emoteId));
  res.status(201).json({ emote, server: await publish(req, serverId) });
}));

router.patch('/servers/:id/emotes/:emoteId', authRequired, manageLimiter, asyncHandler(async (req, res) => {
  const serverId = await guard(req, res);
  if (!serverId) return;
  if (!(await hasServerPermission(serverId, req.user.id, 'manageServer', req.user.role))) {
    return res.status(403).json({ error: 'You need the Manage server permission.' });
  }

  const existing = await getServerEmote(serverId, req.params.emoteId);
  if (!existing) return res.status(404).json({ error: 'Emote not found.' });

  // name stays optional: a client that only changes the access list should not
  // have to resend the name.
  const renaming = req.body.name !== undefined;
  let name = existing.name;
  if (renaming) {
    name = normalizeName(req.body.name);
    if (!EMOTE_NAME_RE.test(name)) {
      return res.status(400).json({
        error: 'Names are 2-32 characters and can only use letters, numbers, and underscores.'
      });
    }
    const clash = await findEmoteByName(serverId, name);
    if (clash && clash.id !== existing.id) {
      return res.status(409).json({ error: `This server already has an emote named :${name}:` });
    }
  }

  const access = await readRestrictedGroupIds(req.body.restrictedGroupIds, serverId);
  if (access.error) return res.status(400).json({ error: access.error });

  try {
    await withTransaction(async () => {
      if (renaming) {
        await query('UPDATE server_emotes SET name = $1 WHERE id = $2', [name, existing.id]);
      }
      if (access.provided) await replaceEmoteAccess(existing.id, access.ids);
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: `This server already has an emote named :${name}:` });
    }
    throw error;
  }

  if (renaming && name !== existing.name) {
    await logAudit(req.user.id, 'emote.rename', 'server_emote', existing.id, `${existing.name} -> ${name}`);
  }
  if (access.provided) {
    await logAudit(
      req.user.id,
      'emote.access',
      'server_emote',
      existing.id,
      `:${name}: groups ${access.ids.join(',') || 'none'}`
    );
  }

  res.json({ emote: await decorate(await getServerEmote(serverId, existing.id)), server: await publish(req, serverId) });
}));

router.delete('/servers/:id/emotes/:emoteId', authRequired, manageLimiter, asyncHandler(async (req, res) => {
  const serverId = await guard(req, res);
  if (!serverId) return;
  if (!(await hasServerPermission(serverId, req.user.id, 'manageServer', req.user.role))) {
    return res.status(403).json({ error: 'You need the Manage server permission.' });
  }

  const existing = await getServerEmote(serverId, req.params.emoteId);
  if (!existing) return res.status(404).json({ error: 'Emote not found.' });

  await query('DELETE FROM server_emotes WHERE id = $1', [existing.id]);
  await deleteUploadIfUnused(existing.url);
  await logAudit(req.user.id, 'emote.delete', 'server_emote', existing.id, `:${existing.name}:`);

  res.json({ ok: true, server: await publish(req, serverId) });
}));

module.exports = router;
