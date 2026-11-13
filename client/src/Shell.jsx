import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { KeyRound, Loader2, ShieldAlert, Sparkles, WifiOff } from 'lucide-react';
import api from './api';
import SavedModal from './components/SavedModal';
import EditHistoryModal from './components/EditHistoryModal';
// The four tool views are opened far less often than a chat channel, so they are
// split out of the first bundle the same way the forum is.
const DocsView = lazy(() => import('./components/DocsView'));
const ListsView = lazy(() => import('./components/ListsView'));
const MediaView = lazy(() => import('./components/MediaView'));
const CalendarView = lazy(() => import('./components/CalendarView'));
import RemindModal from './components/RemindModal';
import BotModal from './components/BotModal';
import { clearNativeToken, getNativeToken, SOCKET_URL } from './runtime';
import { disableBackgroundPush } from './push';
import { useVoice } from './voice';
import { useGameOverlay } from './overlay';
import { useCall } from './call';
import {
  createRecoveryBackup,
  encryptAttachment,
  encryptDmMessage,
  forgetRememberedDevice,
  generateRecoveryCode,
  getE2eeSnapshot,
  hashRecoveryCode,
  isE2eeUnlocked,
  lockE2ee,
  restoreRememberedDevice,
  useE2ee
} from './e2ee';
import {
  playMessageSound,
  readNotificationPrefs,
  showDesktopNotification,
  startCallRingtone,
  stopCallRingtone,
  writeNotificationPrefs
} from './notifications';
import { triggerMessageEasterEgg } from './easterEggs';
import useNowPlaying from './useNowPlaying';
import { onlineOf } from './utils';
import { hasServerPermission } from './permissions';
import { BADGE_META } from './components/Badges';
import Logo from './components/Logo';
import ServerRail from './components/ServerRail';
import ChannelSidebar from './components/ChannelSidebar';
import ChatView from './components/ChatView';

// Forums are a destination, not a default view - keep them out of the first
// payload and load the code the first time someone opens one.
const ForumView = lazy(() => import('./components/ForumView'));
const DiscoverPage = lazy(() => import('./components/DiscoverPage'));
import HomeView from './components/HomeView';
import MemberList from './components/MemberList';
import VoiceStage from './components/VoiceStage';
import VoiceDock from './components/VoiceDock';
import ScreenSharePicker from './components/ScreenSharePicker';

import CallOverlay from './components/CallOverlay';
import ProfileModal from './components/ProfileModal';
import SettingsPage from './components/SettingsPage';
import ServerSettingsPage from './components/ServerSettingsPage';
import E2eeUnlockModal from './components/E2eeUnlockModal';
import E2eeSafetyModal from './components/E2eeSafetyModal';
import RecoveryCodeModal from './components/RecoveryCodeModal';
import ReportMessageModal from './components/ReportMessageModal';
import AddServerModal from './components/AddServerModal';
import CreateChannelModal from './components/CreateChannelModal';
import InviteModal from './components/InviteModal';
import SearchModal from './components/SearchModal';
import DmSearchModal from './components/DmSearchModal';
import MentionsModal from './components/MentionsModal';
import PollModal from './components/PollModal';
import ServerEventsModal from './components/ServerEventsModal';
import ServerIconSuggestionsModal from './components/ServerIconSuggestionsModal';
import WhatsNewModal from './components/WhatsNewModal';
import SupportPrompt from './components/SupportPrompt';
import WelcomeScreen from './components/WelcomeScreen';
import AwayModal from './components/AwayModal';
import QuickSwitcher from './components/QuickSwitcher';
import { LATEST_RELEASE } from './changelog';
import {
  shouldShowSupportPrompt,
  markSupportPromptSeen,
  dismissSupportPromptForever
} from './supportPrompt';
import Toast from './components/Toast';

function sortDms(dms) {
  return [...dms].sort((a, b) => {
    const aTime = a.lastMessage?.createdAt || a.createdAt;
    const bTime = b.lastMessage?.createdAt || b.createdAt;
    return bTime - aTime;
  });
}

function mapFriendUsers(friends, updater) {
  const categories = ['friends', 'incoming', 'outgoing', 'blocked'];
  const next = { ...friends };
  for (const category of categories) {
    next[category] = (friends[category] || []).map((entry) => ({
      ...entry,
      user: updater(entry.user)
    }));
  }
  return next;
}

