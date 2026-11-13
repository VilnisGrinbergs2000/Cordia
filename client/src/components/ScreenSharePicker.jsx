import { AppWindow, Loader2, Monitor, MonitorUp } from 'lucide-react';
import Modal from './Modal';

function SourceCard({ source, onSelect }) {
  const Icon = source.kind === 'screen' ? Monitor : AppWindow;
  return (
    <button
      type="button"
      className="screen-source-card"
      onClick={() => onSelect(source.id)}
      title={`Share ${source.name}`}
    >
      {source.thumbnail ? (
        <img className="screen-source-thumb" src={source.thumbnail} alt="" />
      ) : (
        <span className="screen-source-placeholder">
          <Icon size={24} />
        </span>
      )}
      <span className="screen-source-name">
        <Icon size={13} />
        <span>{source.name}</span>
      </span>
    </button>
  );
}

function SourceSection({ title, sources, onSelect }) {
  if (!sources.length) return null;
  return (
    <section className="screen-picker-section">
      <h3>{title}</h3>
      <div className="screen-source-grid">
        {sources.map((source) => (
          <SourceCard key={source.id} source={source} onSelect={onSelect} />
        ))}
      </div>
    </section>
  );
}

export default function ScreenSharePicker({ voice }) {
  if (!voice.screenPickerOpen) return null;

  const sources = voice.screenPickerSources || [];
  const screens = sources.filter((source) => source.kind === 'screen');
  const windows = sources.filter((source) => source.kind !== 'screen');
  const empty = !voice.screenPickerLoading && !sources.length;

  return (
    <Modal
      title="Share your screen"
      subtitle="Choose what to stream."
      width={860}
      className="screen-picker-modal"
      onClose={voice.cancelScreenPicker}
      footer={
        <div className="screen-picker-footer">
          <span className="screen-picker-hint">
            <MonitorUp size={13} /> Only the selected screen or window is shared.
          </span>
          <button type="button" className="btn btn-ghost" onClick={voice.cancelScreenPicker}>
            Cancel
          </button>
        </div>
      }
    >
      <div className="screen-picker-content">
        <div className="screen-picker-options">
          <label>
            <span>Resolution</span>
            <select
              value={voice.screenQuality}
              onChange={(event) => voice.setScreenQuality(event.target.value)}
            >
              <option value="720p">720p</option>
              <option value="1080p">1080p (max)</option>
            </select>
          </label>
          <label>
            <span>Frame rate</span>
            <select
              value={voice.screenFps}
              onChange={(event) => voice.setScreenFps(event.target.value)}
            >
              <option value="15">15 FPS</option>
              <option value="30">30 FPS</option>
              <option value="60">60 FPS</option>
            </select>
          </label>
          <span className="screen-picker-hint">Applies to this share.</span>
        </div>

        {voice.screenPickerDesktop ? (
          voice.screenPickerLoading ? (
            <div className="screen-picker-state">
              <Loader2 size={18} className="spin" /> Looking for screens and windows...
            </div>
          ) : empty ? (
            <div className="screen-picker-state error">
              {voice.screenPickerError || 'No screens or windows were found.'}
            </div>
          ) : (
            <>
              <SourceSection title="Screens" sources={screens} onSelect={voice.chooseScreenSource} />
              <SourceSection title="Windows" sources={windows} onSelect={voice.chooseScreenSource} />
            </>
          )
        ) : (
          <div className="screen-picker-native">
            <Monitor size={28} />
            <strong>Choose a screen or window</strong>
            <p>Your browser will open its share picker next.</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => voice.chooseScreenSource('native')}
            >
              Choose screen or window
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
