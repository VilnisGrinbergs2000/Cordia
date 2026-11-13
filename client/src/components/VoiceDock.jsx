import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, MicOff, Music2, Radio, TriangleAlert } from 'lucide-react';
import { useAudioOutput } from '../audioPrefs';
import { hasServerPermission } from '../permissions';
import Avatar from './Avatar';
import SoundboardPicker from './SoundboardPicker';
import VoiceControls from './VoiceControls';

function RemoteAudio({ stream, muted }) {
  const ref = useRef(null);
  useAudioOutput(ref);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    el.play().catch(() => {});
  }, [stream]);
  useEffect(() => {
    if (ref.current) ref.current.muted = !!muted;
  }, [muted]);
  return <audio ref={ref} autoPlay playsInline />;
}

export default function VoiceDock({ voice, me, onOpen, server, socket }) {
  const [soundboardOpen, setSoundboardOpen] = useState(false);
  const canUseSoundboard = hasServerPermission(server, me, 'useSoundboard');
  const [played, setPlayed] = useState(null);
  const playedTimer = useRef(null);

  useEffect(() => {
    if (!voice.channel) setSoundboardOpen(false);
  }, [voice.channel?.id]);

  // Losing the permission while the panel is open (a group edit from another
  // tab) should close it rather than leave a picker that 403s on every click.
  useEffect(() => {
    if (!canUseSoundboard) setSoundboardOpen(false);
  }, [canUseSoundboard]);

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

  const showPlayed = useCallback((payload) => {
    setPlayed(payload);
    clearTimeout(playedTimer.current);
    playedTimer.current = setTimeout(() => setPlayed(null), 3200);
  }, []);

  if (!voice.channel) return null;
  const participants = Object.values(voice.participants);

  return (
    <>
      <div className="voice-dock">
        <div className="voice-dock-head">
          <span className="voice-signal">
            {voice.connecting ? <Loader2 size={16} className="spin" /> : <Radio size={16} />}
          </span>
          <button className="voice-dock-title" onClick={() => onOpen?.(voice.channel)}>
            <span>Voice connected</span>
            <strong>{voice.channel.name}</strong>
          </button>
          {canUseSoundboard && (
            <button
              className={`voice-ctrl soundboard-trigger ${soundboardOpen ? 'active' : ''}`}
              onClick={() => setSoundboardOpen((open) => !open)}
              title="Soundboard"
              aria-expanded={soundboardOpen}
            >
              <Music2 size={15} />
            </button>
          )}
          <div className="eq" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </div>
        </div>

        <div className="voice-dock-people">
          {participants.slice(0, 5).map((participant) => {
            const speaking = !!voice.speaking?.[participant.socketId] && !participant.muted;
            return (
              <div
                className={`voice-chip ${speaking ? 'speaking' : ''} ${participant.muted ? 'muted' : ''}`}
                key={participant.socketId}
                title={`${participant.displayName}${participant.muted ? ' — muted' : speaking ? ' — speaking' : ''}`}
              >
                <Avatar
                  user={{
                    displayName: participant.displayName,
                    avatarColor: participant.avatarColor,
                    avatarUrl: participant.avatarUrl
                  }}
                  size={24}
                />
                {participant.muted && (
                  <span className="voice-chip-mute">
                    <MicOff size={8} />
                  </span>
                )}
              </div>
            );
          })}
          {participants.length > 5 && <span className="voice-more">+{participants.length - 5}</span>}
          <span className="voice-count">
            {participants.length} in voice
          </span>
        </div>

        {voice.error && (
          <div className="voice-error">
            <TriangleAlert size={13} /> {voice.error}
          </div>
        )}

        <VoiceControls voice={voice} />

        {played && (
          <div className="voice-played">
            <Music2 size={11} />
            <span>
              <strong>{played.userName}</strong> played {played.name}
            </span>
          </div>
        )}

        <SoundboardPicker
          server={server}
          channelId={voice.channel.id}
          socket={socket}
          me={me}
          open={soundboardOpen}
          onClose={() => setSoundboardOpen(false)}
          onPlayed={showPlayed}
        />
      </div>

      <div className="remote-audio">
        {Object.entries(voice.streams).map(([socketId, stream]) => (
          <RemoteAudio key={socketId} stream={stream} muted={voice.deafened} />
        ))}
      </div>
    </>
  );
}
