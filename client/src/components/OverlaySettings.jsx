import { useState } from 'react';
import { Gamepad2 } from 'lucide-react';
import { overlayBridge, readOverlayConfig, writeOverlayConfig } from '../overlay';

const CORNERS = [
  { value: 'top-left', label: 'Top left' },
  { value: 'top-right', label: 'Top right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-right', label: 'Bottom right' }
];

export default function OverlaySettings() {
  const bridge = overlayBridge();
  const [config, setConfig] = useState(() => readOverlayConfig());

  function update(patch) {
    const next = writeOverlayConfig(patch);
    setConfig(next);
    if (bridge) bridge.configure(next);
  }

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <div>
          <h1>Game overlay</h1>
          <p>
            Who is in your voice channel, drawn on top of the game while you play. It is a
            separate always-on-top window rather than something injected into the game: it
            appears over windowed and borderless games, and an exclusive-fullscreen game will
            cover it.
          </p>
        </div>
      </div>

      {bridge ? (
        <div className="settings-group">
          <div className="overlay-head">
            <span className="spotify-badge" aria-hidden="true">
              <Gamepad2 size={18} />
            </span>
            <div className="spotify-title">
              <h3>Show the overlay</h3>
              <p>Shift plus the backtick key hides and shows it while it is on</p>
            </div>
          </div>

          <label className="spotify-toggle">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={() => update({ enabled: !config.enabled })}
            />
            <span>
              <strong>Enable the game overlay</strong>
              <em>Off removes the window and releases both shortcuts.</em>
            </span>
          </label>

          <div className="field">
            <span>Corner</span>
            <div className="overlay-corners">
              {CORNERS.map((corner) => (
                <button
                  key={corner.value}
                  type="button"
                  className={'btn btn-ghost btn-sm ' + (config.corner === corner.value ? 'active' : '')}
                  onClick={() => update({ corner: corner.value })}
                  disabled={!config.enabled}
                >
                  {corner.label}
                </button>
              ))}
            </div>
          </div>

          <label className="spotify-toggle">
            <input
              type="checkbox"
              checked={config.showSelf}
              onChange={() => update({ showSelf: !config.showSelf })}
              disabled={!config.enabled}
            />
            <span>
              <strong>Include yourself in the list</strong>
              <em>Off shows only the other people in the channel.</em>
            </span>
          </label>

          <label className="spotify-toggle">
            <input
              type="checkbox"
              checked={config.showChat}
              onChange={() => update({ showChat: !config.showChat })}
              disabled={!config.enabled}
            />
            <span>
              <strong>Show the last few messages</strong>
              <em>The channel on screen, one line each, four at a time.</em>
            </span>
          </label>

          <label className="av-slider-row">
            <span>
              <strong>Opacity</strong>
              <small>{config.opacity}%</small>
            </span>
            <input
              type="range"
              min="50"
              max="100"
              step="2"
              value={config.opacity}
              onChange={(event) => update({ opacity: Number(event.target.value) })}
              disabled={!config.enabled}
            />
          </label>

          <p className="overlay-note">
            The overlay is click-through, so the game keeps every mouse click. Press
            Ctrl + Shift + the backtick key to unlock it: the panel then accepts clicks,
            drags anywhere on the screen, and its microphone, deafen, leave and message
            controls work. Escape locks it again. It reads the voice channel you are
            already in and the conversation on screen - no capture, no recording, no second
            connection.
          </p>
        </div>
      ) : (
        <div className="spotify-notice">
          <p>
            The overlay is part of the desktop app. A browser tab cannot draw over another
            window, so there is nothing to configure here.
          </p>
        </div>
      )}
    </section>
  );
}
