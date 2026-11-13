'use strict';
const express = require('express');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query, withTransaction } = require('../pg/pool');
const { authRequired } = require('../auth');
const { canManageServer, getMembership } = require('../util');
const { normalizePermissions } = require('../permissions');
const { recordAudit, auditFor } = require('../appAudit');
const { SERVER_PERMISSIONS } = require('../permissionCatalog');
const { mintToken, hashToken } = require('../botToken');
const {
  createBotUser,
  botPublicUser,
  emitToApp,
  forgetServer,
  forgetApp,
  intentsOf,
  revokeSessions,
  INTENTS
} = require('../bots');

const router = express.Router();

const NAME_RE = /^[a-z0-9_-]{1,32}$/;
const OPTION_TYPES = new Set(['string', 'integer', 'boolean', 'user', 'channel']);
const MAX_APPS = 10;
const MAX_COMMANDS = 25;

function appPayload(row, extra = {}) {
  return {
    id: Number(row.id),
    name: row.name,
    description: row.description || '',
    clientId: row.client_id,
    tokenHint: row.token_hint || '',
    bot: botPublicUser({
      id: Number(row.bot_user_id),
      username: row.bot_username || '',
      display_name: row.bot_display_name || row.name,
      avatar_color: row.bot_avatar_color || '#6366f1',
      avatar_url: row.bot_avatar_url || '',
      bot_application_id: row.id
    }),
    intents: String(row.intents || '').split(',').filter(Boolean),
    verified: !!row.verified_at,
    createdAt: Number(row.created_at),
    ...extra
  };
}

async function loadApp(id) {
  const { rows } = await query(
    `SELECT a.*, u.username AS bot_username, u.display_name AS bot_display_name,
            u.avatar_color AS bot_avatar_color, u.avatar_url AS bot_avatar_url
       FROM applications a JOIN users u ON u.id = a.bot_user_id
      WHERE a.id = $1`,
    [Number(id)]
  );
  return rows[0] || null;
}

function ownedBy(row, user) {
  return row && (Number(row.owner_id) === Number(user.id) || user.role === 'admin');
}

// One level of nesting, which is what a subcommand is: "/admin ban" is a command
// with a subcommand called ban. A subcommand group is the level above it, for the
// cases where "/config set" and "/config show" want to sit under one word.
const NESTED_TYPES = new Set(['subcommand', 'subcommand_group']);

function cleanOptions(input, depth = 0, parentType = 'command') {
  if (input === undefined) return { options: [] };
  if (!Array.isArray(input)) return { error: 'Options must be a list.' };
  if (input.length > 5) return { error: 'A command can have at most 5 options.' };

  const options = [];
  for (const raw of input) {
    const name = String(raw?.name || '').trim().toLowerCase();
    if (!NAME_RE.test(name)) return { error: 'Option names use lowercase letters, numbers, _ and -.' };
    const type = String(raw?.type || 'string').toLowerCase();
    if (!OPTION_TYPES.has(type) && !NESTED_TYPES.has(type)) {
      return { error: `Unknown option type: ${type}` };
    }

    if (NESTED_TYPES.has(type)) {
      // Two levels is the whole model: a command holds a subcommand or a group,
      // and a group holds subcommands. Anything deeper is refused rather than
      // silently flattened into something the parser cannot resolve.
      if (depth >= 2) return { error: 'Subcommands cannot be nested inside each other.' };
      if (type === 'subcommand' && parentType === 'subcommand') {
        return { error: 'Subcommands cannot be nested inside each other.' };
      }
      if (type === 'subcommand_group' && parentType !== 'command') {
        return { error: 'A group can only sit directly under a command.' };
      }
      const inner = cleanOptions(raw?.options, depth + 1, type);
      if (inner.error) return { error: inner.error };
      if (!inner.options.length) return { error: `${name} needs at least one option.` };
      if (type === 'subcommand_group' && inner.options.some((entry) => entry.type !== 'subcommand')) {
        return { error: 'A group can only contain subcommands.' };
      }
      options.push({
        name,
        description: String(raw?.description || '').slice(0, 100),
        type,
        required: false,
        options: inner.options
      });
      continue;
    }

    const autocomplete = !!raw?.autocomplete;
    // Numbers can be suggested too — a list of years, a list of ids. Booleans
    // and picks cannot: there is nothing to narrow down.
    if (autocomplete && type !== 'string' && type !== 'integer') {
      return { error: 'Only text and number options can offer suggestions.' };
    }
    options.push({
      name,
      description: String(raw?.description || '').slice(0, 100),
      type,
      required: !!raw?.required,
      ...(autocomplete ? { autocomplete: true } : {})
    });
  }
  return { options };
}

