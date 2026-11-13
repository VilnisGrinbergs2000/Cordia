import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Headphones,
  Loader2,
  Maximize2,
  MicOff,
  MonitorUp,
  Music2,
  Radio,
  UserPlus,
  Video,
  Volume2,
  X
} from 'lucide-react';
import api from '../api';
import Avatar from './Avatar';
import SoundboardPicker from './SoundboardPicker';
import { hasServerPermission } from '../permissions';
import VideoViewer from './VideoViewer';
import VoiceControls from './VoiceControls';

function ParticipantVideo({ stream, sharing, mirrored }) {
  const ref = useRef(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    element.srcObject = stream;
    element.play().catch(() => {});
    return () => {
      element.srcObject = null;
    };
  }, [stream]);

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className={`voice-person-video ${sharing ? 'screen' : ''} ${
        mirrored ? 'mirrored' : ''
      }`}
    />
  );
}

// A stage has no message list to persist into, so join/leave is a transient
// notice instead of a row nobody would ever read.
const NOTICE_MS = 4200;
const LEAVE_GRACE_MS = 5000;

export default function VoiceStage({
  channel,
  voice,
  me,
  server,
  voiceOccupancy = {},
  onOpenInvite,
  onBack,
  canConnect = true,
  canSpeak
}) {
  const [expanded, setExpanded] = useState(null);
  const [soundboardOpen, setSoundboardOpen] = useState(false);
  const [soundboardServer, setSoundboardServer] = useState(null);
  const [soundboardLoading, setSoundboardLoading] = useState(false);
  const [soundboardError, setSoundboardError] = useState('');
  const [soundboardAttempt, setSoundboardAttempt] = useState(0);
  const [notices, setNotices] = useState([]);
  const seenRef = useRef(null);
  const leaveTimers = useRef(new Map());
  const noticeTimers = useRef(new Set());
  const connected = voice.channel?.id === channel.id;
  const participants = connected
    ? Object.values(voice.participants)
    : voiceOccupancy[channel.id] || [];
  // Carry the channel type (and speak right) on the join target so the stage
  // listener path does not have to fall back to the channel context.
  const target = {
    id: channel.id,
    name: channel.name,
    serverId: channel.serverId,
    type: channel.type,
    ...(canSpeak === undefined ? {} : { canSpeak })
  };
  // participants is rebuilt on every render, so the roster diff is keyed on a
  // stable id+socketId signature instead. Otherwise every render rewrites
  // seenRef and the diff reports phantom joins and leaves.
  const rosterSignature = useMemo(
    () => participants.map((participant) => `${participant?.id}:${participant?.socketId}`).join('|'),
    [participants]
  );

  // Switching channels re-seeds the diff so the new room's roster is silent.
  useEffect(() => {
    seenRef.current = null;
    setNotices([]);
    for (const entry of leaveTimers.current.values()) clearTimeout(entry.timer);
    leaveTimers.current.clear();
  }, [channel.id]);

  // The participant list is the source of truth: diffing it keeps reconnects
  // and duplicate socket events from ever producing a second line, and a leave
  // that is undone within five seconds produces no line at all.
  useEffect(() => {
    const next = new Map();
    for (const participant of participants) {
      if (participant?.id) next.set(participant.id, participant);
    }
    const prev = seenRef.current;
    seenRef.current = next;
    if (!prev) return undefined;

    for (const [id, participant] of next) {
      if (id === me.id) continue;
      const pending = leaveTimers.current.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        leaveTimers.current.delete(id);
        continue;
      }
      if (prev.has(id)) continue;
      const key = `${id}-join-${Date.now()}`;
      // A stale "left" pill from a slow rejoin is dropped, not stacked on.
      setNotices((list) => [
        ...list.filter((notice) => !(notice.kind === 'left' && notice.user.id === id)).slice(-2),
        { key, kind: 'join', user: participant }
      ]);
      const timer = setTimeout(() => {
        noticeTimers.current.delete(timer);
        setNotices((list) => list.filter((notice) => notice.key !== key));
      }, NOTICE_MS);
      noticeTimers.current.add(timer);
    }

    for (const [id, participant] of prev) {
      if (id === me.id || next.has(id) || leaveTimers.current.has(id)) continue;
      const timer = setTimeout(() => {
        leaveTimers.current.delete(id);
        const key = `${id}-left-${Date.now()}`;
        setNotices((list) => [...list.slice(-2), { key, kind: 'left', user: participant }]);
        const dismiss = setTimeout(() => {
          noticeTimers.current.delete(dismiss);
          setNotices((list) => list.filter((notice) => notice.key !== key));
        }, NOTICE_MS);
        noticeTimers.current.add(dismiss);
      }, LEAVE_GRACE_MS);
      leaveTimers.current.set(id, { timer, user: participant });
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rosterSignature, me.id]);

  useEffect(
    () => () => {
      for (const entry of leaveTimers.current.values()) clearTimeout(entry.timer);
      leaveTimers.current.clear();
      for (const timer of noticeTimers.current) clearTimeout(timer);
      noticeTimers.current.clear();
    },
    []
  );

  useEffect(() => {
    setExpanded(null);
    setSoundboardOpen(false);
  }, [channel.id, connected]);

  // The dock is hidden on the live voice page below 821px, so the call bar
  // needs the same popover. The stage only receives the channel, so pull the
  // server once per call for the picker's permission check.
  useEffect(() => {
    if (!connected || !channel.serverId) return undefined;
    let alive = true;
    setSoundboardLoading(true);
    setSoundboardError('');
    api
      .get(`/api/servers/${channel.serverId}`)
      .then((data) => {
        if (!alive) return;
        setSoundboardServer(data?.server || null);
        if (!data?.server) setSoundboardError('Could not load this server.');
      })
      .catch((err) => {
        // On mobile this popover is the only soundboard surface, so a silent
        // failure left the trigger doing nothing at all.
        if (alive) setSoundboardError(err?.message || 'Could not load the soundboard.');
      })
      .finally(() => {
        if (alive) setSoundboardLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [connected, channel.serverId, soundboardAttempt]);

  useEffect(() => {
    if (!soundboardOpen) return undefined;
    function onPointerDown(event) {
      if (event.target?.closest?.('.soundboard-pop, .soundboard-trigger')) return;
      setSoundboardOpen(false);
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') setSoundboardOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [soundboardOpen]);

  useEffect(() => {
    if (!expanded) return;
    const participant = participants.find((entry) => entry.socketId === expanded.socketId);
    const stream = participant?.video
      ? participant.id === me.id
        ? voice.localVideo
        : voice.streams[participant.socketId]
      : null;
    if (!stream) setExpanded(null);
  }, [expanded, participants, voice.localVideo, voice.streams, me.id]);

  const subtitle = connected
    ? 'Voice connected'
    : participants.length > 0
      ? `${participants.length} in voice`
      : 'Voice channel';

  return (
    <section className="voice-stage">
      <header className="voice-channel-header">
        <button
          className="icon-btn chat-back"
          onClick={onBack}
          title="Back to channels"
          aria-label="Back to channels"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="voice-channel-title">
          <span className="voice-channel-icon">
            <Volume2 size={20} />
          </span>
          <span className="voice-channel-title-text">
            <strong>{channel.name}</strong>
            <small>{subtitle}</small>
          </span>
        </div>

        <div className="voice-channel-actions">
          {!connected &&
            (canConnect ? (
              <button
                className="btn btn-primary voice-join-btn"
                onClick={() => voice.join(target)}
                disabled={voice.connecting}
              >
                {voice.connecting ? (
                  <Loader2 size={16} className="spin" />
                ) : (
                  <Headphones size={16} />
                )}
                {voice.connecting ? 'Joining.' : 'Join Voice'}
              </button>
            ) : (
              <span className="voice-no-access">Voice access restricted</span>
            ))}
          <button className="icon-btn" onClick={onOpenInvite} title="Invite people">
            <UserPlus size={18} />
          </button>
        </div>
      </header>

      {voice.error && <div className="voice-stage-error voice-stage-error-bar">{voice.error}</div>}

      {notices.length > 0 && (
        <div className="voice-notices" role="status" aria-live="polite">
          {notices.map((notice) => (
            <div className={`voice-notice ${notice.kind}`} key={notice.key}>
              <Avatar
                user={{
                  displayName: notice.user.displayName,
                  avatarColor: notice.user.avatarColor,
                  avatarUrl: notice.user.avatarUrl
                }}
                size={20}
              />
              <span>
                {notice.user.displayName} {notice.kind === 'join' ? 'joined' : 'left'}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="voice-room-wrap">
        {participants.length === 0 ? (
          <div className="voice-room-empty">
            <span className="voice-room-empty-icon">
              <Volume2 size={26} />
            </span>
            <h2>{connected ? 'No one else is here yet' : `Join ${channel.name}`}</h2>
            <p>
              {connected
                ? 'Invite someone to join you in voice.'
                : 'Hop in to talk, turn on a camera, or share your screen.'}
            </p>
            {connected ? (
              <button className="btn btn-ghost" onClick={onOpenInvite}>
                <UserPlus size={16} /> Invite people
              </button>
            ) : canConnect ? (
              <button
                className="btn btn-primary"
                onClick={() => voice.join(target)}
                disabled={voice.connecting}
              >
                {voice.connecting ? (
                  <Loader2 size={16} className="spin" />
                ) : (
                  <Headphones size={16} />
                )}
                {voice.connecting ? 'Joining.' : 'Join Voice'}
              </button>
            ) : (
              <p className="voice-no-access">You do not have permission to join voice.</p>
            )}
          </div>
        ) : (
          <div className={`voice-room-grid ${participants.length === 1 ? 'solo' : ''}`}>
            {participants.map((participant) => {
              const speaking =
                connected &&
                !!voice.speaking?.[participant.socketId] &&
                !participant.muted;
              const isSelf = participant.id === me.id;
              const stream = participant.video
                ? isSelf
                  ? voice.localVideo
                  : voice.streams[participant.socketId]
                : null;
              const viewerTile = stream
                ? {
                    socketId: participant.socketId,
                    stream,
                    label: `${participant.displayName}${isSelf ? ' (you)' : ''}`,
                    muted: true,
                    mirrored: isSelf && !participant.sharing,
                    badge: participant.sharing ? 'screen' : undefined
                  }
                : null;
              const avatarSize =
                participants.length === 1 ? 144 : participants.length === 2 ? 92 : 76;
              return (
                <div
                  className={`voice-person ${speaking ? 'speaking' : ''} ${
                    participant.muted ? 'muted' : ''
                  } ${stream ? 'has-video' : ''} ${participant.sharing ? 'sharing' : ''}`}
                  key={participant.socketId}
                >
                  {stream ? (
                    <ParticipantVideo
                      stream={stream}
                      sharing={participant.sharing}
                      mirrored={isSelf && !participant.sharing}
                    />
                  ) : (
                    <div className="voice-person-avatar">
                      <Avatar
                        user={{
                          displayName: participant.displayName,
                          avatarColor: participant.avatarColor,
                          avatarUrl: participant.avatarUrl
                        }}
                        size={avatarSize}
                      />
                    </div>
                  )}

                  {viewerTile && (
                    <button
                      type="button"
                      className="voice-person-expand"
                      title={`Enlarge ${participant.displayName}`}
                      onClick={() => setExpanded(viewerTile)}
                    >
                      <Maximize2 size={14} />
                    </button>
                  )}

                  <span className="voice-person-name">
                    {participant.displayName}
                    {participant.id === me.id ? ' (you)' : ''}
                  </span>

                  <span className="voice-person-flags">
                    {participant.sharing && (
                      <span className="voice-person-flag sharing" title="Screen sharing">
                        <MonitorUp size={13} />
                      </span>
                    )}
                    {participant.video && !participant.sharing && (
                      <span className="voice-person-flag video" title="Camera on">
                        <Video size={13} />
                      </span>
                    )}
                    {participant.muted && (
                      <span className="voice-person-flag muted" title="Muted">
                        <MicOff size={13} />
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {connected && (
        <footer className="voice-callbar">
          <div className="voice-callbar-inner">
            <span className="voice-callbar-status">
              <span className="voice-callbar-dot" />
              <Radio size={14} />
              Voice Connected
            </span>

            <div className="voice-callbar-main">
              {hasServerPermission(server, me, 'useSoundboard') && (
                <button
                  className={`voice-ctrl soundboard-trigger ${soundboardOpen ? 'active' : ''}`}
                  onClick={() => {
                    const next = !soundboardOpen;
                    setSoundboardOpen(next);
                    // Retry the server fetch when the popover is reopened after
                    // a failure, instead of showing a dead popover forever.
                    if (next && soundboardError) setSoundboardAttempt((attempt) => attempt + 1);
                  }}
                  title="Soundboard"
                  aria-expanded={soundboardOpen}
                >
                  <Music2 size={18} />
                </button>
              )}
              <VoiceControls voice={voice} />
            </div>

            {soundboardOpen && !soundboardServer && (
              <div className="soundboard-pop" role="dialog" aria-label="Soundboard">
                <div className="soundboard-head">
                  <strong>Soundboard</strong>
                  <button
                    className="soundboard-close"
                    onClick={() => setSoundboardOpen(false)}
                    title="Close"
                    aria-label="Close soundboard"
                  >
                    <X size={14} />
                  </button>
                </div>
                {soundboardLoading || !soundboardError ? (
                  <div className="soundboard-empty">
                    <Loader2 size={16} className="spin" />
                  </div>
                ) : (
                  <div className="soundboard-empty">
                    <strong>Soundboard unavailable</strong>
                    <span>{soundboardError || 'This channel has no soundboard.'}</span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setSoundboardAttempt((attempt) => attempt + 1)}
                    >
                      Retry
                    </button>
                  </div>
                )}
              </div>
            )}

            <SoundboardPicker
              server={soundboardServer}
              channelId={channel.id}
              me={me}
              open={soundboardOpen}
              onClose={() => setSoundboardOpen(false)}
            />
          </div>
        </footer>
      )}

      {expanded && <VideoViewer tile={expanded} onClose={() => setExpanded(null)} />}
    </section>
  );
}
