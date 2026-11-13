const SERVER_PERMISSIONS = [
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

const PERMISSION_META = [
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
    description: 'Create threads from messages and start new threads in text channels.',
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

// Event creation used to be open to every member. It is a permission now, so
// the default group keeps it: turning it off is a choice a manager makes, not
// something this change does to every existing server.
const DEFAULT_MEMBER_PERMISSIONS = [
  'sendMessages',
  'startThreads',
  'attachFiles',
  'addReactions',
  'connectVoice',
  'speak',
  'useSoundboard',
  'createEvents'
];

const MODERATOR_PERMISSIONS = [
  ...DEFAULT_MEMBER_PERMISSIONS,
  'viewServerSettings',
  'manageMessages',
  'pinMessages',
  'manageSoundboard',
  'kickMembers'
];

const ADMIN_PERMISSIONS = [...SERVER_PERMISSIONS];

// Channel overrides can only name these. Everything here is also a server
// permission except viewChannel, which has no server-level switch on purpose:
// a channel is visible unless something explicitly hides it, so adding this
// feature could not lock anybody out of a channel that already existed.
const CHANNEL_PERMISSIONS = [
  'viewChannel',
  'sendMessages',
  'attachFiles',
  'addReactions',
  'startThreads',
  'manageMessages',
  'connectVoice',
  'speak'
];

const CHANNEL_PERMISSION_META = [
  { key: 'viewChannel', label: 'View channel', description: 'See the channel in the sidebar and read it.' },
  { key: 'sendMessages', label: 'Send messages', description: 'Post new messages.' },
  { key: 'attachFiles', label: 'Attach files', description: 'Upload images and files.' },
  { key: 'addReactions', label: 'Add reactions', description: 'React to messages.' },
  { key: 'startThreads', label: 'Start threads', description: 'Open a thread on a message.' },
  { key: 'manageMessages', label: 'Manage messages', description: 'Delete or pin anyone\'s messages.' },
  { key: 'connectVoice', label: 'Connect', description: 'Join this voice channel.' },
  { key: 'speak', label: 'Speak', description: 'Turn the microphone on here.' }
];

const DEFAULT_GROUPS = [
  {
    key: 'members',
    name: 'Members',
    color: '#7a8798',
    position: 0,
    isDefault: true,
    permissions: DEFAULT_MEMBER_PERMISSIONS
  },
  {
    key: 'moderator',
    name: 'Moderator',
    color: '#2f7df6',
    position: 500,
    isDefault: false,
    permissions: MODERATOR_PERMISSIONS
  },
  {
    key: 'admin',
    name: 'Admin',
    color: '#8b5cf6',
    position: 1000,
    isDefault: false,
    permissions: ADMIN_PERMISSIONS
  }
];

module.exports = {
  SERVER_PERMISSIONS,
  PERMISSION_META,
  CHANNEL_PERMISSIONS,
  CHANNEL_PERMISSION_META,
  DEFAULT_MEMBER_PERMISSIONS,
  MODERATOR_PERMISSIONS,
  ADMIN_PERMISSIONS,
  DEFAULT_GROUPS
};
