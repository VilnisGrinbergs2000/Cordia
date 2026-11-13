import { useEffect, useMemo, useRef, useState } from 'react';
import { Hash, Loader2, Search } from 'lucide-react';
import Modal from './Modal';
import Avatar from './Avatar';
import api from '../api';

function notify(detail) {
  window.dispatchEvent(new CustomEvent('cordia:toast', { detail }));
}

export default function ForwardModal({ message, destinations, onClose }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  // Enter only forwards once the list has been navigated: the first match must
  // never be sent by an accidental keystroke.
  const [navigated, setNavigated] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // The shell already filtered destinations by permission, so this only drops
  // the conversation the message came from (and channels that cannot take the
  // attachment, when there is one).
  const options = useMemo(() => {
    if (!destinations) return [];
    const needsAttach = !!message.attachment;
    return destinations.filter((option) => {
      if (option.kind === 'dm') return Number(option.id) !== Number(message.dmId);
      if (Number(option.id) === Number(message.channelId)) return false;
      return !needsAttach || option.canAttach;
    });
  }, [destinations, message]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((option) => `${option.name} ${option.group}`.toLowerCase().includes(q));
  }, [options, query]);

  useEffect(() => {
    setActive(0);
    setNavigated(false);
  }, [query, destinations]);

  useEffect(() => {
    listRef.current?.querySelector('.forward-option.active')?.scrollIntoView({ block: 'nearest' });
  }, [active, filtered.length]);

  async function confirm(picked) {
    const option = picked || filtered[Math.min(active, Math.max(0, filtered.length - 1))];
    if (!option || sending) return;
    setSending(true);
    setError('');
    try {
      await api.post(
        `/api/messages/${message.id}/forward`,
        option.kind === 'dm' ? { conversationId: option.id } : { channelId: option.id }
      );
      notify({ title: 'Message forwarded', message: `Sent to ${option.name}` });
      onClose();
    } catch (err) {
      setError(err.message);
      notify({ type: 'error', title: 'Could not forward', message: err.message });
      setSending(false);
    }
  }

  function onKeyDown(event) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setNavigated(true);
      setActive((value) => (filtered.length ? (value + 1) % filtered.length : 0));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setNavigated(true);
      setActive((value) => (filtered.length ? (value - 1 + filtered.length) % filtered.length : 0));
    } else if (event.key === 'Enter') {
      // A click (or an explicit arrow move) is required first: typing a name and
      // hitting Enter must not fire a message at whoever matched first.
      event.preventDefault();
      if (navigated) confirm();
    }
  }

  let lastGroup = '';
  return (
    <Modal
      title="Forward message"
      subtitle="Pick a channel or conversation"
      onClose={onClose}
      width={460}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => confirm()}
            disabled={!filtered[active] || sending}
          >
            {sending ? <Loader2 size={15} className="spin" /> : null}
            Forward
          </button>
        </>
      }
    >
      <p className="forward-preview">
        {message.content ? message.content : message.attachment ? 'Attachment' : 'Message'}
      </p>
      <div className="forward-search">
        <Search size={15} />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search channels and people"
          aria-label="Search destinations"
        />
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className="forward-list" role="listbox" aria-label="Forward destinations" ref={listRef}>
        {!destinations ? (
          <div className="forward-empty">
            <Loader2 size={16} className="spin" /> Loading destinations…
          </div>
        ) : filtered.length === 0 ? (
          <div className="forward-empty">No destinations you can send to.</div>
        ) : (
          filtered.map((option, index) => {
            const header = option.group !== lastGroup ? option.group : '';
            lastGroup = option.group;
            return (
              <div key={option.key}>
                {header && <div className="forward-group">{header}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  className={`forward-option ${index === active ? 'active' : ''}`}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => confirm(option)}
                >
                  {option.kind === 'dm' ? (
                    <Avatar user={option.user} size={20} />
                  ) : (
                    <Hash size={15} />
                  )}
                  <span>{option.name}</span>
                </button>
              </div>
            );
          })
        )}
      </div>
    </Modal>
  );
}
