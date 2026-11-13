import { useEffect, useRef, useState } from 'react';
import { Hash, Loader2, Search } from 'lucide-react';
import Modal from './Modal';
import api from '../api';
import { formatDateTime } from '../utils';

export default function SearchModal({ server, onClose, onJump }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function submit(event) {
    event.preventDefault();
    if (query.trim().length < 2) return;
    setBusy(true);
    setError('');
    try {
      const data = await api.get(
        `/api/search?q=${encodeURIComponent(query.trim())}&serverId=${server.id}`
      );
      setResults(data.results);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Search messages"
      subtitle={`Looking through ${server.name}`}
      onClose={onClose}
      width={640}
    >
      <form className="search-form" onSubmit={submit}>
        <label className="search-box">
          <Search size={16} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search words, phrases, secrets…"
          />
        </label>
        <button className="btn btn-primary btn-sm" disabled={busy || query.trim().length < 2}>
          {busy ? <Loader2 size={15} className="spin" /> : <Search size={15} />} Search
        </button>
      </form>

      {error && <div className="form-error">{error}</div>}

      <div className="search-results">
        {results === null ? (
          <div className="search-empty">
            <Search size={26} />
            <p>Search any text channel in this server.</p>
          </div>
        ) : results.length === 0 ? (
          <div className="search-empty">
            <p>No messages matched “{query}”.</p>
          </div>
        ) : (
          results.map((result) => (
            <button
              className="search-result"
              key={result.id}
              onClick={() => {
                onJump(result);
                onClose();
              }}
            >
              <div className="search-result-meta">
                <span className="search-channel">
                  <Hash size={13} /> {result.channelName}
                </span>
                <span>{result.author.displayName}</span>
                <span>{formatDateTime(result.createdAt)}</span>
              </div>
              <p>{result.content}</p>
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}
