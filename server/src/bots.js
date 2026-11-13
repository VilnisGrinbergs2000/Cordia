'use strict';
// Bot platform core: token minting, the bot user row, and the gateway.
//
// A bot is not a second kind of principal. It is a users row with is_bot = 1
// and a server_members row like anyone else, so assertChannelAccess,
// hasServerPermission, mentions and message authoring all work unchanged. What
// it does not have is a password, a session cookie, friends or presence.
require('./pg/env');
const crypto = require('node:crypto');
const { query } = require('./pg/pool');
const { Client } = require('pg');
const { adjustUserCount } = require('./messageCounters');
const { getMessageRow, serializeMessage } = require('./util');
const { TOKEN_PREFIX, hashToken, mintToken, botFromTokenAsync } = require('./botToken');
const { markBotOnline, markBotOffline } = require('./botPresence');
const { memberPermissions } = require('./permissions');

function slugify(name) {
  const base = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  return base.length >= 3 ? base : 'bot_' + base;
}

// Bot usernames are visible in mentions and autocomplete, so they read like a
// name rather than an id. The suffix is only added when the slug is taken.
async function uniqueBotUsername(name) {
  const base = slugify(name);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = attempt === 0 ? base : base.slice(0, 20) + '_' + crypto.randomBytes(2).toString('hex');
    const taken = (await query('SELECT 1 FROM users WHERE LOWER(username) = $1', [candidate])).rows[0];
    if (!taken) return candidate;
  }
  return 'bot_' + crypto.randomBytes(6).toString('hex');
}

async function createBotUser(name) {
  const username = await uniqueBotUsername(name);
  const now = Date.now();
  const { rows } = await query(
    `INSERT INTO users (username, email, display_name, password_hash, avatar_color, presence, is_bot, created_at)
     VALUES ($1, $2, $3, $4, $5, 'online', 1, $6) RETURNING *`,
    [
      username,
      `${username}@bots.cordia.local`,
      String(name).slice(0, 32),
      // No password can ever match this hash, and the login route rejects bots
      // before it gets that far anyway.
      '!bot-account',
      ['#6366f1', '#8b5cf6', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444'][
        Math.floor(Math.random() * 6)
      ],
      now
    ]
  );
  return rows[0];
}

const BUTTON_STYLES = new Set(['primary', 'secondary', 'success', 'danger']);

// Components are validated on the way in so the client never has to defend
// against a bot's markup: fixed types, bounded counts, bounded strings.
function validateComponents(input) {
  if (input === undefined || input === null) return { components: null };
  if (!Array.isArray(input)) return { error: 'Components must be a list of rows.' };
  if (input.length > 5) return { error: 'At most 5 component rows.' };
  const rows = [];
  for (const row of input) {
    const items = Array.isArray(row?.components) ? row.components : [];
    if (!items.length) return { error: 'Each row needs at least one component.' };
    if (items.length > 5) return { error: 'At most 5 components per row.' };
    const clean = [];
    for (const item of items) {
      const customId = String(item?.customId || '').slice(0, 100);
      if (!customId) return { error: 'Every component needs a customId.' };
      if (item.type === 'button') {
        clean.push({
          type: 'button',
          style: BUTTON_STYLES.has(item.style) ? item.style : 'secondary',
          label: String(item.label || '').slice(0, 80),
          customId,
          disabled: !!item.disabled
        });
      } else if (item.type === 'select') {
        const options = (Array.isArray(item.options) ? item.options : []).slice(0, 25).map((option) => ({
          label: String(option?.label || '').slice(0, 100),
          value: String(option?.value || '').slice(0, 100),
          description: String(option?.description || '').slice(0, 100)
        }));
        if (!options.length) return { error: 'A select needs options.' };
        clean.push({
          type: 'select',
          customId,
          placeholder: String(item.placeholder || '').slice(0, 150),
          options
        });
      } else {
        return { error: 'Unknown component type: ' + String(item.type) };
      }
    }
    rows.push({ components: clean });
  }
  return { components: rows };
}

// A modal is a form the bot asks for after a click or a command. Validated on
// the way in for the same reason components are: the client renders what it is
// given, so the shape has to be bounded before it is stored.
const MODAL_INPUT_STYLES = new Set(['short', 'paragraph']);

