const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
require('./pg/env');
const { query } = require('./pg/pool');
const { uploadsDir } = require('./config');
const { isVisibleOnline } = require('./presence');
const { isBotOnline } = require('./botPresence');
const nowPlaying = require('./nowPlaying');
const {
  getServerGroups,
  getMemberGroupsForServer,
  permissionsForMember,
  hasServerPermission,
  getChannelOverrides,
  resolveChannelPermissions,
  hasChannelPermission
} = require('./permissions');
const { listServerEmotes } = require('./emotes');
const { vanityStatus } = require('./invites');

const AVATAR_COLORS = [
  '#6d5efc',
  '#2f7df6',
  '#159f9a',
  '#2f9e6f',
  '#d98a1f',
  '#d95757',
  '#d9538a',
  '#8b5cf6',
  '#0d94ae',
  '#7a8798'
];

const THEMES = ['iris', 'ocean', 'fern', 'ember', 'rose', 'graphite'];
const MODES = ['ink', 'slate', 'dusk'];
const DM_PRIVACY = ['friends', 'anyone'];
const FRIEND_REQUESTS = ['anyone', 'mutual', 'nobody'];
const PROFILE_VISIBILITY = ['everyone', 'mutual', 'friends'];
const PRESENCE_VISIBILITY = ['everyone', 'nobody'];
// The categories Discover offers. Stored on the server row as-is.
const DISCOVER_CATEGORIES = [
  'Gaming',
  'Music',
  'Entertainment',
  'Science & Tech',
  'Education',
  'Community'
];

const BANNER_COLORS = [
  '#242a52',
  '#16385d',
  '#153d33',
  '#47281c',
  '#4a1d35',
  '#382049',
  '#22333f',
  '#3c2d18',
  '#22382a',
  '#2d2338'
];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarColor: row.avatar_color,
    avatarUrl: row.avatar_url || '',
    bannerColor: row.banner_color || '',
    bannerUrl: row.banner_url || '',
    statusText: row.status_text || '',
    presence: row.presence || 'online',
    // What the user is listening to right now, or null. Ephemeral: a client
    // pushes it and the server forgets it after five quiet minutes, so it is
    // never read from this row.
    activity: row.id ? nowPlaying.get(row.id) : null,
    bio: row.bio || '',
    // jsonb arrives already parsed; a row built without these columns (a message
    // author join, say) yields [] rather than undefined.
    socialLinks: Array.isArray(row.social_links) ? row.social_links : [],
    games: Array.isArray(row.games) ? row.games : [],
    role: row.role || 'user',
    // Bots are users rows with a flag, so every surface that already renders a
    // user can render a bot without a second payload shape.
    bot: !!Number(row.is_bot || 0),
    applicationId: row.bot_application_id ? Number(row.bot_application_id) : null,
    // A bot is online exactly while its gateway is connected, not because a
    // human socket is open.
    online: Number(row.is_bot || 0) ? isBotOnline(row.bot_application_id) : isVisibleOnline(row.id),
    e2eePublicKey: row.e2ee_public_key || '',
    e2eeSigningPublicKey: row.e2ee_signing_public_key || '',
    e2eeKeyVersion: Number(row.e2ee_key_version) || 0,
    e2eeKeyCreatedAt: row.e2ee_key_created_at || null,
    e2eeReady: !!row.e2ee_public_key && !!row.e2ee_key_backup,
    e2eeRecoveryReady: !!row.e2ee_recovery_backup,
    e2eeRecoveryResettable: !!row.e2ee_recovery_backup && !!row.e2ee_recovery_verifier,
    e2eeRecoveryCreatedAt: row.e2ee_recovery_created_at || null,
    createdAt: row.created_at
  };
}

