import { API_BASE } from './runtime';

export const AVATAR_COLORS = [
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

export const BANNER_COLORS = [
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

export const REACTIONS = ['🔥', '💜', '✨', '😂', '🎉', '💥', '👀', '🫡', '🌊', '🌙', '⚡'];

export const DISCOVER_CATEGORIES = [
  'Gaming',
  'Music',
  'Entertainment',
  'Science & Tech',
  'Education',
  'Community'
];

export function inviteLink(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  // Desktop builds run from cordia://app, and a cordia:// invite link is
  // useless to the person it is sent to. The API serves the app shell, so its
  // origin is the one that resolves for everybody.
  const base = /^https?:$/.test(window.location.protocol) ? window.location.origin : API_BASE;
  return `${base}/invite/${encodeURIComponent(raw)}`;
}

export function appInviteLink(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/\/invite\/([^/?#]+)/);
  return `cordia://invite/${encodeURIComponent(match ? decodeURIComponent(match[1]) : raw)}?auto=1`;
}

export function initials(name = '?') {
  return (
    String(name)
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase() || '?'
  );
}

export function serverIdentityStyle(server) {
  const color = server?.iconColor || '#6366f1';
  return {
    '--server-color': color,
    backgroundColor: color
  };
}

export function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatDay(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
}

export function formatDate(timestamp) {
  return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDateTime(timestamp) {
  return new Date(timestamp).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

export function formatDuration(seconds) {
  const total = Number(seconds) || 0;
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function sameDay(a, b) {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

export function onlineOf(user, presence) {
  if (!user) return false;
  if (presence && Object.prototype.hasOwnProperty.call(presence, user.id)) {
    return !!presence[user.id];
  }
  return !!user.online;
}

export function presenceColor(user, presence) {
  if (!user) return '#64748b';
  if (!onlineOf(user, presence)) return '#64748b';
  if (user.presence === 'idle') return '#fbbf24';
  if (user.presence === 'dnd') return '#f87171';
  return '#34d399';
}

export function presenceLabel(user, presence) {
  if (!user) return 'Offline';
  if (!onlineOf(user, presence)) return 'Offline';
  if (user.presence === 'idle') return 'Idle';
  if (user.presence === 'dnd') return 'Do not disturb';
  return 'Online';
}

export function groupMessages(messages) {
  const groups = [];
  let lastAuthor = null;
  let lastTime = 0;
  for (const message of messages) {
    const system = !!message.systemType;
    const grouped =
      !system &&
      lastAuthor === message.author.id &&
      message.createdAt - lastTime < 5 * 60 * 1000 &&
      sameDay(message.createdAt, lastTime);
    groups.push({ ...message, grouped });
    lastAuthor = system ? null : message.author.id;
    lastTime = message.createdAt;
  }
  return groups;
}

export function fileKind(type = '') {
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  return 'file';
}
