export const SERVER_PERMISSIONS = [
  'manageServer',
  'viewServerSettings',
  'manageChannels',
  'manageGroups',
  'manageMessages',
  'pinMessages',
  'kickMembers',
  'sendMessages',
  'startThreads',
  'attachFiles',
  'addReactions',
  'connectVoice',
  'speak',
  'useSoundboard',
  'manageSoundboard',
  'createEvents'
];

export const PERMISSION_META = [
  {
    key: 'manageServer',
    label: 'Manage server',
    description: 'Change the server name, description, accent, and invite link.',
    group: 'Server'
  },
  {
    key: 'viewServerSettings',
    label: 'View server settings',
    description: 'Open server settings and view its configuration.',
    group: 'Server'
  },
  {
    key: 'manageChannels',
    label: 'Manage channels',
    description: 'Create and delete text and voice channels.',
    group: 'Server'
  },
  {
    key: 'manageGroups',
    label: 'Manage groups',
    description: 'Create groups, edit permissions, and assign members.',
    group: 'Server'
  },
  {
    key: 'manageMessages',
    label: 'Manage messages',
    description: 'Delete messages from other members.',
    group: 'Moderation'
  },
  {
    key: 'pinMessages',
    label: 'Pin messages',
    description: 'Pin and unpin messages so they stay at the top of a channel.',
    group: 'Moderation'
  },
  {
    key: 'kickMembers',
    label: 'Kick members',
    description: 'Remove members from the server.',
    group: 'Moderation'
  },
  {
    key: 'sendMessages',
    label: 'Send messages',
    description: 'Post messages in text channels.',
    group: 'Text'
  },
  {
    key: 'startThreads',
    label: 'Start threads',
    description: 'Create threads in text channels.',
    group: 'Text'
  },
  {
    key: 'attachFiles',
    label: 'Attach files',
    description: 'Upload images and files with messages.',
    group: 'Text'
  },
  {
    key: 'addReactions',
    label: 'Add reactions',
    description: 'React to messages with emoji.',
    group: 'Text'
  },
  {
    key: 'connectVoice',
    label: 'Join voice',
    description: 'Connect to voice channels.',
    group: 'Voice'
  },
  {
    key: 'speak',
    label: 'Speak',
    description: 'Turn on the microphone in voice channels.',
    group: 'Voice'
  },
  {
    key: 'useSoundboard',
    label: 'Use soundboard',
    description: 'Play sounds from the soundboard while connected to voice.',
    group: 'Voice'
  },
  {
    key: 'manageSoundboard',
    label: 'Manage soundboard',
    description: 'Add and remove the sounds a server can play.',
    group: 'Voice'
  },
  {
    key: 'createEvents',
    label: 'Create events',
    description: 'Schedule events on the server calendar.',
    group: 'Events'
  }
];

export const PERMISSION_GROUPS = ['Server', 'Moderation', 'Text', 'Voice', 'Events'];

export const DEFAULT_MEMBER_PERMISSIONS = [
  'sendMessages',
  'startThreads',
  'attachFiles',
  'addReactions',
  'connectVoice',
  'speak',
  'useSoundboard',
  'createEvents'
];

export function memberFor(server, userId) {
  return server?.members?.find((member) => member.id === userId) || null;
}

export function hasServerPermission(server, user, permission) {
  if (!server || !user) return false;
  if (user.role === 'admin') return true;
  const member = memberFor(server, user.id);
  if (!member) return false;
  if (member.serverRole === 'owner' || member.serverRole === 'admin') return true;
  return (member.permissions || []).includes(permission);
}

export function isOwnerOrAdmin(server, user) {
  if (!server || !user) return false;
  if (user.role === 'admin') return true;
  const role = memberFor(server, user.id)?.serverRole;
  return role === 'owner' || role === 'admin';
}

export function highestPosition(server, user) {
  if (isOwnerOrAdmin(server, user)) return 1000000;
  return memberFor(server, user.id)?.highestGroupPosition || 0;
}

export function canManageGroup(server, user, group) {
  if (!group || !server || !user) return false;
  if (isOwnerOrAdmin(server, user)) return true;
  if (group.isDefault) return false;
  if (!hasServerPermission(server, user, 'manageGroups')) return false;
  return group.position < highestPosition(server, user);
}

export function canManageMember(server, user, member, permission = 'manageGroups') {
  if (!member || !server || !user) return false;
  if (member.serverRole === 'owner') return false;
  if (member.id === user.id) return false;
  if (isOwnerOrAdmin(server, user)) return true;
  if (!hasServerPermission(server, user, permission)) return false;
  return highestPosition(server, user) > (member.highestGroupPosition || 0);
}

export function canManageMemberGroups(server, user, member) {
  if (!member || !server || !user) return false;
  if (member.serverRole === 'owner') return member.id === user.id;
  return canManageMember(server, user, member, 'manageGroups');
}

export function visibleGroups(member) {
  return (member?.groups || []).filter((group) => !group.isDefault);
}

export function topGroup(member) {
  return visibleGroups(member)[0] || null;
}

export function separateGroup(member) {
  return visibleGroups(member).find((group) => group.displaySeparately) || null;
}

export function groupMemberCount(server, groupId) {
  return (server?.members || []).filter((member) =>
    (member.groups || []).some((group) => group.id === groupId)
  ).length;
}

export function permissionCount(group) {
  return (group?.permissions || []).length;
}