function meUser(row) {
  return {
    ...publicUser(row),
    email: row.email,
    // Never in publicUser: an address is the account's recovery path, so only
    // the owner and an admin ever see whether it is confirmed.
    emailVerified: !!row.email_verified,
    emailOptout: !!row.email_optout,
    theme: row.theme || 'iris',
    mode: row.mode || 'ink',
    dmPrivacy: row.dm_privacy || 'friends',
    friendRequests: row.friend_requests || 'anyone',
    profileVisibility: row.profile_visibility || 'everyone',
    presenceVisibility: row.presence_visibility || 'everyone',
    showTyping: row.show_typing == null ? true : Number(row.show_typing) === 1
  };
}

async function canInitiateDm(senderId, target) {
  if (!target) return false;
  if (await blockedBetween(senderId, target.id)) return false;
  // A bot has no privacy setting to honour, and no way to message anybody first:
  // the only way this call happens is a person opening the conversation. Without
  // this a support bot is unreachable by default, because the default is
  // friends-only and nobody can friend a bot.
  if (target.is_bot) return true;
  if ((target.dm_privacy || 'friends') === 'anyone') return true;
  return (await relationship(senderId, target.id)) === 'friends';
}

// Accepted friendships only; blocks and pending requests never count.
async function friendIds(userId) {
  const { rows } = await query(
    `SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS id
     FROM friendships
     WHERE status = 'accepted' AND blocked_by IS NULL AND (requester_id = $1 OR addressee_id = $1)`,
    [Number(userId)]
  );
  return rows.map((row) => Number(row.id));
}

async function mutualFriends(a, b) {
  const mine = new Set(await friendIds(a));
  if (!mine.size) return [];
  return (await friendIds(b)).filter((id) => mine.has(id));
}

async function sharesServer(a, b) {
  const { rows } = await query(
    `SELECT 1 FROM server_members mine
     JOIN server_members theirs ON theirs.server_id = mine.server_id
     WHERE mine.user_id = $1 AND theirs.user_id = $2
     LIMIT 1`,
    [Number(a), Number(b)]
  );
  return !!rows[0];
}

// The target's friend_requests policy decides whether a request may be created.
async function canSendFriendRequest(senderId, target) {
  if (!target) return false;
  if (await blockedBetween(senderId, target.id)) return false;
  const policy = target.friend_requests || 'anyone';
  if (policy === 'anyone') return true;
  if (policy === 'nobody') return false;
  return (await mutualFriends(senderId, target.id)).length > 0;
}

// The target's profile_visibility policy decides how much of a profile a
// viewer may read. Self always sees everything.
async function canViewProfile(viewerId, target) {
  if (!target) return false;
  if (Number(viewerId) === Number(target.id)) return true;
  const policy = target.profile_visibility || 'everyone';
  if (policy === 'everyone') return true;
  if ((await relationship(viewerId, target.id)) === 'friends') return true;
  if (policy === 'friends') return false;
  return sharesServer(viewerId, target.id);
}

async function getMembership(serverId, userId) {
  const { rows } = await query(
    'SELECT * FROM server_members WHERE server_id = $1 AND user_id = $2',
    [Number(serverId), Number(userId)]
  );
  return rows[0];
}

async function canManageServer(serverId, userId) {
  return hasServerPermission(serverId, userId, 'manageServer');
}

async function isServerOwner(serverId, userId) {
  const membership = await getMembership(serverId, userId);
  return !!membership && membership.role === 'owner';
}

// Emote role gating lives in emote_role_access: no rows means the emote is
// usable by everyone, rows means the sender has to hold one of those groups.
// Every emote payload carries the answer so a client can grey out locked emotes
// without a second request. One query for the whole list, never one per emote.
async function attachEmoteAccess(emotes) {
  if (!Array.isArray(emotes) || !emotes.length) return emotes;
  const { rows } = await query(
    `SELECT emote_id, group_id FROM emote_role_access
     WHERE emote_id IN (SELECT (value)::bigint FROM jsonb_array_elements_text($1::jsonb))
     ORDER BY group_id ASC`,
    [JSON.stringify(emotes.map((emote) => Number(emote.id)))]
  );
  const byEmote = new Map();
  for (const row of rows) {
    const key = Number(row.emote_id);
    const list = byEmote.get(key);
    if (list) list.push(Number(row.group_id));
    else byEmote.set(key, [Number(row.group_id)]);
  }
  return emotes.map((emote) => {
    const groupIds = byEmote.get(Number(emote.id)) || [];
    return { ...emote, restricted: groupIds.length > 0, groupIds };
  });
}

