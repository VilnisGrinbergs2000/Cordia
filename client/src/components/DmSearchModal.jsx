import { useEffect, useRef, useState } from 'react';
import { LockKeyhole, Loader2, Search, ShieldCheck } from 'lucide-react';
import Modal from './Modal';
import api from '../api';
import { decryptDmMessage, useE2ee } from '../e2ee';
import { formatDateTime } from '../utils';

const PAGE_SIZE = 100;
const MAX_MESSAGES = 500;

async function loadRecentMessages(dmId) {
  const collected = [];
  let before = null;
  for (let page = 0; page < MAX_MESSAGES / PAGE_SIZE; page += 1) {
    const suffix = before ? `&before=${before}` : '';
    const data = await api.get(`/api/dms/${dmId}/messages?limit=${PAGE_SIZE}${suffix}`);
    const messages = data.messages || [];
    collected.push(...messages);
    if (!data.hasMore || !messages.length) break;
    before = messages[messages.length - 1].id;
  }
  return collected.reverse();
}

export default function DmSearchModal({ dm, onClose, onJump }) {
  const e2ee = useE2ee();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scanned, setScanned] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function submit(event) {
    event.preventDefault();
    const needle = query.trim();
    if (needle.length < 2) return;
    if (e2ee.status !== 'ready') {
      setError('Unlock encrypted messages before searching this conversation.');
      return;
    }
    setBusy(true);
    setError('');
    setResults(null);
    try {
      const messages = await loadRecentMessages(dm.id);
      const decrypted = await Promise.all(
        messages.map(async (message) => {
          let text = message.content || '';
          let attachmentName = message.attachment?.name || '';
          if (message.encrypted && message.envelope) {
            try {
              const payload = await decryptDmMessage(message.envelope, {
                peerPublicKey: dm.user.e2eePublicKey,
                peerId: dm.user.id
              });
              text = payload.text || '';
              attachmentName = payload.attachment?.name || attachmentName;
            } catch {
              return null;
            }
          }
          const displayText = text || attachmentName;
          if (!displayText) return null;
          if (!`${text}\n${attachmentName}`.toLowerCase().includes(needle.toLowerCase())) {
            return null;
          }
          return { ...message, dmId: dm.id, displayText };
        })
      );
      setScanned(messages.length);
      setResults(decrypted.filter(Boolean));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Search this conversation"
      subtitle={`Messages with ${dm.user.displayName} are decrypted on this device for search.`}
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
            placeholder="Search messages on this device"
          />
        </label>
        <button className="btn btn-primary btn-sm" disabled={busy || query.trim().length < 2}>
          {busy ? <Loader2 size={15} className="spin" /> : <Search size={15} />} Search
        </button>
      </form>

      <div className="search-scope-note">
        <ShieldCheck size={14} />
        <span>
          Local only. Up to {MAX_MESSAGES} recent messages are decrypted in this browser and
          nothing is sent to the server.
        </span>
      </div>

      {e2ee.status !== 'ready' && (
        <div className="search-locked">
          <LockKeyhole size={17} />
          <span>Unlock encrypted messages to search this conversation.</span>
        </div>
      )}

      {error && <div className="form-error">{error}</div>}

      <div className="search-results">
        {results === null ? (
          <div className="search-empty">
            <Search size={26} />
            <p>Search decrypted direct messages without sending your query to the server.</p>
          </div>
        ) : results.length === 0 ? (
          <div className="search-empty">
            <p>No messages matched “{query}” in {scanned} recent message(s).</p>
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
                  <LockKeyhole size={12} /> Direct message
                </span>
                <span>{result.author.displayName}</span>
                <span>{formatDateTime(result.createdAt)}</span>
              </div>
              <p>{result.displayText}</p>
            </button>
          ))
        )}
      </div>
    </Modal>
  );
}