function attentionState(readState) {
  const unread = {};
  const mentions = {};
  const muted = {};
  for (const [key, entry] of Object.entries(readState || {})) {
    if (entry?.unread) unread[key] = entry.unread;
    if (entry?.mentions) mentions[key] = entry.mentions;
    if (entry?.muted) muted[key] = true;
  }
  return { unread, mentions, muted };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Stage channels are voice channels with a speaker audience, so everything the
// voice stage does - joining, the live layout, the dock - applies to them too.
function isVoiceLike(channel) {
  return channel?.type === 'voice' || channel?.type === 'stage';
}

export default function Shell({ user, setUser, onLoggedOut }) {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [friends, setFriends] = useState({ friends: [], incoming: [], outgoing: [], blocked: [] });
  const [view, setView] = useState('home');
  const [activeServerId, setActiveServerId] = useState(null);
  const [activeChannelId, setActiveChannelId] = useState(null);
  const [activeDmId, setActiveDmId] = useState(null);
  const [messages, setMessages] = useState({});
  const [catchup, setCatchup] = useState({});
  const [reloadToken, setReloadToken] = useState(0);
  const [presence, setPresence] = useState({ [user.id]: true });
  const [typing, setTyping] = useState({});
  const [unread, setUnread] = useState({});
  const [mentionUnread, setMentionUnread] = useState({});
  const [mutedScopes, setMutedScopes] = useState({});
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [showMembers, setShowMembers] = useState(true);
  const [modal, setModal] = useState(null);
  const [eventsRefresh, setEventsRefresh] = useState(0);
  // Threads are private, so they cannot ride in the bootstrap payload: they are
  // fetched per viewer for the server you are looking at.
  const [threads, setThreads] = useState([]);
  const [threadsVersion, setThreadsVersion] = useState(0);
  const [profileId, setProfileId] = useState(null);
  const [badgesVersion, setBadgesVersion] = useState(0);
  // Pins are fetched by ChatView on its own, so a pin made in one place has to
  // nudge every open channel list to re-read rather than duplicate the query.
  const [pinsVersion, setPinsVersion] = useState(0);
  const [toast, setToast] = useState(null);
  const [reportTarget, setReportTarget] = useState(null);
  const [savedOpen, setSavedOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [remindTarget, setRemindTarget] = useState(null);
  // A bot can answer a click or a command with a form. The payload arrives on
  // the socket because the bot's own HTTP response goes to the bot.
  // A queue, not a slot: two bots can ask a question at once, and replacing the
  // first form lost whatever had been typed into it.
  const [botModals, setBotModals] = useState([]);
  const [highlightId, setHighlightId] = useState(null);
  const [voiceOccupancy, setVoiceOccupancy] = useState({});
  const [settingsContext, setSettingsContext] = useState({ tab: 'profile' });
  const [settingsReturn, setSettingsReturn] = useState('home');
  const [serverSettingsId, setServerSettingsId] = useState(null);
  const [whatsNewOpen, setWhatsNewOpen] = useState(false);
  // /app?support=1 opens the launch card once, ignoring the frequency rules and
  // without touching the "seen" clock. It exists so the card can be looked at
  // without waiting a fortnight; it is a preview, not a way to skip the rules.
  const supportPreview = useMemo(() => {
    try {
      return new URLSearchParams(window.location.search).get('support') === '1';
    } catch {
      return false;
    }
  }, []);
  const [supportPromptOpen, setSupportPromptOpen] = useState(supportPreview);
  const supportPromptChecked = useRef(supportPreview);
  const [welcome, setWelcome] = useState(null);
  const [unreadMarkerId, setUnreadMarkerId] = useState(null);
  // Below 620px the app shows one pane at a time: the conversation list, or the chat.
  const [mobilePane, setMobilePane] = useState('list');

  useEffect(() => {
    if (!data) return;
    try {
      if (localStorage.getItem('cordia:whats-new-seen') !== LATEST_RELEASE.version) {
        setWhatsNewOpen(true);
      }
    } catch {
      // storage may be unavailable
    }
  }, [data]);
  // The tip jar waits for the what's-new card and the welcome card to finish:
  // one overlay at a time, and never on the launch that already has news to
  // read. The ref keeps it to one decision per session, so closing the card
  // cannot make the effect offer it again on the next render.
  // Drop the preview flag from the URL so a reload does not reopen the card.
  useEffect(() => {
    if (!supportPreview) return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('support');
      window.history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
    } catch {
      // history may be unavailable
    }
  }, [supportPreview]);

  useEffect(() => {
    if (!data || supportPromptChecked.current) return;
    // whatsNewOpen is set by another effect on the same data, so on the first
    // pass it is still false while the what's-new card is already due. Read the
    // same flag that effect reads instead of racing it.
    let newsPending = false;
    try {
      newsPending = localStorage.getItem('cordia:whats-new-seen') !== LATEST_RELEASE.version;
    } catch {
      newsPending = false;
    }
    if (newsPending || whatsNewOpen || welcome) return;
    supportPromptChecked.current = true;
    if (shouldShowSupportPrompt(user)) {
      markSupportPromptSeen();
      setSupportPromptOpen(true);
    }
  }, [data, whatsNewOpen, welcome, user]);

  const [notificationPrefs, setNotificationPrefs] = useState(readNotificationPrefs);
  const [e2eeModalOpen, setE2eeModalOpen] = useState(false);
  const [recoverySetup, setRecoverySetup] = useState(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState('');
  const [safetyDm, setSafetyDm] = useState(null);
  const [e2eePinVersion, setE2eePinVersion] = useState(0);
  const e2ee = useE2ee();
  const [socket] = useState(() => {
    const token = getNativeToken();
    const options = {
      autoConnect: false,
      withCredentials: !token,
      auth: token ? { token } : {}
    };
    return SOCKET_URL ? io(SOCKET_URL, options) : io(options);
  });

  const toastTimer = useRef(null);
  const activeKeyRef = useRef(null);
  const activeServerRef = useRef(null);
  const pendingJumpRef = useRef(null);
  const typingScopeRef = useRef(null);
  const typingAtRef = useRef(0);
  const voiceRef = useRef(null);
  const dataRef = useRef(null);
  const notificationPrefsRef = useRef(notificationPrefs);
  const mutedScopesRef = useRef(mutedScopes);
  const readRequestsRef = useRef(new Set());
  const deferReadRef = useRef({});
  const incomingCallRef = useRef(null);
  // One /welcome read per server per session: switching away and back must not
  // refetch, and a dismissal has to survive the round trip.
  const welcomeCacheRef = useRef(new Map());

  const voice = useVoice(socket);
  voiceRef.current = voice;
  // Desktop only: mirrors the active voice channel into the always-on-top
  // overlay window. A no-op in the browser, where there is no bridge. The chat
  // preview and the composer follow whatever channel is on screen, which is
  // computed further down, so both are passed as accessors.
  useGameOverlay(voice, user, {
    chat: () => scopeMessages,
    canSend: () =>
      !!scopeKey && (!!activeDmId || activeChannelType === 'text' || activeChannelType === 'thread'),
    // The overlay has no room for an error state, so a failed send comes back
    // as the usual toast instead of an unhandled rejection. sendMessage bails
    // out with undefined when no conversation is open, hence the guard.
    send: (text) => {
      const pending = sendMessage(text);
      if (pending && typeof pending.catch === 'function') {
        pending.catch((error) =>
          showToast({ type: 'error', title: 'Could not send', message: error.message })
        );
      }
    }
  });
  const call = useCall(socket, user.id);
  // Desktop only, and only while the person has switched it on: reports what
  // Spotify is playing so it shows up as "listening to".
  useNowPlaying();

  const showToast = useCallback((payload) => {
    setToast(payload);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4200);
  }, []);

  // Components that do not receive showToast as a prop (the composer's mic,
  // the forward modal) raise a toast by dispatching this event.
  useEffect(() => {
    function onToast(event) {
      if (event.detail) showToast(event.detail);
    }
    window.addEventListener('cordia:toast', onToast);
    return () => window.removeEventListener('cordia:toast', onToast);
  }, [showToast]);

  // An update downloads in the background and installs when the app closes, so
  // without this the whole thing is invisible until the version number changes.
  // One toast per version, however many status events arrive.
  useEffect(() => {
    const updates = window.cordiaDesktop && window.cordiaDesktop.updates;
    if (!updates || typeof updates.onStatus !== 'function') return undefined;
    let announced = '';
    const off = updates.onStatus((status) => {
      if (!status || status.status !== 'downloaded' || !status.version) return;
      if (announced === status.version) return;
      announced = status.version;
      showToast({
        title: `Cordia ${status.version} is ready`,
        message: 'It installs itself the next time you close the app.'
      });
    });
    return () => off && off();
  }, [showToast]);

  const openReport = useCallback((message, plaintext) => {
    setReportTarget({ message, plaintext: plaintext || '' });
  }, []);

  async function submitReport(payload) {
    try {
      await api.post('/api/reports', payload);
      showToast({
        title: 'Report submitted',
        message: 'The Cordia team will review this message.'
      });
    } catch (error) {
      showToast({ type: 'error', title: 'Could not submit report', message: error.message });
      throw error;
    }
  }

  const openRecoverySetup = useCallback(async () => {
    setRecoveryError('');
    const identity = getE2eeSnapshot().identity;
    if (!identity) {
      setE2eeModalOpen(true);
      return;
    }
    setRecoveryBusy(true);
    try {
      const code = generateRecoveryCode();
      const keyBackup = await createRecoveryBackup(identity, user.id, code);
      const recoveryVerifier = await hashRecoveryCode(code);
      setRecoverySetup({ code, keyBackup, recoveryVerifier });
    } catch (error) {
      setRecoveryError(error.message);
      showToast({
        type: 'error',
        title: 'Could not create recovery code',
        message: error.message
      });
    } finally {
      setRecoveryBusy(false);
    }
  }, [showToast, user.id]);

  const confirmRecoverySetup = useCallback(async () => {
    if (!recoverySetup) return;
    setRecoveryBusy(true);
    setRecoveryError('');
    try {
      const payload = await api.post('/api/e2ee/recovery', {
        keyBackup: recoverySetup.keyBackup,
        recoveryVerifier: recoverySetup.recoveryVerifier
      });
      if (payload.user) setUser(payload.user);
      setRecoverySetup(null);
      showToast({
        title: 'Recovery code saved',
        message: 'Password reset is now available.'
      });
    } catch (error) {
      setRecoveryError(error.message);
    } finally {
      setRecoveryBusy(false);
    }
  }, [recoverySetup, showToast]);

  const markScopeRead = useCallback((key) => {
    if (!key || readRequestsRef.current.has(key)) return;
    const [kind, id] = key.split(':');
    const scopeType = kind === 'dm' ? 'dm' : 'channel';
    readRequestsRef.current.add(key);
    api
      .post(`/api/read/${scopeType}/${id}`, {})
      .catch(() => {})
      .finally(() => readRequestsRef.current.delete(key));
  }, []);

  const toggleScopeMute = useCallback(
    async (key) => {
      if (!key) return;
      const [kind, id] = key.split(':');
      const scopeType = kind === 'dm' ? 'dm' : 'channel';
      const currentlyMuted = !!mutedScopesRef.current[key];
      const nextMuted = !currentlyMuted;
      const apply = (value) =>
        setMutedScopes((prev) => {
          const next = { ...prev };
          if (value) next[key] = true;
          else delete next[key];
          return next;
        });
      apply(nextMuted);
      try {
        await api.patch(`/api/read/${scopeType}/${id}/mute`, { muted: nextMuted });
      } catch (error) {
        apply(currentlyMuted);
        showToast({
          type: 'error',
          title: nextMuted ? 'Could not mute conversation' : 'Could not unmute conversation',
          message: error.message
        });
      }
    },
    [showToast]
  );

  const openMessageScope = useCallback((msg) => {
    const current = dataRef.current;
    if (!msg || !current) return;
    if (msg.dmId) {
      const dm = current.dms.find((entry) => entry.id === msg.dmId);
      if (!dm) return;
      setView('home');
      setActiveServerId(null);
      setActiveChannelId(null);
      setActiveDmId(dm.id);
      return;
    }
    if (!msg.channelId) return;
    const server = current.servers.find((entry) =>
      entry.channels.some((channel) => channel.id === msg.channelId)
    );
    const channel = server?.channels.find((entry) => entry.id === msg.channelId);
    if (!server || !channel) return;
    setView('server');
    setActiveServerId(server.id);
    setActiveChannelId(channel.id);
    setActiveDmId(null);
  }, []);

  const notifyMessage = useCallback(
    (msg, key, mentioned = false) => {
      if (!msg?.author || msg.author.id === user.id) return;
      if (msg.systemType) return;
      if (mutedScopesRef.current[key] && !mentioned) return;
      if (key === activeKeyRef.current && !document.hidden && document.hasFocus()) return;

      const prefs = notificationPrefsRef.current;
      const current = dataRef.current;
      const fullPreview = msg.encrypted
        ? 'New encrypted message. Open Cordia to decrypt.'
        : (msg.content || '').trim() || (msg.attachment ? 'Sent an attachment' : 'New message');
      const preview =
        fullPreview.length > 140 ? `${fullPreview.slice(0, 137).trimEnd()}...` : fullPreview;
      let title = msg.author.displayName;
      let context = 'New message';

      if (msg.dmId) {
        context = 'Direct message';
      } else {
        const server = current?.servers.find((entry) =>
          entry.channels.some((channel) => channel.id === msg.channelId)
        );
        const channel = server?.channels.find((entry) => entry.id === msg.channelId);
        if (channel && server) {
          title = `${msg.author.displayName} in #${channel.name}`;
          context = server.name;
        }
      }

      showToast({ type: 'message', title, message: preview });
      if (prefs.sounds) playMessageSound();

      if (prefs.desktop && (document.hidden || !document.hasFocus())) {
        showDesktopNotification({
          title,
          body: `${context} · ${preview}`,
          tag: msg.dmId ? `dm-${msg.dmId}` : `ch-${msg.channelId}`,
          onClick: () => openMessageScope(msg)
        });
      }
    },
    [openMessageScope, showToast, user.id]
  );

  const changeNotificationPrefs = useCallback((next) => {
    setNotificationPrefs(next);
    writeNotificationPrefs(next);
  }, []);

  useEffect(() => {
    function onOccupancy(payload) {
      if (!payload?.channelId) return;
      setVoiceOccupancy((prev) => ({
        ...prev,
        [payload.channelId]: payload.participants || []
      }));
    }
    function onOccupancyInit(snapshot) {
      setVoiceOccupancy(snapshot && typeof snapshot === 'object' ? snapshot : {});
    }
    socket.on('voice:occupancy', onOccupancy);
    socket.on('voice:occupancy:init', onOccupancyInit);
    return () => {
      socket.off('voice:occupancy', onOccupancy);
      socket.off('voice:occupancy:init', onOccupancyInit);
    };
  }, [socket]);

  const refreshFriends = useCallback(async () => {
    try {
      const next = await api.get('/api/friends');
      setFriends(next);
    } catch {
      // silent
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/api/bootstrap')
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
        const attention = attentionState(payload.readState);
        setUnread(attention.unread);
        setMentionUnread(attention.mentions);
        setMutedScopes(attention.muted);
        mutedScopesRef.current = attention.muted;
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error.message);
      });
    refreshFriends();
    return () => {
      cancelled = true;
    };
  }, [refreshFriends]);

  useEffect(() => {
    if (!data) return;
    setPresence((prev) => {
      const next = { ...prev };
      for (const person of data.users) {
        if (!(person.id in next)) next[person.id] = !!person.online;
      }
      for (const server of data.servers) {
        for (const member of server.members) {
          if (!(member.id in next)) next[member.id] = !!member.online;
        }
      }
      next[user.id] = true;
      return next;
    });
  }, [data, user.id]);

  const activeServer = useMemo(() => {
    const server = data?.servers.find((entry) => entry.id === activeServerId) || null;
    return server ? { ...server, threads } : null;
  }, [data, activeServerId, threads]);
  const activeChannel = useMemo(() => {
    if (!activeServer) return null;
    const channel = activeServer.channels.find((entry) => entry.id === activeChannelId);
    if (channel) return channel;
    // Threads and forum posts are channels too, but they ride in their own array.
    return activeServer.threads?.find((thread) => thread.id === activeChannelId) || null;
  }, [activeServer, activeChannelId]);

  useEffect(() => {
    if (!activeServerId) {
      setThreads([]);
      return undefined;
    }
    let cancelled = false;
    api
      .get(`/api/servers/${activeServerId}/threads`)
      .then((payload) => {
        if (!cancelled) setThreads(payload?.threads || []);
      })
      .catch(() => {
        if (!cancelled) setThreads([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeServerId, threadsVersion]);
  const activeDm = useMemo(
    () => data?.dms.find((dm) => dm.id === activeDmId) || null,
    [data, activeDmId]
  );
  // Emotes are server-owned, but a DM is not. Resolve the pool both people can see:
  // every server the two of us share. Sending something the other side cannot render
  // would just leave them staring at :name:.
  const dmEmotes = useMemo(() => {
    const peerId = activeDm?.user?.id;
    if (!peerId) return [];
    const seen = new Set();
    const merged = [];
    for (const server of data?.servers || []) {
      if (!server.members?.some((member) => member.id === peerId)) continue;
      for (const emote of server.emotes || []) {
        const key = String(emote.name).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(emote);
      }
    }
    return merged;
  }, [data?.servers, activeDm]);
  // A server can opt out of other servers' emotes. When it allows them the pool is
  // its own emotes first, then everyone else's, deduped by name so the local one wins.
  // A restricted emote is gated by the groups of the server that owns it, and the
  // member list already ships every member's groups - so the viewer's own groups
  // are in the bootstrap payload and need no extra request. The map is rebuilt
  // whenever a server payload is replaced, which is exactly what a role edit does
  // (server:updated carries the rebuilt member list), so the pool cannot go stale.
  const myGroupIdsByServer = useMemo(() => {
    const map = new Map();
    for (const server of data?.servers || []) {
      const member = server.members?.find((entry) => entry.id === user.id);
      map.set(server.id, new Set((member?.groups || []).map((group) => group.id)));
    }
    return map;
  }, [data?.servers, user.id]);
  const channelEmotes = useMemo(() => {
    if (!activeServer) return [];
    const seen = new Set();
    const merged = [];
    const canUse = (emote) => {
      if (!emote.restricted) return true;
      const held = myGroupIdsByServer.get(emote.serverId);
      if (!held) return false;
      return (emote.groupIds || []).some((groupId) => held.has(groupId));
    };
    const add = (emote) => {
      if (!canUse(emote)) return;
      const key = String(emote.name).toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(emote);
    };
    for (const emote of activeServer.emotes || []) add(emote);
    if (activeServer.allowExternalEmotes !== false) {
      for (const server of data?.servers || []) {
        if (server.id === activeServer.id) continue;
        for (const emote of server.emotes || []) add(emote);
      }
    }
    return merged;
  }, [activeServer, data?.servers, myGroupIdsByServer]);

  // The sidebar only ever shows channels this viewer may open. Viewer-specific
  // responses are already filtered server-side; this keeps a broadcast - which
  // has no viewer and therefore carries every channel - from putting a hidden
  // channel back on screen.
  const sidebarServer = useMemo(() => {
    if (!activeServer || !activeServer.channelPermissions) return activeServer;
    const map = activeServer.channelPermissions;
    return {
      ...activeServer,
      // A channel with no entry in the map is one the payload has never seen -
      // created since it was built, by this window or another. Hiding it would
      // make a channel disappear the moment it was created, which is exactly
      // what happened; the server's rule is that a channel is visible unless
      // something explicitly hides it, so a missing entry means visible.
      channels: activeServer.channels.filter((channel) => {
        const allowed = map[channel.id];
        return !allowed || allowed.includes('viewChannel');
      })
    };
  }, [activeServer]);

  // Onboarding is read once per server per session: buildServer only carries the
  // enabled flag, so the body is fetched the first time the server is opened and
  // cached - a dismissal included, so switching away and back shows nothing.
  useEffect(() => {
    const serverId = activeServer?.id;
    if (!serverId || !activeServer.welcomeEnabled) {
      setWelcome(null);
      return undefined;
    }
    const cached = welcomeCacheRef.current.get(serverId);
    if (cached) {
      setWelcome(cached.enabled && !cached.dismissed ? { ...cached, serverId } : null);
      return undefined;
    }
    let cancelled = false;
    api
      .get(`/api/servers/${serverId}/welcome`)
      .then((payload) => {
        welcomeCacheRef.current.set(serverId, payload);
        if (cancelled) return;
        setWelcome(payload.enabled && !payload.dismissed ? { ...payload, serverId } : null);
      })
      .catch(() => {
        // Onboarding must never block the app: a failed read just means no card.
        if (!cancelled) setWelcome(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeServer?.id, activeServer?.welcomeEnabled]);

  const dismissWelcome = useCallback(async () => {
    const current = welcome;
    setWelcome(null);
    if (!current) return;
    welcomeCacheRef.current.set(current.serverId, { ...current, dismissed: true });
    try {
      await api.post(`/api/servers/${current.serverId}/welcome/dismiss`);
    } catch {
      // Already closed on this side; a failed write only means it may return later.
    }
  }, [welcome]);

  const activeChannelType = activeChannel?.type;
  const scopeKey = activeDmId ? `dm:${activeDmId}` : activeChannelId ? `ch:${activeChannelId}` : null;
  const scopeMessages = (scopeKey && messages[scopeKey]) || [];
  const typingUsers = (typing[scopeKey] || []).filter((entry) => entry.id !== user.id);

  useEffect(() => {
    activeKeyRef.current = scopeKey;
    activeServerRef.current = activeServerId;
  }, [scopeKey, activeServerId]);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    notificationPrefsRef.current = notificationPrefs;
  }, [notificationPrefs]);

  useEffect(() => {
    if (!user.e2eeReady || isE2eeUnlocked()) return undefined;
    let cancelled = false;
    (async () => {
      try {
        await restoreRememberedDevice(user);
      } catch (error) {
        console.warn('[e2ee] could not restore remembered device:', error.message);
      }
      if (!cancelled && !isE2eeUnlocked()) setE2eeModalOpen(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [user.id, user.e2eeReady, user.e2eePublicKey, user.e2eeKeyVersion]);

  useEffect(() => {
    mutedScopesRef.current = mutedScopes;
  }, [mutedScopes]);

  useEffect(() => {
    const incoming = call.call?.status === 'incoming' ? call.call : null;
    if (!incoming) {
      incomingCallRef.current = null;
      stopCallRingtone();
      return;
    }
    if (incomingCallRef.current !== incoming.id) {
      incomingCallRef.current = incoming.id;
      if (notificationPrefs.desktop) {
        const peerName = incoming.peer?.displayName || 'Someone';
        showDesktopNotification({
          title: `Incoming call from ${peerName}`,
          body: 'Open Cordia to answer or decline.',
          tag: `call-${incoming.id}`,
          requireInteraction: true
        });
      }
    }
    if (notificationPrefs.sounds) startCallRingtone();
    else stopCallRingtone();
  }, [call.call, notificationPrefs.desktop, notificationPrefs.sounds]);

  useEffect(() => () => stopCallRingtone(), []);

  useEffect(() => {
    if (scopeKey) {
      const jump = pendingJumpRef.current;
      const jumpMatchesScope =
        jump &&
        ((activeDmId && jump.dmId === activeDmId) ||
          (!activeDmId && jump.channelId === activeChannelId));
      // A scope that was deliberately left unread (or entered from the catch-up
      // inbox) keeps its badge until the reader actually reaches the bottom.
      if (!deferReadRef.current[scopeKey]) {
        setUnread((prev) => (prev[scopeKey] ? { ...prev, [scopeKey]: 0 } : prev));
        setMentionUnread((prev) => (prev[scopeKey] ? { ...prev, [scopeKey]: 0 } : prev));
      }
      if (!jumpMatchesScope) setHighlightId(null);
      typingScopeRef.current = null;
    }
  }, [scopeKey]);

  useEffect(() => {
    function syncReadState() {
      if (!scopeKey || document.hidden || !document.hasFocus()) return;
      if (deferReadRef.current[scopeKey]) return;
      setUnread((prev) => (prev[scopeKey] ? { ...prev, [scopeKey]: 0 } : prev));
      setMentionUnread((prev) => (prev[scopeKey] ? { ...prev, [scopeKey]: 0 } : prev));
      markScopeRead(scopeKey);
    }
    window.addEventListener('focus', syncReadState);
    document.addEventListener('visibilitychange', syncReadState);
    return () => {
      window.removeEventListener('focus', syncReadState);
      document.removeEventListener('visibilitychange', syncReadState);
    };
  }, [scopeKey, markScopeRead]);

  useEffect(() => {
    if (!data) return;
    const keys = new Set([...Object.keys(unread), ...Object.keys(mentionUnread)]);
    let total = 0;
    for (const key of keys) {
      const mentions = mentionUnread[key] || 0;
      const count = mutedScopes[key] ? mentions : Math.max(unread[key] || 0, mentions);
      total += count;
    }
    document.title = total > 0 ? `(${total > 99 ? '99+' : total}) Cordia` : 'Cordia';
  }, [unread, mentionUnread, mutedScopes, data]);

  useEffect(() => {
    const timer = setInterval(() => {
      setTyping((prev) => {
        let changed = false;
        const next = {};
        for (const [key, list] of Object.entries(prev)) {
          const filtered = list.filter((entry) => Date.now() - entry.at < 3500);
          if (filtered.length !== list.length) changed = true;
          if (filtered.length) next[key] = filtered;
        }
        return changed ? next : prev;
      });
    }, 1200);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!scopeKey) return undefined;
    // Threads hold messages too; forums hold threads, so they load nothing here.
    if (!activeDmId && activeChannelType !== 'text' && activeChannelType !== 'thread') {
      setLoadingMessages(false);
      return undefined;
    }
    let cancelled = false;
    setLoadingMessages(true);

    let url = activeDmId
      ? `/api/dms/${activeDmId}/messages`
      : `/api/channels/${activeChannelId}/messages`;
    const jump = pendingJumpRef.current;
    const jumpMatchesDm = jump?.dmId && jump.dmId === activeDmId;
    const jumpMatchesChannel = jump?.channelId && jump.channelId === activeChannelId && !activeDmId;
    if (jumpMatchesDm || jumpMatchesChannel) {
      url += `?before=${jump.messageId + 1}&limit=50`;
    }

    api
      .get(url)
      .then((payload) => {
        if (cancelled) return;
        setMessages((prev) => ({ ...prev, [scopeKey]: payload.messages }));
        setCatchup((prev) => ({ ...prev, [scopeKey]: payload.catchup || null }));
        if (payload.catchup?.count || deferReadRef.current[scopeKey]) {
          deferReadRef.current[scopeKey] = true;
        } else {
          setUnread((prev) => ({ ...prev, [scopeKey]: 0 }));
          setMentionUnread((prev) => ({ ...prev, [scopeKey]: 0 }));
          markScopeRead(scopeKey);
        }
        if (jumpMatchesDm || jumpMatchesChannel) pendingJumpRef.current = null;
      })
      .catch((error) => {
        if (!cancelled) {
          showToast({ type: 'error', title: 'Could not load messages', message: error.message });
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingMessages(false);
      });

    return () => {
      cancelled = true;
    };
  }, [scopeKey, activeDmId, activeChannelId, activeChannelType, showToast, markScopeRead, reloadToken]);

  function jumpToUnread(messageId) {
    if (!messageId) return;
    if (activeDmId) pendingJumpRef.current = { dmId: activeDmId, messageId };
    else if (activeChannelId) pendingJumpRef.current = { channelId: activeChannelId, messageId };
    else return;
    setHighlightId(messageId);
    setReloadToken((value) => value + 1);
  }

  async function markMessageUnread(message) {
    if (!scopeKey || !message?.id) return;
    const scopeType = activeDmId ? 'dm' : 'channel';
    const scopeId = activeDmId || activeChannelId;
    if (!scopeId) return;
    try {
      const payload = await api.post(`/api/read/${scopeType}/${scopeId}/unread`, {
        messageId: message.id
      });
      const count = payload?.readState?.unread || 0;
      deferReadRef.current[scopeKey] = true;
      setUnread((prev) => ({ ...prev, [scopeKey]: count }));
      setMentionUnread((prev) => ({ ...prev, [scopeKey]: 0 }));
      setCatchup((prev) => ({ ...prev, [scopeKey]: null }));
      showToast({
        type: 'success',
        title: 'Marked unread',
        message: `${count} message${count === 1 ? '' : 's'} will wait for you here.`
      });
    } catch (error) {
      showToast({ type: 'error', title: 'Could not mark unread', message: error.message });
    }
  }

  function handleReachBottom() {
    if (!scopeKey || !deferReadRef.current[scopeKey]) return;
    delete deferReadRef.current[scopeKey];
    setUnread((prev) => ({ ...prev, [scopeKey]: 0 }));
    setMentionUnread((prev) => ({ ...prev, [scopeKey]: 0 }));
    setCatchup((prev) => ({ ...prev, [scopeKey]: null }));
    markScopeRead(scopeKey);
  }

  useEffect(() => {
    function onPresenceList(ids) {
      const online = new Set(ids.map(Number));
      setPresence((prev) => {
        const next = { ...prev };
        for (const key of Object.keys(next)) next[key] = online.has(Number(key));
        for (const id of online) next[id] = true;
        return next;
      });
    }

    function onPresenceUpdate({ userId, online }) {
      setPresence((prev) => ({ ...prev, [userId]: !!online }));
    }

    // Listening is presence, not profile: it changes every few minutes and is
    // gone the moment the track stops, so it rides its own event instead of
    // dragging a whole user object across the wire.
    function onActivityUpdate({ userId, activity }) {
      if (!userId) return;
      const next = activity || null;
      setUser((previous) => (previous && previous.id === userId ? { ...previous, activity: next } : previous));
      setData((previous) => {
        if (!previous) return previous;
        const merge = (entry) => (entry.id === userId ? { ...entry, activity: next } : entry);
        return {
          ...previous,
          users: previous.users.map(merge),
          servers: previous.servers.map((server) => ({ ...server, members: server.members.map(merge) })),
          dms: previous.dms.map((dm) =>
            dm.user.id === userId ? { ...dm, user: { ...dm.user, activity: next } } : dm
          )
        };
      });
    }

    function onUserNew(person) {
      if (!person) return;
      setData((prev) =>
        prev && !prev.users.some((entry) => entry.id === person.id)
          ? { ...prev, users: [...prev.users, person] }
          : prev
      );
    }

    function onUserUpdated(person) {
      if (!person) return;
      const merge = (entry) => (entry.id === person.id ? { ...entry, ...person } : entry);
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          users: prev.users.map(merge),
          servers: prev.servers.map((server) => ({
            ...server,
            members: server.members.map(merge)
          })),
          dms: prev.dms.map((dm) => (dm.user.id === person.id ? { ...dm, user: { ...dm.user, ...person } } : dm))
        };
      });
      setFriends((prev) => mapFriendUsers(prev, merge));
      if (person.id === user.id) {
        setUser((prev) => ({ ...prev, ...person }));
      }
    }

    function dropServer(serverId) {
      setData((prev) => (prev ? { ...prev, servers: prev.servers.filter((s) => s.id !== serverId) } : prev));
      if (activeServerRef.current === serverId) {
        setView('home');
        setActiveServerId(null);
        setActiveChannelId(null);
        setActiveDmId(null);
      }
      if (voiceRef.current?.channel?.serverId === serverId) voiceRef.current.leave();
    }

    function onUserDeleted({ userId }) {
      setData((prev) => {
        if (!prev) return prev;
        const dms = prev.dms.filter((dm) => dm.user.id !== userId);
        return {
          ...prev,
          users: prev.users.filter((person) => person.id !== userId),
          servers: prev.servers.map((server) => ({
            ...server,
            members: server.members.filter((member) => member.id !== userId)
          })),
          dms
        };
      });
      setFriends((prev) => mapFriendUsers(prev, (entry) => entry).friends
        ? {
            friends: prev.friends.filter((entry) => entry.user.id !== userId),
            incoming: prev.incoming.filter((entry) => entry.user.id !== userId),
            outgoing: prev.outgoing.filter((entry) => entry.user.id !== userId),
            blocked: prev.blocked.filter((entry) => entry.user.id !== userId)
          }
        : prev);
      setProfileId((current) => (current === userId ? null : current));
    }

    function onMessage(msg) {
      if (!msg) return;
      const key = msg.dmId ? `dm:${msg.dmId}` : `ch:${msg.channelId}`;
      // A new thread (announcement) or activity in a thread you are not looking
      // at changes the sidebar, so refetch the viewer's thread list.
      if (msg.systemType === 'thread' || (msg.threadId && key !== activeKeyRef.current)) {
        setThreadsVersion((version) => version + 1);
      }
      setMessages((prev) => {
        const list = prev[key];
        if (!list) return prev;
        if (list.some((entry) => entry.id === msg.id)) return prev;
        return { ...prev, [key]: [...list, msg] };
      });
      const activelyViewing =
        key === activeKeyRef.current && !document.hidden && document.hasFocus();
      const system = !!msg.systemType;
      if (activelyViewing && !system && !msg.encrypted) {
        triggerMessageEasterEgg(msg.content);
      }
      const mentioned =
        !system &&
        !msg.encrypted &&
        msg.author.id !== user.id &&
        new RegExp(`@${escapeRegExp(user.username)}(?![\\w.-])`, 'i').test(msg.content || '');
      if (mentioned && !activelyViewing) {
        setMentionUnread((prev) => ({ ...prev, [key]: (prev[key] || 0) + 1 }));
      }
      if (!system && msg.author.id !== user.id && !activelyViewing && !mutedScopesRef.current[key]) {
        setUnread((prev) => ({ ...prev, [key]: (prev[key] || 0) + 1 }));
      }
      if (activelyViewing) markScopeRead(key);
      notifyMessage(msg, key, mentioned);
      if (msg.dmId) {
        setData((prev) => {
          if (!prev) return prev;
          const exists = prev.dms.some((dm) => dm.id === msg.dmId);
          if (!exists) return prev;
          return {
            ...prev,
            dms: sortDms(
              prev.dms.map((dm) =>
                dm.id === msg.dmId
                  ? {
                      ...dm,
                      closed: false,
                      lastMessage: {
                        content: msg.encrypted ? '' : msg.content,
                        encrypted: !!msg.encrypted,
                        createdAt: msg.createdAt,
                        authorId: msg.author.id,
                        authorName: msg.author.displayName,
                        hasAttachment: !!msg.attachment
                      }
                    }
                  : dm
              )
            )
          };
        });
      }
    }

    function onMessageUpdated(payload) {
      const key = payload.dmId ? `dm:${payload.dmId}` : `ch:${payload.channelId}`;
      setMessages((prev) => {
        const list = prev[key];
        if (!list) return prev;
        return {
          ...prev,
          [key]: list.map((entry) => {
            if (entry.id === payload.messageId) {
              return { ...entry, content: payload.content, editedAt: payload.editedAt };
            }
            if (entry.replyTo?.id === payload.messageId) {
              return {
                ...entry,
                replyTo: { ...entry.replyTo, content: payload.content }
              };
            }
            return entry;
          })
        };
      });
    }

    function onMessageDeleted(payload) {
      const key = payload.dmId ? `dm:${payload.dmId}` : `ch:${payload.channelId}`;
      setMessages((prev) => {
        const list = prev[key];
        if (!list) return prev;
        return {
          ...prev,
          [key]: list
            .filter((entry) => entry.id !== payload.messageId)
            .map((entry) =>
              entry.replyTo?.id === payload.messageId ? { ...entry, replyTo: null } : entry
            )
        };
      });
    }

    function onMessageReactions(payload) {
      const key = payload.dmId ? `dm:${payload.dmId}` : `ch:${payload.channelId}`;
      setMessages((prev) => {
        const list = prev[key];
        if (!list) return prev;
        return {
          ...prev,
          [key]: list.map((entry) =>
            entry.id === payload.messageId ? { ...entry, reactions: payload.reactions } : entry
          )
        };
      });
    }

    function onMessagePoll(payload) {
      const key = payload.dmId ? `dm:${payload.dmId}` : `ch:${payload.channelId}`;
      setMessages((prev) => {
        const list = prev[key];
        if (!list) return prev;
        return {
          ...prev,
          [key]: list.map((entry) =>
            entry.id === payload.messageId ? { ...entry, poll: payload.poll } : entry
          )
        };
      });
    }

    // The pin itself is echoed by whoever pressed the button too; applying it
    // twice is harmless because it only writes pinnedAt.
    function onMessagePinChanged(payload) {
      const key = payload.dmId ? `dm:${payload.dmId}` : `ch:${payload.channelId}`;
      setMessages((prev) => {
        const list = prev[key];
        if (!list) return prev;
        return {
          ...prev,
          [key]: list.map((entry) =>
            entry.id === payload.messageId
              ? { ...entry, pinnedAt: payload.pinnedAt ?? null, pinnedBy: payload.pinnedBy ?? null }
              : entry
          )
        };
      });
      setPinsVersion((version) => version + 1);
    }

    function onEventsChanged({ serverId }) {
      if (Number(serverId) === Number(activeServerRef.current)) {
        setEventsRefresh((value) => value + 1);
      }
    }

    function onTyping(payload) {
      if (!payload?.user) return;
      const key = payload.scopeType === 'dm' ? `dm:${payload.scopeId}` : `ch:${payload.scopeId}`;
      setTyping((prev) => {
        const list = (prev[key] || []).filter((entry) => entry.id !== payload.user.id);
        list.push({ ...payload.user, at: Date.now() });
        return { ...prev, [key]: list };
      });
    }

    function onServerUpdated(server) {
      if (!server) return;
      setData((prev) =>
        prev ? { ...prev, servers: prev.servers.map((s) => (s.id === server.id ? server : s)) } : prev
      );
    }

    // Sent to every session of the account that just joined. The tab that did
    // the joining already has the server from the POST response; the others -
    // the desktop app while you join from a browser - get it here.
    function onServerJoined({ server }) {
      if (!server) return;
      setData((prev) => {
        if (!prev) return prev;
        if (prev.servers.some((entry) => entry.id === server.id)) return prev;
        return { ...prev, servers: [...prev.servers, server] };
      });
    }

    function onMemberJoined({ serverId, member }) {
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          servers: prev.servers.map((server) => {
            if (server.id !== serverId) return server;
            if (server.members.some((entry) => entry.id === member.id)) return server;
            return { ...server, members: [...server.members, member] };
          })
        };
      });
    }

    function onMemberLeft({ serverId, userId }) {
      if (userId === user.id) {
        dropServer(serverId);
        return;
      }
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          servers: prev.servers.map((server) =>
            server.id === serverId
              ? { ...server, members: server.members.filter((member) => member.id !== userId) }
              : server
          )
        };
      });
    }

    function onServerDeleted({ serverId }) {
      dropServer(serverId);
    }

    function onChannelCreated(channel) {
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          servers: prev.servers.map((server) => {
            if (server.id !== channel.serverId) return server;
            if (server.channels.some((entry) => entry.id === channel.id)) return server;
            return { ...server, channels: [...server.channels, channel] };
          })
        };
      });
    }

    function onChannelDeleted({ channelId, serverId }) {
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          servers: prev.servers.map((server) =>
            server.id === serverId
              ? { ...server, channels: server.channels.filter((channel) => channel.id !== channelId) }
              : server
          )
        };
      });
      setActiveChannelId((current) => (current === channelId ? null : current));
    }

    function onDmNew(dm) {
      if (!dm) return;
      setData((prev) => {
        if (!prev) return prev;
        const exists = prev.dms.some((entry) => entry.id === dm.id);
        const dms = exists
          ? prev.dms.map((entry) => (entry.id === dm.id ? { ...entry, ...dm } : entry))
          : [...prev.dms, dm];
        return { ...prev, dms: sortDms(dms) };
      });
    }

    function onFriendsChanged() {
      refreshFriends();
      api.get('/api/bootstrap').then((payload) => {
        setData(payload);
        const attention = attentionState(payload.readState);
        setUnread(attention.unread);
        setMentionUnread(attention.mentions);
        setMutedScopes(attention.muted);
        mutedScopesRef.current = attention.muted;
      }).catch(() => {});
    }

    // The archiver runs on the server; it only tells us which server changed.
    function onThreadsChanged({ serverId }) {
      if (Number(serverId) !== Number(activeServerRef.current)) return;
      setThreadsVersion((version) => version + 1);
    }

    // Admin grants and revokes arrive as a bare badge list for this user. The
    // only surface that renders badges is the profile card, and it owns its
    // /api/users/:id/profile fetch, so bump a version it watches instead of
    // pulling the whole bootstrap down again.
    function onBadgesUpdated() {
      setBadgesVersion((version) => version + 1);
    }

    function onBadgeAwarded({ badge }) {
      const meta = BADGE_META[badge];
      showToast({
        type: 'badge',
        badge,
        title: `Badge unlocked - ${meta?.label || badge}`,
        message: meta?.description || ''
      });
    }

    // A reminder that fires while the tab is open lands as a toast; the same
    // reminder is still in the Reminders list afterwards, because a toast that
    // appears while somebody is making coffee is a reminder nobody received.
    function onReminderDue(payload) {
      const preview = payload?.message?.content || '';
      showToast({
        type: 'reminder',
        title: payload?.note || 'Reminder',
        message: payload?.note
          ? preview.slice(0, 120)
          : (payload?.message?.where ? payload.message.where + ' · ' : '') + preview.slice(0, 120)
      });
    }

    function onInteractionModal(payload) {
      setBotModals((previous) =>
        previous.some((entry) => entry.interactionId === payload.interactionId)
          ? previous
          : [...previous, payload]
      );
    }

    socket.on('interaction:modal', onInteractionModal);
    socket.on('reminder:due', onReminderDue);
    socket.on('presence:list', onPresenceList);
    socket.on('presence:update', onPresenceUpdate);
    socket.on('activity:update', onActivityUpdate);
    socket.on('user:new', onUserNew);
    socket.on('user:updated', onUserUpdated);
    socket.on('user:deleted', onUserDeleted);
    socket.on('message:new', onMessage);
    socket.on('message:updated', onMessageUpdated);
    socket.on('message:deleted', onMessageDeleted);
    socket.on('message:reactions', onMessageReactions);
    socket.on('message:poll', onMessagePoll);
    socket.on('message:pinned', onMessagePinChanged);
    socket.on('message:unpinned', onMessagePinChanged);
    socket.on('server:events-changed', onEventsChanged);
    socket.on('typing', onTyping);
    socket.on('server:updated', onServerUpdated);
    socket.on('server:threads-changed', onThreadsChanged);
    socket.on('server:joined', onServerJoined);
    socket.on('server:member-joined', onMemberJoined);
    socket.on('server:member-left', onMemberLeft);
    socket.on('server:deleted', onServerDeleted);
    socket.on('channel:created', onChannelCreated);
    socket.on('channel:deleted', onChannelDeleted);
    socket.on('dm:new', onDmNew);
    socket.on('friends:changed', onFriendsChanged);
    socket.on('badge:awarded', onBadgeAwarded);
    socket.on('badges:updated', onBadgesUpdated);
    socket.on('connect_error', () => {});

    socket.connect();

    return () => {
      socket.off('presence:list', onPresenceList);
    socket.off('interaction:modal', onInteractionModal);
      socket.off('reminder:due', onReminderDue);
      socket.off('presence:update', onPresenceUpdate);
      socket.off('activity:update', onActivityUpdate);
      socket.off('user:new', onUserNew);
      socket.off('user:updated', onUserUpdated);
      socket.off('user:deleted', onUserDeleted);
      socket.off('message:new', onMessage);
      socket.off('message:updated', onMessageUpdated);
      socket.off('message:deleted', onMessageDeleted);
      socket.off('message:reactions', onMessageReactions);
      socket.off('message:poll', onMessagePoll);
      socket.off('message:pinned', onMessagePinChanged);
      socket.off('message:unpinned', onMessagePinChanged);
      socket.off('server:events-changed', onEventsChanged);
      socket.off('typing', onTyping);
      socket.off('server:updated', onServerUpdated);
    socket.off('server:threads-changed', onThreadsChanged);
      socket.off('server:joined', onServerJoined);
      socket.off('server:member-joined', onMemberJoined);
      socket.off('server:member-left', onMemberLeft);
      socket.off('server:deleted', onServerDeleted);
      socket.off('channel:created', onChannelCreated);
      socket.off('channel:deleted', onChannelDeleted);
      socket.off('dm:new', onDmNew);
      socket.off('friends:changed', onFriendsChanged);
      socket.off('badge:awarded', onBadgeAwarded);
      socket.off('badges:updated', onBadgesUpdated);
      socket.disconnect();
    };
  }, [socket, refreshFriends, showToast, setUser, user.id, user.username, notifyMessage, markScopeRead]);

  const serverUnread = useMemo(() => {
    if (!data) return {};
    const map = {};
    for (const server of data.servers) {
      let total = 0;
      for (const channel of server.channels) {
        const key = `ch:${channel.id}`;
        const mentions = mentionUnread[key] || 0;
        total += mutedScopes[key] ? mentions : Math.max(unread[key] || 0, mentions);
      }
      if (total > 0) map[server.id] = total;
    }
    return map;
  }, [data, unread, mentionUnread, mutedScopes]);

  const mentionTotal = useMemo(
    () => Object.values(mentionUnread).reduce((total, count) => total + (count || 0), 0),
    [mentionUnread]
  );

  // Conversations with something new that the user has not muted. Matches the
  // list returned by GET /api/catchup/summary.
  const awayTotal = useMemo(() => {
    let total = 0;
    for (const [key, count] of Object.entries(unread)) {
      if (count > 0 && !mutedScopes[key] && key !== scopeKey) total += 1;
    }
    return total;
  }, [unread, mutedScopes, scopeKey]);

  useEffect(() => {
    function onKey(event) {
      if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === 'k') {
        event.preventDefault();
        setModal((prev) => (prev?.type === 'quickSwitch' ? null : { type: 'quickSwitch' }));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const canModerate = useMemo(
    () => hasServerPermission(activeServer, user, 'manageMessages'),
    [activeServer, user]
  );
  const canSendMessages = useMemo(
    () => hasServerPermission(activeServer, user, 'sendMessages'),
    [activeServer, user]
  );
  const canPinMessages = useMemo(
    () => hasServerPermission(activeServer, user, 'pinMessages'),
    [activeServer, user]
  );
  const canStartThreads = useMemo(
    () => hasServerPermission(activeServer, user, 'startThreads'),
    [activeServer, user]
  );
  const canAttachFiles = useMemo(
    () => hasServerPermission(activeServer, user, 'attachFiles'),
    [activeServer, user]
  );
  const canAddReactions = useMemo(
    () => hasServerPermission(activeServer, user, 'addReactions'),
    [activeServer, user]
  );
  const canConnectVoice = useMemo(
    () => hasServerPermission(activeServer, user, 'connectVoice'),
    [activeServer, user]
  );
  const canManageChannels = useMemo(
    () => hasServerPermission(activeServer, user, 'manageChannels'),
    [activeServer, user]
  );
  const canCreateEvents = useMemo(
    () => hasServerPermission(activeServer, user, 'createEvents'),
    [activeServer, user]
  );
  // The dock follows the call, not the page: you can be connected to voice in
  // one server while browsing another, and the soundboard belongs to the call.
  const voiceServer = useMemo(
    () => (data?.servers || []).find((entry) => entry.id === voice.channel?.serverId) || null,
    [data, voice.channel?.serverId]
  );

  function openServer(server, channelId = null) {
    if (!server) return;
    const channel =
      (channelId && server.channels.find((entry) => entry.id === channelId)) ||
      server.channels.find((entry) => entry.type === 'text') ||
      server.channels[0] ||
      null;
    setView('server');
    setActiveServerId(server.id);
    setActiveChannelId(channel?.id ?? null);
    setActiveDmId(null);
    if (isVoiceLike(channel) && hasServerPermission(server, user, 'connectVoice')) {
      voice.join({ id: channel.id, name: channel.name, serverId: server.id });
    }
  }

  function chooseServer(serverId, channelId = null) {
    if (!data) return;
    openServer(
      data.servers.find((entry) => entry.id === serverId),
      channelId
    );
  }

  function selectChannel(channel) {
    if (!activeServer) return;
    setMobilePane('chat');
    setActiveChannelId(channel.id);
    setActiveDmId(null);
    if (isVoiceLike(channel) && canConnectVoice) {
      voice.join({ id: channel.id, name: channel.name, serverId: activeServer.id });
    }
  }

  function goHome() {
    setMobilePane('chat');
    setView('home');
    setActiveServerId(null);
    setActiveChannelId(null);
    setActiveDmId(null);
    setHighlightId(null);
  }

  function openSettings(tab = 'profile') {
    setMobilePane('chat');
    if (view !== 'settings') {
      setSettingsReturn(view === 'server' ? 'server' : 'home');
    }
    setProfileId(null);
    setModal(null);
    setSettingsContext({ tab });
    setView('settings');
  }

  function closeWhatsNew(openAll) {
    setWhatsNewOpen(false);
    try {
      localStorage.setItem('cordia:whats-new-seen', LATEST_RELEASE.version);
    } catch {
      // storage may be unavailable
    }
    if (openAll) openSettings('updates');
  }

  function closeSettings() {
    setView(settingsReturn === 'server' && !activeServerId ? 'home' : settingsReturn);
  }

  function openServerSettings(serverId = activeServerId) {
    if (!serverId) return;
    const targetServer = data.servers.find((entry) => entry.id === Number(serverId));
    if (!targetServer || !hasServerPermission(targetServer, user, 'viewServerSettings')) {
      showToast({
        type: 'error',
        title: "You don't have permission to view server settings."
      });
      return;
    }
    if (view !== 'server-settings') {
      setSettingsReturn(view === 'server' ? 'server' : 'home');
    }
    setProfileId(null);
    setModal(null);
    setServerSettingsId(serverId);
    setView('server-settings');
  }

  function closeServerSettings() {
    setView(settingsReturn === 'server' && !activeServerId ? 'home' : settingsReturn);
  }

  function updateServer(server) {
    setData((prev) =>
      prev
        ? {
            ...prev,
            servers: prev.servers.map((entry) => {
              if (entry.id !== server.id) return entry;
              // A broadcast has no viewer, so it carries every channel and no
              // permission map. Keep the map we already resolved for this
              // viewer, otherwise a rename elsewhere would reveal the channels
              // their overrides hide.
              if (server.channelPermissions || !entry.channelPermissions) return server;
              return { ...server, channelPermissions: entry.channelPermissions };
            })
          }
        : prev
    );
  }

  async function reorderChannels(nextChannels) {
    if (!activeServer) return;
    const previous = activeServer;
    const ordered = nextChannels.map((channel, index) => ({ ...channel, position: index }));
    setData((prev) =>
      prev
        ? {
            ...prev,
            servers: prev.servers.map((entry) =>
              entry.id === activeServer.id ? { ...entry, channels: ordered } : entry
            )
          }
        : prev
    );
    try {
      const payload = await api.put(`/api/servers/${activeServer.id}/channels/order`, {
        channels: ordered.map((channel) => ({
          id: channel.id,
          categoryId: channel.categoryId ?? null
        }))
      });
      updateServer(payload.server);
    } catch (error) {
      updateServer(previous);
      showToast({ type: 'error', title: 'Could not reorder channels', message: error.message });
    }
  }

  async function reorderCategories(categoryIds) {
    if (!activeServer) return;
    const previous = activeServer;
    const byId = new Map(activeServer.categories.map((category) => [category.id, category]));
    if (categoryIds.some((id) => !byId.has(id))) return;
    const ordered = categoryIds.map((id, index) => ({ ...byId.get(id), position: index }));
    setData((prev) =>
      prev
        ? {
            ...prev,
            servers: prev.servers.map((entry) =>
              entry.id === activeServer.id ? { ...entry, categories: ordered } : entry
            )
          }
        : prev
    );
    try {
      const payload = await api.put(`/api/servers/${activeServer.id}/categories/order`, {
        categoryIds
      });
      updateServer(payload.server);
    } catch (error) {
      updateServer(previous);
      showToast({ type: 'error', title: 'Could not reorder categories', message: error.message });
    }
  }

  function removeServer(serverId) {
    setData((prev) =>
      prev ? { ...prev, servers: prev.servers.filter((server) => server.id !== serverId) } : prev
    );
    if (activeServerId === serverId) {
      setActiveServerId(null);
      setActiveChannelId(null);
      setActiveDmId(null);
      setSettingsReturn('home');
    }
  }

  function openDiscover() {
    setMobilePane('chat');
    setView('discover');
    setActiveServerId(null);
    setActiveDmId(null);
    setHighlightId(null);
  }

  function joinDiscoveredServer(server) {
    setData((prev) =>
      prev.servers.some((entry) => entry.id === server.id)
        ? prev
        : { ...prev, servers: [...prev.servers, server] }
    );
    openServer(server);
    showToast({ title: `Joined ${server.name}` });
  }

  function selectDm(dm) {
    setView('home');
    setActiveServerId(null);
    setActiveChannelId(null);
    setActiveDmId(dm.id);
    setUnread((prev) => ({ ...prev, [`dm:${dm.id}`]: 0 }));
    setMentionUnread((prev) => ({ ...prev, [`dm:${dm.id}`]: 0 }));
    markScopeRead(`dm:${dm.id}`);
  }

  async function closeDm(dm) {
    try {
      await api.post(`/api/dms/${dm.id}/close`, {});
      setData((prev) =>
        prev
          ? {
              ...prev,
              dms: prev.dms.map((entry) =>
                entry.id === dm.id ? { ...entry, closed: true } : entry
              )
            }
          : prev
      );
      setUnread((prev) => {
        const next = { ...prev };
        delete next[`dm:${dm.id}`];
        return next;
      });
      setMentionUnread((prev) => {
        const next = { ...prev };
        delete next[`dm:${dm.id}`];
        return next;
      });
      setActiveDmId((current) => (current === dm.id ? null : current));
    } catch (error) {
      showToast({ type: 'error', title: 'Could not close conversation', message: error.message });
    }
  }

  async function createServer(details) {
    const body = typeof details === 'string' ? { name: details } : details;
    const payload = await api.post('/api/servers', body);
    setData((prev) => ({ ...prev, servers: [...prev.servers, payload.server] }));
    openServer(payload.server, payload.firstChannelId);
    showToast({ title: `${payload.server.name} is live`, message: 'Your new server is ready.' });
  }

  async function joinServer(inviteCode) {
    const payload = await api.post('/api/servers/join', { inviteCode });
    setData((prev) =>
      prev.servers.some((server) => server.id === payload.server.id)
        ? prev
        : { ...prev, servers: [...prev.servers, payload.server] }
    );
    chooseServer(payload.server.id);
    showToast({ title: `Joined ${payload.server.name}` });
  }

  async function createChannel(name, type, categoryId = null) {
    if (!activeServer) return;
    if (type === 'category') {
      const payload = await api.post(`/api/servers/${activeServer.id}/categories`, { name });
      setData((prev) =>
        prev
          ? {
              ...prev,
              servers: prev.servers.map((server) =>
                server.id === activeServer.id ? payload.server : server
              )
            }
          : prev
      );
      showToast({ title: `Category ${payload.category.name} created` });
      return;
    }
    const payload = await api.post(`/api/servers/${activeServer.id}/channels`, {
      name,
      type,
      categoryId
    });
    setData((prev) => ({
      ...prev,
      servers: prev.servers.map((server) =>
        server.id === activeServer.id
          ? {
              ...server,
              channels: server.channels.some((channel) => channel.id === payload.channel.id)
                ? server.channels
                : [...server.channels, payload.channel]
            }
          : server
      )
    }));
    selectChannel(payload.channel);
  }

  async function deleteChannel(channel) {
    if (!window.confirm(`Delete #${channel.name}? Messages in it will be lost.`)) return;
    try {
      await api.del(`/api/channels/${channel.id}`);
      setData((prev) => ({
        ...prev,
        servers: prev.servers.map((server) =>
          server.id === channel.serverId
            ? { ...server, channels: server.channels.filter((entry) => entry.id !== channel.id) }
            : server
        )
      }));
      if (channel.id === activeChannelId) {
        const remaining =
          activeServer?.channels.filter((entry) => entry.id !== channel.id) || [];
        const next = remaining.find((entry) => entry.type === 'text') || remaining[0];
        setActiveChannelId(next?.id ?? null);
      }
      showToast({ title: 'Channel deleted' });
    } catch (error) {
      showToast({ type: 'error', title: 'Could not delete channel', message: error.message });
    }
  }

  async function createThread(message) {
    if (!message?.channelId) return null;
    // One thread per message: the button opens the existing one rather than
    // bouncing off the 409 the server would send.
    const existing = (activeServer?.threads || []).find(
      (thread) => thread.parentMessageId === message.id
    );
    if (existing) {
      setActiveChannelId(existing.id);
      return existing;
    }
    const payload = await api.post(`/api/channels/${message.channelId}/threads`, {
      messageId: message.id
    });
    if (payload?.thread?.id) {
      setThreads((prev) =>
        prev.some((entry) => entry.id === payload.thread.id)
          ? prev.map((entry) => (entry.id === payload.thread.id ? payload.thread : entry))
          : [payload.thread, ...prev]
      );
      setActiveChannelId(payload.thread.id);
    }
    return payload?.thread || null;
  }

  // Opening a thread you are not part of joins it first - the announcement in
  // the parent channel is public, the thread itself is not.
  async function openThread(target) {
    const id = Number(typeof target === 'object' && target ? target.id : target);
    if (!id) return;
    const known = (activeServer?.threads || []).find((entry) => entry.id === id);
    if (!known?.joined) {
      try {
        const payload = await api.post(`/api/threads/${id}/join`);
        const thread = payload?.thread;
        if (thread) {
          setThreads((prev) =>
            prev.some((entry) => entry.id === id)
              ? prev.map((entry) => (entry.id === id ? thread : entry))
              : [thread, ...prev]
          );
        }
      } catch (error) {
        showToast({ type: 'error', title: 'Could not open thread', message: error.message });
        return;
      }
    }
    setActiveChannelId(id);
  }

  // Posting keeps you in the forum: the new post is added to the list instead of
  // opening it, which is what "post and stay" means.
  async function createForumPost(channelId, { title, content }) {
    const payload = await api.post(`/api/channels/${channelId}/posts`, { title, content });
    const thread = payload?.thread;
    if (thread?.id) {
      setThreads((prev) =>
        prev.some((entry) => entry.id === thread.id)
          ? prev.map((entry) => (entry.id === thread.id ? thread : entry))
          : [thread, ...prev]
      );
    }
    return thread || null;
  }

  async function togglePostPin(post) {
    const next = !post.pinned;
    setThreads((prev) =>
      prev.map((entry) => (entry.id === post.id ? { ...entry, pinned: next } : entry))
    );
    try {
      const payload = await api.patch(`/api/threads/${post.id}`, { pinned: next });
      if (payload?.thread) {
        setThreads((prev) =>
          prev.map((entry) => (entry.id === post.id ? payload.thread : entry))
        );
      }
    } catch (error) {
      setThreads((prev) =>
        prev.map((entry) => (entry.id === post.id ? { ...entry, pinned: !next } : entry))
      );
      showToast({ type: 'error', title: 'Could not pin that post', message: error.message });
    }
  }

  async function saveForumGuidelines(channelId, guidelines) {
    const payload = await api.patch(`/api/channels/${channelId}`, { guidelines });
    if (payload?.server) updateServer(payload.server);
  }

  async function sendMessage(content, attachment, replyToId) {
    if (!scopeKey) return;
    // Voice notes ride on the File (see MessageInput); encrypted DMs cannot
    // carry the field because the attachment is re-typed as octet-stream.
    const voiceDurationMs =
      attachment instanceof File ? Math.round(Number(attachment.voiceDurationMs) || 0) : 0;
    let body = { content, attachment: null, replyToId };
    if (activeDmId) {
      const peer = activeDm?.user;
      const encryptedDm = !!user.e2eeReady && !!peer?.e2eeReady;
      if (encryptedDm) {
        if (!isE2eeUnlocked()) {
          throw new Error('Unlock encrypted messages to send.');
        }
        let encryptedAttachment = null;
        let envelopeAttachment = null;
        if (attachment instanceof File) {
          const encrypted = await encryptAttachment(attachment);
          const encryptedFile = new File([encrypted.blob], 'encrypted.bin', {
            type: 'application/octet-stream'
          });
          const uploaded = await api.upload(encryptedFile);
          encryptedAttachment = {
            url: uploaded.attachment.url,
            name: 'Encrypted attachment',
            type: 'application/octet-stream'
          };
          envelopeAttachment = {
            name: encrypted.name,
            type: encrypted.type,
            key: encrypted.key,
            iv: encrypted.iv,
            // Encrypted with the rest of the payload: the server never sees it,
            // but the receiver still gets a voice player instead of a file.
            ...(voiceDurationMs > 0 ? { durationMs: voiceDurationMs } : {})
          };
        } else if (attachment) {
          throw new Error('Choose the attachment again to encrypt it.');
        }
        const envelope = await encryptDmMessage({
          text: content,
          attachment: envelopeAttachment,
          dmId: activeDmId,
          senderId: user.id,
          senderKeyVersion: user.e2eeKeyVersion,
          recipientId: peer.id,
          recipientPublicKey: peer.e2eePublicKey,
          recipientKeyVersion: peer.e2eeKeyVersion
        });
        body = {
          content: '',
          attachment: encryptedAttachment,
          e2eeEnvelope: envelope,
          replyToId
        };
      } else {
        const uploaded = attachment instanceof File ? await api.upload(attachment) : null;
        body = {
          content,
          attachment: uploaded?.attachment || attachment || null,
          replyToId,
          ...(voiceDurationMs > 0 ? { voiceDurationMs } : {})
        };
      }
      const payload = await api.post(`/api/dms/${activeDmId}/messages`, body);
      if (!socket.connected) {
        setMessages((prev) => ({
          ...prev,
          [scopeKey]: [...(prev[scopeKey] || []), payload.message]
        }));
      }
    } else if (activeChannelId) {
      const uploaded = attachment instanceof File ? await api.upload(attachment) : null;
      body = {
        content,
        attachment: uploaded?.attachment || attachment || null,
        replyToId,
        ...(voiceDurationMs > 0 ? { voiceDurationMs } : {})
      };
      const payload = await api.post(`/api/channels/${activeChannelId}/messages`, body);
      if (!socket.connected) {
        setMessages((prev) => ({
          ...prev,
          [scopeKey]: [...(prev[scopeKey] || []), payload.message]
        }));
      }
    }
  }

  function replacePoll(messageId, poll) {
    setMessages((prev) => {
      const next = { ...prev };
      for (const [key, list] of Object.entries(prev)) {
        if (!list?.some((entry) => entry.id === messageId)) continue;
        next[key] = list.map((entry) => (entry.id === messageId ? { ...entry, poll } : entry));
      }
      return next;
    });
  }

  async function createPoll(payload) {
    if (!activeChannelId) return;
    const data = await api.post(`/api/channels/${activeChannelId}/polls`, payload);
    if (!socket.connected) {
      setMessages((prev) => ({
        ...prev,
        [scopeKey]: [...(prev[scopeKey] || []), data.message]
      }));
    }
  }

  async function votePoll(message, optionIds) {
    const data = await api.post(`/api/polls/${message.poll.id}/vote`, { optionIds });
    replacePoll(message.id, data.poll);
  }

  async function closePoll(message) {
    const data = await api.post(`/api/polls/${message.poll.id}/close`);
    replacePoll(message.id, data.poll);
  }

  async function editMessage(message, content) {
    await api.patch(`/api/messages/${message.id}`, { content });
  }

  async function deleteMessage(message) {
    try {
      await api.del(`/api/messages/${message.id}`);
      const key = message.dmId ? `dm:${message.dmId}` : `ch:${message.channelId}`;
      setMessages((prev) => ({
        ...prev,
        [key]: (prev[key] || [])
          .filter((entry) => entry.id !== message.id)
          .map((entry) =>
            entry.replyTo?.id === message.id ? { ...entry, replyTo: null } : entry
          )
      }));
    } catch (error) {
      showToast({ type: 'error', title: 'Could not delete message', message: error.message });
    }
  }

  // Pinning is its own permission, so the button only exists for people who can
  // use it. The socket echo is what refreshes everyone else's open panel; this
  // path keeps the local copy honest and asks the panel to re-read.
  async function togglePin(message) {
    const pinning = !message.pinnedAt;
    try {
      const payload = pinning
        ? await api.post(`/api/messages/${message.id}/pin`)
        : await api.del(`/api/messages/${message.id}/pin`);
      const key = message.dmId ? `dm:${message.dmId}` : `ch:${message.channelId}`;
      setMessages((prev) => ({
        ...prev,
        [key]: (prev[key] || []).map((entry) =>
          entry.id === message.id
            ? { ...entry, pinnedAt: payload.message?.pinnedAt ?? null, pinnedBy: payload.message?.pinnedBy ?? null }
            : entry
        )
      }));
      setPinsVersion((version) => version + 1);
      showToast({
        type: 'success',
        title: pinning ? 'Message pinned' : 'Message unpinned'
      });
    } catch (error) {
      showToast({
        type: 'error',
        title: pinning ? 'Could not pin message' : 'Could not unpin message',
        message: error.message
      });
    }
  }

  async function reactMessage(message, emoji) {
    try {
      await api.post(`/api/messages/${message.id}/reactions`, { emoji });
    } catch (error) {
      showToast({ type: 'error', title: 'Could not react', message: error.message });
    }
  }

  function emitTyping() {
    if (!socket.connected || !scopeKey) return;
    const now = Date.now();
    if (typingScopeRef.current === scopeKey && now - typingAtRef.current < 2500) return;
    typingScopeRef.current = scopeKey;
    typingAtRef.current = now;
    socket.emit('typing', {
      scopeType: activeDmId ? 'dm' : 'channel',
      scopeId: activeDmId || activeChannelId
    });
  }

  async function messageUser(userId) {
    try {
      const payload = await api.post('/api/dms', { userId });
      setData((prev) =>
        prev
          ? {
              ...prev,
              dms: sortDms(
                prev.dms.some((dm) => dm.id === payload.dm.id)
                  ? prev.dms.map((dm) => (dm.id === payload.dm.id ? { ...dm, ...payload.dm } : dm))
                  : [...prev.dms, payload.dm]
              )
            }
          : prev
      );
      setProfileId(null);
      selectDm(payload.dm);
    } catch (error) {
      showToast({ type: 'error', title: 'Message not sent', message: error.message });
      throw error;
    }
  }

  async function addFriend(username) {
    await api.post('/api/friends/requests', { username });
    await refreshFriends();
    showToast({ title: 'Friend request sent' });
  }

  async function acceptFriend(request) {
    await api.post(`/api/friends/requests/${request.requestId}/accept`);
    await refreshFriends();
    showToast({ title: `You and ${request.user.displayName} are now friends` });
  }

  async function acceptFriendByUser(userId) {
    const request = friends.incoming.find((entry) => entry.user.id === userId);
    if (!request) throw new Error('Request no longer available.');
    await acceptFriend(request);
  }

  async function declineFriend(request) {
    await api.del(`/api/friends/requests/${request.requestId}`);
    await refreshFriends();
  }

  async function cancelRequest(request) {
    await api.del(`/api/friends/requests/${request.requestId}`);
    await refreshFriends();
    showToast({ title: 'Request cancelled' });
  }

  async function removeFriend(userId) {
    await api.del(`/api/friends/${userId}`);
    await refreshFriends();
    showToast({ title: 'Friend removed' });
  }

  async function saveMessage(message) {
    try {
      await api.post(`/api/messages/${message.id}/save`, {});
      showToast({ title: 'Saved', message: 'Find it under Bookmarks.' });
    } catch (error) {
      showToast({ title: 'Could not save that message', message: error.message });
    }
  }

  // A component click is an interaction, not a message: the bot decides what
  // happens next, so there is nothing to echo locally.
  async function useComponent(message, customId, values) {
    try {
      await api.post(`/api/channels/${message.channelId}/components`, {
        messageId: message.id,
        customId,
        values
      });
    } catch (error) {
      showToast({ title: 'That button did not work', message: error.message });
    }
  }

  async function blockUser(userId) {
    await api.post('/api/friends/block', { userId });
    await refreshFriends();
    setProfileId(null);
    showToast({ title: 'User blocked', message: 'They can no longer message you.' });
  }

  async function unblockUser(userId) {
    await api.del(`/api/friends/block/${userId}`);
    await refreshFriends();
    showToast({ title: 'User unblocked' });
  }

  function applyOwnUser(nextUser) {
    setUser(nextUser);
    setData((prev) =>
      prev
        ? {
            ...prev,
            servers: prev.servers.map((server) => ({
              ...server,
              members: server.members.map((member) =>
                member.id === nextUser.id ? { ...member, ...nextUser } : member
              )
            }))
          }
        : prev
    );
  }

  async function saveProfile(form) {
    const payload = await api.patch('/api/users/me', form);
    applyOwnUser(payload.user);
    showToast({ title: 'Profile updated' });
  }

  async function changePresence(presence) {
    try {
      const payload = await api.patch('/api/users/me', { presence });
      applyOwnUser(payload.user);
      showToast({ title: 'Status updated' });
    } catch (error) {
      showToast({ type: 'error', title: 'Could not update status', message: error.message });
    }
  }

  async function changeStatusText(statusText) {
    try {
      const payload = await api.patch('/api/users/me', { statusText });
      applyOwnUser(payload.user);
      showToast({ title: statusText ? 'Custom status updated' : 'Custom status cleared' });
      return true;
    } catch (error) {
      showToast({ type: 'error', title: 'Could not update custom status', message: error.message });
      return false;
    }
  }

  async function logout() {
    try {
      await disableBackgroundPush();
    } catch {
      // ignore
    }
    try {
      await api.post('/api/auth/logout');
    } catch {
      // ignore
    }
    clearNativeToken();
    lockE2ee();
    await forgetRememberedDevice(user.id).catch(() => {});
    onLoggedOut();
  }

  function handleJump(result) {
    pendingJumpRef.current = { channelId: result.channelId, messageId: result.id };
    setActiveServerId(result.serverId);
    setActiveChannelId(result.channelId);
    setActiveDmId(null);
    setView('server');
    setHighlightId(result.id);
  }

  function handleDmJump(result) {
    pendingJumpRef.current = { dmId: result.dmId, messageId: result.id };
    setActiveServerId(null);
    setActiveChannelId(null);
    setActiveDmId(result.dmId);
    setView('home');
    setHighlightId(result.id);
  }

  function handleAwayCleared(cleared) {
    if (!cleared?.length) return;
    const keys = cleared.map((entry) => `${entry.scopeType === 'dm' ? 'dm' : 'ch'}:${entry.scopeId}`);
    setUnread((prev) => {
      const next = { ...prev };
      for (const key of keys) delete next[key];
      return next;
    });
    setMentionUnread((prev) => {
      const next = { ...prev };
      for (const key of keys) delete next[key];
      return next;
    });
    for (const key of keys) delete deferReadRef.current[key];
    showToast({
      type: 'success',
      title: 'All caught up',
      message: `Cleared ${cleared.length} conversation${cleared.length === 1 ? '' : 's'}.`
    });
  }

  function jumpToChannel(serverId, channelId) {
    setModal(null);
    setMobilePane('chat');
    setView('server');
    setActiveServerId(serverId);
    setActiveChannelId(channelId);
    setActiveDmId(null);
    setHighlightId(null);
  }

  function jumpToDm(dmId) {
    setModal(null);
    setMobilePane('chat');
    setView('home');
    setActiveServerId(null);
    setActiveChannelId(null);
    setActiveDmId(dmId);
    setHighlightId(null);
  }

  function openAwayScope(entry) {
    setModal(null);
    const messageId = entry.firstUnreadId || entry.lastMessage?.id;
    if (!messageId) return;

    const key = `${entry.scopeType === 'dm' ? 'dm' : 'ch'}:${entry.scopeId}`;
    // Land at the unread point and keep the scope unread until the reader actually
    // reaches the bottom, so jumping in does not silently consume the backlog.
    deferReadRef.current[key] = true;
    setMobilePane('chat');
    setUnreadMarkerId(messageId);
    setHighlightId(messageId);

    if (entry.scopeType === 'dm') {
      pendingJumpRef.current = { dmId: entry.scopeId, messageId };
      setView('home');
      setActiveServerId(null);
      setActiveChannelId(null);
      setActiveDmId(entry.scopeId);
      return;
    }

    const serverId =
      entry.serverId ||
      data?.servers.find((server) => server.channels.some((channel) => channel.id === entry.scopeId))?.id;
    pendingJumpRef.current = { channelId: entry.scopeId, messageId };
    setView('server');
    setActiveServerId(serverId || null);
    setActiveChannelId(entry.scopeId);
    setActiveDmId(null);
  }

  function openMention(entry) {
    const key = `${entry.scopeType === 'dm' ? 'dm' : 'ch'}:${entry.scopeId}`;
    const messageId = entry.message.id;
    setModal(null);
    setMobilePane('chat');
    setHighlightId(messageId);
    setUnread((prev) => ({ ...prev, [key]: 0 }));
    setMentionUnread((prev) => ({ ...prev, [key]: 0 }));
    markScopeRead(key);

    if (entry.scopeType === 'dm') {
      pendingJumpRef.current = { dmId: entry.scopeId, messageId };
      setView('home');
      setActiveServerId(null);
      setActiveChannelId(null);
      setActiveDmId(entry.scopeId);
      return;
    }

    const serverId =
      entry.serverId ||
      data?.servers.find((server) => server.channels.some((channel) => channel.id === entry.scopeId))?.id;
    pendingJumpRef.current = { channelId: entry.scopeId, messageId };
    setView('server');
    setActiveServerId(serverId || null);
    setActiveChannelId(entry.scopeId);
    setActiveDmId(null);
  }

  if (loadError) {
    return (
      <div className="splash">
        <WifiOff size={36} />
        <p>{loadError}</p>
        <button className="btn btn-primary btn-sm" onClick={() => window.location.reload()}>
          Try again
        </button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="splash">
        <div className="splash-orbit">
          <Logo size={64} />
        </div>
        <p>Loading your conversations…</p>
      </div>
    );
  }

  if (view === 'settings' || view === 'server-settings') {
    return (
      <div className="settings-root">
        {view === 'settings' ? (
          <SettingsPage
            user={user}
            presence={presence}
            initialTab={settingsContext.tab}
            onClose={closeSettings}
            onSave={saveProfile}
            onLogout={logout}
            onUserUpdate={setUser}
            onOpenE2eeUnlock={() => setE2eeModalOpen(true)}
            notificationPrefs={notificationPrefs}
            onNotificationPrefsChange={changeNotificationPrefs}
          />
        ) : (
          <ServerSettingsPage
            user={user}
            servers={data.servers}
            presence={presence}
            socket={socket}
            initialServerId={serverSettingsId}
            onClose={closeServerSettings}
            onUpdated={updateServer}
            onRemoved={removeServer}
            onAddServer={() => setModal({ type: 'addServer' })}
          />
        )}
        {modal?.type === 'addServer' && (
          <AddServerModal
            onClose={() => setModal(null)}
            onCreate={createServer}
            onJoin={joinServer}
          />
        )}
        {e2eeModalOpen && (
          <E2eeUnlockModal
            user={user}
            onClose={() => setE2eeModalOpen(false)}
            onUnlocked={(nextUser) => {
              if (nextUser) setUser(nextUser);
              setE2eeModalOpen(false);
            }}
          />
        )}
        <Toast toast={toast} />
        <CallOverlay
          call={call.call}
          remoteStream={call.remoteStream}
          remoteVideo={call.remoteVideo}
          localScreen={call.localScreen}
          sharing={call.sharing}
          security={call.security}
          securityNote={call.securityNote}
          muted={call.muted}
          notice={call.notice}
          onAccept={call.accept}
          onDecline={call.decline}
          onEnd={call.end}
          onToggleMute={call.toggleMute}
          onToggleScreen={call.toggleScreen}
        />
      </div>
    );
  }

  const serverForModal = activeServer;
  const membersVisible = view === 'server' && activeChannel?.type === 'text' && showMembers;
  const onLiveVoiceStage =
    view === 'server' && isVoiceLike(activeChannel) && voice.channel?.id === activeChannel.id;
  // One overlay at a time. The welcome card waits for any other overlay to close
  // (rather than stacking) and never covers the voice stage - it stays pending
  // until the member is back on a text channel.
  const welcomeVisible =
    !!welcome &&
    welcome.serverId === activeServer?.id &&
    view === 'server' &&
    !isVoiceLike(activeChannel) &&
    !modal &&
    !profileId &&
    !reportTarget &&
    !e2eeModalOpen &&
    !whatsNewOpen &&
    !supportPromptOpen;

  return (
    <div className={`app-shell mobile-${mobilePane}${onLiveVoiceStage ? ' voice-live' : ''}`}>
      <ServerRail
        servers={data.servers}
        activeServerId={activeServerId}
        homeActive={view === 'home'}
        user={user}
        serverUnread={serverUnread}
        onHome={goHome}
        onSelectServer={(serverId) => chooseServer(serverId)}
        onAddServer={() => setModal({ type: 'addServer' })}
        onDiscover={openDiscover}
        discoverActive={view === 'discover'}
      />

      {view !== 'discover' && (
        <ChannelSidebar
          mode={view === 'server' && activeServer ? 'server' : 'home'}
          user={user}
          presence={presence}
          server={sidebarServer}
          dms={data.dms}
          unread={unread}
          mentionUnread={mentionUnread}
          mentionTotal={mentionTotal}
          awayTotal={awayTotal}
          mutedScopes={mutedScopes}
          activeChannelId={activeChannelId}
          activeDmId={activeDmId}
          voiceChannelId={voice.channel?.id}
          voiceOccupancy={voiceOccupancy}
          onSelectChannel={selectChannel}
          onCreateChannel={(categoryId) =>
            setModal({ type: 'createChannel', categoryId: categoryId ?? null })
          }
          onInvite={() => setModal({ type: 'invite' })}
          onOpenEvents={() => setModal({ type: 'events' })}
          onOpenIconSuggestions={() => setModal({ type: 'iconSuggestions' })}
          onOpenServerSettings={() => openServerSettings(activeServer?.id)}
          onDeleteChannel={deleteChannel}
          onReorderChannels={reorderChannels}
          onReorderCategories={reorderCategories}
          onSelectDm={selectDm}
          onCloseDm={closeDm}
          onHome={goHome}
          onOpenMentions={() => setModal({ type: 'mentions' })}
          onOpenSaved={() => setSavedOpen(true)}
          onOpenAway={() => setModal({ type: 'away' })}
          onOpenProfile={setProfileId}
          onOpenSettings={() => openSettings('profile')}
          onPresenceChange={changePresence}
          onStatusTextChange={changeStatusText}
          onLogout={logout}
        />
      )}

      <main className="main-pane">
        {user.e2eeReady && isE2eeUnlocked() && !user.e2eeRecoveryResettable && (
          <div className="recovery-banner">
            <ShieldAlert size={16} />
            <p>
              {user.e2eeRecoveryReady
                ? 'Your recovery code was created before password reset was available. Re-create it to enable account recovery.'
                : 'Add a recovery code so you can reset your password without losing encrypted messages.'}
            </p>
            <button
              type="button"
              className="btn btn-sm"
              onClick={openRecoverySetup}
              disabled={recoveryBusy}
            >
              {recoveryBusy ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <KeyRound size={14} />
              )}
              {user.e2eeRecoveryReady ? 'Update code' : 'Set up code'}
            </button>
          </div>
        )}
        {view === 'discover' ? (
          <Suspense fallback={<div className="stage-empty">Loading discover…</div>}>
            <DiscoverPage onJoined={joinDiscoveredServer} onOpen={chooseServer} />
          </Suspense>
        ) : view === 'home' ? (
          activeDm ? (
            <ChatView
              mode="dm"
              scopeKey={scopeKey}
              server={null}
              emotes={dmEmotes}
              channel={null}
              dm={activeDm}
              me={user}
              presence={presence}
              messages={scopeMessages}
              loading={loadingMessages}
              typingUsers={typingUsers}
              highlightId={highlightId}
              catchup={catchup[scopeKey] || null}
              onJumpToUnread={jumpToUnread}
              showMembers={false}
              canModerate={false}
              muted={!!mutedScopes[scopeKey]}
              e2ee={e2ee}
              onUnlockE2ee={() => setE2eeModalOpen(true)}
              onVerifyE2ee={() => setSafetyDm(activeDm)}
              e2eePinVersion={e2eePinVersion}
              onToggleMute={() => toggleScopeMute(scopeKey)}
              onToggleMembers={() => {}}
              onInvite={() => {}}
              onSearch={() => setModal({ type: 'dmSearch' })}
              onSend={sendMessage}
              onEdit={editMessage}
              onDelete={deleteMessage}
              onReact={reactMessage}
              onTogglePin={togglePin}
              pinsVersion={pinsVersion}
onReport={openReport}
onMarkUnread={markMessageUnread}
onSaveMessage={saveMessage}
            onRemindMessage={setRemindTarget}
            onShowEdits={setEditTarget}
              onBlockUser={blockUser}
onComponent={useComponent}
onReachBottom={handleReachBottom}
unreadMarkerId={unreadMarkerId}
onBackToList={() => setMobilePane('list')}
              onTyping={emitTyping}
              onOpenProfile={setProfileId}
              onStartCall={call.startCall}
            />
          ) : (
            <HomeView
              user={user}
              friends={friends}
              presence={presence}
              dms={data.dms}
              unread={unread}
              onSelectDm={selectDm}
              onBackToList={() => setMobilePane('list')}
              onMessageUser={messageUser}
              onOpenProfile={setProfileId}
              onAddFriend={addFriend}
              onAcceptFriend={acceptFriend}
              onDeclineFriend={declineFriend}
              onCancelRequest={cancelRequest}
              onRemoveFriend={removeFriend}
              onBlockUser={blockUser}
              onUnblockUser={unblockUser}
            />
          )
        ) : activeServer ? (
          activeChannel ? (
            isVoiceLike(activeChannel) ? (
              <VoiceStage
                channel={activeChannel}
                voice={voice}
                me={user}
                server={activeServer}
                voiceOccupancy={voiceOccupancy}
                onOpenInvite={() => setModal({ type: 'invite' })}
                onBack={() => setMobilePane('list')}
                canConnect={canConnectVoice}
              />
            ) : activeChannel.type === 'forum' ? (
              <Suspense fallback={<div className="stage-empty">Loading forum…</div>}>
                <ForumView
                  channel={activeChannel}
                  server={activeServer}
                  me={user}
                  posts={(activeServer.threads || []).filter(
                    (thread) => thread.parentChannelId === activeChannel.id
                  )}
                  canPost={canSendMessages}
                  canManage={canManageChannels}
                  onOpenPost={(post) => setActiveChannelId(post.id)}
                  onCreatePost={(payload) => createForumPost(activeChannel.id, payload)}
                  onTogglePin={togglePostPin}
                  onSaveGuidelines={(text) => saveForumGuidelines(activeChannel.id, text)}
                  onBackToList={() => setMobilePane('list')}
                />
              </Suspense>
            ) : activeChannel.type === 'docs' ? (
              <Suspense fallback={<div className="stage-empty">Loading documents…</div>}>
                <DocsView
                  channel={activeChannel}
                  canWrite={canSendMessages}
                  onBackToList={() => setMobilePane('list')}
                />
              </Suspense>
            ) : activeChannel.type === 'list' ? (
              <Suspense fallback={<div className="stage-empty">Loading lists…</div>}>
                <ListsView
                  channel={activeChannel}
                  members={activeServer.members || []}
                  canWrite={canSendMessages}
                  onBackToList={() => setMobilePane('list')}
                />
              </Suspense>
            ) : activeChannel.type === 'media' ? (
              <Suspense fallback={<div className="stage-empty">Loading gallery…</div>}>
                <MediaView
                  channel={activeChannel}
                  canAttach={canAttachFiles && canSendMessages}
                  onBackToList={() => setMobilePane('list')}
                />
              </Suspense>
            ) : activeChannel.type === 'calendar' ? (
              <Suspense fallback={<div className="stage-empty">Loading calendar…</div>}>
                <CalendarView
                  server={activeServer}
                  channel={activeChannel}
                  canWrite={canSendMessages}
                  canCreateEvent={canCreateEvents}
                  onBackToList={() => setMobilePane('list')}
                />
              </Suspense>
            ) : (
              <ChatView
                mode="channel"
                scopeKey={scopeKey}
                server={activeServer}
                emotes={channelEmotes}
                channel={activeChannel}
                dm={null}
                me={user}
                presence={presence}
                messages={scopeMessages}
                loading={loadingMessages}
                typingUsers={typingUsers}
                highlightId={highlightId}
                catchup={catchup[scopeKey] || null}
                onJumpToUnread={jumpToUnread}
                showMembers={showMembers}
                canModerate={canModerate}
                canSend={canSendMessages}
                canAttach={canAttachFiles}
                canReact={canAddReactions}
                muted={!!mutedScopes[scopeKey]}
                onToggleMute={() => toggleScopeMute(scopeKey)}
                onToggleMembers={() => setShowMembers((value) => !value)}
                onInvite={() => setModal({ type: 'invite' })}
                onSearch={() => setModal({ type: 'search' })}
                onSend={sendMessage}
                onEdit={editMessage}
                onDelete={deleteMessage}
                onReact={reactMessage}
                onTogglePin={togglePin}
                pinsVersion={pinsVersion}
                canPinMessages={canPinMessages}
                onReport={openReport}
                onMarkUnread={markMessageUnread}
                onSaveMessage={saveMessage}
                onRemindMessage={setRemindTarget}
                onShowEdits={setEditTarget}
                onBlockUser={blockUser}
                onComponent={useComponent}
                onReachBottom={handleReachBottom}
                unreadMarkerId={unreadMarkerId}
                onBackToList={() => setMobilePane('list')}
                onTyping={emitTyping}
                onOpenProfile={setProfileId}
                onCreatePoll={() => setModal({ type: 'poll' })}
                onVotePoll={votePoll}
                onClosePoll={closePoll}
                onCreateThread={createThread}
                onOpenThread={openThread}
                canStartThreads={canStartThreads}
              />
            )
          ) : (
            <div className="stage-empty">
              <Sparkles size={32} />
              <h2>This server is a blank canvas</h2>
              <p>Create a channel to start the conversation.</p>
              <button className="btn btn-primary" onClick={() => setModal({ type: 'createChannel' })}>
                Create a channel
              </button>
            </div>
          )
        ) : (
            <div className="stage-empty">
              <Logo size={48} />
              <h2>Choose a conversation</h2>
              <p>Open a server or start a direct message.</p>
            </div>
        )}
      </main>

      {membersVisible && (
        <MemberList
          server={activeServer}
          user={user}
          presence={presence}
          onOpenProfile={setProfileId}
          onMessageUser={messageUser}
        />
      )}

      <VoiceDock
        voice={voice}
        me={user}
        server={voiceServer}
        socket={socket}
        onOpen={(channel) => {
          const server = data.servers.find((entry) => entry.id === channel.serverId);
          if (server) chooseServer(server.id, channel.id);
        }}
      />

      <ScreenSharePicker voice={voice} />
      <ScreenSharePicker voice={call.screenPicker} />

      {modal?.type === 'addServer' && (
        <AddServerModal
          onClose={() => setModal(null)}
          onCreate={createServer}
          onJoin={joinServer}
        />
      )}
      {modal?.type === 'createChannel' && serverForModal && (
        <CreateChannelModal
          categories={serverForModal.categories || []}
          defaultCategoryId={modal.categoryId ?? null}
          onClose={() => setModal(null)}
          onCreate={createChannel}
        />
      )}
      {modal?.type === 'invite' && serverForModal && (
        <InviteModal server={serverForModal} onClose={() => setModal(null)} />
      )}
      {modal?.type === 'search' && serverForModal && (
        <SearchModal server={serverForModal} onClose={() => setModal(null)} onJump={handleJump} />
      )}
      {modal?.type === 'dmSearch' && activeDm && (
        <DmSearchModal
          dm={activeDm}
          onClose={() => setModal(null)}
          onJump={handleDmJump}
        />
      )}
      {modal?.type === 'mentions' && (
        <MentionsModal onClose={() => setModal(null)} onOpenMention={openMention} />
      )}
      {modal?.type === 'away' && (
        <AwayModal
          onClose={() => setModal(null)}
          onOpenScope={openAwayScope}
          excludeScope={scopeKey}
          onCleared={handleAwayCleared}
        />
      )}
      {modal?.type === 'quickSwitch' && (
        <QuickSwitcher
          data={data}
          me={user}
          onClose={() => setModal(null)}
          onOpenChannel={jumpToChannel}
          onOpenDm={jumpToDm}
          onOpenPerson={(userId) => {
            setModal(null);
            messageUser(userId);
          }}
        />
      )}
      {modal?.type === 'poll' && serverForModal && activeChannel && (
        <PollModal
          channelName={activeChannel.name}
          onClose={() => setModal(null)}
          onCreate={createPoll}
        />
      )}
      {modal?.type === 'events' && serverForModal && (
        <ServerEventsModal
          server={serverForModal}
          me={user}
          refreshKey={eventsRefresh}
          onClose={() => setModal(null)}
          onChanged={() => setEventsRefresh((value) => value + 1)}
        />
      )}
      {modal?.type === 'iconSuggestions' && serverForModal && (
        <ServerIconSuggestionsModal
          server={serverForModal}
          me={user}
          socket={socket}
          onUpdated={updateServer}
          onClose={() => setModal(null)}
        />
      )}

      {welcomeVisible && (
        <WelcomeScreen welcome={welcome} server={activeServer} onDismiss={dismissWelcome} />
      )}

      {whatsNewOpen && (
        <WhatsNewModal
          version={LATEST_RELEASE.version}
          onClose={() => closeWhatsNew(false)}
          onSeeAll={() => closeWhatsNew(true)}
        />
      )}

      {supportPromptOpen && (
        <SupportPrompt
          onClose={() => setSupportPromptOpen(false)}
          onNever={() => {
            dismissSupportPromptForever();
            setSupportPromptOpen(false);
          }}
        />
      )}

      {botModals.length > 0 && (
        <BotModal
          interaction={botModals[0]}
          onClose={() =>
            setBotModals((previous) => previous.filter((entry) => entry !== botModals[0]))
          }
        />
      )}
      {savedOpen && (
        <SavedModal onClose={() => setSavedOpen(false)} onOpenSavedMessage={openMention} />
      )}
      {editTarget && (
        <EditHistoryModal message={editTarget} onClose={() => setEditTarget(null)} />
      )}
      {remindTarget && (
        <RemindModal
          message={remindTarget}
          onClose={() => setRemindTarget(null)}
          onScheduled={() =>
            showToast({
              title: 'Reminder set',
              message: 'Cordia will bring this message back when you asked.'
            })
          }
        />
      )}

      {reportTarget && (
        <ReportMessageModal
          message={reportTarget.message}
          plaintext={reportTarget.plaintext}
          onClose={() => setReportTarget(null)}
          onSubmit={submitReport}
        />
      )}

      {profileId && (
        <ProfileModal
          userId={profileId}
          serverId={activeServer?.id || null}
          refreshKey={badgesVersion}
          me={user}
          presence={presence}
          onClose={() => setProfileId(null)}
          onOpenSettings={() => openSettings('profile')}
          onMessageUser={messageUser}
          onAddFriend={addFriend}
          onAcceptFriendByUser={acceptFriendByUser}
          onRemoveFriend={removeFriend}
          onBlockUser={blockUser}
          onUnblockUser={unblockUser}
        />
      )}

      {e2eeModalOpen && (
        <E2eeUnlockModal
          user={user}
          onClose={() => setE2eeModalOpen(false)}
          onUnlocked={(nextUser) => {
            if (nextUser) setUser(nextUser);
            setE2eeModalOpen(false);
          }}
        />
      )}

      {recoverySetup && (
        <RecoveryCodeModal
          code={recoverySetup.code}
          title="Save your recovery code"
          subtitle="This is the only time this code will be shown."
          confirmLabel="I saved my code"
          onConfirm={confirmRecoverySetup}
          onClose={() => {}}
          busy={recoveryBusy}
          error={recoveryError}
        />
      )}

      {safetyDm && (
        <E2eeSafetyModal
          me={user}
          peer={safetyDm.user}
          onClose={() => setSafetyDm(null)}
          onVerified={() => {
            setE2eePinVersion((value) => value + 1);
            setSafetyDm(null);
          }}
        />
      )}

      <Toast toast={toast} />
      <CallOverlay
        call={call.call}
        remoteStream={call.remoteStream}
        remoteVideo={call.remoteVideo}
        localScreen={call.localScreen}
        sharing={call.sharing}
        security={call.security}
        securityNote={call.securityNote}
        muted={call.muted}
        notice={call.notice}
        onAccept={call.accept}
        onDecline={call.decline}
        onEnd={call.end}
        onToggleMute={call.toggleMute}
        onToggleScreen={call.toggleScreen}
      />
    </div>
  );
}
