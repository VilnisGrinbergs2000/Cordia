require('./pg/env');
const path = require('node:path');
const { query, withTransaction } = require('./pg/pool');
const { SERVER_PERMISSIONS } = require('./permissionCatalog');
const { normalizePermissions } = require('./permissions');
const { trim, sanitizeChannelName, isHexColor } = require('./util');
const { EMOTE_NAME_RE, EMOTE_KINDS, KIND_LIMITS, UPLOAD_URL_RE } = require('./emotes');

const FORMAT = 'cordia.server.v1';
const MAX_MESSAGES = 20000;
const MAX_WARNINGS = 50;

class TransferError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

function collectionFromDoc(doc, key) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  if (doc[key] !== undefined) return doc[key];
  if (doc.guild && typeof doc.guild === 'object' && doc.guild[key] !== undefined) {
    return doc.guild[key];
  }
  return null;
}

function findCollection(documents, key, predicate) {
  for (const entry of documents) {
    const value = collectionFromDoc(entry.doc, key);
    if (value !== null) return value;
  }
  for (const entry of documents) {
    if (predicate(entry.doc)) return entry.doc;
  }
  return [];
}

function cleanName(value, max = 48) {
  return trim(value).replace(/\s+/g, ' ').slice(0, max);
}

function nameKey(value) {
  return String(value || '').trim().toLowerCase();
}

function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function addWarning(warnings, message) {
  if (!message) return;
  if (!warnings.includes(message)) warnings.push(message);
}

function normalizeColor(value, fallback = '#7a8798') {
  if (typeof value === 'string' && isHexColor(value)) return value.toLowerCase();
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) {
    return `#${(number & 0xffffff).toString(16).padStart(6, '0')}`;
  }
  return fallback;
}

// Channel types survive a round-trip verbatim: a stage channel that comes back
// as a voice channel (or a forum as text) is data loss, not a safe downgrade.
function normalizeChannelType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (type === 'voice' || type === '2') return 'voice';
  if (type === 'stage' || type === '13') return 'stage';
  if (type === 'forum' || type === '15') return 'forum';
  return 'text';
}

function discordChannelType(value) {
  const type = Number(value);
  if ([0, 5, 15, 16].includes(type)) return 'text';
  if (type === 13) return 'stage';
  if (type === 2) return 'voice';
  return null;
}

const DISCORD_PERMISSION_BITS = [
  { bit: 1n << 3n, permissions: SERVER_PERMISSIONS },
  { bit: 1n << 5n, permissions: ['manageServer', 'viewServerSettings'] },
  { bit: 1n << 4n, permissions: ['manageChannels', 'viewServerSettings'] },
  { bit: 1n << 28n, permissions: ['manageGroups', 'viewServerSettings'] },
  { bit: 1n << 13n, permissions: ['manageMessages'] },
  { bit: 1n << 1n, permissions: ['kickMembers'] },
  { bit: 1n << 11n, permissions: ['sendMessages'] },
  { bit: 1n << 15n, permissions: ['attachFiles'] },
  { bit: 1n << 6n, permissions: ['addReactions'] },
  { bit: 1n << 20n, permissions: ['connectVoice'] },
  { bit: 1n << 21n, permissions: ['speak'] }
];

const DISCORD_PERMISSION_NAMES = {
  ADMINISTRATOR: SERVER_PERMISSIONS,
  MANAGE_GUILD: ['manageServer', 'viewServerSettings'],
  MANAGE_CHANNELS: ['manageChannels', 'viewServerSettings'],
  MANAGE_ROLES: ['manageGroups', 'viewServerSettings'],
  MANAGE_MESSAGES: ['manageMessages'],
  KICK_MEMBERS: ['kickMembers'],
  SEND_MESSAGES: ['sendMessages'],
  ATTACH_FILES: ['attachFiles'],
  ADD_REACTIONS: ['addReactions'],
  CONNECT: ['connectVoice'],
  SPEAK: ['speak']
};

