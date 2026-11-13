import { HardDrive, Loader2 } from 'lucide-react';
import StorageManager from './StorageManager';
import { useSupport } from '../support';

function bytes(value) {
  const size = Number(value) || 0;
  if (size >= 1024 ** 3) {
    const gb = size / 1024 ** 3;
    return `${gb % 1 === 0 ? gb : gb.toFixed(1)} GB`;
  }
  if (size >= 1024 ** 2) {
    const mb = size / 1024 ** 2;
    return `${mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
  }
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

// Its own tab rather than a card under Support: the quota is an account fact,
// not a donation pitch, and it is the one place that can free up space.
export default function StorageSettings() {
  const { storage, loading, error, refresh } = useSupport();
  const percent = storage.quota > 0 ? Math.min(100, (storage.used / storage.quota) * 100) : 0;
  const tone = percent > 95 ? 'danger' : percent > 80 ? 'warn' : 'ok';

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <div>
          <h1>Storage</h1>
          <p>
            Every file you upload counts against {bytes(storage.quota)} of account space, on every
            device. Nothing here is ever deleted for you.
          </p>
        </div>
      </div>

      <div className="settings-group">
        {error && <div className="form-error">{error}</div>}
        {loading && !storage.used ? (
          <div className="storage-meter">
            <Loader2 size={15} className="spin" />
          </div>
        ) : (
          <>
            <div className={`storage-meter storage-meter-${tone}`}>
              <div className="storage-meter-head">
                <span className="settings-label">
                  <HardDrive size={13} /> Storage
                </span>
                <span className="storage-meter-figure">
                  {bytes(storage.used)} of {bytes(storage.quota)}
                </span>
              </div>
              <div
                className="storage-meter-track"
                role="progressbar"
                aria-label={`Account storage used: ${bytes(storage.used)} of ${bytes(storage.quota)}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(percent)}
                aria-valuetext={`${Math.round(percent)} percent used`}
              >
                <span className="storage-meter-fill" style={{ width: `${percent}%` }} />
              </div>
              <p className="storage-meter-note">
                {tone === 'ok'
                  ? `${Math.round(percent)}% of your account storage is in use.`
                  : 'You are running out of space. Delete a few files you no longer need.'}
              </p>
            </div>
            <StorageManager onChanged={refresh} />
          </>
        )}
      </div>
    </section>
  );
}
