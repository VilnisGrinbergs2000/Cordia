'use strict';
const crypto = require('node:crypto');
const express = require('express');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query } = require('../pg/pool');
const { authRequired, rateLimit } = require('../auth');
const { assertChannelAccess } = require('../util');
const { hasServerPermission, memberPermissions } = require('../permissions');
const { recordAudit } = require('../appAudit');
const { localize, localeFromHeader } = require('../localize');
const {
  emitToApp,
  postBotMessage,
  postEphemeral,
  validateComponents,
  validateModal
} = require('../bots');

const router = express.Router();

// A slash command is a message-shaped action, so it shares the message budget
// rather than getting an unlimited lane of its own.
const commandLimiter = rateLimit({
  windowMs: 10_000,
  max: 12,
  message: 'That is a lot of commands. Give it a second.',
  key: (req) => 'command:' + req.user.id
});

// Suggestions fire while somebody types, so they get their own, wider budget —
// sharing the command budget would throttle the composer mid-word.
const autocompleteLimiter = rateLimit({
  windowMs: 10_000,
  max: 120,
  message: 'Too many suggestions. Keep typing.',
  key: (req) => 'autocomplete:' + req.user.id
});

// A suggestion request is not an event worth keeping: it is a keystroke with a
// round trip attached. It lives in this map for at most the wait below and
// never touches the database.
const AUTOCOMPLETE_WAIT_MS = 800;
const AUTOCOMPLETE_LIMIT = 25;

// The same prefix is asked again every time typing pauses, and the answer
// almost never changes: a list of countries does not reorder between keystrokes.
// Caching it turns the second half of a word into no round trip at all.
const AUTOCOMPLETE_CACHE_MS = 20_000;
const AUTOCOMPLETE_CACHE_MAX = 500;
const autocompleteCache = new Map(); // app|option|prefix -> { choices, at }

function cachedSuggestions(key) {
  const hit = autocompleteCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > AUTOCOMPLETE_CACHE_MS) {
    autocompleteCache.delete(key);
    return null;
  }
  return hit.choices;
}

function rememberSuggestions(key, choices) {
  // A bot that answers with nothing is a bot that may answer with something in a
  // second; only a non-empty answer is worth remembering.
  if (!choices.length) return;
  if (autocompleteCache.size >= AUTOCOMPLETE_CACHE_MAX) {
    autocompleteCache.delete(autocompleteCache.keys().next().value);
  }
  autocompleteCache.set(key, { choices, at: Date.now() });
}

const pendingAutocomplete = new Map();

function settleAutocomplete(token, choices) {
  const entry = pendingAutocomplete.get(String(token));
  if (!entry) return false;
  pendingAutocomplete.delete(String(token));
  entry.resolve(choices);
  return true;
}

function coerceOptions(schema, input) {
  const values = {};
  const source = input && typeof input === 'object' ? input : {};
  for (const option of schema) {
    const raw = source[option.name];
    if (raw === undefined || raw === null || raw === '') {
      if (option.required) return { error: `Missing required option: ${option.name}` };
      continue;
    }
    if (option.type === 'integer') {
      const number = Number(raw);
      if (!Number.isInteger(number)) return { error: `${option.name} must be a whole number.` };
      values[option.name] = number;
    } else if (option.type === 'boolean') {
      values[option.name] = raw === true || raw === 'true' || raw === 1 || raw === '1';
    } else if (option.type === 'user' || option.type === 'channel') {
      const id = Number(raw);
      if (!Number.isInteger(id) || id <= 0) return { error: `${option.name} must be an id.` };
      values[option.name] = id;
    } else {
      values[option.name] = String(raw).slice(0, 1000);
    }
  }
  return { values };
}