async function buildServer(serverId, viewerId = null) {
  const { rows: serverRows } = await query('SELECT * FROM servers WHERE id = $1', [Number(serverId)]);
  const server = serverRows[0];
  if (!server) return null;
  // Boost count and level are server-wide, but whether the button reads "Boost"
  // or "Remove boost" is per viewer, so the flag is only computed when a viewer
  // is supplied - broadcasts stay viewer-neutral and never clobber it.
  // Whether this viewer may claim a vanity link depends on their account age
  // and the server's, so the answer travels with the payload rather than
  // costing the settings card a second request.
  let inviteVanity = null;
  if (viewerId) {
    const viewer = (
      await query('SELECT created_at, role FROM users WHERE id = $1', [Number(viewerId)])
    ).rows[0];
    inviteVanity = vanityStatus({
      accountCreatedAt: viewer?.created_at,
      accountRole: viewer?.role,
      serverCreatedAt: server.created_at
    });
  }
  const boosted = viewerId
    ? !!(await query(
        "SELECT 1 FROM read_states WHERE user_id = $1 AND scope_type = 'server_boost' AND scope_id = $2",
        [Number(viewerId), server.id]
      )).rows[0]
    : null;
  const categories = (
    await query('SELECT * FROM channel_categories WHERE server_id = $1 ORDER BY position ASC, id ASC', [server.id])
  ).rows.map((category) => ({
      id: category.id,
      serverId: category.server_id,
      name: category.name,
      position: category.position,
      createdAt: category.created_at
    }));
  const channels = (
    await query('SELECT * FROM channels WHERE server_id = $1 ORDER BY position ASC, id ASC', [server.id])
  ).rows
    // Threads and forum posts are channel rows, but they are not part of the
    // channel list - they ride along in their own array below.
    .filter((channel) => channel.type !== 'thread')
    .map((channel) => ({
      id: channel.id,
      serverId: channel.server_id,
      categoryId: channel.category_id ?? null,
      name: channel.name,
      type: channel.type,
      position: channel.position,
      guidelines: channel.guidelines || ''
    }));
  const [groups, memberGroups, groupCategoryRows] = await Promise.all([
    getServerGroups(server.id),
    getMemberGroupsForServer(server.id),
    query(
      'SELECT id, server_id, name, position, created_at FROM group_categories WHERE server_id = $1 ORDER BY position ASC, id ASC',
      [server.id]
    )
  ]);
  const groupCategories = groupCategoryRows.rows.map((row) => ({
    id: Number(row.id),
    serverId: Number(row.server_id),
    name: row.name,
    position: Number(row.position) || 0,
    createdAt: row.created_at
  }));
  const members = (
    await query(
      `SELECT u.*, sm.role AS member_role, sm.joined_at
       FROM server_members sm JOIN users u ON u.id = sm.user_id
       WHERE sm.server_id = $1 ORDER BY sm.joined_at ASC`,
      [server.id]
    )
  ).rows.map((row) => {
      const assignedGroups = memberGroups.get(row.id) || [];
      const permissions = permissionsForMember(
        { role: row.member_role },
        groups,
        assignedGroups,
        row.role
      );
      const highestGroupPosition =
        row.member_role === 'owner' || row.member_role === 'admin' || row.role === 'admin'
          ? 1000000
          : assignedGroups.reduce((highest, group) => Math.max(highest, group.position), 0);
      return {
        ...publicUser(row),
        role: row.role,
        serverRole: row.member_role,
        joinedAt: row.joined_at,
        groups: assignedGroups,
        permissions,
        highestGroupPosition
      };
    });
  // Channel visibility is resolved only when a viewer is named. A broadcast has
  // no viewer, so it keeps every channel: enforcement happens on the read and
  // write paths, not on the payload shape. The client keeps the permissions map
  // from its own bootstrap, which is always viewer-specific.
  let visibleChannels = channels;
  let channelPermissions = null;
  if (viewerId) {
    const viewerRow = members.find((member) => Number(member.id) === Number(viewerId));
    const overrides = await getChannelOverrides(server.id);
    channelPermissions = {};
    for (const channel of channels) {
      const rows = (overrides.get(Number(channel.id)) || []).filter(
        (row) => row.targetType === 'group' || row.targetId === Number(viewerId)
      );
      channelPermissions[channel.id] = viewerRow
        ? resolveChannelPermissions(
            { role: viewerRow.serverRole },
            groups,
            viewerRow.groups,
            viewerRow.role,
            rows
          )
        : [];
    }
    visibleChannels = channels.filter((channel) =>
      (channelPermissions[channel.id] || []).includes('viewChannel')
    );
  }

  return {
    id: server.id,
    name: server.name,
    description: server.description || '',
    iconColor: server.icon_color,
    iconUrl: server.icon_url || '',
    banner: server.banner || '',
    ownerId: server.owner_id,
    inviteCode: server.invite_code,
    inviteCodeCustom: Number(server.invite_code_custom) === 1,
    ...(inviteVanity ? { inviteVanity } : {}),
    threadArchiveMinutes: Number(server.thread_archive_minutes) || 0,
    allowExternalEmotes: !!server.allow_external_emotes,
    discoverable: !!server.discoverable,
    discoverCategory: server.discover_category || 'Community',
    // The welcome body is deliberately left out of this payload: it can be 1000
    // characters and only the onboarding screen needs it.
    welcomeEnabled: !!server.welcome_enabled,
    // Join and leave lines. Stored as 0/1; the client only needs a boolean.
    joinMessages: Number(server.join_messages ?? 1) !== 0,
    boostCount: Number(server.boost_count) || 0,
    boostLevel: Number(server.boost_level) || 0,
    ...(boosted === null ? {} : { boosted }),
    createdAt: server.created_at,
    groups,
    groupCategories,
    categories,
    channels: visibleChannels,
    members,
    ...(channelPermissions ? { channelPermissions } : {}),
    emotes: await attachEmoteAccess(await listServerEmotes(server.id))
  };
}

