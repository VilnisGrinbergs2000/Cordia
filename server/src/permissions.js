require('./pg/env');
const { query, withTransaction } = require('./pg/pool');
const {
  SERVER_PERMISSIONS,
  CHANNEL_PERMISSIONS,
  DEFAULT_MEMBER_PERMISSIONS,
  DEFAULT_GROUPS
} = require('./permissionCatalog');

function normalizePermissions(value, fallback = []) {
  const source = Array.isArray(value) ? value : fallback;
  const seen = new Set();
  for (const entry of source) {
    if (SERVER_PERMISSIONS.includes(entry)) seen.add(entry);
  }
  return SERVER_PERMISSIONS.filter((permission) => seen.has(permission));
}

function parsePermissions(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return normalizePermissions(parsed);
  } catch {
    return [];
  }
}

function serializeGroup(row) {
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.name,
    color: row.color,
    permissions: parsePermissions(row.permissions),
    position: Number(row.position) || 0,
    isDefault: !!row.is_default,
    displaySeparately: !!row.display_separately,
    categoryId: row.category_id ? Number(row.category_id) : null,
    createdAt: row.created_at
  };
}

async function getMembership(serverId, userId) {
  const { rows } = await query(
    'SELECT * FROM server_members WHERE server_id = $1 AND user_id = $2',
    [Number(serverId), Number(userId)]
  );
  return rows[0];
}

async function getServerGroups(serverId) {
  const { rows } = await query(
    'SELECT * FROM server_groups WHERE server_id = $1 ORDER BY position DESC, id ASC',
    [Number(serverId)]
  );
  return rows.map(serializeGroup);
}

async function getMemberGroups(serverId, userId) {
  const { rows } = await query(
    `SELECT g.* FROM server_member_groups smg
       JOIN server_groups g ON g.id = smg.group_id
       WHERE smg.server_id = $1 AND smg.user_id = $2
       ORDER BY g.position DESC, g.id ASC`,
    [Number(serverId), Number(userId)]
  );
  return rows.map(serializeGroup);
}

async function getMemberGroupsForServer(serverId) {
  const { rows } = await query(
    `SELECT smg.user_id, g.* FROM server_member_groups smg
       JOIN server_groups g ON g.id = smg.group_id
       WHERE smg.server_id = $1
       ORDER BY g.position DESC, g.id ASC`,
    [Number(serverId)]
  );
  const map = new Map();
  for (const row of rows) {
    const list = map.get(row.user_id) || [];
    list.push(serializeGroup(row));
    map.set(row.user_id, list);
  }
  return map;
}

