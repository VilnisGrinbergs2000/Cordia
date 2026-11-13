import { useEffect, useState } from 'react';
import { Check, Music2 } from 'lucide-react';
import { nowPlayingShared, setNowPlayingShared } from '../useNowPlaying';

// Permission to read the media session the operating system already keeps.
// The bridge filters to Spotify: the same API also reports browser tabs and
// video players, and none of that belongs on a profile.
export default function NowPlayingCard() {
  const bridge = window.cordiaDesktop && window.cordiaDesktop.mediaSession;
  const [shared, setShared] = useState(nowPlayingShared);
  const [current, setCurrent] = useState(null);

  useEffect(() => {
    if (!bridge) return undefined;
    let alive = true;
    const tick = async () => {
      const info = await bridge().catch(() => null);
      if (alive) setCurrent(info && !info.none && info.title ? info : null);
    };
    tick();
    const timer = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [bridge]);

  function toggle() {
    const next = !shared;
    setShared(next);
    setNowPlayingShared(next);
  }

  return (
    <div className="settings-group spotify-card">
      <div className="spotify-head">
        <span className="spotify-badge" aria-hidden="true">
          <Music2 size={18} />
        </span>
        <div className="spotify-title">
          <h3>Now playing</h3>
          <p>{bridge ? 'Read from this computer' : 'Desktop app only'}</p>
        </div>
        {shared && (
          <span className="spotify-state spotify-state--on">
            <Check size={13} /> Sharing
          </span>
        )}
      </div>

      {bridge ? (
        <>
          <p className="spotify-copy">
            Cordia reads Spotify's media session from Windows - no account to link and no API key.
            Nothing else on this computer is read: a browser tab or a video player stays private.
            Only the title, artist and position are sent, and only while this stays on.
          </p>
          <p className="spotify-copy spotify-idle">
            {current
              ? current.artist
                ? `${current.title} - ${current.artist}`
                : current.title
              : 'Spotify is not playing right now.'}
          </p>
          <label className="spotify-toggle">
            <input type="checkbox" checked={shared} onChange={toggle} />
            <span>
              <strong>Show what this computer is playing</strong>
              <em>Off hides it immediately. Nothing is written to the database.</em>
            </span>
          </label>
        </>
      ) : (
        <div className="spotify-notice">
          <p>
            Automatic detection runs in the desktop app, which can read the system media
            session. A browser cannot see other applications, so there is nothing to read here.
          </p>
        </div>
      )}
    </div>
  );
}