async function buildDm(dm, viewerId) {
  const otherId = dm.user_a === Number(viewerId) ? dm.user_b : dm.user_a;
  const other = (await query('SELECT * FROM users WHERE id = $1', [otherId])).rows[0];
  const last = (
    await query(
      `SELECT m.*, u.display_name AS author_name FROM messages m
       JOIN users u ON u.id = m.user_id WHERE m.dm_id = $1 ORDER BY m.id DESC LIMIT 1`,
      [dm.id]
    )
  ).rows[0];
  return {
    id: dm.id,
    user: publicUser(other),
    createdAt: dm.created_at,
    closed:
      Number(viewerId) === dm.user_a ? !!dm.closed_by_a : !!dm.closed_by_b,
    lastMessage: last
      ? {
          content: last.e2ee ? '' : last.content,
          encrypted: !!last.e2ee,
          createdAt: last.created_at,
          authorId: last.user_id,
          authorName: last.author_name,
          hasAttachment: !!last.attachment_url
        }
      : null
  };
}

const MESSAGE_SELECT = `
  SELECT m.*, c.server_id AS server_id,
    u.username AS author_username, u.display_name AS author_display_name,
    u.avatar_color AS author_avatar_color, u.avatar_url AS author_avatar_url,
    u.status_text AS author_status_text, u.presence AS author_presence,
    u.bio AS author_bio, u.role AS author_role, u.is_bot AS author_is_bot,
    u.bot_application_id AS author_application_id,
    u.e2ee_public_key AS author_e2ee_public_key,
    u.e2ee_key_version AS author_e2ee_key_version,
    r.content AS reply_content, r.attachment_name AS reply_attachment_name,
    r.e2ee AS reply_e2ee, r.e2ee_envelope AS reply_e2ee_envelope,
    r.user_id AS reply_user_id, ru.display_name AS reply_author_name,
    ru.avatar_color AS reply_author_color, ru.avatar_url AS reply_author_avatar_url,
    p.id AS poll_id, p.question AS poll_question,
    p.allow_multiple AS poll_allow_multiple, p.closes_at AS poll_closes_at,
    p.created_at AS poll_created_at, p.created_by AS poll_created_by,
    th.name AS thread_name, th.archived AS thread_archived
  FROM messages m
  JOIN users u ON u.id = m.user_id
  LEFT JOIN channels c ON c.id = m.channel_id
  LEFT JOIN messages r ON r.id = m.reply_to_id
  LEFT JOIN users ru ON ru.id = r.user_id
  LEFT JOIN polls p ON p.message_id = m.id
  LEFT JOIN channels th ON th.id = m.thread_id
`;

