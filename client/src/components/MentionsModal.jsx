import { useEffect, useState } from 'react';
import { AtSign, Hash, MessageSquare, RefreshCw } from 'lucide-react';
import api from '../api';
import { formatDateTime } from '../utils';
import Avatar from './Avatar';
import Modal from './Modal';

function MentionText({ content }) {
  const parts = String(content || '').split(/(@[a-zA-Z0-9._-]{2,24})/g);
  return parts.map((part, index) =>
    part.startsWith('@') ? (
      <strong className="mention-inbox-token" key={`${part}-${index}`}>
        {part}
      </strong>
    ) : (
      part
    )
  );
}

export default function MentionsModal({ onClose, onOpenMention }) {
  const [state, setState] = useState({ loading: true, error: '', mentions: [] });

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: '' }));
    api
      .get('/api/mentions')
      .then((payload) => {
        if (!cancelled) setState({ loading: false, error: '', mentions: payload.mentions || [] });
      })
      .catch((error) => {
        if (!cancelled) setState({ loading: false, error: error.message, mentions: [] });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Modal
      title="Mentions"
      subtitle="Messages that need your attention, newest first."
      onClose={onClose}
      width={580}
    >
      {state.loading && (
        <div className="mention-inbox-empty">
          <RefreshCw size={22} className="spin" />
          <p>Loading mentions…</p>
        </div>
      )}
      {state.error && (
        <div className="form-error">
          <strong>Could not load mentions.</strong>
          <span>{state.error}</span>
        </div>
      )}
      {!state.loading && !state.error && state.mentions.length === 0 && (
        <div className="mention-inbox-empty">
          <AtSign size={26} />
          <h3>You are all caught up</h3>
          <p>When someone mentions you or replies to your message, it will show up here.</p>
        </div>
      )}
      {!state.loading && !state.error && state.mentions.length > 0 && (
        <div className="mention-inbox-list">
          {state.mentions.map((entry) => {
            const scopeIcon =
              entry.scopeType === 'dm' ? <MessageSquare size={12} /> : <Hash size={12} />;
            return (
              <button
                type="button"
                className={`mention-inbox-row ${entry.readAt ? '' : 'unread'}`}
                key={entry.id}
                onClick={() => onOpenMention(entry)}
              >
                <Avatar user={entry.message.author} size={36} />
                <span className="mention-inbox-copy">
                  <span className="mention-inbox-meta">
                    <strong>{entry.message.author.displayName}</strong>
                    <span className="mention-inbox-scope">
                      {scopeIcon}
                      {entry.scopeType === 'dm' ? 'Direct message' : entry.scopeName}
                      {entry.serverName ? ` · ${entry.serverName}` : ''}
                    </span>
                    <time>{formatDateTime(entry.createdAt)}</time>
                  </span>
                  <span className="mention-inbox-preview">
                    <MentionText content={entry.message.content} />
                    {entry.message.attachment?.name ? (
                      <span className="mention-inbox-attachment">{entry.message.attachment.name}</span>
                    ) : null}
                  </span>
                </span>
                {!entry.readAt && <span className="mention-inbox-dot" aria-label="Unread mention" />}
              </button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