function discordPermissions(value) {
  const keys = new Set();
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (SERVER_PERMISSIONS.includes(entry)) keys.add(entry);
      const mapped = DISCORD_PERMISSION_NAMES[String(entry || '').toUpperCase()];
      if (mapped) mapped.forEach((permission) => keys.add(permission));
    }
  } else {
    let bits = 0n;
    try {
      bits = BigInt(String(value ?? '0'));
    } catch {
      bits = 0n;
    }
    for (const rule of DISCORD_PERMISSION_BITS) {
      if ((bits & rule.bit) !== 0n) rule.permissions.forEach((permission) => keys.add(permission));
    }
  }
  return normalizePermissions([...keys]);
}

function normalizeAttachment(value, warnings) {
  if (!value) return null;
  const raw = typeof value === 'string' ? { url: value } : value;
  if (!raw || typeof raw !== 'object') return null;
  const url = trim(raw.url);
  if (!/^\/uploads\/[a-zA-Z0-9._-]+$/.test(url)) {
    addWarning(warnings, 'Some attachments were skipped because they are not Cordia upload URLs.');
    return null;
  }
  return {
    url,
    name: trim(raw.name).slice(0, 200) || 'file',
    type: trim(raw.type).slice(0, 100) || 'application/octet-stream'
  };
}

function normalizeMessage(entry, warnings) {
  if (!entry || typeof entry !== 'object') return null;
  const channel = cleanName(
    typeof entry.channel === 'string' ? entry.channel : entry.channel?.name,
    32
  );
  const author = cleanName(
    typeof entry.author === 'string' ? entry.author : entry.author?.username,
    32
  );
  const content = trim(entry.content).slice(0, 4000);
  const attachment = normalizeAttachment(entry.attachment, warnings);
  if (!channel || !author || (!content && !attachment)) return null;
  return {
    channel: sanitizeChannelName(channel),
    author,
    content,
    attachment,
    createdAt: numberOr(entry.createdAt, Date.now()),
    editedAt: entry.editedAt ? numberOr(entry.editedAt, null) : null
  };
}

// An emote is name + kind + the upload it points at; there is no access
// restriction column on server_emotes, so nothing else has to travel. The
// uploaded_by id is deliberately not carried: it means nothing in another
// instance and the importer is not the original uploader.
function normalizeEmote(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const name = cleanName(entry.name, 32).replace(/^:+|:+$/g, '');
  const url = trim(entry.url);
  if (!EMOTE_NAME_RE.test(name) || !UPLOAD_URL_RE.test(url)) return null;
  const kind = EMOTE_KINDS.includes(trim(entry.kind)) ? trim(entry.kind) : 'emote';
  return { name, kind, url };
}

function parseCanonical(doc, warnings) {
  const server = doc.server && typeof doc.server === 'object' ? doc.server : doc;
  const categories = asArray(doc.categories ?? server.categories)
    .map((entry, index) => {
      if (typeof entry === 'string') return { name: cleanName(entry), position: index };
      if (!entry || typeof entry !== 'object') return null;
      return {
        name: cleanName(entry.name),
        position: numberOr(entry.position, index)
      };
    })
    .filter((entry) => entry?.name);
  const channels = asArray(doc.channels ?? server.channels)
    .map((entry, index) => {
      if (typeof entry === 'string') {
        return {
          name: sanitizeChannelName(entry),
          type: 'text',
          category: null,
          position: index
        };
      }
      if (!entry || typeof entry !== 'object') return null;
      return {
        name: sanitizeChannelName(entry.name),
        type: normalizeChannelType(entry.type),
        category: cleanName(entry.category ?? entry.categoryName ?? entry.parent, 48) || null,
        position: numberOr(entry.position, index)
      };
    })
    .filter((entry) => entry?.name);
  const groups = asArray(doc.groups ?? server.groups)
    .map((entry, index) => {
      if (typeof entry === 'string') {
        return {
          name: cleanName(entry, 32),
          color: '#7a8798',
          permissions: [],
          position: index,
          isDefault: false,
          displaySeparately: false
        };
      }
      if (!entry || typeof entry !== 'object') return null;
      return {
        name: cleanName(entry.name, 32),
        color: normalizeColor(entry.color),
        permissions: normalizePermissions(entry.permissions),
        position: numberOr(entry.position, index),
        isDefault: entry.isDefault === true,
        displaySeparately: entry.displaySeparately === true
      };
    })
    .filter((entry) => entry?.name);
  const messages = asArray(doc.messages ?? server.messages)
    .map((entry) => normalizeMessage(entry, warnings))
    .filter(Boolean);
  const rawEmotes = asArray(doc.emotes ?? server.emotes);
  const emotes = rawEmotes.map(normalizeEmote).filter(Boolean);
  if (emotes.length < rawEmotes.length) {
    addWarning(warnings, 'Some emotes were skipped: their name or upload reference was invalid.');
  }

  return {
    source: 'cordia',
    sourceName: cleanName(server.name) || 'Imported server',
    server: {
      name: cleanName(server.name) || 'Imported server',
      description: trim(server.description).slice(0, 280),
      iconColor: normalizeColor(server.iconColor, '#6d5efc')
    },
    categories,
    channels,
    groups,
    messages,
    emotes
  };
}