async function reactionsFor(messageId, viewerId) {
  const { rows } = await query(
    `SELECT emoji, COUNT(*) AS count, string_agg(user_id::text, ',') AS users,
      MAX(CASE WHEN user_id = $1 THEN 1 ELSE 0 END) AS me
     FROM reactions WHERE message_id = $2 GROUP BY emoji ORDER BY MIN(created_at) ASC`,
    [Number(viewerId), Number(messageId)]
  );
  return rows.map((row) => ({
      emoji: row.emoji,
      count: Number(row.count),
      users: row.users ? String(row.users).split(',').map(Number) : [],
      me: !!row.me
    }));
}

async function pollForMessage(row, viewerId) {
  if (!row?.poll_id) return null;
  const viewer = Number(viewerId) || 0;
  const options = (
    await query(
      `SELECT o.id, o.label, o.position,
        COUNT(v.user_id) AS count,
        string_agg(v.user_id::text, ',') AS users,
        MAX(CASE WHEN v.user_id = $1 THEN 1 ELSE 0 END) AS me
       FROM poll_options o
       LEFT JOIN poll_votes v ON v.option_id = o.id
       WHERE o.poll_id = $2
       GROUP BY o.id
       ORDER BY o.position ASC, o.id ASC`,
      [viewer, row.poll_id]
    )
  ).rows.map((option) => ({
      id: option.id,
      label: option.label,
      count: Number(option.count) || 0,
      users: option.users ? String(option.users).split(',').map(Number) : [],
      me: !!option.me
    }));
  const totals = (
    await query(
      `SELECT COUNT(*) AS votes, COUNT(DISTINCT user_id) AS voters
       FROM poll_votes WHERE poll_id = $1`,
      [row.poll_id]
    )
  ).rows[0];
  const closesAt = row.poll_closes_at ? Number(row.poll_closes_at) : null;
  return {
    id: row.poll_id,
    question: row.poll_question,
    allowMultiple: !!row.poll_allow_multiple,
    closesAt,
    closed: !!closesAt && closesAt <= Date.now(),
    createdAt: row.poll_created_at,
    createdBy: row.poll_created_by,
    totalVotes: Number(totals?.votes) || 0,
    voterCount: Number(totals?.voters) || 0,
    options
  };
}

