import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  AlertTriangle,
  ArrowDown,
  Bell,
  Check,
  MessagesSquare,
  BellOff,
  Hash,
  LockKeyhole,
  Phone,
  Pin,
  PinOff,
  Search,
  ShieldCheck,
  Sparkles,
  UserPlus,
  Users,
  Volume2,
  X
} from 'lucide-react';
import Avatar from './Avatar';
import MessageItem from './MessageItem';
import MessageInput from './MessageInput';
import api from '../api';
import { checkE2eePin } from '../e2ee';
import { formatDay, formatTime, groupMessages, presenceLabel } from '../utils';
import { hasServerPermission } from '../permissions';

export default function ChatView({
  mode,
  scopeKey,
  server,
  emotes: emoteProp,
  channel,
  dm,
  me,
  presence,
  messages,
  loading,
  typingUsers,
  highlightId,
  catchup,
  unreadMarkerId,
  onBackToList,
  onJumpToUnread,
  onReachBottom,
  showMembers,
  canModerate,
  canPinMessages = false,
  canSend = true,
  canAttach = true,
  canReact = true,
  muted,
  e2ee,
  onUnlockE2ee,
  onVerifyE2ee,
  e2eePinVersion = 0,
  onToggleMute,
  onToggleMembers,
  onInvite,
  onOpenServerSettings,
  onSearch,
  onSend,
  onEdit,
  onDelete,
  onReact,
  onTogglePin,
  pinsVersion = 0,
  onReport,
  onComponent,
  onMarkUnread,
  onSaveMessage,
  onRemindMessage,
  onShowEdits,
  onBlockUser,
  onTyping,
  onOpenProfile,
  onStartCall,
  onCreatePoll,
  onVotePoll,
  onClosePoll,
  onCreateThread,
  onOpenThread,
  canStartThreads = true,
  forwardDestinations = null
}) {
  const isThread = channel?.type === 'thread';
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  // A brand-new server opens on an empty channel, which is the only moment the
  // owner needs a checklist. Everything here is derived from data the shell
  // already has, so no extra request runs to decide whether to show it.
  // The checklist is for whoever can act on it, not only the creator: an admin
  // holding manageServer can invite and edit just as well.
  const canManage =
    mode === 'channel' &&
    !!server &&
    !!me &&
    (Number(server.ownerId) === Number(me.id) || hasServerPermission(server, me, 'manageServer'));
  const invited = (server?.members?.length || 0) > 1;
  const hasIcon = !!server?.iconUrl;
  const hasWelcome = !!server?.welcomeEnabled;
  // A checklist is for a server that is still being set up. Months-old quiet
  // servers keep an empty channel forever, and the card read as a bug there.
  const createdAt = Number(server?.createdAt) || 0;
  const isNewServer = !createdAt || Date.now() - createdAt < 14 * 24 * 60 * 60 * 1000;
  const showOnboarding =
    canManage &&
    isNewServer &&
    !isThread &&
    !onboardingDismissed &&
    !(invited && hasIcon && hasWelcome);
  // Join and leave lines do not count as conversation: a channel holding only
  // those still reads as empty, so the checklist stays up for the owner.
  const onlySystemLines = messages.length > 0 && messages.every((entry) => entry.systemType);

  // A member who joined in the last day and has not closed the greeting yet gets
  // one. Deriving it from joinedAt instead of a click keeps it alive across a
  // reload, which is exactly when someone comes back to an empty channel.
  const [greetingDismissed, setGreetingDismissed] = useState(false);
  const joinedAt = Number(server?.members?.find((m) => Number(m.id) === Number(me?.id))?.joinedAt) || 0;
  const recentlyJoined = joinedAt > 0 && Date.now() - joinedAt < 24 * 60 * 60 * 1000;
  const showGreeting =
    mode === 'channel' && !!server && recentlyJoined && !greetingDismissed && !showOnboarding;

  useEffect(() => {
    if (!server) return undefined;
    const key = `cordia:onboarding:${server.id}`;
    const cached = localStorage.getItem(key) === '1';
    setOnboardingDismissed(cached);
    if (cached) return undefined;
    // The cache is only the fast path. The account is the source of truth, so a
    // second device does not show a card that was already dismissed.
    let cancelled = false;
    api
      .get(`/api/servers/${server.id}/onboarding`)
      .then((data) => {
        if (cancelled || !data.dismissed) return;
        localStorage.setItem(key, '1');
        setOnboardingDismissed(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [server?.id]);

  function dismissOnboarding() {
    if (!server) return;
    localStorage.setItem(`cordia:onboarding:${server.id}`, '1');
    setOnboardingDismissed(true);
    api.post(`/api/servers/${server.id}/onboarding/dismiss`).catch(() => {});
  }

  useEffect(() => {
    if (!server) return;
    setGreetingDismissed(localStorage.getItem(`cordia:greeted:${server.id}`) === '1');
  }, [server?.id]);

  function dismissGreeting() {
    if (server) localStorage.setItem(`cordia:greeted:${server.id}`, '1');
    setGreetingDismissed(true);
  }

  // The composer is owned by MessageInput, which has no exposed ref, so the
  // greeting reaches it the same way the rest of the app reaches DOM nodes.
  function sayHi() {
    dismissGreeting();
    document.querySelector('.composer textarea')?.focus();
  }
  const emotes = useMemo(
    () => emoteProp || server?.emotes || [],
    [emoteProp, server?.emotes]
  );
  const scrollRef = useRef(null);
  const stickRef = useRef(true);
  const lastMessageRef = useRef({ id: null, createdAt: 0 });
  const [replyTo, setReplyTo] = useState(null);
  const [atBottom, setAtBottom] = useState(true);
  const [newBelow, setNewBelow] = useState(0);
  const [firstUnreadId, setFirstUnreadId] = useState(null);
  const [catchupDismissed, setCatchupDismissed] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [pinnedMessages, setPinnedMessages] = useState([]);
  const [pinsLoading, setPinsLoading] = useState(false);
  const [pinsError, setPinsError] = useState('');
  const catchupAnchorRef = useRef(null);
  const unreadMarkerRef = useRef(null);
  const dividerRef = useRef(null);
  const userScrolledRef = useRef(false);
  // In a direct message there are no roles to consult: pinning your own
  // conversation is just another thing you can do in it.
  const canPin = mode === 'dm' ? canSend : canPinMessages;

  // Who can be @-mentioned here. In a channel that is everyone in the server;
  // in a direct message it is the other person, because mentioning yourself
  // does nothing.
  const mentionables = useMemo(() => {
    if (mode === 'dm') {
      return dm?.user
        ? [{ id: dm.user.id, username: dm.user.username, displayName: dm.user.displayName }]
        : [];
    }
    return (server?.members || []).map((member) => ({
      id: member.id,
      username: member.username,
      displayName: member.displayName
    }));
  }, [mode, dm?.user, server]);

  function scrollToPresent(behavior = 'smooth') {
    stickRef.current = true;
    setAtBottom(true);
    setNewBelow(0);
    setFirstUnreadId(null);
    requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (element) element.scrollTo({ top: element.scrollHeight, behavior });
    });
  }

  async function sendMessage(content, attachment) {
    await onSend(content, attachment, replyTo?.id);
    setReplyTo(null);
    scrollToPresent('auto');
  }

  useEffect(() => {
    setReplyTo(null);
    setAtBottom(true);
    setNewBelow(0);
    setCatchupDismissed(false);
    dividerRef.current = null;
    setFirstUnreadId(null);
    lastMessageRef.current = { id: null, createdAt: 0 };
    stickRef.current = true;
    userScrolledRef.current = false;
    catchupAnchorRef.current = null;
    requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
  }, [scopeKey]);

  useEffect(() => {
    setPinsOpen(false);
  }, [scopeKey]);

  useEffect(() => {
    if (!scopeKey) return undefined;
    const endpoint =
      mode === 'dm'
        ? dm && `/api/dms/${dm.id}/pins`
        : channel && `/api/channels/${channel.id}/pins`;
    if (!endpoint) {
      setPinnedMessages([]);
      setPinsError('');
      return undefined;
    }
    let cancelled = false;
    setPinsLoading(true);
    setPinsError('');
    api
      .get(endpoint)
      .then((payload) => {
        if (!cancelled) setPinnedMessages(payload.messages || []);
      })
      .catch((error) => {
        if (!cancelled) {
          setPinnedMessages([]);
          setPinsError(error.message || 'Could not load pinned messages.');
        }
      })
      .finally(() => {
        if (!cancelled) setPinsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scopeKey, mode, channel?.id, dm?.id, pinsVersion]);

  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last) {
      lastMessageRef.current = { id: null, createdAt: 0 };
      return;
    }
    const previous = lastMessageRef.current;
    if (
      last.id !== previous.id &&
      last.createdAt > previous.createdAt &&
      !stickRef.current
    ) {
      let count = 1;
      if (previous.id) {
        const previousIndex = messages.findIndex((message) => message.id === previous.id);
        if (previousIndex >= 0) count = messages.length - previousIndex - 1;
      }
      const incoming = messages.slice(-count).filter((message) => message.author.id !== me.id);
      if (incoming.length) {
        setNewBelow((value) => value + incoming.length);
        setFirstUnreadId((value) => value ?? incoming[0].id);
      }
    }
    lastMessageRef.current = { id: last.id, createdAt: last.createdAt };
    if (stickRef.current) {
      setNewBelow(0);
      setFirstUnreadId(dividerRef.current || null);
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      });
    }
  }, [messages, me.id]);

  useEffect(() => {
    if (!highlightId) return;
    const element = document.getElementById(`msg-${highlightId}`);
    if (!element) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.classList.add('flash');
    const timer = setTimeout(() => element.classList.remove('flash'), 2200);
    return () => clearTimeout(timer);
  }, [highlightId, messages.length]);

  function handleScroll() {
    const element = scrollRef.current;
    if (!element) return;
    const nearBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight < 140;
    stickRef.current = nearBottom;
    setAtBottom(nearBottom);
    if (nearBottom) {
      setNewBelow(0);
      if (userScrolledRef.current) {
        dividerRef.current = null;
        setFirstUnreadId(null);
        onReachBottom?.();
      }
    }
  }

  const groupedMessages = groupMessages(messages);
  const typingText =
    typingUsers.length === 1
      ? `${typingUsers[0].displayName} is typing`
      : typingUsers.length > 1
        ? `${typingUsers.slice(0, 2).map((user) => user.displayName).join(', ')} are typing`
        : '';
  const draftKey = scopeKey ? `${me.id}:${scopeKey}` : null;
  const title = mode === 'dm' ? dm?.user.displayName : channel?.name;
  const e2eeReady = mode === 'dm' && !!me.e2eeReady && !!dm?.user.e2eeReady;
  const e2eeUnlocked = e2ee?.status === 'ready';
  const e2eeLocked = e2eeReady && !e2eeUnlocked;
  const e2eePinStatus = useMemo(() => {
    if (mode !== 'dm' || !dm?.user?.e2eePublicKey) return null;
    return checkE2eePin(
      me.id,
      dm.user.id,
      dm.user.e2eePublicKey,
      dm.user.e2eeKeyVersion
    );
  }, [
    mode,
    me.id,
    dm?.user?.id,
    dm?.user?.e2eePublicKey,
    dm?.user?.e2eeKeyVersion,
    e2eePinVersion
  ]);
  const e2eeKeyChanged = e2eePinStatus?.status === 'changed';
  const catchupSummary = useMemo(() => {
    if (!catchup?.count) return '';
    const people = catchup.participants || [];
    const names = people.slice(0, 3).map((person) => person.displayName);
    const parts = [];
    if (names.length) {
      parts.push(people.length > 3 ? `${names.join(', ')} and others` : names.join(', '));
    }
    if (catchup.mentions > 0) {
      parts.push(`${catchup.mentions} ${catchup.mentions === 1 ? 'mention' : 'mentions'}`);
    }
    return parts.join(' · ');
  }, [catchup]);

  useEffect(() => {
    // Clearing the marker lets the same scope re-anchor its divider on the next
    // visit, instead of being treated as already handled.
    if (!unreadMarkerId) {
      unreadMarkerRef.current = null;
      return;
    }
    if (unreadMarkerRef.current === `${scopeKey}:${unreadMarkerId}`) return;
    unreadMarkerRef.current = `${scopeKey}:${unreadMarkerId}`;
    dividerRef.current = unreadMarkerId;
    setFirstUnreadId(unreadMarkerId);
  }, [unreadMarkerId, scopeKey]);

  useEffect(() => {
    if (!catchup?.firstUnreadId) return;
    dividerRef.current = catchup.firstUnreadId;
    setFirstUnreadId(catchup.firstUnreadId);
    if (catchupAnchorRef.current === `${scopeKey}:${catchup.firstUnreadId}`) return;
    catchupAnchorRef.current = `${scopeKey}:${catchup.firstUnreadId}`;
    stickRef.current = false;
    setAtBottom(false);
    requestAnimationFrame(() => {
      const element = document.getElementById(`msg-${catchup.firstUnreadId}`);
      if (element) element.scrollIntoView({ block: 'center' });
    });
  }, [catchup?.firstUnreadId, scopeKey]);
  const subtitle =
    mode === 'dm'
      ? `${presenceLabel(dm?.user, presence)}${e2eeReady ? ' | End-to-end encrypted' : ''}`
      : isThread
        ? `Thread in #${channel.parentName || 'channel'} · ${server?.name || ''}`
        : server
          ? `${server.name} | ${server.members.length} members`
          : '';

  return (
    <section className="chat-view">
      <header className="chat-header">
        <button className="icon-btn chat-back" onClick={onBackToList} title="Back to channels" aria-label="Back to channels">
          <ArrowLeft size={18} />
        </button>
        <button
          className="chat-title"
          onClick={() => mode === 'dm' && dm && onOpenProfile(dm.user.id)}
        >
          <span className="chat-title-icon">
            {mode === 'dm' ? (
              dm && <Avatar user={dm.user} size={26} presence={presence} showPresence />
            ) : channel?.type === 'voice' ? (
              <Volume2 size={20} />
            ) : isThread ? (
              <MessagesSquare size={19} />
            ) : (
              <Hash size={20} />
            )}
          </span>
          <span className="chat-title-text">
            <strong>{title}</strong>
            <small>{subtitle}</small>
          </span>
        </button>

        <div className="chat-header-actions">
          {mode === 'dm' && e2eeReady && !e2eeUnlocked && (
            <button
              className="icon-btn active-soft"
              onClick={onUnlockE2ee}
              title="Unlock encrypted messages"
            >
              <LockKeyhole size={17} />
            </button>
          )}
          {mode === 'dm' && !me.e2eeReady && (
            <button
              className="icon-btn"
              onClick={onUnlockE2ee}
              title="Set up encrypted messages"
            >
              <ShieldCheck size={17} />
            </button>
          )}
          {mode === 'dm' && e2eeReady && onVerifyE2ee && (
            <button
              className={`icon-btn ${e2eePinStatus?.status === 'verified' ? 'active-soft' : ''}`}
              onClick={onVerifyE2ee}
              title={
                e2eePinStatus?.status === 'verified'
                  ? 'Encryption verified'
                  : 'Verify encryption'
              }
            >
              <ShieldCheck size={17} />
            </button>
          )}
          <button
            className={`icon-btn chat-pin-button ${pinsOpen ? 'active-soft' : ''}`}
            onClick={() => setPinsOpen((value) => !value)}
            title="Pinned messages"
            aria-label="Pinned messages"
            aria-expanded={pinsOpen}
          >
            <Pin size={17} />
            {pinnedMessages.length > 0 && (
              <span className="chat-pin-count">{pinnedMessages.length}</span>
            )}
          </button>
          <button
            className={`icon-btn ${muted ? 'active-soft' : ''}`}
            onClick={onToggleMute}
            title={muted ? 'Unmute notifications' : 'Mute notifications'}
          >
            {muted ? <BellOff size={17} /> : <Bell size={17} />}
          </button>
          {mode === 'channel' && (
            <>
              <button className="icon-btn" onClick={onSearch} title="Search messages">
                <Search size={18} />
              </button>
              <button className="icon-btn" onClick={onInvite} title="Invite people">
                <UserPlus size={18} />
              </button>
              <button
                className={`icon-btn ${showMembers ? 'active-soft' : ''}`}
                onClick={onToggleMembers}
                title="Toggle member list"
              >
                <Users size={18} />
              </button>
            </>
          )}
          {mode === 'dm' && dm && (
            <>
              <button className="icon-btn" onClick={onSearch} title="Search conversation">
                <Search size={17} />
              </button>
              <button
                className="icon-btn"
                onClick={() => onStartCall?.(dm.user)}
                title={`Call ${dm.user.displayName}`}
              >
                <Phone size={17} />
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => onOpenProfile(dm.user.id)}
              >
                Profile
              </button>
            </>
          )}
        </div>
      </header>

      {pinsOpen && (
        <aside className="pinned-panel" aria-label="Pinned messages">
          <div className="pinned-panel-head">
            <div className="pinned-panel-title">
              <Pin size={16} />
              <strong>Pinned messages</strong>
              <span>{pinnedMessages.length}</span>
            </div>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setPinsOpen(false)}
              title="Close pinned messages"
            >
              <X size={16} />
            </button>
          </div>
          <div className="pinned-panel-body">
            {pinsLoading ? (
              <div className="pinned-panel-state">Loading pinned messages...</div>
            ) : pinsError ? (
              <div className="pinned-panel-state">{pinsError}</div>
            ) : pinnedMessages.length === 0 ? (
              <div className="pinned-panel-empty">
                <Pin size={22} />
                <strong>Nothing pinned yet</strong>
                <span>
                  {canPin ? (
                    <>
                      Hover a message and press the pin button, or right-click it
                      and choose <em>Pin message</em>. Pinned messages stay here
                      for everyone in the channel.
                    </>
                  ) : (
                    <>
                      Pinned messages collect here. You need the{' '}
                      <em>Pin messages</em> permission to add one.
                    </>
                  )}
                </span>
              </div>
            ) : (
              pinnedMessages.map((message) => (
                <div className="pinned-item" key={message.id}>
                  <button
                    type="button"
                    className="pinned-item-jump"
                    onClick={() => {
                      setPinsOpen(false);
                      onJumpToUnread?.(message.id);
                    }}
                  >
                    <span className="pinned-item-meta">
                      <strong>{message.author?.displayName || 'Unknown'}</strong>
                      <span>{formatTime(message.createdAt)}</span>
                    </span>
                    <span className="pinned-item-content">
                      {message.encrypted
                        ? 'Encrypted message'
                        : message.content?.trim() ||
                          (message.attachment ? 'Attachment' : 'Message')}
                    </span>
                  </button>
                  {canPin && onTogglePin && (
                    <button
                      type="button"
                      className="pinned-item-unpin"
                      onClick={() => onTogglePin(message)}
                      title="Unpin message"
                      aria-label="Unpin message"
                    >
                      <PinOff size={13} />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </aside>
      )}

      {catchup?.count > 0 && !catchupDismissed && (
        <div className="catchup-banner">
          <span className="catchup-icon">
            <Sparkles size={15} />
          </span>
          <div className="catchup-copy">
            <strong>
              {catchup.count} new {catchup.count === 1 ? 'message' : 'messages'} while you were away
            </strong>
            {catchupSummary && <span>{catchupSummary}</span>}
          </div>
          <div className="catchup-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setCatchupDismissed(true);
                onJumpToUnread?.(catchup.firstUnreadId);
              }}
            >
              Read from here
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setCatchupDismissed(true)}
              title="Dismiss"
            >
              <X size={15} />
            </button>
          </div>
        </div>
      )}

      {e2eeKeyChanged && (
        <div className="e2ee-key-warning">
          <AlertTriangle size={18} />
          <div>
            <strong>Encryption key changed</strong>
            <span>
              {dm.user.displayName} has a new key. Verify the safety number before sending
              anything sensitive.
            </span>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onVerifyE2ee}>
            Verify
          </button>
        </div>
      )}

      <div className="messages-wrap">
        <div
          className="messages"
          ref={scrollRef}
          onScroll={handleScroll}
          onWheel={() => { userScrolledRef.current = true; }}
          onPointerDown={() => { userScrolledRef.current = true; }}
          onKeyDown={() => { userScrolledRef.current = true; }}
        >
          {loading ? (
            <div className="message-skeletons">
              {[0, 1, 2, 3].map((index) => (
                <div className="message-skeleton" key={index}>
                  <span className="skeleton avatar-skeleton" />
                  <div>
                    <span className="skeleton line short" />
                    <span className="skeleton line long" />
                  </div>
                </div>
              ))}
            </div>
          ) : messages.length === 0 || ((showOnboarding || showGreeting) && onlySystemLines) ? (
            showOnboarding ? (
              <div className="messages-empty">
                <div className="onboarding-card">
                  <div className="onboarding-head">
                    <span className="onboarding-spark">
                      <Sparkles size={17} />
                    </span>
                    <div>
                      <h3>Get {server.name} ready</h3>
                      <p>Three quick steps and the place feels alive.</p>
                    </div>
                  </div>
                  <ul className="onboarding-steps">
                    <li className={invited ? 'done' : ''}>
                      <span className="onboarding-check">
                        {invited ? <Check size={13} /> : '1'}
                      </span>
                      <div>
                        <strong>Invite your first members</strong>
                        <span>It takes two people to make a conversation.</span>
                      </div>
                      {!invited && (
                        <button className="btn btn-primary btn-sm" onClick={onInvite}>
                          Invite
                        </button>
                      )}
                    </li>
                    <li className={hasIcon ? 'done' : ''}>
                      <span className="onboarding-check">
                        {hasIcon ? <Check size={13} /> : '2'}
                      </span>
                      <div>
                        <strong>Give it a face</strong>
                        <span>An icon makes the server easy to spot.</span>
                      </div>
                      {!hasIcon && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => onOpenServerSettings?.('identity')}
                        >
                          Pick icon
                        </button>
                      )}
                    </li>
                    <li className={hasWelcome ? 'done' : ''}>
                      <span className="onboarding-check">
                        {hasWelcome ? <Check size={13} /> : '3'}
                      </span>
                      <div>
                        <strong>Write a welcome message</strong>
                        <span>New members read it the first time they open the server.</span>
                      </div>
                      {!hasWelcome && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => onOpenServerSettings?.('welcome')}
                        >
                          Write it
                        </button>
                      )}
                    </li>
                  </ul>
                  <button className="onboarding-dismiss" onClick={dismissOnboarding}>
                    Dismiss
                  </button>
                </div>
              </div>
            ) : showGreeting ? (
              <div className="messages-empty">
                <div className="joined-card">
                  <div className="joined-head">
                    <span className="joined-spark">
                      <Sparkles size={17} />
                    </span>
                    <div>
                      <h3>You&apos;re in {server?.name}</h3>
                      <p>
                        This is where the conversation starts. Say hi in #{channel?.name} and
                        you&apos;re part of it.
                      </p>
                    </div>
                  </div>
                  <div className="joined-actions">
                    <button className="btn btn-primary btn-sm" onClick={sayHi}>
                      Say hi
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={dismissGreeting}>
                      Maybe later
                    </button>
                  </div>
                </div>
              </div>
            ) : (
            <div className="messages-empty">
              <div className="messages-empty-icon">
                {mode === 'dm' ? (
                  <Sparkles size={30} />
                ) : isThread ? (
                  <MessagesSquare size={30} />
                ) : (
                  <Hash size={30} />
                )}
              </div>
              <h3>
                {mode === 'dm'
                  ? `This is the start of something with ${dm?.user.displayName}`
                  : isThread
                    ? channel?.name
                    : `Welcome to #${channel?.name}`}
              </h3>
              <p>
                {mode === 'dm'
                  ? 'Send the first message. The universe is listening.'
                  : isThread
                    ? `This is the start of the thread. Only people who join it or reply here can see it.`
                    : 'This is the very beginning of the channel. Say hi, share an idea, or drop a meme.'}
              </p>
            </div>
            )
          ) : (
            groupedMessages.map((message, index) => {
              const previous = messages[index - 1];
              const newDay = !previous || formatDay(message.createdAt) !== formatDay(previous.createdAt);
              return (
                <div key={message.id}>
                  {newDay && (
                    <div className="day-divider">
                      <span>{formatDay(message.createdAt)}</span>
                    </div>
                  )}
                  {message.id === firstUnreadId && (
                    <div className="new-divider">
                      <span>New messages</span>
                    </div>
                  )}
                  <MessageItem
                    message={message}
                    me={me}
                    forwardDestinations={forwardDestinations}
                    presence={presence}
                    canModerate={canModerate}
                    canSend={canSend}
                    canReact={canReact}
                    emotes={emotes}
                    e2eePeerPublicKey={mode === 'dm' ? dm?.user.e2eePublicKey || '' : ''}
                    e2eePeerId={mode === 'dm' ? dm?.user.id : null}
                    onUnlockE2ee={onUnlockE2ee}
                    highlight={highlightId === message.id}
                    onOpenProfile={onOpenProfile}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onReact={onReact}
                    canPin={canPin}
                    onTogglePin={onTogglePin}
                    onReport={onReport}
                    onComponent={onComponent}
                    onMarkUnread={onMarkUnread}
                    onSave={onSaveMessage}
                    onRemind={onRemindMessage}
                    onShowEdits={onShowEdits}
                    onBlockUser={onBlockUser}
                    onReply={setReplyTo}
                    onVotePoll={onVotePoll}
                    onClosePoll={onClosePoll}
                    canThread={
                      mode === 'channel' && channel?.type === 'text' && canStartThreads
                    }
                    onCreateThread={onCreateThread}
                    onOpenThread={onOpenThread}
                  />
                </div>
              );
            })
          )}
        </div>
        {!atBottom && (
          <button
            type="button"
            className="jump-present"
            onClick={() => scrollToPresent()}
            title="Jump to present"
          >
            <ArrowDown size={15} />
            {newBelow > 0
              ? `${newBelow} new message${newBelow === 1 ? '' : 's'}`
              : 'Jump to present'}
          </button>
        )}
      </div>

      <div className={`typing-line ${typingText ? 'visible' : ''}`}>
        {typingText && (
          <>
            <span className="typing-dots">
              <i />
              <i />
              <i />
            </span>
            {typingText}...
          </>
        )}
      </div>

      {canSend ? (
        e2eeLocked ? (
          <div className="composer-readonly e2ee-composer-locked">
            <LockKeyhole size={16} />
            <span>Encrypted messages are locked on this device.</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onUnlockE2ee}>
              Unlock
            </button>
          </div>
        ) : (
          <MessageInput
            key={draftKey}
            draftKey={draftKey}
            placeholder={
              mode === 'dm'
                ? `Message @${dm?.user.username}`
                : `Message #${channel?.name ?? 'channel'}`
            }
            onSend={sendMessage}
            onTyping={onTyping}
            replyTo={replyTo}
            onCancelReply={() => setReplyTo(null)}
            disabled={
              mode === 'dm' ? !dm : !channel || (channel.type !== 'text' && channel.type !== 'thread')
            }
            canAttach={canAttach}
            canPoll={mode === 'channel' && canSend && channel?.type === 'text'}
            onCreatePoll={onCreatePoll}
            scheduleChannelId={
              mode === 'channel' && canSend && (channel?.type === 'text' || channel?.type === 'thread')
                ? channel.id
                : null
            }
            emotes={emotes}
            mentionables={mentionables}
          />
        )
      ) : (
        <div className="composer-readonly">
          You do not have permission to send messages here.
        </div>
      )}
    </section>
  );
}