// Which server permissions somebody needs before they can run the command. An
// empty list means "anyone who can post here", which is what every command meant
// before this existed, so a command written yesterday still works.
function cleanPermissions(input) {
  if (input === undefined || input === null) return { permissions: [] };
  if (!Array.isArray(input)) return { error: 'Permissions must be a list.' };
  const unknown = input.filter((entry) => !SERVER_PERMISSIONS.includes(entry));
  if (unknown.length) return { error: `Unknown permission: ${unknown[0]}` };
  return { permissions: normalizePermissions(input) };
}

// Descriptions in other languages. A name is not localised: it is what people
// type, and a command that changes its name by locale cannot be typed from
// memory. Ten locales is enough for a command; more is a translation pipeline.
const MAX_LOCALES = 10;

function cleanLocalizations(input) {
  if (input === undefined || input === null) return { localizations: {} };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Localizations must be an object of locale to text.' };
  }
  const entries = Object.entries(input);
  if (entries.length > MAX_LOCALES) {
    return { error: `A command can carry ${MAX_LOCALES} translations.` };
  }
  const localizations = {};
  for (const [rawLocale, value] of entries) {
    const locale = String(rawLocale).trim().toLowerCase().slice(0, 10);
    if (!/^[a-z]{2}(-[a-z0-9]{2,8})?$/.test(locale)) {
      return { error: `"${rawLocale}" is not a language code.` };
    }
    const description = String(value?.description || '').trim().slice(0, 100);
    if (!description) return { error: `${locale} needs a description.` };
    const options = {};
    for (const [optionName, optionValue] of Object.entries(value?.options || {})) {
      const text = String(optionValue || '').trim().slice(0, 100);
      if (text) options[String(optionName).toLowerCase()] = text;
    }
    localizations[locale] = { description, ...(Object.keys(options).length ? { options } : {}) };
  }
  return { localizations };
}

// ── The developer's own applications ────────────────────────────────────────

router.get('/applications', authRequired, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT a.*, u.username AS bot_username, u.display_name AS bot_display_name,
            u.avatar_color AS bot_avatar_color, u.avatar_url AS bot_avatar_url,
            (SELECT COUNT(*)::int FROM application_commands c WHERE c.application_id = a.id) AS command_count,
            (SELECT COUNT(*)::int FROM application_installs i WHERE i.application_id = a.id) AS install_count
       FROM applications a JOIN users u ON u.id = a.bot_user_id
      WHERE a.owner_id = $1
      ORDER BY a.id ASC`,
    [req.user.id]
  );
  res.json({
    applications: rows.map((row) =>
      appPayload(row, { commandCount: row.command_count, installCount: row.install_count })
    )
  });
}));

router.post('/applications', authRequired, asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 32);
  const description = String(req.body.description || '').trim().slice(0, 200);
  if (name.length < 2) return res.status(400).json({ error: 'Give the application a name.' });

  const count = (await query('SELECT COUNT(*)::int AS c FROM applications WHERE owner_id = $1', [req.user.id]))
    .rows[0].c;
  if (count >= MAX_APPS) {
    return res.status(400).json({ error: `You can own ${MAX_APPS} applications.` });
  }

  const minted = mintToken();
  const clientId = minted.hash.slice(0, 18);
  const created = await withTransaction(async () => {
    const bot = await createBotUser(name);
    const { rows } = await query(
      `INSERT INTO applications (owner_id, name, description, client_id, token_hash, token_hint, bot_user_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.user.id, name, description, clientId, minted.hash, minted.hint, bot.id, Date.now()]
    );
    await query('UPDATE users SET bot_application_id = $1 WHERE id = $2', [rows[0].id, bot.id]);
    return rows[0];
  });

  const row = await loadApp(created.id);
  // The plaintext token exists exactly once, here. It is stored as sha256.
  res.status(201).json({ application: appPayload(row), token: minted.token });
}));