function parseE2eeEnvelope(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function serializeMessage(row, viewerId) {
  if (!row) return null;
  const encrypted = !!row.e2ee;
  const [poll, reactions] = await Promise.all([
    pollForMessage(row, viewerId),
    reactionsFor(row.id, viewerId)
  ]);
  return {
    id: row.id,
    channelId: row.channel_id,
    serverId: row.server_id,
    dmId: row.dm_id,
    content: encrypted ? '' : row.content,
    encrypted,
    envelope: encrypted ? parseE2eeEnvelope(row.e2ee_envelope) : null,
    attachment: row.attachment_url
      ? { url: row.attachment_url, name: row.attachment_name, type: row.attachment_type }
      : null,
    // 0 for anything that is not a voice note, so clients can test the number.
    voiceDurationMs: Number(row.voice_duration_ms) || 0,
    // null unless this row is a forwarded copy; the author is a snapshot taken
    // at forward time because the source message may be deleted later.
    forwarded: row.forwarded_from
      ? { from: Number(row.forwarded_from), author: row.forwarded_author || '' }
      : null,
    replyTo: row.reply_to_id
      ? {
          id: row.reply_to_id,
          authorId: row.reply_user_id,
          authorName: row.reply_author_name || 'Unknown user',
          authorColor: row.reply_author_color || '#6366f1',
          authorAvatarUrl: row.reply_author_avatar_url || '',
          content: row.reply_e2ee ? '' : row.reply_content || '',
          encrypted: !!row.reply_e2ee,
          envelope: row.reply_e2ee ? parseE2eeEnvelope(row.reply_e2ee_envelope) : null,
          hasAttachment: !!row.reply_attachment_name
        }
      : null,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    pinnedAt: row.pinned_at || null,
    pinnedBy: row.pinned_by || null,
    systemType: row.system_type || null,
    threadId: row.thread_id || null,
    thread: row.thread_id
      ? {
          id: row.thread_id,
          name: row.thread_name || 'Thread',
          archived: !!row.thread_archived
        }
      : null,
    // Set by the safety scan at send time. Only the recipient sees it: the
    // sender is never told their message was scanned, and a third party
    // reading the same room gets the plain message.
    components: row.components || null,
    safety:
      row.safety_level && viewerId && Number(viewerId) !== Number(row.user_id)
        ? {
            level: row.safety_level,
            categories: String(row.safety_categories || '')
              .split(',')
              .filter(Boolean)
          }
        : null,
    poll,
    reactions,
    author: {
      id: row.user_id,
      username: row.author_username,
      displayName: row.author_display_name,
      avatarColor: row.author_avatar_color,
      avatarUrl: row.author_avatar_url || '',
      statusText: row.author_status_text || '',
      presence: row.author_presence || 'online',
      bio: row.author_bio || '',
      role: row.author_role || 'user',
      bot: !!Number(row.author_is_bot || 0),
      online: Number(row.author_is_bot || 0)
        ? isBotOnline(row.author_application_id)
        : isVisibleOnline(row.user_id),
      e2eePublicKey: row.author_e2ee_public_key || '',
      e2eeKeyVersion: Number(row.author_e2ee_key_version) || 0,
      e2eeReady: !!row.author_e2ee_public_key
    }
  };
}

async function getMessageRow(messageId) {
  const { rows } = await query(`${MESSAGE_SELECT} WHERE m.id = $1`, [Number(messageId)]);
  return rows[0];
}

async function getChannelRow(channelId) {
  const { rows } = await query(
    `SELECT c.*, s.name AS server_name FROM channels c
     JOIN servers s ON s.id = c.server_id WHERE c.id = $1`,
    [Number(channelId)]
  );
  return rows[0];
}

async function getDmRow(dmId) {
  const { rows } = await query('SELECT * FROM dm_channels WHERE id = $1', [Number(dmId)]);
  return rows[0];
}

function isDmParticipant(dm, userId) {
  return !!dm && (dm.user_a === Number(userId) || dm.user_b === Number(userId));
}

async function assertChannelAccess(channelId, userId) {
  const channel = await getChannelRow(channelId);
  if (!channel) return { error: 'Channel not found', status: 404 };
  const membership = await getMembership(channel.server_id, userId);
  if (!membership) return { error: 'You are not a member of this server', status: 403 };
  // A channel override that hides a channel hides it everywhere: the sidebar,
  // the message list and every write path, because they all come through here.
  if (
    !(await hasChannelPermission(channel.server_id, channel.id, userId, 'viewChannel', membership.role))
  ) {
    return { error: 'You cannot view this channel', status: 403 };
  }
  // Threads are private: you only get in by starting one, posting in it or
  // joining it. Forum posts stay public - a forum nobody can read is useless.
  if (channel.type === 'thread') {
    const parent = channel.parent_channel_id ? await getChannelRow(channel.parent_channel_id) : null;
    const isForumPost = parent && parent.type === 'forum';
    if (!isForumPost) {
      const member =
        (await query('SELECT 1 FROM thread_members WHERE thread_id = $1 AND user_id = $2', [
          channel.id,
          Number(userId)
        ])).rows[0] ||
        (await hasServerPermission(channel.server_id, userId, 'manageChannels', membership.role));
      if (!member) return { error: 'Join this thread to see it', status: 403 };
    }
  }
  return { channel, membership };
}

// Lowercase so the random code and a chosen one share a canonical form; the
// lookup folds case, so links shared before this change still resolve.
function makeInviteCode() {
  return crypto.randomBytes(4).toString('hex');
}

// Codes have to be unique across both invite tables: resolution checks
// server_invites first, so a collision would silently shadow the permanent link.
async function uniqueInviteCode() {
  for (let i = 0; i < 10; i += 1) {
    const code = makeInviteCode();
    const exists = (
      await query(
        `SELECT 1 FROM servers WHERE lower(invite_code) = $1
         UNION ALL SELECT 1 FROM server_invites WHERE lower(code) = $1
         LIMIT 1`,
        [code]
      )
    ).rows[0];
    if (!exists) return code;
  }
  return crypto.randomBytes(8).toString('hex');
}

async function relationship(viewerId, otherId) {
  const a = Number(viewerId);
  const b = Number(otherId);
  if (a === b) return 'self';
  const { rows } = await query(
    `SELECT * FROM friendships
     WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $3 AND addressee_id = $4)`,
    [a, b, b, a]
  );
  const row = rows[0];
  if (!row) return 'none';
  if (row.blocked_by) return row.blocked_by === a ? 'blocked' : 'blockedBy';
  if (row.status === 'accepted') return 'friends';
  if (row.status === 'pending') return row.requester_id === a ? 'outgoing' : 'incoming';
  return 'none';
}

async function blockedBetween(a, b) {
  const { rows } = await query(
    `SELECT * FROM friendships
     WHERE blocked_by IS NOT NULL AND ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $3 AND addressee_id = $4))`,
    [Number(a), Number(b), Number(b), Number(a)]
  );
  return !!rows[0];
}

async function canModerateMessage(messageRow, user) {
  if (!messageRow) return false;
  if (messageRow.user_id === user.id) return true;
  if (messageRow.channel_id) {
    return hasServerPermission(messageRow.server_id, user.id, 'manageMessages', user.role);
  }
  return false;
}

async function logAudit(actorId, action, targetType, targetId, detail) {
  await query(
    'INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [
      actorId ? Number(actorId) : null,
      action,
      targetType || '',
      targetId ? Number(targetId) : null,
      detail || '',
      Date.now()
    ]
  );
}

