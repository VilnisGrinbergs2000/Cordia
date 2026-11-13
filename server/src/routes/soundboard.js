const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query, withTransaction } = require('../pg/pool');
const { uploadsDir } = require('../config');
const { authRequired, rateLimit } = require('../auth');
const { hasServerPermission } = require('../permissions');
const { rooms: voiceRooms } = require('../voiceState');
const { getMembership, trim, logAudit, deleteUploadIfUnused } = require('../util');

const router = express.Router();

// Same shape the attachment pipeline produces, so a soundboard clip can only
// point at something /api/upload handed out.
const UPLOAD_URL_RE = /^\/uploads\/[a-zA-Z0-9._-]+$/;
const MAX_SOUNDS = 25;
const MAX_BYTES = 512 * 1024;
const MAX_NAME = 32;
const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.ogg',
  '.oga',
  '.opus',
  '.wav',
  '.weba',
  '.webm',
  '.m4a',
  '.aac',
  '.flac'
]);
// Browsers hand back audio/* for almost everything; Ogg audio sometimes shows
// up as video/ogg because of the container.
const AUDIO_MIME_RE = /^audio\/[a-z0-9.+-]+$/;
const EXTRA_AUDIO_MIMES = new Set(['video/ogg']);

const manageLimiter = rateLimit({
  windowMs: 60_000,
  max: 40,
  message: 'Too many soundboard changes. Try again in a minute.'
});

function serializeSound(row) {
  return {
    id: row.id,
    name: row.name,
    file: row.file,
    mime: row.mime,
    durationMs: Number(row.duration_ms) || 0,
    uploadedBy: row.uploaded_by ?? null
  };
}

async function listSounds(serverId) {
  const { rows } = await query(
    'SELECT * FROM soundboard_sounds WHERE server_id = $1 ORDER BY lower(name) ASC',
    [Number(serverId)]
  );
  return rows.map(serializeSound);
}

async function getSound(id) {
  const soundId = Number(id);
  if (!Number.isInteger(soundId) || soundId <= 0) return null;
  const { rows } = await query('SELECT * FROM soundboard_sounds WHERE id = $1', [soundId]);
  return rows[0] || null;
}

async function countSounds(serverId) {
  const { rows } = await query(
    'SELECT COUNT(*) AS count FROM soundboard_sounds WHERE server_id = $1',
    [Number(serverId)]
  );
  return Number(rows[0]?.count) || 0;
}

async function findSoundByName(serverId, name) {
  const { rows } = await query(
    'SELECT id FROM soundboard_sounds WHERE server_id = $1 AND lower(name) = lower($2)',
    [Number(serverId), name]
  );
  return rows[0] || null;
}

function isAudioMime(mime) {
  return AUDIO_MIME_RE.test(mime) || EXTRA_AUDIO_MIMES.has(mime);
}

// The mime is client supplied, so the file on disk is the only thing that
// actually proves this is a playable clip. Extension + size + presence.
function isAudioFile(value) {
  if (!UPLOAD_URL_RE.test(value)) return false;
  if (!AUDIO_EXTENSIONS.has(path.extname(value).toLowerCase())) return false;
  try {
    const stat = fs.statSync(path.join(uploadsDir, path.basename(value)));
    return stat.isFile() && stat.size > 0 && stat.size <= MAX_BYTES;
  } catch {
    return false;
  }
}

async function guardServer(req, res) {
  const serverId = Number(req.params.id);
  if (!Number.isInteger(serverId) || serverId <= 0) {
    res.status(400).json({ error: 'Invalid server.' });
    return null;
  }
  if (!(await getMembership(serverId, req.user.id))) {
    res.status(403).json({ error: 'You are not a member of this server.' });
    return null;
  }
  return serverId;
}

function can(req, serverId, permission) {
  return hasServerPermission(serverId, req.user.id, permission, req.user.role);
}

router.get('/servers/:id/soundboard', authRequired, asyncHandler(async (req, res) => {
  const serverId = await guardServer(req, res);
  if (!serverId) return;
  res.json({ sounds: await listSounds(serverId) });
}));

