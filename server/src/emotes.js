require('./pg/env');
const { query } = require('./pg/pool');

const EMOTE_NAME_RE = /^[a-zA-Z0-9_]{2,32}$/;
const EMOTE_KINDS = ['emote', 'sticker'];
// Free slots, deliberately far above Discord's 50 emotes / 5 stickers: the
// point of this clone is that a community does not have to pay to express
// itself. Boosts still add more on top (see SLOTS_PER_BOOST_LEVEL).
const KIND_LIMITS = { emote: 200, sticker: 100 };
const UPLOAD_URL_RE = /^\/uploads\/[a-zA-Z0-9._-]+$/;

function serializeEmote(row) {
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    kind: row.kind,
    url: row.url,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at
  };
}

async function listServerEmotes(serverId) {
  const { rows } = await query(
    `SELECT * FROM server_emotes WHERE server_id = $1
     ORDER BY kind ASC, lower(name) ASC`,
    [Number(serverId)]
  );
  return rows.map(serializeEmote);
}

async function getServerEmote(serverId, emoteId) {
  const { rows } = await query(
    'SELECT * FROM server_emotes WHERE server_id = $1 AND id = $2',
    [Number(serverId), Number(emoteId)]
  );
  return rows[0] ? serializeEmote(rows[0]) : null;
}

async function findEmoteByName(serverId, name) {
  const { rows } = await query(
    'SELECT * FROM server_emotes WHERE server_id = $1 AND lower(name) = lower($2)',
    [Number(serverId), String(name || '')]
  );
  return rows[0] ? serializeEmote(rows[0]) : null;
}

async function countEmotes(serverId, kind) {
  const { rows } = await query(
    'SELECT COUNT(*) AS count FROM server_emotes WHERE server_id = $1 AND kind = $2',
    [Number(serverId), kind]
  );
  return Number(rows[0]?.count) || 0;
}

function normalizeName(value) {
  return String(value || '')
    .trim()
    .replace(/^:+|:+$/g, '');
}

module.exports = {
  EMOTE_NAME_RE,
  EMOTE_KINDS,
  KIND_LIMITS,
  UPLOAD_URL_RE,
  serializeEmote,
  listServerEmotes,
  getServerEmote,
  findEmoteByName,
  countEmotes,
  normalizeName
};
