require('./pg/env');
const { query } = require('./pg/pool');
const { logAudit } = require('./util');
const { hasServerPermission } = require('./permissions');

const DEFAULT_AUTOMOD = {
  enabled: false,
  blockedWords: [],
  blockLinks: false,
  blockInvites: true,
  mentionLimit: 0,
  blockEveryone: false,
  blockCaps: false,
  blockRepeated: false,
  emojiLimit: 0,
  duplicateWindow: 0
};

function clamp(value, min, max) {
  return Math.min(Math.max(Number(value) || 0, min), max);
}

function parseBlockedWords(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[\n,]+/);
  const seen = new Set();
  const words = [];
  for (const entry of source) {
    const word = String(entry || '').trim().slice(0, 40);
    if (!word) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    words.push(word);
    if (words.length >= 50) break;
  }
  return words;
}

async function getAutomod(serverId) {
  const { rows } = await query('SELECT * FROM server_automod WHERE server_id = $1', [
    Number(serverId)
  ]);
  const row = rows[0];
  if (!row) return { ...DEFAULT_AUTOMOD, blockedWords: [] };
  let blockedWords = [];
  try {
    blockedWords = parseBlockedWords(JSON.parse(row.blocked_words || '[]'));
  } catch {
    blockedWords = [];
  }
  return {
    enabled: !!row.enabled,
    blockedWords,
    blockLinks: !!row.block_links,
    blockInvites: !!row.block_invites,
    mentionLimit: clamp(row.mention_limit, 0, 20),
    blockEveryone: !!row.block_everyone,
    blockCaps: !!row.block_caps,
    blockRepeated: !!row.block_repeated,
    emojiLimit: clamp(row.emoji_limit, 0, 50),
    duplicateWindow: clamp(row.duplicate_window, 0, 120)
  };
}

