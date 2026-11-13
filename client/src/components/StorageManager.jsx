import { useCallback, useEffect, useState } from 'react';
import { HardDrive, Loader2, Trash2 } from 'lucide-react';
import api from '../api';

function size(value) {
  const n = Number(value) || 0;
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(n % 1024 ** 3 === 0 ? 0 : 1) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(n >= 100 * 1024 ** 2 ? 0 : 1) + ' MB';
  if (n >= 1024) return Math.round(n / 1024) + ' KB';
  return n + ' B';
}

function day(value) {
  if (!value) return '';
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// The quota meter says how full the account is; this says what filled it and
// lets the owner delete a file. Files still referenced by a message, avatar,
// banner or emote are marked and cannot be removed from here.
export default function StorageManager({ onChanged }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const payload = await api.get('/api/support/me/storage');
      setData(payload);
      setError('');
    } catch (err) {
      setError(err.message || 'Could not load your files.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function remove(file) {
    if (busy) return;
    setBusy(file.name);
    setNotice('');
    try {
      await api.del('/api/support/me/storage/' + encodeURIComponent(file.name));
      setNotice('Deleted ' + file.name);
      await load();
      onChanged?.();
    } catch (err) {
      setError(err.message || 'Could not delete that file.');
    } finally {
      setBusy('');
    }
  }

  async function clearUnused() {
    const unused = (data?.files || []).filter((file) => !file.inUse);
    if (!unused.length || busy) return;
    setBusy('*');
    setNotice('');
    let removed = 0;
    for (const file of unused) {
      try {
        await api.del('/api/support/me/storage/' + encodeURIComponent(file.name));
        removed += 1;
      } catch {
        // A file that became attached while this ran stays; the reload below
        // shows it as in use rather than failing the whole sweep.
      }
    }
    setNotice(removed ? `Deleted ${removed} unused ${removed === 1 ? 'file' : 'files'}.` : 'Nothing to delete.');
    await load();
    onChanged?.();
    setBusy('');
  }

  const files = data?.files || [];
  const unused = files.filter((file) => !file.inUse);
  const reclaimable = unused.reduce((total, file) => total + file.bytes, 0);

  return (
    <div className="storage-manager">
      <div className="storage-manager-head">
        <div>
          <h3>Your uploads</h3>
          <p>
            Every file you upload counts against your quota. Files used by a message, profile or
            emote have to be removed there first.
          </p>
        </div>
        {unused.length > 0 && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={clearUnused}
            disabled={!!busy}
          >
            {busy === '*' ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
            Free up {size(reclaimable)}
          </button>
        )}
      </div>

      {error && <div className="form-error">{error}</div>}
      {notice && <div className="form-success">{notice}</div>}

      {loading ? (
        <p className="storage-empty">
          <Loader2 size={15} className="spin" /> Loading files…
        </p>
      ) : files.length === 0 ? (
        <p className="storage-empty">
          <HardDrive size={15} /> Nothing uploaded yet.
        </p>
      ) : (
        <ul className="storage-list">
          {files.map((file) => (
            <li key={file.name} className="storage-row">
              <span className="storage-name" title={file.name}>
                {file.name}
              </span>
              <span className="storage-meta">
                {size(file.bytes)}
                {file.createdAt && ' · ' + day(file.createdAt)}
              </span>
              {file.inUse ? (
                <span className="storage-tag" title={`Used by: ${file.usage.join(', ')}`}>
                  {file.usage[0]}
                </span>
              ) : (
                <span className="storage-tag is-free">Unused</span>
              )}
              <button
                type="button"
                className="icon-btn danger-hover"
                onClick={() => remove(file)}
                disabled={!!busy || file.inUse}
                title={file.inUse ? 'Still in use' : 'Delete this file'}
                aria-label={`Delete ${file.name}`}
              >
                {busy === file.name ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <Trash2 size={14} />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