router.post('/servers/:id/soundboard', authRequired, manageLimiter, asyncHandler(async (req, res) => {
  const serverId = await guardServer(req, res);
  if (!serverId) return;
  if (!(await can(req, serverId, 'manageSoundboard'))) {
    return res.status(403).json({ error: 'You need the Manage soundboard permission.' });
  }

  const name = trim(req.body.name);
  const file = trim(req.body.file);
  const mime = trim(req.body.mime).toLowerCase();
  const durationMs = Math.max(0, Math.min(600_000, Math.round(Number(req.body.durationMs) || 0)));

  if (!name) return res.status(400).json({ error: 'Give the sound a name.' });
  if (name.length > MAX_NAME) {
    return res.status(400).json({ error: `Names are ${MAX_NAME} characters or fewer.` });
  }
  if (!isAudioMime(mime)) {
    return res.status(400).json({ error: 'Soundboard clips must be audio files.' });
  }
  if (!isAudioFile(file)) {
    return res
      .status(400)
      .json({ error: 'Upload an audio clip of 512 KB or smaller first.' });
  }
  // The duplicate-name and 25-sound checks only mean something together with
  // the insert: two concurrent creates that both read "no such name" would both
  // insert. Locking the server row takes the write lock before the SELECTs, so
  // the second request re-reads after the first committed and sees its row.
  const outcome = await withTransaction(async () => {
    await query('SELECT id FROM servers WHERE id = $1 FOR UPDATE', [serverId]);
    if (await findSoundByName(serverId, name)) {
      return { status: 409, error: `This server already has a sound named "${name}".` };
    }
    if ((await countSounds(serverId)) >= MAX_SOUNDS) {
      return { status: 400, error: `This server has reached its limit of ${MAX_SOUNDS} sounds.` };
    }
    const { rows } = await query(
      `INSERT INTO soundboard_sounds (server_id, name, file, mime, duration_ms, uploaded_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [serverId, name, file, mime, durationMs, req.user.id, Date.now()]
    );
    return { sound: rows[0] };
  });
  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });

  const sound = outcome.sound;
  await logAudit(req.user.id, 'soundboard.create', 'soundboard_sound', sound.id, name);
  res.status(201).json({ sound: serializeSound(sound) });
}));

router.delete('/soundboard/:id', authRequired, manageLimiter, asyncHandler(async (req, res) => {
  const existing = await getSound(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Sound not found.' });
  if (!(await can(req, existing.server_id, 'manageSoundboard'))) {
    return res.status(403).json({ error: 'You need the Manage soundboard permission.' });
  }

  await query('DELETE FROM soundboard_sounds WHERE id = $1', [existing.id]);
  await deleteUploadIfUnused(existing.file);
  await logAudit(req.user.id, 'soundboard.delete', 'soundboard_sound', existing.id, existing.name);
  res.json({ ok: true, id: existing.id });
}));

// One clip every two seconds per user per server keeps a held-down button from
// turning a channel into a wall of noise.
const playLimiter = rateLimit({
  windowMs: 2000,
  max: 1,
  message: 'That sound just played. Give it a couple of seconds.',
  key: (req) => `soundboard-play:${req.user.id}:${req.sound.server_id}`
});

// Everything that can be rejected is checked before the rate limiter, so a bad
// request never eats the caller's next two seconds.
const loadPlay = asyncHandler(async (req, res, next) => {
  const sound = await getSound(req.params.id);
  if (!sound) return res.status(404).json({ error: 'Sound not found.' });
  if (!(await getMembership(sound.server_id, req.user.id))) {
    return res.status(403).json({ error: 'You are not a member of this server.' });
  }
  // Playing is its own permission now, separate from managing the library and
  // separate from being able to join voice at all.
  if (!(await hasServerPermission(sound.server_id, req.user.id, 'useSoundboard', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to use the soundboard here." });
  }
  const channelId = Number(req.body.channelId);
  const channel = Number.isInteger(channelId)
    ? (await query('SELECT id, server_id, type FROM channels WHERE id = $1', [channelId])).rows[0]
    : null;
  // A stage channel is voice-like, so clips play there too; everything else
  // (membership, rate limit, cap) is unchanged.
  const playable = channel && (channel.type === 'voice' || channel.type === 'stage');
  if (!playable || channel.server_id !== sound.server_id) {
    return res.status(400).json({ error: 'Join a voice channel in this server first.' });
  }
  // Being a member is not the same as being in the room: without this check any
  // member could play a clip into a channel they never joined. The request is
  // HTTP so it has no socket of its own - the caller counts as present when one
  // of their sockets is in the room (voice:join keys participants by socket).
  const room = voiceRooms.get(channel.id);
  const present =
    !!room && [...room.values()].some((participant) => Number(participant.id) === req.user.id);
  if (!present) {
    return res.status(400).json({ error: 'Join a voice channel in this server first.' });
  }
  req.sound = sound;
  req.playChannel = channel;
  next();
});

router.post('/soundboard/:id/play', authRequired, loadPlay, playLimiter, (req, res) => {
  const sound = req.sound;
  const channel = req.playChannel;

  const payload = {
    serverId: sound.server_id,
    channelId: channel.id,
    sound: { id: sound.id, name: sound.name, file: sound.file, mime: sound.mime },
    userId: req.user.id,
    userName: req.user.display_name
  };

  // Voice rooms are plain Maps of socketId -> participant, not socket.io rooms,
  // so fan out to each member socket the same way voice:peer-joined does.
  const room = voiceRooms.get(channel.id);
  const io = req.app.get('io');
  if (room && room.size) {
    for (const participant of room.values()) io.to(participant.socketId).emit('soundboard:play', payload);
  }

  res.status(204).end();
});

module.exports = router;
