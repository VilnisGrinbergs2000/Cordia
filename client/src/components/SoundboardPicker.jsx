import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Plus, Trash2, X } from 'lucide-react';
import api from '../api';
import { assetUrl } from '../runtime';
import { hasServerPermission } from '../permissions';
import Toast from './Toast';

const MAX_BYTES = 512 * 1024;

export default function SoundboardPicker({ server, channelId, socket, me, open, onClose, onPlayed }) {
  const [sounds, setSounds] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [playingId, setPlayingId] = useState(null);
  const [name, setName] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const fileRef = useRef(null);
  const playersRef = useRef([]);
  const canManage = hasServerPermission(server, me, 'manageSoundboard');

  const load = useCallback(async () => {
    if (!server) return;
    setLoading(true);
    try {
      const data = await api.get(`/api/servers/${server.id}/soundboard`);
      setSounds(Array.isArray(data?.sounds) ? data.sounds : []);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [server?.id]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(timer);
  }, [toast]);

  // Leaving voice must not leave a clip playing: pause and drop the source so
  // each element is released instead of running out in the background.
  useEffect(
    () => () => {
      for (const audio of playersRef.current) {
        try {
          audio.pause();
          audio.removeAttribute('src');
        } catch {
          // The element may already have been discarded by the browser.
        }
      }
      playersRef.current = [];
    },
    []
  );

  function playFile(fileUrl) {
    try {
      // Packaged builds serve cordia://app, so /uploads only resolves through
      // assetUrl. Keep a reference so the element is not collected mid-clip.
      const audio = new Audio(assetUrl(fileUrl));
      playersRef.current.push(audio);
      if (playersRef.current.length > 5) playersRef.current.shift();
      audio.play().catch(() => {});
      return audio;
    } catch {
      return null;
    }
  }

  useEffect(() => {
    if (!socket || !server) return undefined;
    function onPlay(payload) {
      if (!payload?.sound || payload.serverId !== server.id) return;
      if (channelId && payload.channelId !== channelId) return;
      // Our own click already played it locally.
      if (payload.userId === me?.id) return;
      playFile(payload.sound.file);
      onPlayed?.({ userName: payload.userName, name: payload.sound.name });
    }
    socket.on('soundboard:play', onPlay);
    return () => socket.off('soundboard:play', onPlay);
  }, [socket, server?.id, channelId, me?.id, onPlayed]);

  async function play(sound) {
    if (!channelId || playingId) return;
    setPlayingId(sound.id);
    setError('');
    try {
      await api.post(`/api/soundboard/${sound.id}/play`, { channelId });
      playFile(sound.file);
    } catch (err) {
      setError(err.message);
    } finally {
      setPlayingId(null);
    }
  }

  async function remove(sound) {
    // Removing a clip takes it away from everyone in the server, so it needs a
    // confirmation and a result the clicker can see.
    if (!window.confirm(`Delete "${sound.name}" from the soundboard? Everyone loses it.`)) return;
    setError('');
    try {
      await api.del(`/api/soundboard/${sound.id}`);
      setSounds((prev) => prev.filter((entry) => entry.id !== sound.id));
      setToast({
        type: 'success',
        title: 'Sound deleted',
        message: `"${sound.name}" is no longer on the soundboard.`
      });
    } catch (err) {
      setError(err.message);
      setToast({ type: 'error', title: 'Could not delete sound', message: err.message });
    }
  }

  async function add(event) {
    event.preventDefault();
    const clean = name.trim();
    if (!clean) return setError('Give the sound a name.');
    if (!file) return setError('Choose an audio file first.');
    if (file.size > MAX_BYTES) return setError('Clips must be 512 KB or smaller.');
    setBusy(true);
    setError('');
    try {
      const uploaded = await api.upload(file);
      const url = uploaded?.attachment?.url;
      if (!url) throw new Error('Upload failed.');
      await api.post(`/api/servers/${server.id}/soundboard`, {
        name: clean,
        file: url,
        mime: uploaded.attachment.type,
        durationMs: 0
      });
      await load();
      setName('');
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!server || !open) return null;

  return (
    <div className="soundboard-pop" role="dialog" aria-label="Soundboard">
      <div className="soundboard-head">
        <strong>Soundboard</strong>
        <button className="soundboard-close" onClick={onClose} title="Close">
          <X size={14} />
        </button>
      </div>

      {error && <div className="soundboard-error">{error}</div>}

      <div className="soundboard-grid">
        {loading && !sounds.length && (
          <div className="soundboard-empty">
            <Loader2 size={16} className="spin" />
          </div>
        )}
        {!loading && !sounds.length && (
          <div className="soundboard-empty">
            <strong>No sounds yet</strong>
            <span>
              {canManage
                ? 'Upload a clip (512 KB or smaller) and it shows up here for everyone.'
                : 'A server manager can add clips here.'}
            </span>
          </div>
        )}
        {sounds.map((sound) => (
          <div className="soundboard-item" key={sound.id}>
            <button
              className={`soundboard-play ${playingId === sound.id ? 'busy' : ''}`}
              onClick={() => play(sound)}
              title={`Play ${sound.name}`}
              disabled={!channelId}
            >
              {playingId === sound.id ? <Loader2 size={13} className="spin" /> : null}
              <span>{sound.name}</span>
            </button>
            {canManage && (
              <button
                className="soundboard-remove"
                onClick={() => remove(sound)}
                title={`Remove ${sound.name}`}
                aria-label={`Remove ${sound.name}`}
                style={{ minWidth: 36, minHeight: 36 }}
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        ))}
      </div>

      {canManage && (
        <form className="soundboard-add" onSubmit={add}>
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Sound name"
            maxLength={32}
            aria-label="Sound name"
          />
          <input
            ref={fileRef}
            type="file"
            accept="audio/*"
            onChange={(event) => setFile(event.target.files?.[0] || null)}
            aria-label="Audio file"
          />
          <button type="submit" disabled={busy} title="Add sound">
            {busy ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
          </button>
        </form>
      )}

      <Toast toast={toast} />
    </div>
  );
}