function parseDiscord(guild, channelsValue, rolesValue, warnings) {
  const guildObject = guild?.guild && typeof guild.guild === 'object' ? guild.guild : guild;
  const channelList = asArray(channelsValue);
  const roleList = asArray(rolesValue);
  const categories = [];
  const categoryIdByName = new Map();
  const categoryNameById = new Map();
  const channels = [];
  const groups = [];

  for (const channel of channelList) {
    if (!channel || typeof channel !== 'object' || Number(channel.type) !== 4) continue;
    const name = cleanName(channel.name, 48);
    if (!name) continue;
    categories.push({ name, position: numberOr(channel.position) });
    categoryIdByName.set(nameKey(name), name);
    if (channel.id !== undefined && channel.id !== null) {
      categoryNameById.set(String(channel.id), name);
    }
  }

  for (const channel of channelList) {
    if (!channel || typeof channel !== 'object' || Number(channel.type) === 4) continue;
    const type = discordChannelType(channel.type);
    const name = sanitizeChannelName(channel.name);
    if (!type) {
      addWarning(
        warnings,
        `Skipped a Discord channel with unsupported type ${channel.type}${channel.name ? ` (${channel.name})` : ''}.`
      );
      continue;
    }
    if (!name) {
      addWarning(warnings, 'Skipped a Discord channel with an empty name.');
      continue;
    }
    let category = channel.parent_id ? categoryNameById.get(String(channel.parent_id)) || null : null;
    if (channel.parent_id && !category) {
      addWarning(
        warnings,
        `#${name} referenced a category that was not in the export, so it will be uncategorized.`
      );
    }
    channels.push({
      name,
      type,
      category,
      position: numberOr(channel.position)
    });
  }

  for (const role of roleList) {
    if (!role || typeof role !== 'object') continue;
    const name = cleanName(role.name, 32);
    if (!name) continue;
    if (nameKey(name) === '@everyone' || String(role.id) === String(guildObject?.id)) {
      addWarning(warnings, 'The Discord @everyone role was skipped; Cordia keeps its existing Members permissions.');
      continue;
    }
    if (role.managed) {
      addWarning(warnings, `Skipped managed Discord role "${name}".`);
      continue;
    }
    groups.push({
      name,
      color: normalizeColor(role.color ?? role.colors?.primary_color),
      permissions: discordPermissions(role.permissions_new ?? role.permissions),
      position: numberOr(role.position),
      isDefault: false,
      displaySeparately: false
    });
  }

  addWarning(
    warnings,
    'Discord imports restore categories, channels, and roles. Message history is imported from Cordia exports.'
  );

  return {
    source: 'discord',
    sourceName: cleanName(guildObject?.name) || 'Imported Discord server',
    server: {
      name: cleanName(guildObject?.name) || 'Imported Discord server',
      description: '',
      iconColor: '#7a8798'
    },
    categories,
    channels,
    groups,
    messages: []
  };
}

function parseImportFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new TransferError('Choose at least one JSON export file.');
  }

  const documents = [];
  for (const file of files) {
    let text;
    try {
      text = file.buffer.toString('utf8').replace(/^\uFEFF/, '');
    } catch {
      throw new TransferError(`Could not read ${file.originalname}.`);
    }
    try {
      documents.push({
        name: path.basename(file.originalname || '').toLowerCase(),
        doc: JSON.parse(text)
      });
    } catch {
      throw new TransferError(`${file.originalname} is not valid JSON.`);
    }
  }

  const warnings = [];
  const byName = new Map(documents.map((entry) => [entry.name, entry.doc]));
  const cordia = documents.find(
    (entry) =>
      entry.doc?.format === FORMAT ||
      (entry.doc?.server && typeof entry.doc.server === 'object') ||
      (Array.isArray(entry.doc?.categories) && Array.isArray(entry.doc?.channels))
  );
  if (cordia) return { ...parseCanonical(cordia.doc, warnings), warnings };

  const guild =
    byName.get('guild.json') ||
    documents.find((entry) => entry.doc?.guild && typeof entry.doc.guild === 'object')?.doc ||
    documents.find((entry) => {
      const doc = entry.doc;
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
      if (!(doc.name || doc.id)) return false;
      return collectionFromDoc(doc, 'channels') !== null || collectionFromDoc(doc, 'roles') !== null;
    })?.doc ||
    null;
  const channelsDoc = byName.get('channels.json');
  const channels =
    channelsDoc === undefined
      ? findCollection(
          documents,
          'channels',
          (doc) =>
            asArray(doc).some((item) => item && typeof item === 'object' && 'type' in item)
        )
      : collectionFromDoc(channelsDoc, 'channels') ?? channelsDoc;
  const rolesDoc = byName.get('roles.json');
  const roles =
    rolesDoc === undefined
      ? findCollection(
          documents,
          'roles',
          (doc) =>
            asArray(doc).some(
              (item) =>
                item &&
                typeof item === 'object' &&
                ('permissions' in item || 'permissions_new' in item)
            )
        )
      : collectionFromDoc(rolesDoc, 'roles') ?? rolesDoc;

  if (!guild && asArray(channels).length === 0 && asArray(roles).length === 0) {
    throw new TransferError(
      'Unsupported export. Choose a Cordia server export or Discord guild.json, channels.json, and roles.json files.'
    );
  }

  return {
    ...parseDiscord(guild, channels, roles, warnings),
    warnings
  };
}

async function exportServer(serverId, { includeMessages = true } = {}) {
  const { rows: serverRows } = await query('SELECT * FROM servers WHERE id = $1', [
    Number(serverId)
  ]);
  const server = serverRows[0];
  if (!server) throw new TransferError('Server not found.', 404);

  const { rows: categoryRows } = await query(
    'SELECT name, position FROM channel_categories WHERE server_id = $1 ORDER BY position ASC, id ASC',
    [server.id]
  );
  const categories = categoryRows.map((category) => ({
    name: category.name,
    position: category.position
  }));

  const { rows: channelRows } = await query(
    `SELECT c.name, c.type, c.position, cc.name AS category
     FROM channels c LEFT JOIN channel_categories cc ON cc.id = c.category_id
     WHERE c.server_id = $1 ORDER BY c.position ASC, c.id ASC`,
    [server.id]
  );
  const channels = channelRows.map((channel) => ({
    name: channel.name,
    type: channel.type,
    category: channel.category || null,
    position: channel.position
  }));

  const { rows: groupRows } = await query(
    `SELECT name, color, permissions, position, is_default, display_separately
     FROM server_groups WHERE server_id = $1 ORDER BY position ASC, id ASC`,
    [server.id]
  );
  const groups = groupRows.map((group) => {
    let permissions = [];
    try {
      permissions = normalizePermissions(JSON.parse(group.permissions || '[]'));
    } catch {
      permissions = [];
    }
    return {
      name: group.name,
      color: group.color,
      permissions,
      position: group.position,
      isDefault: !!group.is_default,
      displaySeparately: !!group.display_separately
    };
  });

  const { rows: emoteRows } = await query(
    `SELECT name, kind, url FROM server_emotes WHERE server_id = $1
     ORDER BY kind ASC, lower(name) ASC`,
    [server.id]
  );
  const emotes = emoteRows.map((emote) => ({
    name: emote.name,
    kind: emote.kind,
    url: emote.url
  }));

  let messages = [];
  if (includeMessages) {
    const { rows } = await query(
      `SELECT c.name AS channel, u.username AS author, m.content,
         m.created_at AS "createdAt", m.edited_at AS "editedAt",
         m.attachment_url AS "attachmentUrl", m.attachment_name AS "attachmentName",
         m.attachment_type AS "attachmentType"
       FROM messages m
       JOIN channels c ON c.id = m.channel_id
       JOIN users u ON u.id = m.user_id
       WHERE c.server_id = $1
       ORDER BY m.id ASC`,
      [server.id]
    );
    messages = rows.map((message) => ({
      channel: message.channel,
      author: message.author,
      content: message.content,
      createdAt: message.createdAt,
      editedAt: message.editedAt || null,
      attachment: message.attachmentUrl
        ? {
            url: message.attachmentUrl,
            name: message.attachmentName || 'file',
            type: message.attachmentType || 'application/octet-stream'
          }
        : null
    }));
  }

  return {
    format: FORMAT,
    exportedAt: Date.now(),
    server: {
      name: server.name,
      description: server.description || '',
      iconColor: server.icon_color,
      iconUrl: server.icon_url || ''
    },
    stats: {
      categories: categories.length,
      channels: channels.length,
      groups: groups.length,
      emotes: emotes.length,
      messages: messages.length
    },
    categories,
    channels,
    groups,
    emotes,
    messages
  };
}

