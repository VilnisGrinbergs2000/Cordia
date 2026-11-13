import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, MonitorUp, Phone, PhoneOff, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useAudioOutput } from '../audioPrefs';
import Avatar from './Avatar';

function formatElapsed(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function SecurityBadge({ security, note }) {
  if (!security || security === 'idle' || security === 'pending') return null;
  if (security === 'verified') {
    return (
      <span className="call-security ok" title="This call's encryption keys were signed by the other person.">
        <ShieldCheck size={13} />
        End-to-end encrypted
      </span>
    );
  }
  if (security === 'unverified') {
    return (
      <span className="call-security warn" title={note || ''}>
        <ShieldAlert size={13} />
        Encryption not verified
      </span>
    );
  }
  return (
    <span className="call-security bad" title={note || ''}>
      <ShieldAlert size={13} />
      Call security failed
    </span>
  );
}

export default function CallOverlay({
  call,
  remoteStream,
  remoteVideo,
  localScreen,
  sharing,
  security,
  securityNote,
  muted,
  notice,
  onAccept,
  onDecline,
  onEnd,
  onToggleMute,
  onToggleScreen
}) {
  const audioRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const localVideoRef = useRef(null);
  const [elapsed, setElapsed] = useState(0);
  useAudioOutput(audioRef);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.srcObject = remoteStream || null;
    if (remoteStream) audio.play().catch(() => {});
  }, [remoteStream]);

  useEffect(() => {
    const video = remoteVideoRef.current;
    if (!video) return;
    video.srcObject = remoteStream || null;
    if (remoteStream) video.play().catch(() => {});
  }, [remoteStream, remoteVideo]);

  useEffect(() => {
    const video = localVideoRef.current;
    if (!video) return;
    video.srcObject = localScreen || null;
    if (localScreen) video.play().catch(() => {});
  }, [localScreen]);

  useEffect(() => {
    if (!call || call.status !== 'active') {
      setElapsed(0);
      return undefined;
    }
    const started = call.startedAt || Date.now();
    function tick() {
      setElapsed(Math.max(0, Math.floor((Date.now() - started) / 1000)));
    }
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [call?.id, call?.status, call?.startedAt]);

  const incoming = call?.status === 'incoming';
  const active = call?.status === 'active';
  const peer = call?.peer;
  const stage = active && (remoteVideo || sharing);

  const controls = (
    <>
      <button
        className={`call-btn ${muted ? 'muted' : ''}`}
        onClick={onToggleMute}
        title={muted ? 'Unmute' : 'Mute'}
      >
        {muted ? <MicOff size={18} /> : <Mic size={18} />}
      </button>
      <button
        className={`call-btn ${sharing ? 'active' : ''}`}
        onClick={onToggleScreen}
        title={sharing ? 'Stop sharing' : 'Share your screen'}
      >
        <MonitorUp size={18} />
      </button>
      <button className="call-btn decline" onClick={onEnd} title="End call">
        <PhoneOff size={19} />
      </button>
    </>
  );

  return (
    <>
      {call && (
        <div className={`call-layer ${incoming ? 'incoming' : ''} ${stage ? 'stage' : ''}`}>
          {stage ? (
            <div className="call-stage">
              <video ref={remoteVideoRef} className="call-stage-video" autoPlay playsInline muted />
              {!remoteVideo && (
                <div className="call-stage-placeholder">
                  <Avatar user={peer} size={64} />
                  <strong>{peer?.displayName || 'Unknown caller'}</strong>
                  <span>Sharing your screen</span>
                </div>
              )}
              {sharing && localScreen && (
                <video ref={localVideoRef} className="call-stage-self" autoPlay playsInline muted />
              )}
              <div className="call-stage-top">
                <SecurityBadge security={security} note={securityNote} />
                <span className="call-stage-name">
                  {peer?.displayName || 'Unknown caller'} · {formatElapsed(elapsed)}
                </span>
              </div>
              <div className="call-stage-bar">{controls}</div>
            </div>
          ) : (
            <div className={`call-card ${incoming ? 'incoming' : ''}`}>
              <div className={`call-avatar ${call.status !== 'active' ? 'ringing' : ''}`}>
                <Avatar user={peer} size={58} />
              </div>
              <div className="call-copy">
                <strong>{peer?.displayName || 'Unknown caller'}</strong>
                <span>
                  {incoming
                    ? 'Incoming call'
                    : active
                      ? formatElapsed(elapsed)
                      : 'Calling…'}
                </span>
                {active && <SecurityBadge security={security} note={securityNote} />}
              </div>

              {incoming ? (
                <div className="call-actions">
                  <button className="call-btn accept" onClick={onAccept} title="Accept call">
                    <Phone size={19} />
                  </button>
                  <button className="call-btn decline" onClick={onDecline} title="Decline call">
                    <PhoneOff size={19} />
                  </button>
                </div>
              ) : (
                <div className="call-actions">{controls}</div>
              )}
            </div>
          )}
        </div>
      )}
      {notice && <div className="call-notice">{notice}</div>}
      <audio ref={audioRef} autoPlay playsInline />
      {!stage && <video ref={remoteVideoRef} className="call-video-hidden" autoPlay playsInline muted />}
    </>
  );
}
