import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bookmark,
  Bell,
  Check,
  Download,
  FileText,
  Flag,
  Forward,
  Loader2,
  LockKeyhole,
  Mail,
  MessagesSquare,
  Pause,
  Pencil,
  PhoneCall,
  Pin,
  PinOff,
  Play,
  Reply,
  ShieldAlert,
  SmilePlus,
  Trash2,
  UserMinus,
  UserPlus,
  X
} from 'lucide-react';
import ImageViewer from './ImageViewer';
import Avatar from './Avatar';
import Markdown from './Markdown';
import PollCard from './PollCard';
import { REACTIONS, fileKind, formatTime } from '../utils';
import EmojiPicker from './EmojiPicker';
import Emoji from './Emoji';
import { assetUrl } from '../runtime';

// One icon per system line; anything unlisted (call summaries) keeps the handset.
const SYSTEM_ICONS = {
  thread: MessagesSquare,
  join: UserPlus,
  leave: UserMinus
};
import { cachedDecryptedMessage, decryptAttachment, decryptDmMessage, useE2ee } from '../e2ee';
import { messageFlair, triggerReactionEasterEgg } from '../easterEggs';
import ForwardModal from './ForwardModal';

// One clip at a time: starting another pauses whatever was playing.
let activeVoice = null;

function notify(detail) {
  window.dispatchEvent(new CustomEvent('cordia:toast', { detail }));
}

function clock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function VoicePlayer({ attachment, durationMs }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [total, setTotal] = useState(durationMs > 0 ? durationMs / 1000 : 0);

  useEffect(
    () => () => {
      const element = audioRef.current;
      if (!element) return;
      element.pause();
      if (activeVoice === element) activeVoice = null;
    },
    []
  );

  function toggle() {
    const element = audioRef.current;
    if (!element) return;
    if (element.paused) {
      if (activeVoice && activeVoice !== element) {
        activeVoice.pause();
        activeVoice.currentTime = 0;
      }
      activeVoice = element;
      element.play().catch(() => setPlaying(false));
    } else {
      element.pause();
    }
  }

  return (
    <div className={`voice-player ${playing ? 'playing' : ''}`}>
      <audio
        ref={audioRef}
        src={assetUrl(attachment.url)}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration;
          if (Number.isFinite(value) && value > 0) setTotal(value);
        }}
        onEnded={(event) => {
          setPlaying(false);
          setTime(0);
          event.currentTarget.currentTime = 0;
          if (activeVoice === event.currentTarget) activeVoice = null;
        }}
      />
      <button
        type="button"
        className="voice-play"
        onClick={toggle}
        title={playing ? 'Pause voice message' : 'Play voice message'}
        aria-label={playing ? 'Pause voice message' : 'Play voice message'}
      >
        {playing ? <Pause size={15} /> : <Play size={15} />}
      </button>
      <div className="voice-track">
        <input
          className="voice-progress"
          type="range"
          min="0"
          max={total || 0}
          step="0.1"
          value={Math.min(time, total || 0)}
          onChange={(event) => {
            const element = audioRef.current;
            if (!element) return;
            const value = Number(event.target.value);
            element.currentTime = value;
            setTime(value);
          }}
          aria-label="Voice message progress"
        />
        <span className="voice-time">
          {clock(time * 1000)} / {clock(total * 1000)}
        </span>
      </div>
    </div>
  );
}

