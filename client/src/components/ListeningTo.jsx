import { useEffect, useState } from 'react';
import { Music } from 'lucide-react';

// One activity object is shared by three surfaces at different sizes: the line
// under a name, the member list row, and the profile card. They all want the
// same words, so the words live here.

export function activityText(activity) {
  if (!activity) return '';
  return activity.artist ? `${activity.track} - ${activity.artist}` : activity.track;
}

/**
 * The player reports a position when it is asked, not continuously, so the bar
 * counts forward from the sample. Every mount ticks once a second, which is
 * fine: only one profile or menu is open at a time.
 */
function useElapsed(activity) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!activity) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activity]);
  if (!activity || !activity.durationMs) return 0;
  const drift = Math.max(0, now - (activity.sampledAt || now));
  return Math.min(activity.durationMs, activity.progressMs + drift);
}

function Art({ activity, size }) {
  if (activity.albumArt) {
    return <img className="listening-art" src={activity.albumArt} alt="" width={size} height={size} />;
  }
  return (
    <span className="listening-art listening-art--empty" style={{ width: size, height: size }}>
      <Music size={Math.round(size * 0.42)} />
    </span>
  );
}

/** The one-line form: what the sidebar shows under a display name. */
export function ListeningLine({ activity }) {
  if (!activity) return null;
  return (
    <span className="listening-line" title={activityText(activity)}>
      <span className="listening-bars" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="listening-line-text">{activity.track}</span>
    </span>
  );
}

/** The card form: profile, and the top of the status menu. */
export default function ListeningTo({ activity, compact = false }) {
  const elapsed = useElapsed(activity);
  if (!activity) return null;
  const percent = activity.durationMs ? Math.min(100, (elapsed / activity.durationMs) * 100) : 0;
  return (
    <div className={`listening-card${compact ? ' listening-card--compact' : ''}`}>
      <Art activity={activity} size={compact ? 38 : 56} />
      <div className="listening-body">
        <span className="listening-source">
          <span className="listening-bars" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          Listening to {activity.source || 'Desktop'}
        </span>
        <strong className="listening-track" title={activity.track}>{activity.track}</strong>
        {activity.artist && <span className="listening-artist">{activity.artist}</span>}
        {!compact && activity.durationMs > 0 && (
          <span className="listening-progress" aria-hidden="true">
            <i style={{ width: percent + '%' }} />
          </span>
        )}
      </div>
    </div>
  );
}
