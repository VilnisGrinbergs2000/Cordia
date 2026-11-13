import { useEffect, useRef } from 'react';
import { assetUrl } from './runtime';

// Settings live in the renderer, not the main process: the overlay is a desktop
// nicety, and localStorage already survives updates and reloads. The main
// process is told what to draw and never reads this key.
const STORAGE_KEY = 'cordia:overlay';
// The panel is small on purpose - it sits over a game, not instead of it.
const CHAT_LINES = 4;
const CHAT_LENGTH = 140;

export const OVERLAY_DEFAULTS = {
  enabled: false,
  corner: 'top-right',
  showSelf: true,
  showChat: true,
  opacity: 94
};

export function overlayBridge() {
  return typeof window !== 'undefined' ? window.cordiaDesktop?.overlay || null : null;
}

export function readOverlayConfig() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...OVERLAY_DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}) };
  } catch {
    return { ...OVERLAY_DEFAULTS };
  }
}

export function writeOverlayConfig(patch) {
  const next = { ...readOverlayConfig(), ...patch };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // storage can be unavailable; the in-memory value still applies this session
  }
  // The hook listens for this instead of taking the config as a prop, so a
  // settings change does not re-render the whole shell.
  window.dispatchEvent(new CustomEvent('cordia:overlay-changed'));
  return next;
}

// Only the tail of the conversation is useful at this size: one line per
// message, no timestamps, no attachments. Anything the overlay cannot render
// faithfully is skipped rather than shown as a broken row.
function buildChat(list, me) {
  const rows = [];
  for (const message of list.slice(-CHAT_LINES * 2)) {
    if (!message || message.systemType || message.deleted) continue;
    const text = String(message.content || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    rows.push({
      author: message.author?.displayName || message.author?.username || 'Someone',
      color: message.author?.avatarColor || '#8b95a7',
      text: text.length > CHAT_LENGTH ? text.slice(0, CHAT_LENGTH - 1) + '\u2026' : text,
      mine: message.author?.id === me?.id
    });
  }
  return rows.slice(-CHAT_LINES);
}

function buildState(voice, me, config, chat, canSend) {
  const channel = voice?.channel;
  if (!channel) return { connected: false };

  const rows = [];
  for (const participant of Object.values(voice.participants || {})) {
    const self = me?.id != null && participant.id === me.id;
    if (self && !config.showSelf) continue;
    rows.push({
      id: participant.id,
      name: participant.displayName || participant.username || 'Someone',
      color: participant.avatarColor || '#5b6474',
      // Absolute and token-bearing: the overlay page is a file:// document, so a
      // relative /uploads path would resolve against the app folder.
      avatarUrl: participant.avatarUrl ? assetUrl(participant.avatarUrl) : '',
      muted: !!participant.muted,
      speaking: !!voice.speaking?.[participant.socketId],
      self
    });
  }
  // Yourself first, the way the voice dock lists it; everyone else keeps the
  // join order the server sent.
  rows.sort((a, b) => Number(b.self) - Number(a.self));

  const showChat = config.showChat !== false;
  return {
    connected: true,
    channel: channel.name || 'Voice',
    showChat,
    canSend: !!canSend,
    selfMuted: !!voice.muted,
    selfDeafened: !!voice.deafened,
    participants: rows,
    messages: showChat ? buildChat(chat || [], me) : []
  };
}

// Polls instead of subscribing: speaking flags are produced by an audio
// analyser several times a second and never land in a single stable object, so
// a small tick plus a JSON comparison is both simpler and quieter than an
// effect that re-runs on every participant update.
//
// "chat" and "send" are accessors rather than values: the shell calls this hook
// before the message list for the current channel exists, and a function keeps
// that read lazy without threading a ref through the whole component.
export function useGameOverlay(voice, me, options = {}) {
  const latest = useRef({ voice, me, options });
  latest.current = { voice, me, options };
  const lastSent = useRef('');
  const lastConfig = useRef('');

  useEffect(() => {
    const bridge = overlayBridge();
    if (!bridge) return undefined;

    const push = () => {
      const config = readOverlayConfig();
      // Settings are pushed separately from the panel state: opacity changes
      // nothing the panel draws, so comparing states alone would drop it.
      const configKey = JSON.stringify(config);
      if (configKey !== lastConfig.current) {
        lastConfig.current = configKey;
        bridge.configure(config);
      }
      const { chat: readChat, canSend: readCanSend } = latest.current.options;
      const chat = typeof readChat === 'function' ? readChat() : [];
      // The composer is pointless on a screen with nowhere to post - a voice
      // channel, a forum, the friends list - so the panel hides it instead of
      // offering a box that would fail.
      const canSend = typeof readCanSend === 'function' ? readCanSend() : false;
      const state = buildState(latest.current.voice, latest.current.me, config, chat, canSend);
      const serialized = JSON.stringify(state);
      if (serialized === lastSent.current) return;
      lastSent.current = serialized;
      bridge.pushState(state);
    };

    push();
    const timer = setInterval(push, 250);
    window.addEventListener('cordia:overlay-changed', push);
    return () => {
      clearInterval(timer);
      window.removeEventListener('cordia:overlay-changed', push);
      bridge.pushState({ connected: false });
    };
  }, []);

  // The overlay window is click-through until it is unlocked, so every button
  // there is a request, not an action: it travels overlay -> main -> here, and
  // this is the only place that owns the voice session and the socket.
  useEffect(() => {
    const bridge = overlayBridge();
    if (!bridge || typeof bridge.onCommand !== 'function') return undefined;
    return bridge.onCommand((command) => {
      if (!command || typeof command.type !== 'string') return;
      const { voice: current, options: handlers } = latest.current;
      if (command.type === 'mute') current?.toggleMute?.();
      else if (command.type === 'deafen') current?.toggleDeafen?.();
      else if (command.type === 'leave') current?.leave?.();
      else if (command.type === 'send') {
        const text = String(command.text || '').trim();
        if (text && typeof handlers.send === 'function') handlers.send(text);
      }
      // "lock" is handled by the main process; nothing to do on this side.
    });
  }, []);
}