// Editing an application: rename it, or narrow which events it subscribes to.
router.patch('/applications/:id', authRequired, asyncHandler(async (req, res) => {
  const row = await loadApp(req.params.id);
  if (!ownedBy(row, req.user)) return res.status(404).json({ error: 'Application not found.' });

  const fields = [];
  const values = [];
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim().slice(0, 32);
    if (name.length < 2) return res.status(400).json({ error: 'Give the application a name.' });
    fields.push(`name = $${fields.length + 1}`);
    values.push(name);
  }
  if (req.body.description !== undefined) {
    fields.push(`description = $${fields.length + 1}`);
    values.push(String(req.body.description).trim().slice(0, 200));
  }
  if (req.body.intents !== undefined) {
    if (!Array.isArray(req.body.intents)) {
      return res.status(400).json({ error: 'Intents must be a list.' });
    }
    const unknown = req.body.intents.filter((intent) => !INTENTS.includes(intent));
    if (unknown.length) {
      return res.status(400).json({ error: 'Unknown intent: ' + unknown[0] });
    }
    fields.push(`intents = $${fields.length + 1}`);
    values.push([...new Set(req.body.intents)].join(','));
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update.' });

  values.push(row.id);
  await query(`UPDATE applications SET ${fields.join(', ')} WHERE id = $${values.length}`, values);
  // Intents are cached with the install index, so a change has to drop it.
  forgetApp(row.id);
  const updated = await loadApp(row.id);
  res.json({ application: appPayload(updated) });
}));

router.post('/applications/:id/token', authRequired, asyncHandler(async (req, res) => {
  const row = await loadApp(req.params.id);
  if (!ownedBy(row, req.user)) return res.status(404).json({ error: 'Application not found.' });
  const minted = mintToken();
  await query('UPDATE applications SET token_hash = $1, token_hint = $2 WHERE id = $3', [
    minted.hash,
    minted.hint,
    row.id
  ]);
  // Rotating a token has to cut off whoever holds the old one, or the rotation is
  // a formality. The rows go and the sockets are closed in the same breath.
  await revokeSessions(row.id, 'token_rotated');
  recordAudit(row.id, 'token_rotated', { actorId: req.user.id });
  res.json({ token: minted.token, tokenHint: minted.hint });
}));

// Everything that had access to this application stops having it, without
// changing the token. Useful when a bot is suspected compromised but the
// replacement token has not been deployed yet.
router.post('/applications/:id/sessions/revoke', authRequired, asyncHandler(async (req, res) => {
  const row = await loadApp(req.params.id);
  if (!ownedBy(row, req.user)) return res.status(404).json({ error: 'Application not found.' });
  const closed = await revokeSessions(row.id, 'revoked');
  recordAudit(row.id, 'sessions_revoked', { actorId: req.user.id, detail: { closed } });
  res.json({ ok: true, closed });
}));

router.delete('/applications/:id', authRequired, asyncHandler(async (req, res) => {
  const row = await loadApp(req.params.id);
  if (!ownedBy(row, req.user)) return res.status(404).json({ error: 'Application not found.' });
  // The bot's messages stay: deleting a bot should not rewrite history. The
  // user row survives without an application, so the token can never resolve
  // again, and the memberships go so it stops appearing in member lists.
  await withTransaction(async () => {
    await query('DELETE FROM server_members WHERE user_id = $1', [row.bot_user_id]);
    await query('DELETE FROM applications WHERE id = $1', [row.id]);
  });
  await revokeSessions(row.id, 'application_deleted');
  forgetApp(row.id);
  res.json({ ok: true });
}));