function validateModal(input) {
  if (!input || typeof input !== 'object') {
    return { error: 'A modal needs a title and at least one field.' };
  }
  const title = String(input.title || '').trim().slice(0, 45);
  const customId = String(input.customId || '').slice(0, 100);
  if (!title) return { error: 'A modal needs a title.' };
  if (!customId) return { error: 'A modal needs a customId.' };

  const rows = Array.isArray(input.components) ? input.components : [];
  if (!rows.length) return { error: 'A modal needs at least one field.' };
  if (rows.length > 5) return { error: 'At most 5 fields in a modal.' };

  const fields = [];
  for (const row of rows) {
    const item = (row && row.components && row.components[0]) || row;
    if (!item || (item.type !== 'text_input' && item.type !== 'select' && item.type !== 'file')) {
      return { error: 'Modal fields must be text inputs, choices or a file.' };
    }
    const fieldId = String(item.customId || '').slice(0, 100);
    const label = String(item.label || '').trim().slice(0, 45);
    if (!fieldId || !label) return { error: 'Every field needs a customId and a label.' };

    if (item.type === 'file') {
      fields.push({
        customId: fieldId,
        label,
        type: 'file',
        required: item.required !== false
      });
      continue;
    }

    if (item.type === 'select') {
      const raw = Array.isArray(item.options) ? item.options : [];
      if (raw.length < 2) return { error: `${label} needs at least two choices.` };
      if (raw.length > 25) return { error: `${label} can have at most 25 choices.` };
      const options = raw.map((choice) => ({
        label: String(choice?.label || choice?.value || '').trim().slice(0, 100),
        value: String(choice?.value ?? choice?.label ?? '').slice(0, 100)
      }));
      if (options.some((choice) => !choice.label || !choice.value)) {
        return { error: `Every choice in ${label} needs a label and a value.` };
      }
      fields.push({
        customId: fieldId,
        label,
        type: 'select',
        options,
        value: String(item.value || '').slice(0, 100),
        required: item.required !== false
      });
      continue;
    }

    fields.push({
      customId: fieldId,
      label,
      type: 'text_input',
      style: MODAL_INPUT_STYLES.has(item.style) ? item.style : 'short',
      placeholder: String(item.placeholder || '').slice(0, 100),
      value: String(item.value || '').slice(0, 4000),
      required: item.required !== false,
      maxLength: Math.min(Math.max(Number(item.maxLength) || 400, 1), 4000)
    });
  }

  return { modal: { title, customId, fields } };
}

function botPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    avatarColor: user.avatar_color,
    avatarUrl: user.avatar_url || '',
    bot: true,
    applicationId: Number(user.bot_application_id) || null
  };
}

// The event shape bots consume. Deliberately smaller than the client payload:
// bots do not need reactions, presence or E2EE material.
function messageEvent(message) {
  return {
    id: message.id,
    channelId: message.channelId,
    serverId: message.serverId,
    // Null for a server message, set for a direct one. Without it a bot sees
    // channelId: null and serverId: null and cannot tell which conversation it
    // is replying to.
    dmId: message.dmId || null,
    content: message.content,
    components: message.components || null,
    createdAt: message.createdAt,
    author: {
      id: message.author.id,
      username: message.author.username,
      displayName: message.author.displayName,
      bot: !!message.author.bot
    }
  };
}

function gatewayOf(io) {
  return io.of('/gateway');
}

// ── Sharding ────────────────────────────────────────────────────────────────
// One process is one shard. A server belongs to exactly one of them, decided by
// its id, so two processes never deliver the same guild event twice and a bot
// can run one gateway per shard the way it would anywhere else.
const SHARD_COUNT = Math.max(1, Number(process.env.CORDIA_SHARD_COUNT) || 1);
const SHARD_ID = Math.min(Math.max(0, Number(process.env.CORDIA_SHARD_ID) || 0), SHARD_COUNT - 1);

function ownsServer(serverId) {
  if (SHARD_COUNT === 1) return true;
  return Number(serverId) % SHARD_COUNT === SHARD_ID;
}
// ── Event streams ───────────────────────────────────────────────────────────
// Every dispatch carries a sequence number that only goes up, per application.
// A bot that drops its socket can say "I had up to 412" and be given everything
// after that instead of a silent hole.

