import {
  HeadphoneOff,
  Headphones,
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  PhoneOff,
  Video,
  VideoOff
} from 'lucide-react';

export default function VoiceControls({ voice }) {
  return (
    <div className="voice-controls">
      <button
        className={`voice-ctrl ${voice.muted ? 'danger' : ''}`}
        onClick={voice.toggleMute}
        title={voice.muted ? 'Unmute' : 'Mute'}
      >
        {voice.muted ? <MicOff size={18} /> : <Mic size={18} />}
      </button>
      <button
        className={`voice-ctrl ${voice.deafened ? 'danger' : ''}`}
        onClick={voice.toggleDeafen}
        title={voice.deafened ? 'Undeafen' : 'Deafen'}
      >
        {voice.deafened ? <HeadphoneOff size={18} /> : <Headphones size={18} />}
      </button>
      <button
        className={`voice-ctrl ${voice.cameraOn ? 'active' : ''}`}
        onClick={voice.toggleCamera}
        title={voice.cameraOn ? 'Turn camera off' : 'Turn camera on'}
      >
        {voice.cameraOn ? <VideoOff size={18} /> : <Video size={18} />}
      </button>
      <button
        className={`voice-ctrl ${voice.sharing ? 'active' : ''}`}
        onClick={voice.toggleScreen}
        title={voice.sharing ? 'Stop sharing' : 'Share screen'}
      >
        {voice.sharing ? <MonitorOff size={18} /> : <Monitor size={18} />}
      </button>
      <button className="voice-ctrl hangup" onClick={voice.leave} title="Disconnect">
        <PhoneOff size={18} />
      </button>
    </div>
  );
}
