import { useEffect, useState } from 'react';
import { Hash, Inbox, MessageSquare, RefreshCw } from 'lucide-react';
import api from '../api';
import { initials } from '../utils';
import Modal from './Modal';

function since(timestamp) {
  if (!timestamp) return '';
  const diff = Date.now() - Number(timestamp);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(Number(timestamp)).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function participantLine(entry) {
  const names = (entry.participants || []).slice(0, 3).map((person) => person.displayName);
  if (!names.length) return '';
  const joined =
    entry.participants.length > 3 ? `${names.join(', ')} and others` : names.join(', ');
  return joined;
}

export default function AwayModal({ onClose, onOpenScope, excludeScope, onCleared }) {
  const [state, setState] = useState({ loading: true, error: '', conversations: [], total: 0 });
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get(excludeScope ? `/api/catchup/summary?exclude=${encodeURIComponent(excludeScope)}` : '/api/catchup/summary')
      .then((payload) => {
        if (!cancelled) {
          setState({
            loading: false,
            error: '',
            conversations: payload.conversations || [],
            total: payload.total || 0
          });
        }
      })
      .catch((error) => {
        if (!cancelled) setState({ loading: false, error: error.message, conversations: [], total: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, [excludeScope]);

  async function markAllRead() {
    if (clearing) return;
    setClearing(true);
    try {
      const payload = await api.post('/api/read/all', {});
      onCleared?.(payload?.cleared || []);
      onClose?.();
    } catch (error) {
      setState((prev) => ({ ...prev, error: error.message }));
      setClearing(false);
    }
  }

  const unreadTotal = state.conversations.reduce((sum, entry) => sum + entry.unread, 0);

  return (
    <Modal
      title="Catch up"
      subtitle={
        state.conversations.length
          ? `${unreadTotal} new message${unreadTotal === 1 ? '' : 's'} across ${state.conversations.length} conversation${state.conversations.length === 1 ? '' : 's'}.`
          : 'Everything that moved while you were away.'
      }
      onClose={onClose}
      width={600}
      footer={
        state.conversations.length > 0 ? (
          <div className="away-actions">
            <span className="away-actions-count">
              {unreadTotal} unread message{unreadTotal === 1 ? '' : 's'}
            </span>
            <button className="btn btn-primary btn-sm" onClick={markAllRead} disabled={clearing}>
              {clearing ? 'Clearing…' : 'Mark all read'}
            </button>
          </div>
        ) : null
      }
    >
      {state.loading && (
        <div className="mention-inbox-empty">
          <RefreshCw size={22} className="spin" />
          <p>Gathering what you missed…</p>
        </div>
      )}

      {state.error && (
        <div className="form-error">
          <strong>Could not load your catch-up list.</strong>
          <span>{state.error}</span>
        </div>
      )}

      {!state.loading && !state.error && state.conversations.length === 0 && (
        <div className="mention-inbox-empty">
          <Inbox size={26} />
          <h3>You are all caught up</h3>
          <p>When a conversation has something new for you, it will show up here.</p>
        </div>
      )}

      {!state.loading && !state.error && state.conversations.length > 0 && (
        <div className="away-list">
          {state.conversations.map((entry) => {
            const people = participantLine(entry);
            const isDm = entry.scopeType === 'dm';
            return (
              <button
                type="button"
                className="away-row"
                key={`${entry.scopeType}:${entry.scopeId}`}
                onClick={() => onOpenScope(entry)}
              >
                <span className="away-icon">
                  {isDm ? <span className="away-initials">{initials(entry.name)}</span> : <Hash size={16} />}
                </span>
                <span className="away-copy">
                  <span className="away-top">
                    <strong>{entry.name}</strong>
                    {entry.serverName && <span className="away-scope">{entry.serverName}</span>}
                    <span className="away-count">{entry.unread > 99 ? '99+' : entry.unread}</span>
                  </span>
                  {entry.lastMessage && (
                    <span className="away-preview">
                      <b>{entry.lastMessage.authorName}</b> {entry.lastMessage.excerpt}
                    </span>
                  )}
                  <span className="away-foot">
                    {isDm ? <MessageSquare size={11} /> : <Hash size={11} />}
                    <span className="away-people">{people || 'New activity'}</span>
                    {entry.mentions > 0 && (
                      <em className="away-mention">
                        {entry.mentions} {entry.mentions === 1 ? 'mention' : 'mentions'}
                      </em>
                    )}
                    <span className="away-time">{since(entry.lastMessage?.createdAt)}</span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