// The audit trail, newest first. Owner only: it names people.
router.get('/applications/:id/audit', authRequired, asyncHandler(async (req, res) => {
  const row = await loadApp(req.params.id);
  if (!ownedBy(row, req.user)) return res.status(404).json({ error: 'Application not found.' });
  res.json({ entries: await auditFor(row.id, req.query.limit) });
}));

// ── Commands ────────────────────────────────────────────────────────────────

router.get('/applications/:id/commands', authRequired, asyncHandler(async (req, res) => {
  const row = await loadApp(req.params.id);
  if (!ownedBy(row, req.user)) return res.status(404).json({ error: 'Application not found.' });
  const { rows } = await query(
    'SELECT * FROM application_commands WHERE application_id = $1 ORDER BY name',
    [row.id]
  );
  res.json({
    commands: rows.map((command) => ({
      id: Number(command.id),
      name: command.name,
      description: command.description,
      options: command.options || [],
      permissions: command.permissions || [],
      localizations: command.localizations || {}
    }))
  });
}));

router.post('/applications/:id/commands', authRequired, asyncHandler(async (req, res) => {
  const row = await loadApp(req.params.id);
  if (!ownedBy(row, req.user)) return res.status(404).json({ error: 'Application not found.' });

  const name = String(req.body.name || '').trim().toLowerCase().replace(/^\//, '');
  const description = String(req.body.description || '').trim().slice(0, 100);
  if (!NAME_RE.test(name)) {
    return res.status(400).json({ error: 'Command names use lowercase letters, numbers, _ and -.' });
  }
  if (!description) return res.status(400).json({ error: 'Commands need a short description.' });
  const parsed = cleanOptions(req.body.options);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const required = cleanPermissions(req.body.permissions);
  if (required.error) return res.status(400).json({ error: required.error });
  const translated = cleanLocalizations(req.body.localizations);
  if (translated.error) return res.status(400).json({ error: translated.error });

  const existing = (
    await query('SELECT COUNT(*)::int AS c FROM application_commands WHERE application_id = $1', [row.id])
  ).rows[0].c;
  if (existing >= MAX_COMMANDS) {
    return res.status(400).json({ error: `An application can register ${MAX_COMMANDS} commands.` });
  }

  try {
    const { rows } = await query(
      `INSERT INTO application_commands
         (application_id, name, description, options, permissions, localizations, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        row.id,
        name,
        description,
        JSON.stringify(parsed.options),
        JSON.stringify(required.permissions),
        JSON.stringify(translated.localizations),
        Date.now()
      ]
    );
    recordAudit(row.id, 'command_created', {
      actorId: req.user.id,
      detail: { name, permissions: required.permissions }
    });
    res.status(201).json({
      command: {
        id: Number(rows[0].id),
        name: rows[0].name,
        description: rows[0].description,
        options: rows[0].options || [],
        permissions: rows[0].permissions || [],
        localizations: rows[0].localizations || {}
      }
    });
  } catch (error) {
    if (error.code === '23505') return res.status(400).json({ error: 'That command already exists.' });
    throw error;
  }
}));

// Editing a command in place. Deleting and recreating it worked, but it changed
// the id and lost the thing people actually wanted to change: who may run it.
router.patch('/applications/:id/commands/:commandId', authRequired, asyncHandler(async (req, res) => {
  const row = await loadApp(req.params.id);
  if (!ownedBy(row, req.user)) return res.status(404).json({ error: 'Application not found.' });

  const commandId = Number(req.params.commandId);
  const existing = (
    await query('SELECT * FROM application_commands WHERE id = $1 AND application_id = $2', [
      commandId,
      row.id
    ])
  ).rows[0];
  if (!existing) return res.status(404).json({ error: 'Command not found.' });

  const fields = [];
  const values = [];
  if (req.body.description !== undefined) {
    const description = String(req.body.description).trim().slice(0, 100);
    if (!description) return res.status(400).json({ error: 'Commands need a short description.' });
    fields.push(`description = $${fields.length + 1}`);
    values.push(description);
  }
  if (req.body.options !== undefined) {
    const parsed = cleanOptions(req.body.options);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    fields.push(`options = $${fields.length + 1}`);
    values.push(JSON.stringify(parsed.options));
  }
  if (req.body.permissions !== undefined) {
    const required = cleanPermissions(req.body.permissions);
    if (required.error) return res.status(400).json({ error: required.error });
    fields.push(`permissions = $${fields.length + 1}`);
    values.push(JSON.stringify(required.permissions));
  }
  if (req.body.localizations !== undefined) {
    const translated = cleanLocalizations(req.body.localizations);
    if (translated.error) return res.status(400).json({ error: translated.error });
    fields.push(`localizations = $${fields.length + 1}`);
    values.push(JSON.stringify(translated.localizations));
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to change.' });

  values.push(commandId);
  const { rows } = await query(
    `UPDATE application_commands SET ${fields.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );
  recordAudit(row.id, 'command_updated', {
    actorId: req.user.id,
    detail: { name: rows[0].name, permissions: rows[0].permissions || [] }
  });
  res.json({
    command: {
      id: Number(rows[0].id),
      name: rows[0].name,
      description: rows[0].description,
      options: rows[0].options || [],
      permissions: rows[0].permissions || [],
      localizations: rows[0].localizations || {}
    }
  });
}));

router.delete('/applications/:id/commands/:commandId', authRequired, asyncHandler(async (req, res) => {
  const row = await loadApp(req.params.id);
  if (!ownedBy(row, req.user)) return res.status(404).json({ error: 'Application not found.' });
  const removed = await query(
    'DELETE FROM application_commands WHERE id = $1 AND application_id = $2 RETURNING name',
    [Number(req.params.commandId), row.id]
  );
  if (removed.rows[0]) {
    recordAudit(row.id, 'command_deleted', { actorId: req.user.id, detail: { name: removed.rows[0].name } });
  }
  res.json({ ok: true });
}));

// ── Installing into a server ────────────────────────────────────────────────

// Only servers where the caller actually holds manageServer can host an app, so
// the picker is filtered server-side instead of offering choices that 403.
router.get('/applications/servers', authRequired, asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT s.id, s.name FROM servers s
       JOIN server_members m ON m.server_id = s.id AND m.user_id = $1
      ORDER BY s.name ASC`,
    [req.user.id]
  );
  const servers = [];
  for (const row of rows) {
    if (await canManageServer(row.id, req.user.id)) servers.push({ id: Number(row.id), name: row.name });
  }
  res.json({ servers });
}));

router.get('/applications/:id/installs', authRequired, asyncHandler(async (req, res) => {
  const row = await loadApp(req.params.id);
  if (!ownedBy(row, req.user)) return res.status(404).json({ error: 'Application not found.' });
  const { rows } = await query(
    `SELECT i.server_id, s.name, i.created_at
       FROM application_installs i JOIN servers s ON s.id = i.server_id
      WHERE i.application_id = $1 ORDER BY s.name`,
    [row.id]
  );
  res.json({
    installs: rows.map((install) => ({
      serverId: Number(install.server_id),
      name: install.name,
      createdAt: Number(install.created_at)
    }))
  });
}));

// Shared by the in-app install picker and the public install link. Both grant
// the same access, so both go through one function rather than two copies that
// drift apart.
// A scope is a narrower subscription than the application declared: installing
// with ?intents=messages means this server sends it messages and nothing else.
// An unknown intent is refused rather than dropped, because a typo that silently
// narrows nothing is worse than an error.
function cleanScopes(input) {
  if (input === undefined || input === null || input === '') return { intents: null };
  const list = Array.isArray(input) ? input : String(input).split(',');
  const cleaned = list.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean);
  const unknown = cleaned.filter((entry) => !INTENTS.includes(entry));
  if (unknown.length) return { error: `Unknown intent: ${unknown[0]}` };
  if (!cleaned.length) return { intents: null };
  return { intents: INTENTS.filter((intent) => cleaned.includes(intent)).join(',') };
}

async function installApplication(io, row, serverId, userId, scopes = null) {
  const existing = await getMembership(serverId, row.bot_user_id);
  if (!existing) {
    await query(
      'INSERT INTO server_members (server_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4)',
      [serverId, row.bot_user_id, 'member', Date.now()]
    );
  }
  await query(
    `INSERT INTO application_installs (application_id, server_id, installed_by, intents, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (application_id, server_id) DO UPDATE SET intents = COALESCE(EXCLUDED.intents, application_installs.intents)`,
    [row.id, serverId, userId, scopes, Date.now()]
  );
  forgetServer(serverId);

  const server = (await query('SELECT id, name FROM servers WHERE id = $1', [serverId])).rows[0];
  if (io && server) {
    emitToApp(io, row.id, 'GUILD_CREATE', { id: Number(server.id), name: server.name });
  }
  return server;
}

router.post('/applications/:id/install', authRequired, asyncHandler(async (req, res) => {
  const row = await loadApp(req.params.id);
  if (!ownedBy(row, req.user)) return res.status(404).json({ error: 'Application not found.' });
  const serverId = Number(req.body.serverId);
  if (!serverId) return res.status(400).json({ error: 'Pick a server.' });
  // Installing grants a bot access to a server, so it needs the same permission
  // as adding a channel: manageServer, not mere membership.
  if (!(await canManageServer(serverId, req.user.id))) {
    return res.status(403).json({ error: "You need the Manage server permission to add an application." });
  }
  const scopes = cleanScopes(req.body.intents);
  if (scopes.error) return res.status(400).json({ error: scopes.error });
  const server = await installApplication(req.app.get('io'), row, serverId, req.user.id, scopes.intents);
  recordAudit(row.id, 'install', {
    serverId,
    actorId: req.user.id,
    detail: { name: server?.name || '', intents: scopes.intents }
  });
  res.json({ ok: true, serverId, name: server?.name || '' });
}));

router.delete('/applications/:id/install/:serverId', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.serverId);
  const row = await loadApp(req.params.id);
  const manages = serverId ? await canManageServer(serverId, req.user.id) : false;
  // Two people may remove a bot: its owner, and a manager of the server it sits
  // in. A manager could not remove somebody else's bot before this, which made
  // "add a bot to my server" a one-way door for everyone but the author.
  if (!row || (!ownedBy(row, req.user) && !manages)) {
    return res.status(404).json({ error: 'Application not found.' });
  }
  if (!manages) {
    return res.status(403).json({ error: 'You need the Manage server permission to remove an application.' });
  }
  await withTransaction(async () => {
    await query('DELETE FROM application_installs WHERE application_id = $1 AND server_id = $2', [
      row.id,
      serverId
    ]);
    forgetServer(serverId);
    await query('DELETE FROM server_members WHERE server_id = $1 AND user_id = $2', [
      serverId,
      row.bot_user_id
    ]);
  });
  // Commands are registered per application, not per install — the same command
  // exists in every server the bot is in — so removing one install must not
  // delete them. They are only ever *offered* where the app is installed, which
  // is what the composer's join already enforces.
  // A live gateway learns the same way it learns about an install.
  emitToApp(req.app.get('io'), row.id, 'GUILD_DELETE', { id: serverId });
  recordAudit(row.id, 'uninstall', {
    serverId,
    actorId: req.user.id,
    detail: { byOwner: ownedBy(row, req.user) && !manages }
  });
  res.json({ ok: true });
}));

// Which of this person's servers already have the application. The install page
// needs it to say "already here" instead of offering to add it twice.
router.get('/applications/installed', authRequired, asyncHandler(async (req, res) => {
  const clientId = String(req.query.clientId || '');
  if (!clientId) return res.status(400).json({ error: 'Missing application.' });
  const app = (await query('SELECT id FROM applications WHERE client_id = $1', [clientId])).rows[0];
  if (!app) return res.status(404).json({ error: 'Application not found.' });

  const { rows } = await query(
    `SELECT i.server_id, s.name FROM application_installs i
       JOIN servers s ON s.id = i.server_id
      WHERE i.application_id = $1`,
    [app.id]
  );
  // One check per install, in parallel. The alternative is a single query that
  // reimplements the permission model in SQL, which is how the two drift apart.
  const allowed = await Promise.all(
    rows.map((install) => canManageServer(install.server_id, req.user.id))
  );
  const servers = rows
    .filter((install, index) => allowed[index])
    .map((install) => ({ serverId: Number(install.server_id), name: install.name }));
  res.json({ servers });
}));

// ── The install link ────────────────────────────────────────────────────────

// What a stranger holding the link is allowed to know: the name, what it does,
// what it will be able to read, and who built it. No token, no membership, no
// session — the same surface a store listing would have.
router.get('/applications/public/:clientId', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT a.id, a.name, a.description, a.client_id, a.created_at, a.intents, a.verified_at, a.bot_user_id,
            u.username, u.display_name, u.avatar_color, u.avatar_url
       FROM applications a JOIN users u ON u.id = a.bot_user_id
      WHERE a.client_id = $1`,
    [String(req.params.clientId)]
  );
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'Application not found.' });

  const [commands, counts] = await Promise.all([
    query('SELECT name, description FROM application_commands WHERE application_id = $1 ORDER BY name', [row.id]),
    query('SELECT COUNT(*)::int AS installs FROM application_installs WHERE application_id = $1', [row.id])
  ]);

  res.json({
    application: {
      // The numeric id is a public handle, not a credential; the page needs it to
      // remove an install and the client id is already in the URL.
      id: Number(row.id),
      name: row.name,
      description: row.description || '',
      clientId: row.client_id,
      verified: !!row.verified_at,
      createdAt: Number(row.created_at),
      installs: counts.rows[0].installs,
      intents: intentsOf(row),
      bot: botPublicUser({
        id: Number(row.bot_user_id),
        username: row.username,
        display_name: row.display_name,
        avatar_color: row.avatar_color,
        avatar_url: row.avatar_url,
        bot_application_id: row.id
      })
    },
    commands: commands.rows.map((command) => ({ name: command.name, description: command.description }))
  });
}));