// "/admin ban user" is one command with a subcommand. The client says which one
// it picked; the server checks it against what the command declared, then
// validates the arguments against that subcommand's own options. A client that
// invents a subcommand gets the same 400 as one that invents an option.
function resolveSubcommand(options, body) {
  const nested = (options || []).filter(
    (entry) => entry.type === 'subcommand' || entry.type === 'subcommand_group'
  );
  if (!nested.length) return { options: options || [] };

  const subName = String(body.subcommand || '').trim().toLowerCase();
  const groupName = String(body.subcommandGroup || '').trim().toLowerCase();
  if (!subName) return { error: 'Pick a subcommand.' };

  if (groupName) {
    const group = nested.find((entry) => entry.type === 'subcommand_group' && entry.name === groupName);
    if (!group) return { error: 'Unknown subcommand group.' };
    const sub = (group.options || []).find((entry) => entry.name === subName);
    if (!sub) return { error: 'Unknown subcommand.' };
    return { options: sub.options || [], subcommand: sub.name, subcommandGroup: group.name };
  }

  const sub = nested.find((entry) => entry.type === 'subcommand' && entry.name === subName);
  if (!sub) return { error: 'Unknown subcommand.' };
  return { options: sub.options || [], subcommand: sub.name, subcommandGroup: null };
}

// Option descriptions can be translated too, including the ones inside a
// subcommand. The map is name -> text, so it applies by name and ignores depth.
function localizeOptions(options, translated) {
  return (options || []).map((entry) => ({
    ...entry,
    ...(translated[entry.name] ? { description: translated[entry.name] } : {}),
    ...(entry.options ? { options: localizeOptions(entry.options, translated) } : {})
  }));
}
// What the composer shows after the user types "/". Only applications actually
// installed in this server are listed, so the picker is also the install check.
router.get('/channels/:id/commands', authRequired, asyncHandler(async (req, res) => {
  const access = await assertChannelAccess(req.params.id, req.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });

  const locale = String(req.query.locale || '') || localeFromHeader(req.headers['accept-language']);

  const { rows } = await query(
    `SELECT c.name, c.description, c.options, c.permissions, c.localizations, a.id AS application_id,
            a.name AS application_name, a.client_id, u.display_name AS bot_name
       FROM application_commands c
       JOIN applications a ON a.id = c.application_id
       JOIN application_installs i ON i.application_id = a.id AND i.server_id = $1
       JOIN users u ON u.id = a.bot_user_id
      ORDER BY c.name ASC`,
    [access.channel.server_id]
  );
  // A command the viewer could not run is not offered. The run route checks
  // again — this is a list, not a gate.
  const allowed = await memberPermissions(access.channel.server_id, req.user.id, req.user.role);
  res.json({
    commands: rows
      .filter((row) => (row.permissions || []).every((permission) => allowed.includes(permission)))
      .map((row) => {
        const translated = localize(row, locale);
        return {
        name: row.name,
        // Descriptions follow the viewer; the name never does.
        description: translated.description,
        descriptionDefault: row.description,
        options: localizeOptions(row.options || [], translated.options),
        permissions: row.permissions || [],
        applicationId: Number(row.application_id),
        applicationName: row.application_name,
        botName: row.bot_name
        };
      })
  });
}));

