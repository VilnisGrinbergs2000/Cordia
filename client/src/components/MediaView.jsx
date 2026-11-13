import { useEffect, useRef, useState } from 'react';
import { Image as ImageIcon, Loader2, Plus, UploadCloud } from 'lucide-react';
import api from '../api';
import ImageViewer from './ImageViewer';

// A channel that shows only what people attached. The messages are ordinary
// messages — this is a different way of reading them, not a different store.
// That is also why "adding" to a gallery is just posting: the same composer
// rules apply, so the drop target below is a shortcut, not a second uploader.
export default function MediaView({ channel, canAttach = false, onBackToList }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [before, setBefore] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [viewing, setViewing] = useState(null);
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef(null);

  async function load(cursor) {
    const query = '/api/channels/' + channel.id + '/messages?limit=100' + (cursor ? '&before=' + cursor : '');
    const data = await api.get(query);
    const found = (data.messages || [])
      .filter((message) => message.attachment?.url)
      .map((message) => ({
        id: message.id,
        url: message.attachment.url,
        name: message.attachment.name || '',
        type: message.attachment.type || '',
        author: message.author?.displayName || '',
        at: message.createdAt
      }));
    return found;
  }

  useEffect(() => {
    let cancelled = false;
    load(null)
      .then((found) => {
        if (!cancelled) {
          setItems(found);
          setBefore(found.length ? found[found.length - 1].id : null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setItems([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [channel.id]);

  async function more() {
    if (!before) return;
    setLoadingMore(true);
    try {
      const found = await load(before);
      setItems((current) => [...(current || []), ...found]);
      if (found.length) setBefore(found[found.length - 1].id);
      else setBefore(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingMore(false);
    }
  }

  // Each file becomes its own message, which is what makes it show up as its own
  // tile. Files are posted one at a time so a single bad one does not lose the
  // rest, and the failures are reported together at the end.
  async function addFiles(fileList) {
    const files = Array.from(fileList || []).filter(Boolean);
    if (!files.length || !canAttach) return;
    setError('');
    setUploading(files.length);
    const added = [];
    const failures = [];
    for (const file of files) {
      try {
        const uploaded = await api.upload(file);
        const posted = await api.post('/api/channels/' + channel.id + '/messages', {
          content: '',
          attachment: uploaded.attachment
        });
        const message = posted.message;
        added.push({
          id: message.id,
          url: message.attachment?.url || uploaded.attachment.url,
          name: message.attachment?.name || file.name,
          type: message.attachment?.type || file.type,
          author: message.author?.displayName || '',
          at: message.createdAt
        });
      } catch (err) {
        failures.push(file.name + ': ' + err.message);
      } finally {
        setUploading((count) => Math.max(0, count - 1));
      }
    }
    if (added.length) setItems((current) => [...added, ...(current || [])]);
    if (failures.length) setError(failures.join(' · '));
    if (fileRef.current) fileRef.current.value = '';
  }

  function onDrop(event) {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer?.files);
  }

  const canAdd = canAttach && !uploading;

  return (
    <div
      className={`tool-view media-view${dragging ? ' is-dragging' : ''}`}
      onDragOver={(event) => {
        if (!canAttach) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        setDragging(false);
      }}
      onDrop={canAttach ? onDrop : undefined}
    >
      <div className="tool-head">
        <div>
          <span className="eyebrow-mini">Gallery</span>
          <h2>#{channel.name}</h2>
        </div>
        <div className="tool-head-actions">
          {canAttach && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => fileRef.current?.click()}
              disabled={!canAdd}
            >
              {uploading ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
              {uploading ? 'Adding…' : 'Add images'}
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm mobile-only" onClick={onBackToList}>
            Back
          </button>
        </div>
      </div>

      {canAttach && (
        <input
          ref={fileRef}
          type="file"
          multiple
          className="media-file-input"
          onChange={(event) => addFiles(event.target.files)}
        />
      )}

      {error && <div className="form-error">{error}</div>}

      {items === null ? (
        <div className="tool-empty">
          <Loader2 size={16} className="spin" /> Loading…
        </div>
      ) : items.length === 0 ? (
        <div className="media-empty">
          <span className="media-empty-art">
            <ImageIcon size={26} />
          </span>
          <h3>Nothing shared here yet</h3>
          <p>
            This channel keeps pictures and files instead of a conversation. Anything
            posted here becomes a tile: drop files anywhere on this page, or use the
            button below.
          </p>
          {canAttach ? (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => fileRef.current?.click()}
              disabled={!canAdd}
            >
              {uploading ? <Loader2 size={14} className="spin" /> : <UploadCloud size={14} />}
              {uploading ? 'Adding…' : 'Choose files'}
            </button>
          ) : (
            <p className="media-empty-note">
              You need permission to attach files in this channel.
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="media-grid">
            {items.map((item) =>
              item.type.startsWith('image/') ? (
                <button
                  type="button"
                  className="media-tile"
                  key={item.id}
                  onClick={() => setViewing(item)}
                  title={item.name || 'Open image'}
                >
                  <img src={item.url} alt={item.name} loading="lazy" />
                  <span className="media-meta">{item.author}</span>
                </button>
              ) : (
                <a className="media-tile" href={item.url} download={item.name} key={item.id}>
                  <span className="media-file">
                    <ImageIcon size={18} />
                    {item.name || 'File'}
                  </span>
                  <span className="media-meta">{item.author}</span>
                </a>
              )
            )}
          </div>
          {before && (
            <div className="tool-more">
              <button type="button" className="btn btn-ghost btn-sm" onClick={more} disabled={loadingMore}>
                {loadingMore ? <Loader2 size={14} className="spin" /> : null} Load older
              </button>
            </div>
          )}
        </>
      )}

      {dragging && (
        <div className="media-drop">
          <UploadCloud size={28} />
          <strong>Drop to add to #{channel.name}</strong>
          <span>Each file becomes its own tile.</span>
        </div>
      )}

      {viewing && (
        <ImageViewer src={viewing.url} name={viewing.name} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}