// The consent step. Same rule as the in-app picker: you can only add a bot to a
// server you manage, whichever door you came through.
router.post('/applications/authorize', authRequired, asyncHandler(async (req, res) => {
  const clientId = String(req.body.clientId || '');
  const serverId = Number(req.body.serverId);
  if (!clientId) return res.status(400).json({ error: 'Missing application.' });
  if (!serverId) return res.status(400).json({ error: 'Pick a server.' });

  const { rows } = await query('SELECT * FROM applications WHERE client_id = $1', [clientId]);
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'Application not found.' });
  if (!(await canManageServer(serverId, req.user.id))) {
    return res.status(403).json({ error: "You need the Manage server permission to add an application." });
  }

  const scopes = cleanScopes(req.body.intents);
  if (scopes.error) return res.status(400).json({ error: scopes.error });
  const server = await installApplication(req.app.get('io'), row, serverId, req.user.id, scopes.intents);
  recordAudit(row.id, 'install', {
    serverId,
    actorId: req.user.id,
    detail: { name: server?.name || '', intents: scopes.intents, viaLink: true }
  });
  res.json({
    ok: true,
    serverId,
    name: server?.name || '',
    intents: scopes.intents,
    application: { id: Number(row.id), name: row.name }
  });
}));

// ── Bot-facing ──────────────────────────────────────────────────────────────

// "Who am I" for a running bot. Requires a bot token, not a session.
router.get('/applications/@me', authRequired, asyncHandler(async (req, res) => {
  if (!req.bot) return res.status(403).json({ error: 'This route requires a bot token.' });
  const row = await loadApp(req.bot.id);
  const { rows: installs } = await query(
    'SELECT server_id FROM application_installs WHERE application_id = $1',
    [row.id]
  );
  res.json({
    application: appPayload(row),
    servers: installs.map((install) => Number(install.server_id))
  });
}));

module.exports = { router, loadApp, appPayload, ownedBy };
