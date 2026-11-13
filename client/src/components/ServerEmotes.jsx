import { useEffect, useRef, useState } from 'react';
import { Loader2, Lock, Pencil, Plus, Trash2, Upload, Users } from 'lucide-react';
import api from '../api';
import { assetUrl } from '../runtime';
import Modal from './Modal';
import { invalidateMyEmotes } from './EmoteInsertButton';

const KIND_LABEL = { emote: 'Emote', sticker: 'Sticker' };
const KIND_HINT = {
  emote: 'Inline image, 128 KB or smaller works best. Type :name: in chat.',
  sticker: 'Send :name: on its own line to post it at full size.'
};

function cleanName(value) {
  return String(value || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .slice(0, 32);
}

export default function ServerEmotes({ server, canManage, onUpdated }) {
  const emotes = server.emotes || [];
  const [name, setName] = useState('');
  const [kind, setKind] = useState('emote');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [accessEmote, setAccessEmote] = useState(null);
  const [accessIds, setAccessIds] = useState([]);
  const [accessBusy, setAccessBusy] = useState(false);
  const fileRef = useRef(null);
  // The preview URL outlives the picker unless it is revoked on unmount, which
  // leaks the blob for the life of the page.
  const previewRef = useRef('');
  const serverGroups = server.groups || [];

  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);

  useEffect(
    () => () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    },
    []
  );

  // The global picker caches one list per page load. Adding, renaming or
  // deleting an emote here has to drop that cache or a bio opened afterwards
  // would offer a set that no longer matches the server.
  const emoteSignature = emotes.map((emote) => `${emote.id}:${emote.name}`).join(',');
  useEffect(() => {
    invalidateMyEmotes();
  }, [emoteSignature]);

  const sections = [
    { kind: 'emote', items: emotes.filter((emote) => emote.kind !== 'sticker') },
    { kind: 'sticker', items: emotes.filter((emote) => emote.kind === 'sticker') }
  ];

  function chooseFile(event) {
    const picked = event.target.files?.[0];
    event.target.value = '';
    if (!picked) return;
    setError('');
    setFile(picked);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(URL.createObjectURL(picked));
    if (!name) setName(cleanName(picked.name));
  }

  function resetForm() {
    setFile(null);
    setName('');
    if (preview) URL.revokeObjectURL(preview);
    setPreview('');
  }

  async function addEmote(event) {
    event.preventDefault();
    if (!canManage || busy) return;
    if (!file) {
      setError('Choose an image first.');
      return;
    }
    const clean = name.trim();
    if (!/^[a-zA-Z0-9_]{2,32}$/.test(clean)) {
      setError('Names are 2-32 characters and can only use letters, numbers, and underscores.');
      return;
    }
    setBusy('add');
    setError('');
    try {
      const uploaded = await api.upload(file);
      const url = uploaded?.attachment?.url;
      if (!url) throw new Error('Upload failed.');
      const data = await api.post(`/api/servers/${server.id}/emotes`, { name: clean, url, kind });
      onUpdated?.(data.server);
      resetForm();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function removeEmote(emote) {
    if (!canManage || busy) return;
    if (!window.confirm(`Delete :${emote.name}: from this server?`)) return;
    setBusy(`delete-${emote.id}`);
    setError('');
    try {
      const data = await api.del(`/api/servers/${server.id}/emotes/${emote.id}`);
      onUpdated?.(data.server);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function renameEmote(emote) {
    if (!canManage || busy) return;
    const next = window.prompt(`Rename :${emote.name}:`, emote.name);
    if (next === null) return;
    const clean = next.trim().replace(/^:+|:+$/g, '');
    if (clean === emote.name) return;
    if (!/^[a-zA-Z0-9_]{2,32}$/.test(clean)) {
      setError('Names are 2-32 characters and can only use letters, numbers, and underscores.');
      return;
    }
    setBusy(`rename-${emote.id}`);
    setError('');
    try {
      const data = await api.patch(`/api/servers/${server.id}/emotes/${emote.id}`, { name: clean });
      onUpdated?.(data.server);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  function openAccess(emote) {
    if (!canManage || busy) return;
    setError('');
    setAccessIds(emote.groupIds || []);
    setAccessEmote(emote);
  }

  function toggleAccess(groupId) {
    setAccessIds((prev) =>
      prev.includes(groupId) ? prev.filter((entry) => entry !== groupId) : [...prev, groupId]
    );
  }

  async function saveAccess() {
    if (!accessEmote || accessBusy) return;
    setAccessBusy(true);
    setError('');
    try {
      const data = await api.patch(`/api/servers/${server.id}/emotes/${accessEmote.id}`, {
        restrictedGroupIds: accessIds
      });
      onUpdated?.(data.server);
      setAccessEmote(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setAccessBusy(false);
    }
  }

  return (
    <div className="server-settings">
      <div className="settings-section-head">
        <div>
          <h3>Emotes and stickers</h3>
          <p>Upload images this server can use in messages and reactions.</p>
        </div>
      </div>

      {error && <div className="form-error">{error}</div>}

      {canManage && (
        <form className="emote-uploader" onSubmit={addEmote}>
          <button
            type="button"
            className="emote-drop"
            onClick={() => fileRef.current?.click()}
            disabled={!!busy}
          >
            {preview ? (
              <img src={preview} alt="Preview" />
            ) : (
              <>
                <Upload size={18} />
                <span>Choose image</span>
              </>
            )}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
            hidden
            onChange={chooseFile}
          />
          <div className="emote-uploader-fields">
            <label className="field">
              <span>Name</span>
              <div className="emote-name-field">
                <span>:</span>
                <input
                  value={name}
                  onChange={(event) => setName(cleanName(event.target.value))}
                  placeholder="party_parrot"
                  maxLength={32}
                  disabled={!!busy}
                />
                <span>:</span>
              </div>
            </label>
            <label className="field">
              <span>Type</span>
              <select value={kind} onChange={(event) => setKind(event.target.value)} disabled={!!busy}>
                <option value="emote">Emote</option>
                <option value="sticker">Sticker</option>
              </select>
            </label>
            <button type="submit" className="btn btn-primary btn-sm" disabled={!!busy || !file}>
              {busy === 'add' ? <Loader2 size={15} className="spin" /> : <Plus size={15} />}
              Add
            </button>
          </div>
          <small className="field-hint">{KIND_HINT[kind]}</small>
        </form>
      )}

      {sections.map((section) =>
        section.items.length ? (
          <div className="emote-group" key={section.kind}>
            <span className="settings-label">
              {KIND_LABEL[section.kind]}s · {section.items.length}
            </span>
            <div className="emote-grid">
              {section.items.map((emote) => (
                <div className="emote-tile" key={emote.id}>
                  <img src={assetUrl(emote.url)} alt={`:${emote.name}:`} draggable={false} />
                  {emote.restricted && (
                    <span className="emote-lock" title="Restricted to some groups">
                      <Lock size={11} />
                    </span>
                  )}
                  <div className="emote-tile-meta">
                    <code>:{emote.name}:</code>
                    {canManage && (
                      <div className="emote-tile-actions">
                        <button
                          type="button"
                          className="icon-btn"
                          title="Emote access"
                          onClick={() => openAccess(emote)}
                          disabled={!!busy}
                        >
                          <Users size={13} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="Rename"
                          onClick={() => renameEmote(emote)}
                          disabled={!!busy}
                        >
                          {busy === `rename-${emote.id}` ? (
                            <Loader2 size={13} className="spin" />
                          ) : (
                            <Pencil size={13} />
                          )}
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="Delete"
                          onClick={() => removeEmote(emote)}
                          disabled={!!busy}
                        >
                          {busy === `delete-${emote.id}` ? (
                            <Loader2 size={13} className="spin" />
                          ) : (
                            <Trash2 size={13} />
                          )}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null
      )}

      {!emotes.length && (
        <div className="emote-empty">
          <p>No emotes yet. {canManage ? 'Upload one above to get started.' : 'Ask a server manager to add some.'}</p>
        </div>
      )}

      {accessEmote && (
        <Modal
          title={`:${accessEmote.name}: access`}
          subtitle="Pick the groups that can use it. Nothing selected means everyone."
          onClose={() => setAccessEmote(null)}
          width={420}
          footer={
            <div className="emote-access-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setAccessEmote(null)}
                disabled={accessBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={saveAccess}
                disabled={accessBusy}
              >
                {accessBusy ? <Loader2 size={15} className="spin" /> : <Lock size={15} />}
                Save access
              </button>
            </div>
          }
        >
          {serverGroups.length ? (
            <div className="emote-access-list">
              {serverGroups.map((group) => (
                <label className="emote-access-row" key={group.id}>
                  <input
                    type="checkbox"
                    checked={accessIds.includes(group.id)}
                    onChange={() => toggleAccess(group.id)}
                  />
                  <span className="group-color-dot" style={{ background: group.color }} />
                  <span>{group.name}</span>
                  {group.isDefault && <small>All members</small>}
                </label>
              ))}
            </div>
          ) : (
            <p className="field-hint">This server has no groups yet.</p>
          )}
          {error && <div className="form-error">{error}</div>}
        </Modal>
      )}
    </div>
  );
}