function Attachment({ attachment, voiceDurationMs = 0 }) {
  const [viewing, setViewing] = useState(false);
  if (!attachment) return null;
  const kind = fileKind(attachment.type);
  if (kind === 'image') {
    const src = assetUrl(attachment.url);
    return (
      <>
        <button
          type="button"
          className="attachment-image-link"
          onClick={() => setViewing(true)}
          title="Open image"
        >
          <img className="attachment-image" src={src} alt={attachment.name} loading="lazy" />
        </button>
        {viewing && (
          <ImageViewer src={src} name={attachment.name} onClose={() => setViewing(false)} />
        )}
      </>
    );
  }
  if (kind === 'video') {
    return <video className="attachment-video" src={assetUrl(attachment.url)} controls preload="metadata" />;
  }
  if (kind === 'audio') {
    if (voiceDurationMs > 0) {
      return <VoicePlayer attachment={attachment} durationMs={voiceDurationMs} />;
    }
    return <audio className="attachment-audio" src={assetUrl(attachment.url)} controls preload="metadata" />;
  }
  return (
    <a className="attachment-file" href={assetUrl(attachment.url)} download={attachment.name}>
      <span className="attachment-file-icon">
        <FileText size={20} />
      </span>
      <span className="attachment-file-meta">
        <strong>{attachment.name}</strong>
        <span>Click to download</span>
      </span>
      <Download size={16} className="attachment-download" />
    </a>
  );
}

function EncryptedAttachment({ attachment, meta }) {
  const [state, setState] = useState({ status: 'loading', url: '', type: '', error: '' });
  const [viewing, setViewing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl = '';
    decryptAttachment(attachment.url, meta)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({
          status: 'ready',
          url: objectUrl,
          type: blob.type || meta.type,
          error: ''
        });
      })
      .catch((error) => {
        if (!cancelled) setState({ status: 'error', url: '', type: '', error: error.message });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.url, meta]);

  if (state.status === 'loading') {
    return (
      <div className="attachment-file encrypted-attachment-loading">
        <span className="attachment-file-icon">
          <Loader2 size={20} className="spin" />
        </span>
        <span className="attachment-file-meta">
          <strong>{meta.name || 'Encrypted attachment'}</strong>
          <span>Decrypting…</span>
        </span>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="attachment-file attachment-file-error">
        <span className="attachment-file-icon">
          <LockKeyhole size={20} />
        </span>
        <span className="attachment-file-meta">
          <strong>{meta.name || 'Encrypted attachment'}</strong>
          <span>{state.error}</span>
        </span>
      </div>
    );
  }

  const kind = fileKind(state.type);
  if (kind === 'image') {
    return (
      <>
        <button
          type="button"
          className="attachment-image-link"
          onClick={() => setViewing(true)}
          title="Open image"
        >
          <img className="attachment-image" src={state.url} alt={meta.name} />
        </button>
        {viewing && (
          <ImageViewer src={state.url} name={meta.name} onClose={() => setViewing(false)} />
        )}
      </>
    );
  }
  if (kind === 'video') {
    return <video className="attachment-video" src={state.url} controls preload="metadata" />;
  }
  if (kind === 'audio') {
    // A voice note's duration travels inside the encrypted envelope, so the
    // player renders in a DM exactly as it does in a channel.
    const durationMs = Number(meta.durationMs) || 0;
    if (durationMs > 0) {
      return <VoicePlayer attachment={{ ...meta, url: state.url }} durationMs={durationMs} />;
    }
    return <audio className="attachment-audio" src={state.url} controls preload="metadata" />;
  }
  return (
    <a className="attachment-file" href={state.url} download={meta.name}>
      <span className="attachment-file-icon">
        <FileText size={20} />
      </span>
      <span className="attachment-file-meta">
        <strong>{meta.name}</strong>
        <span>Click to download</span>
      </span>
      <Download size={16} className="attachment-download" />
    </a>
  );
}