// A day, not five minutes. The backlog lives in a table now, so the only reason
// to throw it away is that it has grown unreasonable — and a bot that was down
// for an hour is exactly the case replay exists for.
const REPLAY_LIMIT = 1000;
const REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// How many gateways one application may have open at once. A bot that leaks
// sockets should fail visibly rather than quietly consume the server's memory.
const MAX_GATEWAY_SESSIONS = 5;

const streams = new Map(); // applicationId -> { seq }

function streamOf(applicationId) {
  const id = Number(applicationId);
  let state = streams.get(id);
  if (!state) {
    state = { seq: 0 };
    streams.set(id, state);
  }
  return state;
}

// The counter is seeded from the database the first time an application emits in
// this process, so a restart does not restart the numbering and hand out
// sequence numbers a bot has already seen.
const seeded = new Set();

async function ensureStream(applicationId) {
  const id = Number(applicationId);
  if (seeded.has(id)) return streamOf(id).seq;
  const stored = (await query('SELECT seq FROM gateway_streams WHERE application_id = $1', [id])).rows[0];
  const written = (
    await query('SELECT COALESCE(MAX(seq), 0)::bigint AS seq FROM gateway_events WHERE application_id = $1', [id])
  ).rows[0];
  const state = streamOf(id);
  state.seq = Math.max(Number(stored?.seq || 0), Number(written?.seq || 0));
  await query(
    'INSERT INTO gateway_streams (application_id, seq) VALUES ($1, $2) ON CONFLICT (application_id) DO NOTHING',
    [id, state.seq]
  );
  seeded.add(id);
  return state.seq;
}

// Writes are batched: a busy server should not pay a round trip per event, and
// losing the last tenth of a second of history to a hard kill is a better trade
// than slowing every message down. A clean stop loses nothing — shutdown drains
// the queue.
const writeQueue = [];
let flushTimer = null;

function flushGatewayWrites() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!writeQueue.length) return Promise.resolve();
  const rows = writeQueue.splice(0, writeQueue.length);
  const placeholders = [];
  const params = [];
  rows.forEach((row, index) => {
    const base = index * 5;
    placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
    params.push(row.applicationId, row.seq, row.t, JSON.stringify(row.d ?? null), row.at);
  });
  const highest = new Map();
  for (const row of rows) {
    highest.set(row.applicationId, Math.max(highest.get(row.applicationId) || 0, row.seq));
  }
  return query(
    `INSERT INTO gateway_events (application_id, seq, type, payload, created_at) VALUES ${placeholders.join(', ')}`,
    params
  )
    .then(() =>
      Promise.all(
        [...highest].map(([applicationId, seq]) =>
          query('UPDATE gateway_streams SET seq = GREATEST(seq, $2) WHERE application_id = $1', [applicationId, seq])
        )
      )
    )
    .catch((error) => console.error('[gateway] event write failed:', error.message));
}

function queueWrite(row) {
  writeQueue.push(row);
  if (writeQueue.length >= 25) return flushGatewayWrites();
  if (!flushTimer) flushTimer = setTimeout(() => flushGatewayWrites(), 100);
  return Promise.resolve();
}

// Sequence numbers come from the database, not from this process's memory. Two
// processes recording for the same application used to hand out the same number
// twice — the table has no unique constraint on (application_id, seq), so the
// duplicate was accepted and a resuming bot replayed the two events in whatever
// order the index gave back.
async function record(applicationId, t, d) {
  const id = Number(applicationId);
  await ensureStream(id);
  const { rows } = await query(
    'UPDATE gateway_streams SET seq = seq + 1 WHERE application_id = $1 RETURNING seq',
    [id]
  );
  const seq = Number(rows[0].seq);
  streamOf(id).seq = seq;
  queueWrite({ applicationId: id, seq, t, d, at: Date.now() });
  return seq;
}

async function rememberSession(applicationId, sessionId) {
  await query(
    'INSERT INTO gateway_sessions (application_id, session_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [Number(applicationId), String(sessionId), Date.now()]
  );
}

async function knownSession(applicationId, sessionId) {
  const { rows } = await query(
    'SELECT 1 FROM gateway_sessions WHERE application_id = $1 AND session_id = $2',
    [Number(applicationId), String(sessionId)]
  );
  return !!rows[0];
}

// Live sockets, so a rotated token can actually cut off the client still holding
// the old one. The map is per-process — a socket only ever lives in one process —
// but the session rows are shared, so a *new* connection is refused everywhere
// at the same moment.
const liveSockets = new Map(); // applicationId -> Set<socket>