async function ensureDefaultGroups(serverId) {
  const { rows } = await query(
    'SELECT COUNT(*) AS count FROM server_groups WHERE server_id = $1',
    [Number(serverId)]
  );
  if (Number(rows[0].count) > 0) return getServerGroups(serverId);

  const now = Date.now();
  await withTransaction(async () => {
    for (const group of DEFAULT_GROUPS) {
      await query(
        `INSERT INTO server_groups
           (server_id, name, color, permissions, position, is_default, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          Number(serverId),
          group.name,
          group.color,
          JSON.stringify(group.permissions),
          group.position,
          group.isDefault ? 1 : 0,
          now
        ]
      );
    }
  });
  return getServerGroups(serverId);
}

function defaultGroupFor(groups) {
  return groups.find((group) => group.isDefault) || null;
}

async function resolveGlobalRole(userId, globalRole) {
  if (globalRole) return globalRole;
  const { rows } = await query('SELECT role FROM users WHERE id = $1', [Number(userId)]);
  return rows[0]?.role || 'user';
}

function permissionsForMember(membership, groups, assignedGroups, globalRole) {
  if (!membership) return [];
  if (membership.role === 'owner' || membership.role === 'admin' || globalRole === 'admin') {
    return [...SERVER_PERMISSIONS];
  }

  const allowed = new Set();
  const base = defaultGroupFor(groups);
  for (const permission of base ? base.permissions : DEFAULT_MEMBER_PERMISSIONS) {
    allowed.add(permission);
  }
  for (const group of assignedGroups) {
    for (const permission of group.permissions) allowed.add(permission);
  }
  return SERVER_PERMISSIONS.filter((permission) => allowed.has(permission));
}

// The whole set at once. Callers that only need one answer use
// hasServerPermission; this is for the ones that hand the set to somebody else —
// a bot deciding for itself what to allow, for instance.
async function memberPermissions(serverId, userId, globalRole) {
  const membership = await getMembership(serverId, userId);
  if (!membership) return [];
  const role = await resolveGlobalRole(userId, globalRole);
  const [groups, assigned] = await Promise.all([
    getServerGroups(serverId),
    getMemberGroups(serverId, userId)
  ]);
  return permissionsForMember(membership, groups, assigned, role);
}

async function hasServerPermission(serverId, userId, permission, globalRole) {
  const membership = await getMembership(serverId, userId);
  if (!membership) return false;
  const role = await resolveGlobalRole(userId, globalRole);
  if (membership.role === 'owner' || membership.role === 'admin' || role === 'admin') {
    return true;
  }
  const [groups, assigned] = await Promise.all([
    getServerGroups(serverId),
    getMemberGroups(serverId, userId)
  ]);
  return permissionsForMember(membership, groups, assigned, role).includes(permission);
}

async function getHighestGroupPosition(serverId, userId, globalRole) {
  const membership = await getMembership(serverId, userId);
  if (!membership) return -1;
  const role = await resolveGlobalRole(userId, globalRole);
  if (membership.role === 'owner' || membership.role === 'admin' || role === 'admin') {
    return Number.POSITIVE_INFINITY;
  }
  const [groups, assigned] = await Promise.all([
    getServerGroups(serverId),
    getMemberGroups(serverId, userId)
  ]);
  let highest = 0;
  for (const group of assigned) highest = Math.max(highest, group.position);
  const base = defaultGroupFor(groups);
  if (base) highest = Math.max(highest, base.position);
  return highest;
}

async function canManageGroup(serverId, actorId, group, globalRole) {
  if (!group) return false;
  const actorMembership = await getMembership(serverId, actorId);
  if (!actorMembership) return false;
  const role = await resolveGlobalRole(actorId, globalRole);
  if (actorMembership.role === 'owner' || role === 'admin') return true;
  if (group.isDefault) return false;
  if (!(await hasServerPermission(serverId, actorId, 'manageGroups', role))) return false;
  return group.position < (await getHighestGroupPosition(serverId, actorId, role));
}

async function canManageMember(serverId, actorId, targetId, permission, globalRole) {
  if (Number(actorId) === Number(targetId)) return false;
  const target = await getMembership(serverId, targetId);
  if (!target) return false;
  if (target.role === 'owner') return false;

  const actor = await getMembership(serverId, actorId);
  if (!actor) return false;
  const role = await resolveGlobalRole(actorId, globalRole);
  if (actor.role === 'owner' || role === 'admin') return true;
  if (!(await hasServerPermission(serverId, actorId, permission, role))) return false;
  return (
    (await getHighestGroupPosition(serverId, actorId, role)) >
    (await getHighestGroupPosition(serverId, targetId))
  );
}

async function setMemberGroups(serverId, userId, groupIds) {
  const ids = [...new Set(groupIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  await withTransaction(async () => {
    await query('DELETE FROM server_member_groups WHERE server_id = $1 AND user_id = $2', [
      Number(serverId),
      Number(userId)
    ]);
    const now = Date.now();
    for (const groupId of ids) {
      await query(
        'INSERT INTO server_member_groups (server_id, user_id, group_id, assigned_at) VALUES ($1, $2, $3, $4) ON CONFLICT (server_id, user_id, group_id) DO NOTHING',
        [Number(serverId), Number(userId), groupId, now]
      );
    }
  });
}

async function nextGroupPosition(serverId, actorId, globalRole) {
  const { rows } = await query(
    'SELECT COALESCE(MAX(position), 0) AS position FROM server_groups WHERE server_id = $1',
    [Number(serverId)]
  );
  const max = Number(rows[0].position);
  const ceiling = await getHighestGroupPosition(serverId, actorId, globalRole);
  if (!Number.isFinite(ceiling)) return max + 100;
  const next = Math.min(max + 100, ceiling - 1);
  return Math.max(1, next);
}

// ── Channel overrides ───────────────────────────────────────────────────────
// An override is an allow list and a deny list for one channel and one target
// (a group or a single member). They are resolved in a fixed order, and the
// order is the whole design:
//
//   1. server permissions (what the member's groups already give them)
//   2. group overrides, lowest-ranked group first, so a higher group wins
//   3. the member override, which is the most specific and is applied last
//
// Inside one override a deny beats an allow, but a later override can re-allow
// what an earlier one denied - that is what makes "everyone loses #staff, but
// the moderators keep it" expressible with two rows.
function parseChannelPermissionList(value) {
  let parsed = [];
  try {
    parsed = JSON.parse(value || '[]');
  } catch {
    parsed = [];
  }
  if (!Array.isArray(parsed)) return [];
  return CHANNEL_PERMISSIONS.filter((permission) => parsed.includes(permission));
}

async function getChannelOverrides(serverId) {
  const { rows } = await query(
    `SELECT o.channel_id, o.target_type, o.target_id, o.allow, o.deny
       FROM channel_overrides o
       JOIN channels c ON c.id = o.channel_id
      WHERE c.server_id = $1`,
    [Number(serverId)]
  );
  const map = new Map();
  for (const row of rows) {
    const key = Number(row.channel_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({
      targetType: row.target_type,
      targetId: Number(row.target_id),
      allow: parseChannelPermissionList(row.allow),
      deny: parseChannelPermissionList(row.deny)
    });
  }
  return map;
}

function applyChannelOverride(current, override) {
  for (const permission of override.allow) current.add(permission);
  for (const permission of override.deny) current.delete(permission);
}

// Pure function so buildServer can resolve every channel for every member in
// one pass without a query per channel.
function resolveChannelPermissions(membership, groups, assigned, globalRole, overrides) {
  if (!membership) return [];
  if (membership.role === 'owner' || membership.role === 'admin' || globalRole === 'admin') {
    return [...CHANNEL_PERMISSIONS];
  }
  const server = new Set(permissionsForMember(membership, groups, assigned, globalRole));
  const allowed = new Set();
  for (const permission of CHANNEL_PERMISSIONS) {
    // viewChannel has no server-level switch: absent an override, a channel is
    // visible. Everything else inherits the server permission.
    if (permission === 'viewChannel' || server.has(permission)) allowed.add(permission);
  }
  if (!overrides || !overrides.length) {
    return CHANNEL_PERMISSIONS.filter((permission) => allowed.has(permission));
  }
  const positionOf = new Map();
  const held = new Set(assigned.map((group) => Number(group.id)));
  for (const group of groups) {
    positionOf.set(Number(group.id), Number(group.position) || 0);
    // The default group is held by everyone and is not stored in
    // server_member_groups, so an override aimed at it has to be matched here.
    if (group.isDefault) held.add(Number(group.id));
  }
  const groupRows = overrides
    .filter((row) => row.targetType === 'group' && held.has(row.targetId))
    .sort((a, b) => (positionOf.get(a.targetId) || 0) - (positionOf.get(b.targetId) || 0));
  for (const row of groupRows) applyChannelOverride(allowed, row);
  const memberRow = overrides.find((row) => row.targetType === 'member');
  if (memberRow) applyChannelOverride(allowed, memberRow);
  return CHANNEL_PERMISSIONS.filter((permission) => allowed.has(permission));
}

async function hasChannelPermission(serverId, channelId, userId, permission, globalRole) {
  const membership = await getMembership(serverId, userId);
  if (!membership) return false;
  const role = await resolveGlobalRole(userId, globalRole);
  if (membership.role === 'owner' || membership.role === 'admin' || role === 'admin') return true;
  const [groups, assigned, overrides] = await Promise.all([
    getServerGroups(serverId),
    getMemberGroups(serverId, userId),
    getChannelOverrides(serverId)
  ]);
  const list = resolveChannelPermissions(
    membership,
    groups,
    assigned,
    role,
    (overrides.get(Number(channelId)) || []).filter(
      (row) => row.targetType === 'group' || row.targetId === Number(userId)
    )
  );
  return list.includes(permission);
}

module.exports = {
  normalizePermissions,
  parsePermissions,
  serializeGroup,
  getMembership,
  getServerGroups,
  getMemberGroups,
  getMemberGroupsForServer,
  ensureDefaultGroups,
  defaultGroupFor,
  permissionsForMember,
  memberPermissions,
  hasServerPermission,
  getHighestGroupPosition,
  canManageGroup,
  canManageMember,
  CHANNEL_PERMISSIONS,
  parseChannelPermissionList,
  getChannelOverrides,
  resolveChannelPermissions,
  hasChannelPermission,
  setMemberGroups,
  nextGroupPosition
};
