import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Download, Loader2, RefreshCw, Rocket, Sparkles } from 'lucide-react';
import { RELEASES, LATEST_RELEASE } from '../changelog';

const DESKTOP = typeof window !== 'undefined' ? window.cordiaDesktop : null;

const IDLE_STATUS = {
  status: DESKTOP?.updates ? 'idle' : 'unavailable',
  currentVersion: '',
  version: '',
  percent: 0,
  error: ''
};

function statusLine(status) {
  switch (status.status) {
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return status.version ? `Version ${status.version} is available` : 'An update is available';
    case 'downloading':
      return `Downloading update · ${status.percent}%`;
    case 'downloaded':
      return status.version ? `Version ${status.version} is ready to install` : 'Update ready to install';
    case 'current':
      return 'You are on the latest version';
    case 'error':
      return status.error || 'Could not check for updates';
    case 'disabled':
      return status.error || 'Updates are not available in this build';
    case 'unavailable':
      return 'Updates are managed by your browser on the web build';
    default:
      return 'Ready to check for updates';
  }
}

function statusTone(status) {
  if (status.status === 'error') return 'warn';
  if (status.status === 'available' || status.status === 'downloaded') return 'good';
  return 'neutral';
}

export default function UpdatesPanel() {
  const [status, setStatus] = useState(IDLE_STATUS);
  const [info, setInfo] = useState({ version: LATEST_RELEASE.version, packaged: false });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!DESKTOP) return undefined;
    let alive = true;

    DESKTOP.appInfo?.()
      .then((value) => {
        if (alive && value) setInfo(value);
      })
      .catch(() => {});

    if (!DESKTOP.updates) return () => { alive = false; };

    DESKTOP.updates.status().then((value) => {
      if (alive && value) setStatus(value);
    }).catch(() => {});

    const off = DESKTOP.updates.onStatus((value) => {
      if (alive && value) setStatus(value);
    });

    return () => {
      alive = false;
      off?.();
    };
  }, []);

  const version = info.packaged && info.version ? info.version : LATEST_RELEASE.version;
  const line = statusLine(status);
  const tone = statusTone(status);

  const action = useMemo(() => {
    if (!DESKTOP?.updates) return null;
    if (status.status === 'available') {
      return { label: 'Download update', icon: Download, run: () => DESKTOP.updates.download() };
    }
    if (status.status === 'downloaded') {
      return { label: 'Restart and install', icon: Rocket, run: async () => { DESKTOP.updates.install(); } };
    }
    if (status.status === 'checking' || status.status === 'downloading') return null;
    if (status.status === 'disabled' || status.status === 'unavailable') return null;
    return { label: 'Check for updates', icon: RefreshCw, run: () => DESKTOP.updates.check() };
  }, [status.status]);

  async function trigger() {
    if (!action || busy) return;
    setBusy(true);
    try {
      const next = await action.run();
      if (next && next.status) setStatus(next);
    } catch (error) {
      setStatus((prev) => ({ ...prev, status: 'error', error: String(error?.message || error) }));
    } finally {
      setBusy(false);
    }
  }

  const working = busy || status.status === 'checking' || status.status === 'downloading';

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <div>
          <h1>Updates</h1>
          <p>See what changed in each release and keep Cordia current.</p>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group-head">
          <h3>This build</h3>
          <p>Version {version}{info.packaged ? '' : ' · development build'}</p>
        </div>
        <div className={`update-card update-card--${tone}`}>
          <div className="update-card-main">
            <span className="update-card-icon">
              {status.status === 'current' ? <CheckCircle2 size={18} /> : <Sparkles size={18} />}
            </span>
            <div>
              <strong>{line}</strong>
              <small>
                {status.status === 'downloading'
                  ? 'You can keep using Cordia while it downloads.'
                  : status.status === 'unavailable'
                    ? 'Install the desktop app to receive updates automatically.'
                    : status.status === 'disabled'
                      ? 'Automatic updates activate in a packaged desktop build.'
                      : 'Cordia checks for updates automatically after launch.'}
              </small>
            </div>
          </div>
          {action && (
            <button className="btn btn-primary btn-sm" onClick={trigger} disabled={working}>
              {working ? <Loader2 size={15} className="spin" /> : <action.icon size={15} />}
              {action.label}
            </button>
          )}
        </div>
        {status.status === 'downloading' && (
          <div className="update-progress" role="progressbar" aria-valuenow={status.percent} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${status.percent}%` }} />
          </div>
        )}
      </div>

      <div className="settings-group">
        <div className="settings-group-head">
          <h3>Release notes</h3>
          <p>Everything that shipped, newest first.</p>
        </div>
        <div className="release-list">
          {RELEASES.map((release, index) => (
            <article className="release-item" key={release.version}>
              <header>
                <strong>{release.title}</strong>
                <span className="release-meta">
                  v{release.version} · {release.date}
                  {index === 0 && <em className="release-latest">Latest</em>}
                </span>
              </header>
              <ul>
                {release.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