async function buildImportPlan(serverId, parsed) {
  const { rows: serverRows } = await query('SELECT id, name FROM servers WHERE id = $1', [
    Number(serverId)
  ]);
  const server = serverRows[0];
  if (!server) throw new TransferError('Server not found.', 404);

  const warnings = [...(parsed.warnings || [])];
  const { rows: existingCategories } = await query(
    'SELECT id, name, position FROM channel_categories WHERE server_id = $1',
    [server.id]
  );
  const { rows: existingChannels } = await query(
    'SELECT id, name, position FROM channels WHERE server_id = $1',
    [server.id]
  );
  const { rows: existingGroups } = await query(
    'SELECT id, name, position FROM server_groups WHERE server_id = $1',
    [server.id]
  );

  const existingCategoryNames = new Set(existingCategories.map((category) => nameKey(category.name)));
  const existingChannelNames = new Set(existingChannels.map((channel) => nameKey(channel.name)));
  const existingGroupNames = new Set(existingGroups.map((group) => nameKey(group.name)));
  const plannedCategoryNames = new Set();
  const plannedChannelNames = new Set();
  const plannedGroupNames = new Set();

  let nextCategoryPosition =
    existingCategories.reduce((max, category) => Math.max(max, numberOr(category.position)), -1) + 1;
  let nextChannelPosition =
    existingChannels.reduce((max, channel) => Math.max(max, numberOr(channel.position)), -1) + 1;
  let nextGroupPosition =
    Math.max(0, ...existingGroups.map((group) => numberOr(group.position))) + 100;

  const categoryPlan = { create: [], skip: [] };
  for (const category of parsed.categories) {
    const name = cleanName(category.name);
    if (!name) continue;
    const key = nameKey(name);
    if (existingCategoryNames.has(key)) {
      categoryPlan.skip.push({ name, reason: 'Already exists' });
      continue;
    }
    if (plannedCategoryNames.has(key)) {
      categoryPlan.skip.push({ name, reason: 'Duplicate in import' });
      continue;
    }
    plannedCategoryNames.add(key);
    categoryPlan.create.push({ name, position: nextCategoryPosition });
    nextCategoryPosition += 1;
  }

  const channelPlan = { create: [], skip: [] };
  for (const channel of parsed.channels) {
    const name = sanitizeChannelName(channel.name);
    if (!name) continue;
    const key = nameKey(name);
    if (existingChannelNames.has(key)) {
      channelPlan.skip.push({ name, reason: 'Already exists' });
      continue;
    }
    if (plannedChannelNames.has(key)) {
      channelPlan.skip.push({ name, reason: 'Duplicate in import' });
      continue;
    }
    let categoryName = cleanName(channel.category);
    if (
      categoryName &&
      !existingCategoryNames.has(nameKey(categoryName)) &&
      !plannedCategoryNames.has(nameKey(categoryName))
    ) {
      addWarning(
        warnings,
        `#${name} referenced category "${categoryName}" which was not imported; it will be uncategorized.`
      );
      categoryName = null;
    }
    plannedChannelNames.add(key);
    channelPlan.create.push({
      name,
      type: normalizeChannelType(channel.type),
      categoryName: categoryName || null,
      position: nextChannelPosition
    });
    nextChannelPosition += 1;
  }

  const groupPlan = { create: [], skip: [] };
  const sortedGroups = [...parsed.groups].sort(
    (a, b) => numberOr(a.position) - numberOr(b.position)
  );
  for (const group of sortedGroups) {
    const name = cleanName(group.name, 32);
    if (!name) continue;
    const key = nameKey(name);
    if (group.isDefault) {
      groupPlan.skip.push({ name, reason: 'Default group is kept as-is' });
      continue;
    }
    if (existingGroupNames.has(key)) {
      groupPlan.skip.push({ name, reason: 'Already exists' });
      continue;
    }
    if (plannedGroupNames.has(key)) {
      groupPlan.skip.push({ name, reason: 'Duplicate in import' });
      continue;
    }
    plannedGroupNames.add(key);
    groupPlan.create.push({
      name,
      color: normalizeColor(group.color),
      permissions: normalizePermissions(group.permissions),
      position: nextGroupPosition,
      displaySeparately: !!group.displaySeparately
    });
    nextGroupPosition += 100;
  }

  const { rows: existingMessageRows } = await query(
    `SELECT c.name AS channel, u.username AS author, m.content, m.created_at,
       m.attachment_url AS "attachmentUrl"
     FROM messages m
     JOIN channels c ON c.id = m.channel_id
     JOIN users u ON u.id = m.user_id
     WHERE c.server_id = $1`,
    [server.id]
  );
  const existingMessageKeys = new Set(
    existingMessageRows.map(
      (message) =>
        `${nameKey(message.channel)}|${nameKey(message.author)}|${message.created_at}|${
          message.content
        }|${message.attachmentUrl || ''}`
    )
  );
  // Only members of the target server can author an imported message. Resolving
  // a username against the whole users table would let an admin forge history as
  // any account on the instance.
  const { rows: memberRows } = await query(
    `SELECT u.id, u.username FROM users u
     JOIN server_members sm ON sm.user_id = u.id
     WHERE sm.server_id = $1`,
    [server.id]
  );
  const userByName = new Map(memberRows.map((user) => [nameKey(user.username), user.id]));
  const channelNames = new Set([...existingChannelNames, ...plannedChannelNames]);
  const plannedMessageKeys = new Set();
  const messagePlan = { create: [], skip: 0 };
  for (const message of parsed.messages) {
    const channelName = sanitizeChannelName(message.channel);
    const authorName = nameKey(message.author);
    if (!channelName || !channelNames.has(nameKey(channelName)) || !userByName.has(authorName)) {
      messagePlan.skip += 1;
      continue;
    }
    const key = `${nameKey(channelName)}|${authorName}|${message.createdAt}|${
      message.content
    }|${message.attachment?.url || ''}`;
    if (existingMessageKeys.has(key) || plannedMessageKeys.has(key)) {
      messagePlan.skip += 1;
      continue;
    }
    plannedMessageKeys.add(key);
    messagePlan.create.push({
      ...message,
      channel: channelName,
      author: message.author
    });
    if (messagePlan.create.length >= MAX_MESSAGES) {
      addWarning(warnings, `Only the first ${MAX_MESSAGES} messages were included.`);
      break;
    }
  }

  const { rows: existingEmotes } = await query(
    'SELECT name, kind FROM server_emotes WHERE server_id = $1',
    [server.id]
  );
  const existingEmoteNames = new Set(existingEmotes.map((emote) => nameKey(emote.name)));
  const emoteCounts = { emote: 0, sticker: 0 };
  for (const emote of existingEmotes) {
    emoteCounts[emote.kind] = (emoteCounts[emote.kind] || 0) + 1;
  }
  const plannedEmoteNames = new Set();
  const emotePlan = { create: [], skip: [] };
  for (const emote of parsed.emotes || []) {
    const key = nameKey(emote.name);
    if (existingEmoteNames.has(key)) {
      emotePlan.skip.push({ name: emote.name, reason: 'Already exists' });
      continue;
    }
    if (plannedEmoteNames.has(key)) {
      emotePlan.skip.push({ name: emote.name, reason: 'Duplicate in import' });
      continue;
    }
    if ((emoteCounts[emote.kind] || 0) >= KIND_LIMITS[emote.kind]) {
      emotePlan.skip.push({
        name: emote.name,
        reason: `Server limit of ${KIND_LIMITS[emote.kind]} ${emote.kind}s reached`
      });
      continue;
    }
    plannedEmoteNames.add(key);
    emoteCounts[emote.kind] = (emoteCounts[emote.kind] || 0) + 1;
    emotePlan.create.push(emote);
  }
  if (emotePlan.create.length) {
    addWarning(
      warnings,
      'Emote art is stored as an upload path; copy the uploads folder with the export to keep the images.'
    );
  }

  const counts = {
    categories: { create: categoryPlan.create.length, skip: categoryPlan.skip.length },
    channels: { create: channelPlan.create.length, skip: channelPlan.skip.length },
    groups: { create: groupPlan.create.length, skip: groupPlan.skip.length },
    emotes: { create: emotePlan.create.length, skip: emotePlan.skip.length },
    messages: { create: messagePlan.create.length, skip: messagePlan.skip }
  };

  return {
    source: parsed.source,
    sourceName: parsed.sourceName,
    serverName: server.name,
    warnings,
    counts,
    hasChanges:
      counts.categories.create > 0 ||
      counts.channels.create > 0 ||
      counts.groups.create > 0 ||
      counts.emotes.create > 0 ||
      counts.messages.create > 0,
    categories: categoryPlan,
    channels: channelPlan,
    groups: groupPlan,
    emotes: emotePlan,
    messages: messagePlan
  };
}