function trackSocket(applicationId, socket) {
  const id = Number(applicationId);
  let set = liveSockets.get(id);
  if (!set) {
    set = new Set();
    liveSockets.set(id, set);
  }
  set.add(socket);
}

function untrackSocket(applicationId, socket) {
  const id = Number(applicationId);
  const set = liveSockets.get(id);
  if (!set) return;
  set.delete(socket);
  if (!set.size) liveSockets.delete(id);
}

function sessionsFor(applicationId) {
  return liveSockets.get(Number(applicationId))?.size || 0;
}

// Rotating a token, deleting an application, or asking explicitly all mean the
// same thing: every session that existed before this moment is invalid. Clearing
// the rows stops the next connection; disconnecting the sockets stops this one.
async function revokeSessions(applicationId, reason = 'revoked') {
  const id = Number(applicationId);
  await query('DELETE FROM gateway_sessions WHERE application_id = $1', [id]);
  await query('DELETE FROM gateway_live WHERE application_id = $1', [id]);
  const set = liveSockets.get(id);
  const closed = set ? set.size : 0;
  if (set) {
    for (const socket of [...set]) {
      try {
        socket.emit('dispatch', { t: 'DISCONNECT', d: { reason } });
        socket.disconnect(true);
      } catch {
        /* the socket may already be gone */
      }
    }
    liveSockets.delete(id);
  }
  return closed;
}

// The cap has to hold across processes, so the count lives in a table. A row
// that stops being refreshed is a process that died with its sockets open, so it
// is swept rather than counted forever.
const LIVE_STALE_MS = 90_000;

async function claimSession(applicationId, socketId) {
  const id = Number(applicationId);
  const now = Date.now();
  await query('DELETE FROM gateway_live WHERE seen_at < $1', [now - LIVE_STALE_MS]);
  const { rows } = await query('SELECT COUNT(*)::int AS c FROM gateway_live WHERE application_id = $1', [
    id
  ]);
  if (Number(rows[0].c) >= MAX_GATEWAY_SESSIONS) return false;
  await query(
    `INSERT INTO gateway_live (application_id, socket_id, seen_at) VALUES ($1, $2, $3)
     ON CONFLICT (application_id, socket_id) DO UPDATE SET seen_at = EXCLUDED.seen_at`,
    [id, String(socketId), now]
  );
  return true;
}

async function touchSession(applicationId, socketId) {
  await query(
    'UPDATE gateway_live SET seen_at = $3 WHERE application_id = $1 AND socket_id = $2',
    [Number(applicationId), String(socketId), Date.now()]
  );
}

async function releaseSession(applicationId, socketId) {
  await query('DELETE FROM gateway_live WHERE application_id = $1 AND socket_id = $2', [
    Number(applicationId),
    String(socketId)
  ]);
}
// Old events and sessions are swept on a timer rather than on every write.
let prunerStarted = false;

function startGatewayPruner() {
  if (prunerStarted) return;
  prunerStarted = true;
  const timer = setInterval(async () => {
    try {
      await query('DELETE FROM gateway_events WHERE created_at < $1', [Date.now() - REPLAY_TTL_MS]);
      await query(
        `DELETE FROM gateway_events e WHERE e.id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY application_id ORDER BY seq DESC) AS rn
               FROM gateway_events
           ) ranked WHERE ranked.rn > $1
         )`,
        [REPLAY_LIMIT]
      );
      await query('DELETE FROM gateway_sessions WHERE created_at < $1', [Date.now() - SESSION_TTL_MS]);
    } catch (error) {
      console.error('[gateway] prune failed:', error.message);
    }
  }, 60_000);
  if (timer.unref) timer.unref();
}

// Which applications are installed where. Every message dispatch consults this,
// so it is cached and invalidated on install, uninstall, delete and intent
// changes rather than queried once per event.
const installIndex = new Map();
// Invalidation alone is not enough: an install handled by another process never
// reaches this one, and the cache would stay wrong until a restart. A short TTL
// bounds how long any process can be out of date.
const INSTALL_CACHE_MS = 15_000;