router.post('/channels/:id/interactions', authRequired, commandLimiter, asyncHandler(async (req, res) => {
  const access = await assertChannelAccess(req.params.id, req.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  if (access.channel.type !== 'text' && access.channel.type !== 'thread') {
    return res.status(400).json({ error: 'Commands only work in text channels.' });
  }
  if (!(await hasServerPermission(access.channel.server_id, req.user.id, 'sendMessages', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to use commands here." });
  }

  const applicationId = Number(req.body.applicationId);
  const name = String(req.body.command || '').trim().toLowerCase();
  if (!applicationId || !name) return res.status(400).json({ error: 'Pick a command to run.' });

  const { rows } = await query(
    `SELECT c.*, a.name AS application_name
       FROM application_commands c
       JOIN applications a ON a.id = c.application_id
       JOIN application_installs i ON i.application_id = a.id AND i.server_id = $1
      WHERE c.application_id = $2 AND c.name = $3`,
    [access.channel.server_id, applicationId, name]
  );
  const command = rows[0];
  if (!command) return res.status(404).json({ error: 'That command is not available in this server.' });

  // Checked here and not only in the list, because a client can post the id
  // directly. The message names the permission so the person knows what to ask
  // for instead of guessing.
  const required = command.permissions || [];
  const allowed = await memberPermissions(access.channel.server_id, req.user.id, req.user.role);
  const missing = required.filter((permission) => !allowed.includes(permission));
  if (missing.length) {
    // A refusal is worth a row: "the bot did nothing" and "somebody tried and was
    // stopped" look identical from the outside otherwise.
    recordAudit(applicationId, 'command_denied', {
      serverId: access.channel.server_id,
      actorId: req.user.id,
      detail: { command: name, missing: missing[0] }
    });
    return res.status(403).json({ error: `You need the ${missing[0]} permission to run that.` });
  }

  const resolved = resolveSubcommand(command.options || [], req.body);
  if (resolved.error) return res.status(400).json({ error: resolved.error });

  const parsed = coerceOptions(resolved.options, req.body.options);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const token = crypto.randomBytes(24).toString('base64url');
  const { rows: created } = await query(
    `INSERT INTO interactions
       (application_id, server_id, channel_id, user_id, command_name, options, token, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [
      applicationId,
      access.channel.server_id,
      access.channel.id,
      req.user.id,
      name,
      JSON.stringify(parsed.values),
      token,
      Date.now()
    ]
  );

  const io = req.app.get('io');
  emitToApp(io, applicationId, 'INTERACTION_CREATE', {
    id: Number(created[0].id),
    token,
    kind: 'command',
    command: name,
    // Null when the command has no subcommands, which is most of them.
    subcommand: resolved.subcommand || null,
    subcommandGroup: resolved.subcommandGroup || null,
    options: parsed.values,
    channelId: Number(access.channel.id),
    serverId: Number(access.channel.server_id),
    user: {
      id: Number(req.user.id),
      username: req.user.username,
      displayName: req.user.display_name
    },
    // What the person who ran it may do here, so the bot can make its own
    // decisions instead of asking the API for something it cannot read.
    member: { permissions: allowed }
  });

  res.status(202).json({ interactionId: Number(created[0].id), token });
}));

// A button or select on a bot message. The component has to actually exist on
// that message, so a client cannot invent a customId and wake a bot up.
router.post('/channels/:id/components', authRequired, commandLimiter, asyncHandler(async (req, res) => {
  const access = await assertChannelAccess(req.params.id, req.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });

  const messageId = Number(req.body.messageId);
  const customId = String(req.body.customId || '').slice(0, 100);
  if (!messageId || !customId) return res.status(400).json({ error: 'Unknown component.' });

  const { rows } = await query('SELECT * FROM messages WHERE id = $1 AND channel_id = $2', [
    messageId,
    access.channel.id
  ]);
  const message = rows[0];
  if (!message || !message.components) return res.status(404).json({ error: 'Unknown component.' });

  const exists = (message.components || []).some((row) =>
    (row.components || []).some((item) => item.customId === customId)
  );
  if (!exists) return res.status(404).json({ error: 'Unknown component.' });

  const app = (
    await query(
      `SELECT a.* FROM applications a
         JOIN application_installs i ON i.application_id = a.id AND i.server_id = $2
        WHERE a.bot_user_id = $1`,
      [message.user_id, access.channel.server_id]
    )
  ).rows[0];
  if (!app) return res.status(404).json({ error: 'That application is not installed here.' });

  const values = Array.isArray(req.body.values)
    ? req.body.values.slice(0, 5).map((value) => String(value).slice(0, 100))
    : [];
  const token = crypto.randomBytes(24).toString('base64url');
  const created = await query(
    `INSERT INTO interactions
       (application_id, server_id, channel_id, user_id, command_name, options, token, kind, custom_id, message_id, values, created_at)
     VALUES ($1, $2, $3, $4, '', '{}'::jsonb, $5, 'component', $6, $7, $8, $9) RETURNING id`,
    [
      app.id,
      access.channel.server_id,
      access.channel.id,
      req.user.id,
      token,
      customId,
      messageId,
      JSON.stringify(values),
      Date.now()
    ]
  );

  emitToApp(req.app.get('io'), app.id, 'INTERACTION_CREATE', {
    id: Number(created.rows[0].id),
    token,
    kind: 'component',
    customId,
    values,
    messageId,
    channelId: Number(access.channel.id),
    serverId: Number(access.channel.server_id),
    user: { id: Number(req.user.id), username: req.user.username, displayName: req.user.display_name },
    // A button can be as destructive as a command, so the click carries the
    // same permissions the command would have.
    member: { permissions: await memberPermissions(access.channel.server_id, req.user.id, req.user.role) }
  });

  res.status(202).json({ interactionId: Number(created.rows[0].id), token });
}));

// The bot answers here. The interaction token is single-use and bound to the
// application that owns the command, so a leaked token cannot post twice or
// answer somebody else's interaction.
// A form left open is not an invitation to answer it a week later, and an
// unsubmitted one is a row that never goes away.
const MODAL_TTL_MS = 15 * 60 * 1000;

// A bot usually wants a field prefilled with something the server already knows
// — the person's name, the channel — and without this it has to echo the value
// back through its own HTTP response just to fill a box.
const MODAL_PLACEHOLDER = /\{(user|user\.id|channel|server|command)\}/g;

async function resolveModalValues(modal, interaction) {
  // The person filling the form, not the caller. This route is authenticated
  // with the bot's token, so req.user is the bot — using it here prefilled every
  // form with the application's own name.
  const channel = (
    await query('SELECT name FROM channels WHERE id = $1', [Number(interaction.channel_id)])
  ).rows[0];
  const server = interaction.server_id
    ? (await query('SELECT name FROM servers WHERE id = $1', [Number(interaction.server_id)])).rows[0]
    : null;
  const person = (
    await query('SELECT id, username, display_name FROM users WHERE id = $1', [Number(interaction.user_id)])
  ).rows[0];
  const map = {
    user: person?.display_name || person?.username || '',
    'user.id': String(interaction.user_id),
    channel: channel?.name || '',
    server: server?.name || '',
    command: interaction.command_name || ''
  };
  return {
    ...modal,
    fields: (modal.fields || []).map((field) => ({
      ...field,
      value: String(field.value || '').replace(MODAL_PLACEHOLDER, (whole, key) =>
        key in map ? map[key] : whole
      )
    }))
  };
}

router.post('/interactions/:id/callback', authRequired, asyncHandler(async (req, res) => {
  if (!req.bot) return res.status(403).json({ error: 'This route requires a bot token.' });

  const { rows } = await query('SELECT * FROM interactions WHERE id = $1', [Number(req.params.id)]);
  const interaction = rows[0];
  if (!interaction) return res.status(404).json({ error: 'Interaction not found.' });
  if (Number(interaction.application_id) !== Number(req.bot.id)) {
    return res.status(403).json({ error: 'That interaction belongs to another application.' });
  }
  if (req.body.token !== interaction.token) {
    return res.status(403).json({ error: 'Invalid interaction token.' });
  }
  if (interaction.responded_at) {
    return res.status(409).json({ error: 'This interaction has already been answered.' });
  }

  // Answering with a form instead of a message. The definition is stored on the
  // interaction so the submit can be checked against the fields the bot asked
  // for, not against whatever the client sends back.
  if (req.body.modal !== undefined) {
    const parsedModal = validateModal(req.body.modal);
    if (parsedModal.error) return res.status(400).json({ error: parsedModal.error });

    const modal = await resolveModalValues(parsedModal.modal, interaction);
    const opened = await query(
      `UPDATE interactions SET responded_at = $1, modal = $2, expires_at = $3
        WHERE id = $4 AND responded_at IS NULL RETURNING id`,
      [Date.now(), JSON.stringify(modal), Date.now() + MODAL_TTL_MS, interaction.id]
    );
    if (!opened.rows[0]) {
      return res.status(409).json({ error: 'This interaction has already been answered.' });
    }

    // The bot's HTTP response goes to the bot. The person who clicked has to be
    // told separately, or nothing would appear on their screen.
    req.app.get('io').to(`user:${Number(interaction.user_id)}`).emit('interaction:modal', {
      interactionId: Number(interaction.id),
      channelId: Number(interaction.channel_id),
      modal
    });
    return res.json({ modal });
  }

  const content = String(req.body.content || '').trim().slice(0, 2000);
  const parsed = validateComponents(req.body.components);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (!content && !parsed.components) {
    return res.status(400).json({ error: 'A reply needs some content.' });
  }
  const ephemeral = !!req.body.ephemeral;

  const channel = (await query('SELECT * FROM channels WHERE id = $1', [interaction.channel_id])).rows[0];
  if (!channel) return res.status(404).json({ error: 'That channel no longer exists.' });

  // Claim the interaction before posting: two concurrent callbacks must not
  // both produce a message.
  const claimed = await query(
    'UPDATE interactions SET responded_at = $1 WHERE id = $2 AND responded_at IS NULL RETURNING id',
    [Date.now(), interaction.id]
  );
  if (!claimed.rows[0]) return res.status(409).json({ error: 'This interaction has already been answered.' });

  const botUser = (
    await query('SELECT * FROM users WHERE id = $1', [req.bot.bot_user_id])
  ).rows[0];
  // "Only you can see this" never touches the messages table, so there is
  // nothing to leak later and nothing to clean up.
  const message = ephemeral
    ? postEphemeral(req.app.get('io'), {
        channel,
        botUser,
        content,
        components: parsed.components,
        userId: interaction.user_id
      })
    : await postBotMessage(req.app.get('io'), {
        channel,
        botUser,
        content,
        components: parsed.components
      });
  res.status(201).json({ message, ephemeral });
}));

// A follow-up is a second (or tenth) message for the same interaction. The
// callback is single-use, follow-ups are not — that is the whole difference.
router.post('/interactions/:id/followup', authRequired, asyncHandler(async (req, res) => {
  if (!req.bot) return res.status(403).json({ error: 'This route requires a bot token.' });

  const { rows } = await query('SELECT * FROM interactions WHERE id = $1', [Number(req.params.id)]);
  const interaction = rows[0];
  if (!interaction) return res.status(404).json({ error: 'Interaction not found.' });
  if (Number(interaction.application_id) !== Number(req.bot.id)) {
    return res.status(403).json({ error: 'That interaction belongs to another application.' });
  }
  if (!interaction.responded_at) {
    return res.status(409).json({ error: 'Answer the interaction before following up.' });
  }

  const content = String(req.body.content || '').trim().slice(0, 2000);
  const parsed = validateComponents(req.body.components);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (!content && !parsed.components) {
    return res.status(400).json({ error: 'A follow-up needs some content.' });
  }

  const channel = (await query('SELECT * FROM channels WHERE id = $1', [interaction.channel_id])).rows[0];
  if (!channel) return res.status(404).json({ error: 'That channel no longer exists.' });
  const botUser = (await query('SELECT * FROM users WHERE id = $1', [req.bot.bot_user_id])).rows[0];

  const message = req.body.ephemeral
    ? postEphemeral(req.app.get('io'), {
        channel,
        botUser,
        content,
        components: parsed.components,
        userId: interaction.user_id
      })
    : await postBotMessage(req.app.get('io'), {
        channel,
        botUser,
        content,
        components: parsed.components
      });
  res.status(201).json({ message });
}));

// The person fills the form in. That becomes a new interaction — the modal one
// is spent — so the bot answers it exactly like any other.
router.post('/interactions/:id/modal-submit', authRequired, commandLimiter, asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM interactions WHERE id = $1', [Number(req.params.id)]);
  const interaction = rows[0];
  if (!interaction) return res.status(404).json({ error: 'Interaction not found.' });
  if (Number(interaction.user_id) !== Number(req.user.id)) {
    return res.status(403).json({ error: 'That form belongs to somebody else.' });
  }
  if (!interaction.modal) {
    // A submitted form has object values and no definition left; a component
    // interaction has an array of chosen values and never had one.
    const alreadySent = interaction.values && !Array.isArray(interaction.values);
    return res.status(alreadySent ? 409 : 400).json({
      error: alreadySent ? 'That form has already been sent.' : 'That interaction has no open form.'
    });
  }

  // An expired form is cleared as it is refused, so it cannot be answered later
  // by somebody who kept the tab open.
  if (interaction.expires_at && Number(interaction.expires_at) < Date.now()) {
    await query('UPDATE interactions SET modal = NULL WHERE id = $1', [interaction.id]);
    return res.status(410).json({ code: 'MODAL_EXPIRED', error: 'That form has expired.' });
  }

  const modal = interaction.modal;
  const input = req.body.values && typeof req.body.values === 'object' ? req.body.values : {};
  const values = {};
  for (const field of modal.fields || []) {
    if (field.type === 'file') {
      const file = input[field.customId];
      const url = String(file?.url || file || '');
      if (field.required !== false && !url) {
        return res.status(400).json({ error: `${field.label} is required.` });
      }
      // The value has to be something this server stored. A form field that
      // accepts any URL is a form field that accepts a tracker.
      if (url && !/^\/uploads\/[A-Za-z0-9._-]+$/.test(url)) {
        return res.status(400).json({ error: `${field.label} must be an uploaded file.` });
      }
      values[field.customId] = url
        ? {
            url,
            name: String(file?.name || '').slice(0, 200),
            type: String(file?.type || '').slice(0, 100),
            size: Number(file?.size) || 0
          }
        : null;
      continue;
    }

    const raw = String(input[field.customId] ?? '').slice(0, field.maxLength || 400);
    if (field.required !== false && !raw.trim()) {
      return res.status(400).json({ error: `${field.label} is required.` });
    }
    // A choice is one of the choices. The client is not the authority on what
    // the bot offered, so an invented value is refused rather than forwarded.
    if (field.type === 'select' && raw && !(field.options || []).some((o) => o.value === raw)) {
      return res.status(400).json({ error: `${field.label} must be one of the choices.` });
    }
    values[field.customId] = raw;
  }

  // Claiming the form by clearing it: a second submit finds nothing to send, so
  // one form produces exactly one interaction.
  const claimed = await query(
    'UPDATE interactions SET modal = NULL, values = $1 WHERE id = $2 AND modal IS NOT NULL RETURNING id',
    [JSON.stringify(values), interaction.id]
  );
  if (!claimed.rows[0]) return res.status(409).json({ error: 'That form has already been sent.' });

  const token = crypto.randomBytes(24).toString('base64url');
  const created = await query(
    `INSERT INTO interactions
       (application_id, server_id, channel_id, user_id, command_name, options, token, kind, custom_id, message_id, values, created_at)
     VALUES ($1, $2, $3, $4, '', '{}'::jsonb, $5, 'modal_submit', $6, $7, $8, $9) RETURNING id`,
    [
      interaction.application_id,
      interaction.server_id,
      interaction.channel_id,
      req.user.id,
      token,
      modal.customId,
      interaction.message_id,
      JSON.stringify(values),
      Date.now()
    ]
  );

  emitToApp(req.app.get('io'), Number(interaction.application_id), 'INTERACTION_CREATE', {
    id: Number(created.rows[0].id),
    token,
    kind: 'modal_submit',
    customId: modal.customId,
    values,
    channelId: Number(interaction.channel_id),
    serverId: Number(interaction.server_id),
    user: { id: Number(req.user.id), username: req.user.username, displayName: req.user.display_name }
  });

  res.status(202).json({ interactionId: Number(created.rows[0].id), token });
}));

// An option may sit at the top of the command or inside one subcommand. The
// composer sends a name, not a path, because a name is unique within a command.
function findOption(options, name) {
  for (const entry of options || []) {
    if (entry.name === name) return entry;
    if (entry.options) {
      const inner = findOption(entry.options, name);
      if (inner) return inner;
    }
  }
  return null;
}
// ── Autocomplete ────────────────────────────────────────────────────────────

// The composer cannot wait for a bot that never answers, so the request holds
// for a moment and then returns nothing. A missing suggestion is a missing
// suggestion; a frozen keystroke is a broken app.
router.post('/channels/:id/autocomplete', authRequired, autocompleteLimiter, asyncHandler(async (req, res) => {
  const access = await assertChannelAccess(req.params.id, req.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  if (!(await hasServerPermission(access.channel.server_id, req.user.id, 'sendMessages', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to use commands here." });
  }

  const applicationId = Number(req.body.applicationId);
  const name = String(req.body.command || '').trim().toLowerCase();
  const optionName = String(req.body.option || '').trim().toLowerCase();
  // Named "prefix", not "query": the latter is the pool helper this route uses.
  const prefix = String(req.body.query || '').slice(0, 100);
  if (!applicationId || !name || !optionName) {
    return res.status(400).json({ error: 'Nothing to suggest for.' });
  }

  const { rows } = await query(
    `SELECT c.* FROM application_commands c
       JOIN application_installs i ON i.application_id = c.application_id AND i.server_id = $1
      WHERE c.application_id = $2 AND c.name = $3`,
    [access.channel.server_id, applicationId, name]
  );
  const command = rows[0];
  if (!command) return res.status(404).json({ error: 'That command is not available in this server.' });
  const option = findOption(command.options || [], optionName);
  if (!option || !option.autocomplete) {
    return res.status(400).json({ error: 'That option does not offer suggestions.' });
  }

  const cacheKey = `${applicationId}|${optionName}|${prefix.toLowerCase()}`;
  const cached = cachedSuggestions(cacheKey);
  if (cached) return res.json({ choices: cached, cached: true });

  const token = crypto.randomBytes(24).toString('base64url');
  const wait = new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingAutocomplete.delete(token);
      resolve([]);
    }, AUTOCOMPLETE_WAIT_MS);
    pendingAutocomplete.set(token, {
      applicationId,
      cacheKey,
      resolve: (choices) => {
        clearTimeout(timer);
        resolve(choices);
      }
    });
  });

  emitToApp(req.app.get('io'), applicationId, 'INTERACTION_CREATE', {
    kind: 'autocomplete',
    token,
    command: name,
    option: optionName,
    query: prefix,
    channelId: Number(access.channel.id),
    serverId: Number(access.channel.server_id),
    user: { id: Number(req.user.id), username: req.user.username, displayName: req.user.display_name }
  });

  const choices = await wait;
  res.json({ choices });
}));

// The bot answers with a list. It is not tied to an interaction row because the
// question itself is not kept; the token is the whole conversation.
router.post('/autocomplete/:token', authRequired, asyncHandler(async (req, res) => {
  if (!req.bot) return res.status(403).json({ error: 'This route requires a bot token.' });
  const token = String(req.params.token || '');
  const entry = pendingAutocomplete.get(token);
  if (!entry) return res.status(404).json({ error: 'That suggestion request has expired.' });
  if (Number(entry.applicationId) !== Number(req.bot.id)) {
    return res.status(403).json({ error: 'That request belongs to another application.' });
  }

  const input = Array.isArray(req.body.choices) ? req.body.choices : [];
  const choices = input
    .slice(0, AUTOCOMPLETE_LIMIT)
    .map((choice) => ({
      name: String(choice?.name ?? choice?.value ?? '').slice(0, 100),
      value: String(choice?.value ?? choice?.name ?? '').slice(0, 100)
    }))
    .filter((choice) => choice.name && choice.value);

  rememberSuggestions(entry.cacheKey, choices);
  settleAutocomplete(token, choices);
  res.json({ ok: true, delivered: choices.length });
}));

module.exports = router;