function publicPlan(plan) {
  const trimSkips = (entries) => ({
    total: entries.length,
    items: entries.slice(0, 20)
  });
  return {
    source: plan.source,
    sourceName: plan.sourceName,
    hasChanges: plan.hasChanges,
    counts: plan.counts,
    categories: {
      create: plan.categories.create.map((entry) => entry.name),
      skip: trimSkips(plan.categories.skip)
    },
    channels: {
      create: plan.channels.create.map((entry) => entry.name),
      skip: trimSkips(plan.channels.skip)
    },
    groups: {
      create: plan.groups.create.map((entry) => entry.name),
      skip: trimSkips(plan.groups.skip)
    },
    emotes: {
      create: plan.emotes.create.map((entry) => entry.name),
      skip: trimSkips(plan.emotes.skip)
    },
    messages: plan.counts.messages,
    warnings: plan.warnings.slice(0, MAX_WARNINGS),
    warningsTotal: plan.warnings.length
  };
}

// One round trip per ~500 rows: a 20k-message import would otherwise spend
// minutes on 20k individual INSERTs.
const INSERT_BATCH = 500;

function chunk(entries, size) {
  const batches = [];
  for (let index = 0; index < entries.length; index += size) {
    batches.push(entries.slice(index, index + size));
  }
  return batches;
}