function sanitizeChannelName(name) {
  return trim(name)
    .toLowerCase()
    .replace(/[^a-z0-9-_ ]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 32);
}

function isHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

// A voice note is an ordinary audio attachment plus a duration; the clip itself
// lives in attachment_url/name/type. The duration only means something next to
// an audio file, so a value on a text or image message is rejected instead of
// being stored as a lie. Clamped to ten minutes, the same ceiling the client
// recorder uses.
const VOICE_MAX_DURATION_MS = 600000;
const VOICE_MAX_BYTES = 25 * 1024 * 1024;

function validateVoiceDuration(value, attachment) {
  if (value === undefined || value === null || value === '') return { duration: 0 };
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 0) {
    return { error: 'Invalid voice message duration.' };
  }
  if (duration <= 0) return { duration: 0 };
  if (!attachment) return { error: 'Voice messages need an audio attachment.' };
  if (!/^audio\//i.test(String(attachment.type || ''))) {
    return { error: 'Voice messages need an audio attachment.' };
  }
  try {
    if (fs.statSync(path.join(uploadsDir, path.basename(attachment.url))).size > VOICE_MAX_BYTES) {
      return { error: 'Voice message is too large (25 MB max).' };
    }
  } catch {
    return { error: 'Voice message attachment not found.' };
  }
  return { duration: Math.min(Math.round(duration), VOICE_MAX_DURATION_MS) };
}

