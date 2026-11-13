import { useEffect, useState } from 'react';
import { Check, Lightbulb, Loader2, ThumbsUp, Trash2 } from 'lucide-react';
import ServerIcon from './ServerIcon';
import ServerIconCropModal from './ServerIconCropModal';
import api from '../api';
import { hasServerPermission } from '../permissions';

export default function ServerIconSuggestions({
  server,
  me,
  socket,
  onUpdated
}) {
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [cropFile, setCropFile] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  const canManageServer = hasServerPermission(server, me, 'manageServer');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get(`/api/servers/${server.id}/icon-suggestions`)
      .then((data) => {
        if (!cancelled) setSuggestions(data.suggestions || []);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [server.id, refresh]);

  useEffect(() => {
    if (!socket) return undefined;
    function onSuggestionsChanged(payload) {
      if (Number(payload?.serverId) === Number(server.id)) {
        setRefresh((value) => value + 1);
      }
    }
    socket.on('server:icon-suggestions-changed', onSuggestionsChanged);
    return () => {
      socket.off('server:icon-suggestions-changed', onSuggestionsChanged);
    };
  }, [socket, server.id]);

  function chooseIcon(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Choose an image file for your icon idea.');
      return;
    }
    setError('');
    setCropFile(file);
  }

  async function submit(blob) {
    setBusy('upload');
    setError('');
    try {
      const extension = blob.type === 'image/jpeg' ? 'jpg' : 'webp';
      const file = new File([blob], `icon-idea.${extension}`, {
        type: blob.type || 'image/webp'
      });
      const upload = await api.upload(file);
      const data = await api.post(`/api/servers/${server.id}/icon-suggestions`, {
        iconUrl: upload.attachment.url
      });
      setSuggestions(data.suggestions || []);
      setCropFile(null);
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setBusy('');
    }
  }

  async function vote(suggestion) {
    setBusy(`vote-${suggestion.id}`);
    setError('');
    try {
      const data = await api.post(
        `/api/servers/${server.id}/icon-suggestions/${suggestion.id}/vote`
      );
      setSuggestions(data.suggestions || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function apply(suggestion) {
    setBusy(`apply-${suggestion.id}`);
    setError('');
    try {
      const data = await api.post(
        `/api/servers/${server.id}/icon-suggestions/${suggestion.id}/apply`
      );
      onUpdated(data.server);
      setSuggestions(data.suggestions || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function remove(suggestion) {
    if (!window.confirm('Remove this icon idea?')) return;
    setBusy(`remove-${suggestion.id}`);
    setError('');
    try {
      const data = await api.del(
        `/api/servers/${server.id}/icon-suggestions/${suggestion.id}`
      );
      setSuggestions(data.suggestions || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="icon-suggestions">
      <div className="icon-suggestions-head">
        <div>
          <span className="settings-label">
            <Lightbulb size={13} /> Icon ideas
          </span>
          <p>Share a square icon. Members can vote; managers can apply one.</p>
        </div>
        <label className="btn btn-ghost btn-sm">
          {busy === 'upload' ? <Loader2 size={15} className="spin" /> : <Lightbulb size={15} />}
          Suggest icon
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={chooseIcon}
            disabled={busy === 'upload'}
          />
        </label>
      </div>

      {error && <div className="form-error">{error}</div>}

      {loading ? (
        <div className="icon-suggestions-empty">
          <Loader2 size={18} className="spin" /> Loading icon ideas…
        </div>
      ) : suggestions.length ? (
        <div className="icon-suggestions-grid">
          {suggestions.map((suggestion) => {
            const isCurrent = server.iconUrl === suggestion.iconUrl;
            return (
              <div className="icon-suggestion-card" key={suggestion.id}>
                <div className="icon-suggestion-preview">
                  <ServerIcon
                    server={{
                      ...server,
                      name: server.name,
                      iconUrl: suggestion.iconUrl
                    }}
                  />
                </div>
                <div className="icon-suggestion-meta">
                  <strong>
                    {suggestion.suggestedBy.displayName}
                    {suggestion.mine && <span className="you-tag">you</span>}
                  </strong>
                  <span>
                    {suggestion.voteCount} {suggestion.voteCount === 1 ? 'vote' : 'votes'}
                  </span>
                </div>
                <div className="icon-suggestion-actions">
                  <button
                    className={`btn btn-ghost btn-xs icon-suggestion-vote ${
                      suggestion.myVote ? 'active' : ''
                    }`}
                    onClick={() => vote(suggestion)}
                    disabled={busy === `vote-${suggestion.id}` || busy === 'upload'}
                  >
                    {busy === `vote-${suggestion.id}` ? (
                      <Loader2 size={13} className="spin" />
                    ) : (
                      <ThumbsUp size={13} />
                    )}
                    {suggestion.myVote ? 'Voted' : 'Vote'}
                  </button>
                  {canManageServer && (
                    <button
                      className="icon-btn"
                      title={isCurrent ? 'Current server icon' : 'Use this icon'}
                      aria-label={isCurrent ? 'Current server icon' : 'Use this icon'}
                      onClick={() => apply(suggestion)}
                      disabled={
                        isCurrent || busy === `apply-${suggestion.id}` || busy === 'upload'
                      }
                    >
                      {busy === `apply-${suggestion.id}` ? (
                        <Loader2 size={15} className="spin" />
                      ) : (
                        <Check size={15} />
                      )}
                    </button>
                  )}
                  {(suggestion.mine || canManageServer) && (
                    <button
                      className="icon-btn danger-hover"
                      title="Remove icon idea"
                      aria-label="Remove icon idea"
                      onClick={() => remove(suggestion)}
                      disabled={busy === `remove-${suggestion.id}` || busy === 'upload'}
                    >
                      {busy === `remove-${suggestion.id}` ? (
                        <Loader2 size={15} className="spin" />
                      ) : (
                        <Trash2 size={15} />
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="icon-suggestions-empty">
          <Lightbulb size={18} />
          <span>No icon ideas yet. Add the first one.</span>
        </div>
      )}

      {cropFile && (
        <ServerIconCropModal
          file={cropFile}
          title="Crop icon idea"
          subtitle="Choose the square crop and focal point for your suggestion."
          applyLabel="Add idea"
          onClose={() => busy !== 'upload' && setCropFile(null)}
          onApply={submit}
        />
      )}
    </div>
  );
}