function EncryptedContent({ message, peerPublicKey, peerId, onUnlockE2ee, onDecrypted }) {
  const e2ee = useE2ee();
  // Reopening a conversation remounts every message. The plaintext is cached by
  // ciphertext, so the first paint is already the message rather than a column
  // of "Decrypting…" placeholders.
  const [state, setState] = useState(() => {
    const cached = e2ee.status === 'ready' ? cachedDecryptedMessage(message.envelope, peerId) : null;
    return cached
      ? { status: 'ready', text: cached.text, attachment: cached.attachment, error: '' }
      : { status: 'idle', text: '', attachment: null, error: '' };
  });

  useEffect(() => {
    if (e2ee.status !== 'ready') {
      setState({ status: 'locked', text: '', attachment: null, error: '' });
      onDecrypted?.('');
      return undefined;
    }
    const cached = cachedDecryptedMessage(message.envelope, peerId);
    if (cached) {
      setState({ status: 'ready', text: cached.text, attachment: cached.attachment, error: '' });
      onDecrypted?.(cached.text || '');
      return undefined;
    }
    let cancelled = false;
    setState({ status: 'decrypting', text: '', attachment: null, error: '' });
    onDecrypted?.('');
    decryptDmMessage(message.envelope, { peerPublicKey, peerId })
      .then((payload) => {
        if (!cancelled) {
          setState({
            status: 'ready',
            text: payload.text,
            attachment: payload.attachment,
            error: ''
          });
          onDecrypted?.(payload.text || '');
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setState({ status: 'error', text: '', attachment: null, error: error.message });
          onDecrypted?.('');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [e2ee.status, e2ee.identity?.publicKey, message.envelope, peerPublicKey, peerId, onDecrypted]);

  if (state.status === 'locked') {
    return (
      <div className="message-encrypted-locked">
        <LockKeyhole size={16} />
        <div>
          <strong>Encrypted message</strong>
          <span>Unlock encrypted messages to read this.</span>
        </div>
        <button type="button" className="btn btn-ghost btn-xs" onClick={onUnlockE2ee}>
          Unlock
        </button>
      </div>
    );
  }

  if (state.status === 'decrypting') {
    return (
      <div className="message-encrypted-loading">
        <Loader2 size={14} className="spin" /> Decrypting…
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="message-encrypted-error">
        <LockKeyhole size={15} /> Could not decrypt this message. {state.error}
      </div>
    );
  }

  return (
    <>
      {state.text && (
        <div className="message-content">
          <Markdown text={state.text} meUsername="" />
        </div>
      )}
      {state.attachment && message.attachment && (
        <EncryptedAttachment attachment={message.attachment} meta={state.attachment} />
      )}
    </>
  );
}

// Plain-language reasons for the safety notice. The server sends categories,
// never a verdict, so the copy explains the pattern instead of accusing.
const SAFETY_COPY = {
  secrecy: 'They are asking you to keep this from people you trust.',
  off_platform: "They want to move the chat to another app, where Cordia can't help.",
  money: 'Gift cards and payments are a common scam pattern.',
  age_probe: 'They are asking about your age.',
  personal_info: 'They are asking for personal details.'
};

function safetyCopy(categories = []) {
  return categories.map((key) => SAFETY_COPY[key]).filter(Boolean).join(' ');
}

export default function MessageItem({
  message,
  me,
  presence,
  canModerate,
  canSend = true,
  canReact = true,
  emotes = null,
  e2eePeerPublicKey = '',
  e2eePeerId = null,
  onUnlockE2ee,
  highlight,
  onOpenProfile,
  onEdit,
  onDelete,
  onReact,
  onReply,
  canPin = false,
  onTogglePin,
  onReport,
  onComponent,
  onMarkUnread,
  onSave,
  onRemind,
  onShowEdits,
  onBlockUser,
  onVotePoll,
  onClosePoll,
  canThread = false,
  onCreateThread,
  onOpenThread,
  forwardDestinations = null
}) {
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [popoverDown, setPopoverDown] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const [forwardOpen, setForwardOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [saving, setSaving] = useState(false);
  const popoverRef = useRef(null);
  const contextMenuRef = useRef(null);
  const longPressRef = useRef(null);
  const decryptedRef = useRef('');
  const author = message.author;
  const mine = author.id === me.id;
  const emoteList = useMemo(() => {
    if (!emotes) return [];
    return Array.isArray(emotes) ? emotes : Object.values(emotes);
  }, [emotes]);
  const emoteMap = useMemo(() => {
    const map = {};
    for (const emote of emoteList) {
      if (emote?.name) map[String(emote.name).toLowerCase()] = emote;
    }
    return map;
  }, [emoteList]);
  const handleDecrypted = useCallback((text) => {
    decryptedRef.current = text || '';
  }, []);

  useEffect(() => {
    if (!emojiOpen) return undefined;
    function onDown(event) {
      if (popoverRef.current && !popoverRef.current.contains(event.target)) setEmojiOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [emojiOpen]);

  useEffect(() => {
    if (!emojiOpen) return undefined;
    function onKey(event) {
      if (event.key === 'Escape') setEmojiOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [emojiOpen]);

  useEffect(() => {
    if (!contextMenu) return undefined;
    function onDown(event) {
      if (contextMenuRef.current && !contextMenuRef.current.contains(event.target)) {
        setContextMenu(null);
      }
    }
    function onKey(event) {
      if (event.key === 'Escape') setContextMenu(null);
    }
    function onScroll() {
      setContextMenu(null);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [contextMenu]);

  function cancelLongPress() {
    if (longPressRef.current) {
      clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
  }

  // Touch devices have no right-click and the hover toolbar is hidden below the
  // mobile breakpoint, so a held finger opens the same menu.
  function beginLongPress(event) {
    if (editing || event.touches.length !== 1) return;
    const touch = event.touches[0];
    const target = event.target;
    cancelLongPress();
    longPressRef.current = setTimeout(() => {
      longPressRef.current = null;
      openContextMenu({
        clientX: touch.clientX,
        clientY: touch.clientY,
        target,
        preventDefault() {}
      });
    }, 450);
  }

  useEffect(() => () => cancelLongPress(), []);

  function openContextMenu(event) {
    if (editing) return;
    if (event.target.closest('textarea, input')) return;
    event.preventDefault();
    setEmojiOpen(false);
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - 210),
      y: Math.min(event.clientY, window.innerHeight - 190)
    });
  }

  function reportMessage() {
    setContextMenu(null);
    if (!onReport) return;
    onReport(message, message.encrypted ? decryptedRef.current : message.content);
  }

  async function saveEdit() {
    const content = draft.trim();
    if (!content || content === message.content) {
      setEditing(false);
      setDraft(message.content);
      return;
    }
    setSaving(true);
    try {
      await onEdit(message, content);
      setEditing(false);
    } catch (error) {
      // The edit stays open with the draft intact so the text is not lost, and
      // the failure is surfaced instead of becoming an unhandled rejection.
      notify({
        type: 'error',
        title: 'Could not save edit',
        message: error?.message || 'Try again in a moment.'
      });
    } finally {
      setSaving(false);
    }
  }

  function jumpToReply() {
    if (!message.replyTo) return;
    const element = document.getElementById(`msg-${message.replyTo.id}`);
    if (!element) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.classList.add('flash');
    setTimeout(() => element.classList.remove('flash'), 2300);
  }

  const flair = message.encrypted ? '' : messageFlair(message.content);

  if (message.systemType) {
    // Thread announcements read like Discord's: who started it, then the thread
    // name as a link - that link is how someone who is not a member gets in.
    const isThread = message.systemType === 'thread';
    const SystemIcon = SYSTEM_ICONS[message.systemType] || PhoneCall;
    const threadName = message.thread?.name || message.content;
    return (
      <div
        id={`msg-${message.id}`}
        className={`message system-message ${highlight ? 'highlight' : ''}`}
      >
        <div className="system-message-pill">
          <SystemIcon size={13} />
          {isThread ? (
            <>
              <span className="system-thread-lead">{author.displayName} started a thread</span>
              <button
                className="system-thread-link"
                onClick={() => onOpenThread?.(message.thread || message.threadId)}
                disabled={!onOpenThread}
              >
                {threadName}
              </button>
            </>
          ) : (
            <span>{message.content}</span>
          )}
          <time>{formatTime(message.createdAt)}</time>
        </div>
      </div>
    );
  }

  return (
    <div
      id={`msg-${message.id}`}
      className={`message ${message.grouped ? 'grouped' : ''} ${highlight ? 'highlight' : ''} ${
        emojiOpen ? 'emoji-open' : ''
      } ${flair ? `flair-${flair}` : ''}`}
      onContextMenu={openContextMenu}
      onTouchStart={beginLongPress}
      onTouchMove={cancelLongPress}
      onTouchEnd={cancelLongPress}
      onTouchCancel={cancelLongPress}
    >
      {!message.grouped ? (
        <button className="message-avatar" onClick={() => onOpenProfile(author.id)}>
          <Avatar user={author} size={40} presence={presence} />
        </button>
      ) : (
        <div className="message-gutter">
          <span>{formatTime(message.createdAt)}</span>
        </div>
      )}

      <div className="message-body">
        {!message.grouped && (
          <div className="message-head">
            <button className="message-author" onClick={() => onOpenProfile(author.id)}>
              {author.displayName}
            </button>
            {author.bot && (
              <span className="mini-badge bot" title="Application">
                BOT
              </span>
            )}
            {author.role === 'admin' && !author.bot && (
              <span className="mini-badge staff" title="Workspace administrator">
                STAFF
              </span>
            )}
            <time>{formatTime(message.createdAt)}</time>
          </div>
        )}

        {message.replyTo && (
          <button
            className="message-reply-quote"
            onClick={jumpToReply}
            title="Jump to replied message"
          >
            <span className="message-reply-bar" />
            <span className="message-reply-copy">
              <strong>{message.replyTo.authorName}</strong>
              <span>
                {message.replyTo.encrypted
                  ? 'Encrypted message'
                  : message.replyTo.content ||
                    (message.replyTo.hasAttachment ? 'Attachment' : 'Message unavailable')}
              </span>
            </span>
          </button>
        )}

        {message.forwarded && (
          <div className="message-forwarded">
            <Forward size={12} />
            <span>
              Forwarded from <strong>{message.forwarded.author}</strong>
            </span>
          </div>
        )}

        {editing ? (
          <div className="message-edit">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  saveEdit();
                }
                if (event.key === 'Escape') {
                  setEditing(false);
                  setDraft(message.content);
                }
              }}
              rows={Math.min(6, draft.split('\n').length)}
              autoFocus
            />
            <div className="message-edit-actions">
              <button className="btn btn-ghost btn-xs" onClick={() => setEditing(false)}>
                <X size={13} /> Cancel
              </button>
              <button className="btn btn-primary btn-xs" onClick={saveEdit} disabled={saving}>
                <Check size={13} /> Save
              </button>
            </div>
          </div>
        ) : message.poll ? (
          <PollCard
            message={message}
            me={me}
            canVote={canSend}
            canClose={mine || canModerate}
            onVote={onVotePoll}
            onClose={onClosePoll}
          />
        ) : message.encrypted ? (
          <EncryptedContent
            message={message}
            peerPublicKey={mine ? e2eePeerPublicKey : author.e2eePublicKey}
            peerId={e2eePeerId}
            onUnlockE2ee={onUnlockE2ee}
            onDecrypted={handleDecrypted}
          />
        ) : (
          message.content && (
            <div className="message-content">
              <Markdown text={message.content} meUsername={me.username} emotes={emoteList} />
            </div>
          )
        )}

        {!editing && !message.encrypted && (
          <Attachment attachment={message.attachment} voiceDurationMs={message.voiceDurationMs} />
        )}

        {message.safety && (
          <div className={`message-safety level-${message.safety.level}`} role="status">
            <ShieldAlert size={16} />
            <div className="message-safety-copy">
              <strong>Be careful here</strong>
              <p>{safetyCopy(message.safety.categories)}</p>
            </div>
            <div className="message-safety-actions">
              {onBlockUser && (
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  onClick={() => onBlockUser(author.id)}
                >
                  Block
                </button>
              )}
              {onReport && (
                <button type="button" className="btn btn-ghost btn-xs" onClick={() => onReport(message)}>
                  Report
                </button>
              )}
            </div>
          </div>
        )}

        {Array.isArray(message.components) && message.components.length > 0 && (
          <div className="message-components">
            {message.components.map((row, rowIndex) => (
              <div className="message-component-row" key={rowIndex}>
                {(row.components || []).map((component) =>
                  component.type === 'select' ? (
                    <select
                      key={component.customId}
                      className="message-select"
                      defaultValue=""
                      onChange={(event) => {
                        if (!event.target.value) return;
                        onComponent?.(message, component.customId, [event.target.value]);
                        event.target.value = '';
                      }}
                    >
                      <option value="" disabled>
                        {component.placeholder || 'Choose an option'}
                      </option>
                      {component.options.map((option) => (
                        <option value={option.value} key={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <button
                      key={component.customId}
                      type="button"
                      className={`message-button style-${component.style || 'secondary'}`}
                      disabled={component.disabled}
                      onClick={() => onComponent?.(message, component.customId, [])}
                    >
                      {component.label || 'Button'}
                    </button>
                  )
                )}
              </div>
            ))}
          </div>
        )}

        {message.pinnedAt && (
          <span className="message-pin-flag" title="Pinned message">
            <Pin size={11} /> Pinned
          </span>
        )}
        {message.editedAt &&
          (onShowEdits ? (
            <button
              type="button"
              className="message-edited message-edited-btn"
              title="See what changed"
              onClick={() => onShowEdits(message)}
            >
              (edited)
            </button>
          ) : (
            <span className="message-edited">(edited)</span>
          ))}

        {message.reactions?.length > 0 && (
          <div className="reactions">
            {message.reactions.map((reaction) => {
              const active = reaction.users ? reaction.users.includes(me.id) : reaction.me;
              const custom = /^:([a-zA-Z0-9_]{2,32}):$/.exec(reaction.emoji);
              const emote = custom ? emoteMap[custom[1].toLowerCase()] : null;
              return (
                <button
                  key={reaction.emoji}
                  className={`reaction ${active ? 'active' : ''}`}
                  onClick={(event) => {
                    if (!canReact) return;
                    if (!active && !emote) {
                      triggerReactionEasterEgg(reaction.emoji, event.clientX, event.clientY);
                    }
                    onReact(message, reaction.emoji);
                  }}
                  disabled={!canReact}
                  title={`${reaction.count} reaction${reaction.count === 1 ? '' : 's'}`}
                >
                  {emote ? (
                    <img
                      className="reaction-emote"
                      src={assetUrl(emote.url)}
                      alt={reaction.emoji}
                      draggable={false}
                    />
                  ) : (
                    <span>
                      <Emoji char={reaction.emoji} size={17} />
                    </span>
                  )}
                  <span>{reaction.count}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="message-toolbar">
        {canSend && (
          <button
            className="icon-btn toolbar-btn"
            onClick={() => onReply(message)}
            title="Reply"
          >
            <Reply size={15} />
          </button>
        )}
        {canSend && !message.encrypted && (
          <button
            className="icon-btn toolbar-btn"
            onClick={() => setForwardOpen(true)}
            title="Forward"
          >
            <Forward size={15} />
          </button>
        )}
        {canThread && onCreateThread && (
          <button
            className="icon-btn toolbar-btn"
            onClick={() => onCreateThread(message)}
            title="Create thread"
          >
            <MessagesSquare size={15} />
          </button>
        )}
        {canReact && (
          <div className="toolbar-pop-wrap" ref={popoverRef}>
            <button
              className="icon-btn toolbar-btn"
              onClick={() => {
                if (!emojiOpen) {
                  // The full picker is tall; open it downwards when the message
                  // sits near the top of the viewport so it cannot be clipped.
                  const rect = popoverRef.current?.getBoundingClientRect();
                  setPopoverDown(Boolean(rect) && rect.top < 420);
                }
                setEmojiOpen((value) => !value);
              }}
              title="Add reaction"
            >
              <SmilePlus size={15} />
            </button>
            {emojiOpen && (
              <div className={`emoji-popover message-emoji-popover ${popoverDown ? 'drop-down' : ''}`}>
                <div className="reaction-quick">
                  {REACTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className="reaction-quick-btn"
                      title={`React with ${emoji}`}
                      onClick={(event) => {
                        triggerReactionEasterEgg(emoji, event.clientX, event.clientY);
                        onReact(message, emoji);
                        setEmojiOpen(false);
                      }}
                    >
                      <Emoji char={emoji} size={20} />
                    </button>
                  ))}
                </div>
                <EmojiPicker
                  emotes={emoteList}
                  compact
                  onPickEmoji={(char) => {
                    onReact(message, char);
                    setEmojiOpen(false);
                  }}
                  onPickEmote={(emote) => {
                    onReact(message, `:${emote.name}:`);
                    setEmojiOpen(false);
                  }}
                />
              </div>
            )}
          </div>
        )}
        {mine && canSend && message.content && !message.poll && !message.encrypted && (
          <button
            className="icon-btn toolbar-btn"
            onClick={() => {
              setEditing(true);
              setDraft(message.content);
            }}
            title="Edit message"
          >
            <Pencil size={14} />
          </button>
        )}
        {onMarkUnread && (
          <button
            className="icon-btn toolbar-btn"
            onClick={() => onMarkUnread(message)}
            title="Mark unread"
          >
            <Mail size={14} />
          </button>
        )}
        {canPin && onTogglePin && (
          <button
            className={`icon-btn toolbar-btn ${message.pinnedAt ? 'active-soft' : ''}`}
            onClick={() => onTogglePin(message)}
            title={message.pinnedAt ? 'Unpin message' : 'Pin message'}
          >
            {message.pinnedAt ? <PinOff size={14} /> : <Pin size={14} />}
          </button>
        )}
        {(mine || canModerate) && (
          <button
            className="icon-btn toolbar-btn danger-hover"
            onClick={() => onDelete(message)}
            title="Delete message"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {contextMenu &&
        createPortal(
          <div
            ref={contextMenuRef}
            className="message-context-menu"
            role="menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            {canSend && (
              <button
                type="button"
                role="menuitem"
                className="message-context-item"
                onClick={() => {
                  setContextMenu(null);
                  onReply(message);
                }}
              >
                <Reply size={15} />
                Reply
              </button>
            )}
            {canSend && !message.encrypted && (
              <button
                type="button"
                role="menuitem"
                className="message-context-item"
                onClick={() => {
                  setContextMenu(null);
                  setForwardOpen(true);
                }}
              >
                <Forward size={15} />
                Forward
              </button>
            )}
            {onMarkUnread && (
              <button
                type="button"
                role="menuitem"
                className="message-context-item"
                onClick={() => {
                  setContextMenu(null);
                  onMarkUnread(message);
                }}
              >
                <Mail size={15} />
                Mark unread
              </button>
            )}
            {onSave && (
              <button
                type="button"
                role="menuitem"
                className="message-context-item"
                onClick={() => {
                  setContextMenu(null);
                  onSave(message);
                }}
              >
                <Bookmark size={15} />
                Save message
              </button>
            )}
            {onRemind && (
              <button
                type="button"
                role="menuitem"
                className="message-context-item"
                onClick={() => {
                  setContextMenu(null);
                  onRemind(message);
                }}
              >
                <Bell size={15} />
                Remind me
              </button>
            )}
            {canPin && onTogglePin && (
              <button
                type="button"
                role="menuitem"
                className="message-context-item"
                onClick={() => {
                  setContextMenu(null);
                  onTogglePin(message);
                }}
              >
                {message.pinnedAt ? <PinOff size={15} /> : <Pin size={15} />}
                {message.pinnedAt ? 'Unpin message' : 'Pin message'}
              </button>
            )}
            {!mine && onReport && (
              <button
                type="button"
                role="menuitem"
                className="message-context-item message-context-danger"
                onClick={reportMessage}
              >
                <Flag size={15} />
                Report message
              </button>
            )}
            {(mine || canModerate) && (
              <button
                type="button"
                role="menuitem"
                className="message-context-item message-context-danger"
                onClick={() => {
                  setContextMenu(null);
                  onDelete(message);
                }}
              >
                <Trash2 size={15} />
                Delete message
              </button>
            )}
          </div>,
          document.body
        )}

      {forwardOpen && (
        <ForwardModal
          message={message}
          destinations={forwardDestinations}
          onClose={() => setForwardOpen(false)}
        />
      )}
    </div>
  );
}