async function deleteUploadIfUnused(value) {
  if (!value || !/^\/uploads\/[a-zA-Z0-9._-]+$/.test(value)) return false;
  const { rows } = await query(
    `SELECT 1 FROM servers WHERE icon_url = $1
     UNION ALL SELECT 1 FROM servers WHERE banner = $2
     UNION ALL SELECT 1 FROM server_icon_history WHERE icon_url = $3
     UNION ALL SELECT 1 FROM server_icon_suggestions WHERE icon_url = $4
     UNION ALL SELECT 1 FROM users WHERE avatar_url = $5
     UNION ALL SELECT 1 FROM messages WHERE attachment_url = $6
     UNION ALL SELECT 1 FROM server_emotes WHERE url = $7
     UNION ALL SELECT 1 FROM soundboard_sounds WHERE file = $8
     LIMIT 1`,
    [value, value, value, value, value, value, value, value]
  );
  if (rows[0]) return false;
  try {
    fs.unlinkSync(path.join(uploadsDir, path.basename(value)));
    // The file is gone, so its uploads row is stale; dropping it keeps the
    // prune job from probing for a name that no longer exists.
    await query('DELETE FROM uploads WHERE name = $1', [path.basename(value)]);
    return true;
  } catch {
    return false;
  }
}

function isImageUpload(value) {
  if (!value) return true;
  if (!/^\/uploads\/[a-zA-Z0-9._-]+$/.test(value)) return false;
  const filePath = path.join(uploadsDir, path.basename(value));
  try {
    if (fs.statSync(filePath).size > 8 * 1024 * 1024) return false;
    const header = Buffer.alloc(16);
    const descriptor = fs.openSync(filePath, 'r');
    try {
      fs.readSync(descriptor, header, 0, header.length, 0);
    } finally {
      fs.closeSync(descriptor);
    }
    if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return true;
    }
    if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return true;
    if (header.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/)) return true;
    if (header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') {
      return true;
    }
    if (header.subarray(4, 8).toString('ascii') === 'ftyp') {
      const brand = header.subarray(8, 12).toString('ascii');
      return brand === 'avif' || brand === 'avis';
    }
  } catch {
    return false;
  }
  return false;
}

module.exports = {
  AVATAR_COLORS,
  BANNER_COLORS,
  THEMES,
  MODES,
  DM_PRIVACY,
  FRIEND_REQUESTS,
  PROFILE_VISIBILITY,
  PRESENCE_VISIBILITY,
  DISCOVER_CATEGORIES,
  pick,
  trim,
  publicUser,
  meUser,
  canInitiateDm,
  friendIds,
  mutualFriends,
  sharesServer,
  canSendFriendRequest,
  canViewProfile,
  getMembership,
  canManageServer,
  isServerOwner,
  attachEmoteAccess,
  buildServer,
  buildDm,
  MESSAGE_SELECT,
  serializeMessage,
  pollForMessage,
  reactionsFor,
  getMessageRow,
  getChannelRow,
  getDmRow,
  isDmParticipant,
  assertChannelAccess,
  uniqueInviteCode,
  relationship,
  blockedBetween,
  canModerateMessage,
  logAudit,
  sanitizeChannelName,
  isHexColor,
  validateVoiceDuration,
  isImageUpload,
  deleteUploadIfUnused
};
