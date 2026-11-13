import { useEffect, useState } from 'react';
import { Bell, Bookmark, Loader2, Trash2 } from 'lucide-react';
import Modal from './Modal';
import Avatar from './Avatar';
import api from '../api';
import { formatDate } from '../utils';

// Two lists with the same shape and the same job — "things I meant to come back
// to" — so they share one panel instead of two entry points in the sidebar.
function whenText(timestamp, delivered) {
  const now = Date.now();
  const delta = timestamp - now;
  const minutes = Math.round(Math.abs(delta) / 60000);
  const say = (value, unit) => (value === 1 ? '1 ' + unit : value + ' ' + unit + 's');
  const relative =
    minutes < 60
      ? say(Math.max(1, minutes), 'minute')
      : minutes < 60 * 24
        ? say(Math.round(minutes / 60), 'hour')
        : say(Math.round(minutes / (60 * 24)), 'day');
  if (delivered) return 'came back ' + relative + ' ago';
  return delta <= 0 ? 'due now' : 'in ' + relative;
}

export default function SavedModal({ onClose, onOpenSavedMessage }) {
  const [tab, setTab] = useState('saved');
  const [items, setItems] = useState(null);
  const [reminders, setReminders] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/api/saved')
      .then((data) => {
        if (!cancelled) setItems(data.saved || []);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setItems([]);
        }
      });
    api
      .get('/api/reminders')
      .then((data) => {
        if (!cancelled) setReminders(data.reminders || []);
      })
      .catch(() => {
        if (!cancelled) setReminders([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function remove(item) {
    setBusy(item.id);
    setError('');
    try {
      await api.del('/api/messages/' + item.messageId + '/save');
      setItems((list) => (list || []).filter((entry) => entry.id !== item.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(0);
    }
  }

  async function removeReminder(reminder) {
    setBusy(reminder.id);
    setError('');
    try {
      await api.del('/api/reminders/' + reminder.id);
      setReminders((list) => (list || []).filter((entry) => entry.id !== reminder.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(0);
    }
  }

  const pending = (reminders || []).filter((reminder) => !reminder.deliveredAt);

  return (
    <Modal onClose={onClose} width={620} className="saved-modal" ariaLabel="Bookmarks and reminders">
      <div className="saved-head">
        <div>
          <span className="eyebrow-mini">Personal</span>
          <h2>{tab === 'saved' ? 'Bookmarks' : 'Reminders'}</h2>
          <p>
            {tab === 'saved'
              ? 'Messages you saved. Only you can see this list.'
              : 'Messages Cordia will bring back to you. Only you can see this list.'}
          </p>
        </div>
        {tab === 'saved' ? <Bookmark size={20} /> : <Bell size={20} />}
      </div>

      <div className="saved-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'saved'}
          className={'saved-tab' + (tab === 'saved' ? ' active' : '')}
          onClick={() => setTab('saved')}
        >
          Bookmarks{items ? ' · ' + items.length : ''}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'reminders'}
          className={'saved-tab' + (tab === 'reminders' ? ' active' : '')}
          onClick={() => setTab('reminders')}
        >
          Reminders{pending.length ? ' · ' + pending.length : ''}
        </button>
      </div>

      {error && <div className="form-error">{error}</div>}

      {tab === 'saved' ? (
        items === null ? (
          <div className="saved-empty">
            <Loader2 size={18} className="spin" />
            <span>Loading…</span>
          </div>
        ) : items.length === 0 ? (
          <div className="saved-empty">
            <Bookmark size={22} />
            <strong>Nothing saved yet</strong>
            <span>Right-click a message and choose Save message.</span>
          </div>
        ) : (
          <div className="saved-list">
            {items.map((item) => (
              <div className="saved-row" key={item.id}>
                <Avatar user={item.author} size={34} />
                <div className="saved-body">
                  <div className="saved-meta">
                    <strong>{item.author.displayName}</strong>
                    <span>
                      {item.scopeType === 'dm'
                        ? 'Direct message with ' + item.channelName
                        : '#' + item.channelName + (item.serverName ? ' · ' + item.serverName : '')}
                    </span>
                    <small>{formatDate(item.createdAt)}</small>
                  </div>
                  <p className="saved-text">
                    {item.encrypted
                      ? 'Encrypted message — open it in the conversation.'
                      : item.content}
                  </p>
                </div>
                <div className="saved-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    onClick={() =>
                      onOpenSavedMessage({
                        scopeType: item.scopeType,
                        scopeId: item.scopeId,
                        serverId: item.serverId,
                        message: { id: item.messageId }
                      })
                    }
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => remove(item)}
                    disabled={busy === item.id}
                    aria-label="Remove from bookmarks"
                    title="Remove from bookmarks"
                  >
                    {busy === item.id ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )
      ) : reminders === null ? (
        <div className="saved-empty">
          <Loader2 size={18} className="spin" />
          <span>Loading…</span>
        </div>
      ) : reminders.length === 0 ? (
        <div className="saved-empty">
          <Bell size={22} />
          <strong>No reminders</strong>
          <span>Right-click a message and choose Remind me.</span>
        </div>
      ) : (
        <div className="saved-list">
          {reminders.map((reminder) => (
            <div
              className={'saved-row' + (reminder.deliveredAt ? ' delivered' : '')}
              key={reminder.id}
            >
              <div className="reminder-icon">
                <Bell size={16} />
              </div>
              <div className="saved-body">
                <div className="saved-meta">
                  <strong>{reminder.note || 'Reminder'}</strong>
                  <span>{reminder.message?.where || 'a message'}</span>
                  <small>{whenText(reminder.remindAt, reminder.deliveredAt)}</small>
                </div>
                <p className="saved-text">
                  {reminder.message
                    ? reminder.message.e2ee
                      ? 'Encrypted message — open it in the conversation.'
                      : reminder.message.authorName + ': ' + reminder.message.content
                    : 'That message is gone.'}
                </p>
              </div>
              <div className="saved-actions">
                {reminder.message && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    onClick={() =>
                      onOpenSavedMessage({
                        scopeType: reminder.message.dmId ? 'dm' : 'channel',
                        scopeId: reminder.message.dmId || reminder.message.channelId,
                        message: { id: reminder.message.id }
                      })
                    }
                  >
                    Open
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => removeReminder(reminder)}
                  disabled={busy === reminder.id}
                  aria-label="Delete reminder"
                  title="Delete reminder"
                >
                  {busy === reminder.id ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