async function appsForServer(serverId) {
  const key = Number(serverId);
  const hit = installIndex.get(key);
  if (hit && Date.now() - hit.at < INSTALL_CACHE_MS) return hit.apps;
  const { rows } = await query(
    `SELECT a.id, a.intents, i.intents AS install_intents FROM application_installs i
       JOIN applications a ON a.id = i.application_id
      WHERE i.server_id = $1`,
    [key]
  );
  // A narrowed install overrides what the application declared. That is the
  // whole point of a scope: the server agreed to less than the app asked for.
  const apps = rows.map((row) => ({
    id: Number(row.id),
    intents: row.install_intents || row.intents
  }));
  installIndex.set(key, { apps, at: Date.now() });
  return apps;
}

function forgetServer(serverId) {
  installIndex.delete(Number(serverId));
}

function forgetApp(applicationId) {
  const id = Number(applicationId);
  for (const [key, hit] of installIndex) {
    if (hit.apps.some((app) => app.id === id)) installIndex.delete(key);
  }
}

// Delivery goes through one queue so events cannot overtake each other while
// the install index is still cold. Once a server's apps are cached this path
// does no I/O at all.
let dispatchQueue = Promise.resolve();

function enqueue(task) {
  dispatchQueue = dispatchQueue
    .then(task)
    .catch((error) => console.error('[gateway] dispatch failed:', error.message));
}

function emitToApp(io, applicationId, t, d) {
  enqueue(async () => {
    const seq = await record(applicationId, t, d);
    gatewayOf(io).to(`app:${Number(applicationId)}`).emit('dispatch', { t, d, seq });
  });
}

// Events are addressed per intent, so an app that only asked for messages never
// receives reaction or membership traffic. Interactions are not intent-gated:
// a bot that registered a command must be able to hear it being used.
const INTENTS = ['messages', 'reactions', 'members'];