async function saveAutomod(serverId, input, actorId) {
  const blockedWords = parseBlockedWords(input.blockedWords);
  const settings = {
    enabled: !!input.enabled,
    blockedWords,
    blockLinks: !!input.blockLinks,
    blockInvites: !!input.blockInvites,
    mentionLimit: clamp(input.mentionLimit, 0, 20),
    blockEveryone: !!input.blockEveryone,
    blockCaps: !!input.blockCaps,
    blockRepeated: !!input.blockRepeated,
    emojiLimit: clamp(input.emojiLimit, 0, 50),
    duplicateWindow: clamp(input.duplicateWindow, 0, 120)
  };
  const now = Date.now();
  await query(
    `INSERT INTO server_automod
       (server_id, enabled, blocked_words, block_links, block_invites, mention_limit,
        block_everyone, block_caps, block_repeated, emoji_limit, duplicate_window,
        updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT(server_id) DO UPDATE SET
       enabled = excluded.enabled,
       blocked_words = excluded.blocked_words,
       block_links = excluded.block_links,
       block_invites = excluded.block_invites,
       mention_limit = excluded.mention_limit,
       block_everyone = excluded.block_everyone,
       block_caps = excluded.block_caps,
       block_repeated = excluded.block_repeated,
       emoji_limit = excluded.emoji_limit,
       duplicate_window = excluded.duplicate_window,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
    [
    Number(serverId),
    settings.enabled ? 1 : 0,
    JSON.stringify(settings.blockedWords),
    settings.blockLinks ? 1 : 0,
    settings.blockInvites ? 1 : 0,
    settings.mentionLimit,
    settings.blockEveryone ? 1 : 0,
    settings.blockCaps ? 1 : 0,
    settings.blockRepeated ? 1 : 0,
    settings.emojiLimit,
    settings.duplicateWindow,
    now,
    actorId ? Number(actorId) : null
    ]
  );
  await logAudit(
    actorId,
    'automod.update',
    'server',
    serverId,
    `enabled=${settings.enabled} words=${settings.blockedWords.length} links=${settings.blockLinks} invites=${settings.blockInvites} mentions=${settings.mentionLimit} everyone=${settings.blockEveryone} caps=${settings.blockCaps} repeated=${settings.blockRepeated} emoji=${settings.emojiLimit} duplicate=${settings.duplicateWindow}`
  );
  return settings;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function checkAutomod({ serverId, userId, channelId, content, globalRole, excludeMessageId }) {
  const text = String(content || '');
  if (!text) return null;
  if (await hasServerPermission(serverId, userId, 'manageServer', globalRole)) return null;
  const settings = await getAutomod(serverId);
  if (!settings.enabled) return null;

  const lowered = text.toLowerCase();
  for (const word of settings.blockedWords) {
    const needle = word.toLowerCase();
    const matches = /^[a-z0-9_]+$/i.test(word)
      ? new RegExp(`(^|[^a-z0-9_])${escapeRegExp(needle)}([^a-z0-9_]|$)`, 'i').test(text)
      : lowered.includes(needle);
    if (matches) {
      await logAudit(userId, 'automod.block', 'server', serverId, `blocked word: ${text.slice(0, 160)}`);
      return { rule: 'blocked word', message: 'Automod blocked this message for a blocked word.' };
    }
  }

  if (settings.blockLinks && /(?:https?:\/\/|www\.)[^\s]+/i.test(text)) {
    await logAudit(userId, 'automod.block', 'server', serverId, `link: ${text.slice(0, 160)}`);
    return { rule: 'links', message: 'Automod blocked this message because links are not allowed.' };
  }

  if (
    settings.blockInvites &&
    /(?:discord\.gg|discord(?:app)?\.com\/invite)\/[a-z0-9-]+/i.test(text)
  ) {
    await logAudit(userId, 'automod.block', 'server', serverId, `invite: ${text.slice(0, 160)}`);
    return { rule: 'invites', message: 'Automod blocked this message because invites are not allowed.' };
  }

  if (settings.blockEveryone && /@(everyone|here)\b/i.test(text)) {
    await logAudit(userId, 'automod.block', 'server', serverId, `everyone: ${text.slice(0, 160)}`);
    return {
      rule: 'everyone mention',
      message: 'Automod blocked this message because @everyone and @here are not allowed.'
    };
  }

  if (settings.blockCaps) {
    const letters = text.match(/[A-Za-z]/g) || [];
    if (letters.length >= 12) {
      const uppercase = letters.filter((letter) => letter >= 'A' && letter <= 'Z').length;
      if (uppercase / letters.length >= 0.7) {
        await logAudit(userId, 'automod.block', 'server', serverId, `caps: ${text.slice(0, 160)}`);
        return {
          rule: 'excessive caps',
          message: 'Automod blocked this message because it is mostly uppercase.'
        };
      }
    }
  }

  if (settings.blockRepeated && /([\s\S])\1{9,}/.test(text)) {
    await logAudit(userId, 'automod.block', 'server', serverId, `repeated: ${text.slice(0, 160)}`);
    return {
      rule: 'repeated characters',
      message: 'Automod blocked this message for repeated character spam.'
    };
  }

  if (settings.emojiLimit > 0) {
    const emojiCount = (text.match(/\p{Extended_Pictographic}/gu) || []).length;
    if (emojiCount > settings.emojiLimit) {
      await logAudit(userId, 'automod.block', 'server', serverId, `emoji: ${emojiCount}`);
      return {
        rule: 'emoji limit',
        message: `Automod blocked this message because it uses more than ${settings.emojiLimit} emoji.`
      };
    }
  }

  if (settings.mentionLimit > 0) {
    const mentions = text.match(/(?:@everyone|@here|@[a-z0-9._-]{3,24})/gi) || [];
    if (mentions.length > settings.mentionLimit) {
      await logAudit(userId, 'automod.block', 'server', serverId, `mentions: ${mentions.length}`);
      return {
        rule: 'mention limit',
        message: `Automod blocked this message because it mentions more than ${settings.mentionLimit} people.`
      };
    }
  }

  if (settings.duplicateWindow > 0 && channelId) {
    const { rows: duplicateRows } = await query(
      `SELECT 1 FROM messages
       WHERE channel_id = $1 AND user_id = $2 AND content = $3 AND created_at >= $4 AND id != $5
       LIMIT 1`,
      [
        Number(channelId),
        Number(userId),
        text,
        Date.now() - settings.duplicateWindow * 1000,
        Number(excludeMessageId) || 0
      ]
    );
    const duplicate = duplicateRows[0];
    if (duplicate) {
      await logAudit(userId, 'automod.block', 'server', serverId, `duplicate: ${text.slice(0, 160)}`);
      return {
        rule: 'duplicate message',
        message: `Automod blocked this message because you sent the same message within ${settings.duplicateWindow} seconds.`
      };
    }
  }

  return null;
}

module.exports = {
  DEFAULT_AUTOMOD,
  getAutomod,
  saveAutomod,
  checkAutomod
};