async function applyImport(serverId, parsed) {
  const plan = await buildImportPlan(serverId, parsed);
  const imported = { categories: 0, channels: 0, groups: 0, emotes: 0, messages: 0 };
  const now = Date.now();
  const targetId = Number(serverId);

  // Everything below is one transaction: a half-imported server (channels
  // without their messages, groups without members) is worse than a failure.
  await withTransaction(async () => {
    const { rows: categoryRows } = await query(
      'SELECT id, name FROM channel_categories WHERE server_id = $1',
      [targetId]
    );
    const categoryIdByName = new Map(
      categoryRows.map((category) => [nameKey(category.name), category.id])
    );
    const { rows: groupRows } = await query(
      'SELECT id, name FROM server_groups WHERE server_id = $1',
      [targetId]
    );
    const groupIdByName = new Map(groupRows.map((group) => [nameKey(group.name), group.id]));
    // Author resolution is limited to members of the target server - a username in
    // an uploaded file must never be enough to post as an arbitrary account.
    // TODO(schema): messages has no `imported` column, so imported rows cannot be
    // stamped as such; add one if provenance has to be visible to the client.
    const { rows: memberRows } = await query(
      `SELECT u.id, u.username FROM users u
       JOIN server_members sm ON sm.user_id = u.id
       WHERE sm.server_id = $1`,
      [targetId]
    );
    const userByName = new Map(memberRows.map((user) => [nameKey(user.username), user.id]));

    for (const category of plan.categories.create) {
      const { rows } = await query(
        `INSERT INTO channel_categories (server_id, name, position, created_at)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [targetId, category.name, category.position, now]
      );
      categoryIdByName.set(nameKey(category.name), rows[0].id);
      imported.categories += 1;
    }

    for (const group of plan.groups.create) {
      const { rows } = await query(
        `INSERT INTO server_groups
           (server_id, name, color, permissions, position, is_default, display_separately, created_at)
         VALUES ($1, $2, $3, $4, $5, 0, $6, $7) RETURNING id`,
        [
          targetId,
          group.name,
          group.color,
          JSON.stringify(group.permissions),
          group.position,
          group.displaySeparately ? 1 : 0,
          now
        ]
      );
      groupIdByName.set(nameKey(group.name), rows[0].id);
      imported.groups += 1;
    }

    const { rows: channelRows } = await query(
      'SELECT id, name FROM channels WHERE server_id = $1',
      [targetId]
    );
    const channelIdByName = new Map(
      channelRows.map((channel) => [nameKey(channel.name), channel.id])
    );
    for (const channel of plan.channels.create) {
      const categoryId = channel.categoryName
        ? categoryIdByName.get(nameKey(channel.categoryName)) || null
        : null;
      const { rows } = await query(
        `INSERT INTO channels (server_id, category_id, name, type, position, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [targetId, categoryId, channel.name, channel.type, channel.position, now]
      );
      channelIdByName.set(nameKey(channel.name), rows[0].id);
      imported.channels += 1;
    }

    for (const batch of chunk(plan.emotes.create, INSERT_BATCH)) {
      const payload = JSON.stringify(
        batch.map((emote) => ({ name: emote.name, kind: emote.kind, url: emote.url }))
      );
      const { rowCount } = await query(
        `INSERT INTO server_emotes (server_id, name, kind, url, uploaded_by, created_at)
         SELECT $1, r.name, r.kind, r.url, NULL, $2
         FROM jsonb_to_recordset($3::jsonb) AS r(name text, kind text, url text)`,
        [targetId, now, payload]
      );
      imported.emotes += rowCount;
    }

    const messageRows = [];
    const messageCounts = new Map();
    for (const message of plan.messages.create) {
      const channelId = channelIdByName.get(nameKey(message.channel));
      const userId = userByName.get(nameKey(message.author));
      if (!channelId || !userId) continue;
      messageRows.push({
        channelId,
        userId,
        content: message.content,
        attachmentUrl: message.attachment?.url || null,
        attachmentName: message.attachment?.name || null,
        attachmentType: message.attachment?.type || null,
        // created_at/edited_at are bigint columns; the export can carry fractions.
        createdAt: Math.trunc(message.createdAt),
        editedAt: message.editedAt === null || message.editedAt === undefined
          ? null
          : Math.trunc(message.editedAt)
      });
      messageCounts.set(userId, (messageCounts.get(userId) || 0) + 1);
    }

    for (const batch of chunk(messageRows, INSERT_BATCH)) {
      const { rowCount } = await query(
        `INSERT INTO messages
           (channel_id, user_id, content, attachment_url, attachment_name, attachment_type,
            created_at, edited_at)
         SELECT r."channelId", r."userId", r.content, r."attachmentUrl", r."attachmentName",
                r."attachmentType", r."createdAt", r."editedAt"
         FROM jsonb_to_recordset($1::jsonb) AS r(
           "channelId" bigint, "userId" bigint, content text, "attachmentUrl" text,
           "attachmentName" text, "attachmentType" text, "createdAt" bigint, "editedAt" bigint
         )`,
        [JSON.stringify(batch)]
      );
      imported.messages += rowCount;
    }

    if (messageCounts.size) {
      const userIds = [];
      const deltas = [];
      for (const [userId, count] of messageCounts) {
        userIds.push(userId);
        deltas.push(count);
      }
      await query(
        `UPDATE users SET message_count = message_count + v.delta
         FROM unnest($1::bigint[], $2::bigint[]) AS v(user_id, delta)
         WHERE users.id = v.user_id`,
        [userIds, deltas]
      );
    }
  });

  return {
    imported,
    plan: publicPlan(plan)
  };
}

module.exports = {
  FORMAT,
  TransferError,
  exportServer,
  parseImportFiles,
  buildImportPlan,
  publicPlan,
  applyImport
};