function intentsOf(application) {
  const declared = String(application.intents || '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => INTENTS.includes(value));
  return declared.length ? declared : INTENTS;
}

function emitToServerBots(io, serverId, intent, t, d) {
  // A guild event belongs to exactly one shard. Delivering it here and there
  // would give a bot two copies of every message.
  if (!ownsServer(serverId)) return;
  enqueue(async () => {
    const apps = await appsForServer(serverId);
    for (const app of apps) {
      if (!intentsOf(app).includes(intent)) continue;
      const seq = await record(app.id, t, d);
      gatewayOf(io).to(`app:${app.id}`).emit('dispatch', { t, d, seq });
    }
  });
}

// A direct message has no server, so the server-scoped fan-out above never
// reaches a bot. This is the DM equivalent: whoever in the conversation is a bot
// hears about it, and nobody else does.
async function emitToDmBots(io, dmId, t, d) {
  enqueue(async () => {
    const { rows } = await query(
      `SELECT a.id FROM dm_channels d
         JOIN users u ON u.id IN (d.user_a, d.user_b)
         JOIN applications a ON a.bot_user_id = u.id
        WHERE d.id = $1 AND u.is_bot = 1`,
      [Number(dmId)]
    );
    for (const row of rows) {
      const seq = await record(row.id, t, d);
      gatewayOf(io).to(`app:${Number(row.id)}`).emit('dispatch', { t, d, seq });
      // A direct message has no shard to own it: the person's socket lives on
      // one process and the bot's may live on another. Rooms are per-process, so
      // the emit above only reaches bots connected here.
      //
      // The write is flushed first, because the other side reads the event back
      // out of gateway_events by sequence number and the batched insert may not
      // have landed yet. Direct messages are not the hot path; correctness is.
      await flushGatewayWrites();
      await query('SELECT pg_notify($1, $2)', [
        BRIDGE_CHANNEL,
        JSON.stringify({ app: Number(row.id), seq, from: PROCESS_ID })
      ]);
    }
  });
}

// Socket.IO rooms are per process. Sharding covers guild events by giving each
// guild one owner, but a direct message belongs to no guild, so every process
// has to be told. Postgres is already here and already the source of truth, so
// LISTEN/NOTIFY is the bridge: the payload is only { app, seq }, and the event
// itself is read back from gateway_events, which is where it had to be written
// anyway.
const BRIDGE_CHANNEL = 'cordia_gateway';
const PROCESS_ID = crypto.randomUUID();
let bridgeClient = null;

function startGatewayBridge(io) {
  if (bridgeClient) return;
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  bridgeClient = client;
  // A bridge that cannot connect must not take the gateway with it: events
  // still reach the sockets on this process, and a bot that missed one can ask
  // for it again by resuming.
  client.on('error', (error) => console.error('[gateway] bridge error:', error.message));
  client.on('notification', async (message) => {
    if (message.channel !== BRIDGE_CHANNEL) return;
    let note = null;
    try {
      note = JSON.parse(message.payload);
    } catch {
      return;
    }
    // We delivered this one ourselves a moment ago.
    if (!note || note.from === PROCESS_ID) return;
    try {
      const { rows } = await query(
        `SELECT type, payload FROM gateway_events
          WHERE application_id = $1 AND seq = $2 ORDER BY id DESC LIMIT 1`,
        [Number(note.app), Number(note.seq)]
      );
      if (!rows[0]) return;
      gatewayOf(io).to(`app:${Number(note.app)}`).emit('dispatch', {
        t: rows[0].type,
        d: rows[0].payload,
        seq: Number(note.seq)
      });
    } catch (error) {
      console.error('[gateway] bridge delivery failed:', error.message);
    }
  });
  client
    .connect()
    .then(() => client.query('LISTEN ' + BRIDGE_CHANNEL))
    .catch((error) => console.error('[gateway] bridge unavailable:', error.message));
}

async function postBotMessage(io, { channel, botUser, content, components = null }) {
  const now = Date.now();
  const inserted = await query(
    `INSERT INTO messages (channel_id, user_id, content, components, created_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [channel.id, botUser.id, content, components ? JSON.stringify(components) : null, now]
  );
  await adjustUserCount(botUser.id, 1);
  const row = await getMessageRow(Number(inserted.rows[0].id));
  const message = await serializeMessage(row, botUser.id);
  io.to(`server:${channel.server_id}`).emit('message:new', message);
  emitToServerBots(io, channel.server_id, 'messages', 'MESSAGE_CREATE', messageEvent(message));
  return message;
}

// Ephemeral replies are never written to the database: they exist for one user
// until they reload, which is exactly what "only you can see this" means.
function postEphemeral(io, { channel, botUser, content, components = null, userId }) {
  const payload = {
    id: -Date.now(),
    channelId: Number(channel.id),
    serverId: Number(channel.server_id),
    content,
    components: components || null,
    createdAt: Date.now(),
    ephemeral: true,
    author: {
      id: Number(botUser.id),
      username: botUser.username,
      displayName: botUser.display_name,
      avatarColor: botUser.avatar_color,
      avatarUrl: botUser.avatar_url || '',
      bot: true,
      online: true
    },
    reactions: [],
    poll: null,
    replyTo: null
  };
  io.to(`user:${Number(userId)}`).emit('message:new', payload);
  return payload;
}

// The gateway is its own namespace so bots never join the human socket rooms:
// no presence, no typing, no voice, no call signalling. They join one room per
// installed server plus a private room for application-level events.
function attachGateway(io) {
  const gateway = gatewayOf(io);
  startGatewayBridge(io);

  gateway.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      const bot = await botFromTokenAsync(token);
      if (!bot) return next(new Error('unauthorized'));
      socket.bot = bot;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  gateway.on('connection', async (socket) => {
    const { application, user } = socket.bot;
    socket.join(`app:${application.id}`);

    let installs = [];
    try {
      const { rows } = await query('SELECT server_id FROM application_installs WHERE application_id = $1', [
        application.id
      ]);
      installs = rows;
    } catch (error) {
      console.error('[gateway] install lookup failed:', error.message);
    }

    const { rows: commands } = await query(
      'SELECT name, description FROM application_commands WHERE application_id = $1 ORDER BY name',
      [application.id]
    );

    // Names and the bot's own permissions per server, so a bot does not have to
    // spend a request finding out what it may do where. Additive: "servers" is
    // still the id list every existing bot already reads.
    const guilds = [];
    try {
      const { rows: named } = await query(
        `SELECT s.id, s.name FROM application_installs i
           JOIN servers s ON s.id = i.server_id
          WHERE i.application_id = $1 ORDER BY s.id`,
        [application.id]
      );
      for (const row of named) {
        guilds.push({
          id: Number(row.id),
          name: row.name,
          permissions: await memberPermissions(Number(row.id), user.id)
        });
      }
    } catch (error) {
      console.error('[gateway] guild lookup failed:', error.message);
    }

    // A leak of sockets is invisible until the server falls over, so the cap is
    // explicit and the refusal says which limit was hit.
    let claimed = true;
    try {
      claimed = await claimSession(application.id, socket.id);
    } catch (error) {
      // A database that cannot answer the question must not lock every bot out.
      console.error('[gateway] session claim failed:', error.message);
    }
    if (!claimed) {
      socket.emit('dispatch', {
        t: 'SESSION_LIMIT',
        d: { max: MAX_GATEWAY_SESSIONS, reason: 'too_many_sessions' }
      });
      socket.disconnect(true);
      return;
    }
    trackSocket(application.id, socket);

    // The transport heartbeat fires every pingInterval whether or not the bot
    // library sends our app-level `ping`. Without this, a bot that only used
    // the transport heartbeat looked dead after ninety seconds, its row was
    // swept, and its slot was handed to somebody else — the cap was only a cap
    // for bots that spoke our dialect.
    socket.conn.on('heartbeat', () => {
      touchSession(application.id, socket.id).catch(() => {});
    });

    const sessionId = crypto.randomUUID();
    await rememberSession(application.id, sessionId);
    const startSeq = await ensureStream(application.id);

    socket.emit('dispatch', {
      t: 'READY',
      d: {
        application: {
          id: Number(application.id),
          name: application.name,
          clientId: application.client_id
        },
        user: botPublicUser({ ...user, bot_application_id: application.id }),
        servers: installs.map((row) => Number(row.server_id)),
        guilds,
        commands: commands.map((row) => ({ name: row.name, description: row.description })),
        sessionId,
        seq: startSeq,
        // One shard, stated rather than implied. A bot library that expects the
        // field should not have to special-case its absence.
        shard: [SHARD_ID, SHARD_COUNT],
        sessionLimit: MAX_GATEWAY_SESSIONS,
        replayLimit: REPLAY_LIMIT
      },
      seq: startSeq
    });

    startGatewayPruner();
    markBotOnline(application.id);

    socket.on('ping', () => {
      // The heartbeat is also how this process says "still here" to the shared
      // session table, so a slot is not swept out from under a live socket.
      touchSession(application.id, socket.id).catch(() => {});
      socket.emit('dispatch', { t: 'PONG', d: { at: Date.now() } });
    });

    // A bot that reconnects can ask for what it missed. The session id proves it
    // is the same client coming back rather than a fresh one guessing a number,
    // and the buffer has to still hold the gap or the answer is RESUME_FAILED.
    // The backlog comes from the database, not from this process, so a bot that
    // reconnects across a deploy is still told what it missed.
    socket.on('resume', async (payload) => {
      const session = String(payload?.sessionId || '');
      const since = Number(payload?.seq || 0);
      const current = await ensureStream(application.id);
      if (!session || !(await knownSession(application.id, session))) {
        socket.emit('dispatch', { t: 'RESUME_FAILED', d: { reason: 'unknown_session', seq: current } });
        return;
      }
      const { rows } = await query(
        `SELECT seq, type, payload FROM gateway_events
          WHERE application_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
        [application.id, since, REPLAY_LIMIT]
      );
      if (rows.length && Number(rows[0].seq) > since + 1) {
        socket.emit('dispatch', { t: 'RESUME_FAILED', d: { reason: 'gap_too_large', seq: current } });
        return;
      }
      socket.emit('dispatch', { t: 'RESUMED', d: { replayed: rows.length, seq: current } });
      for (const row of rows) {
        socket.emit('dispatch', { t: row.type, d: row.payload, seq: Number(row.seq) });
      }
    });

    socket.on('disconnect', () => {
      releaseSession(application.id, socket.id).catch(() => {});
      untrackSocket(application.id, socket);
      // Only offline when the last gateway is gone; a bot with two connections
      // is not offline because one of them closed.
      if (!sessionsFor(application.id)) markBotOffline(application.id);
    });
  });
}

module.exports = {
  TOKEN_PREFIX,
  hashToken,
  mintToken,
  createBotUser,
  botFromTokenAsync,
  botPublicUser,
  messageEvent,
  emitToApp,
  emitToServerBots,
  forgetServer,
  forgetApp,
  intentsOf,
  postEphemeral,
  flushGatewayWrites,
  validateComponents,
  validateModal,
  INTENTS,
  postBotMessage,
  emitToDmBots,
  attachGateway,
  revokeSessions,
  sessionsFor,
  ownsServer
};
