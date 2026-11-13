import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, Hash, MessageSquare, Search, User } from 'lucide-react';
import Modal from './Modal';
import Avatar from './Avatar';

const KIND_ORDER = { channel: 0, dm: 1, person: 2 };

function score(name, query) {
  const value = name.toLowerCase();
  if (value === query) return 0;
  if (value.startsWith(query)) return 1;
  if (value.includes(query)) return 2;
  return -1;
}

export default function QuickSwitcher({ data, me, onClose, onOpenChannel, onOpenDm, onOpenPerson }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);

  const items = useMemo(() => {
    if (!data) return [];
    const list = [];

    for (const server of data.servers || []) {
      for (const channel of server.channels || []) {
        if (channel.type !== 'text') continue;
        list.push({
          key: `ch:${channel.id}`,
          kind: 'channel',
          id: channel.id,
          serverId: server.id,
          name: channel.name,
          meta: server.name
        });
      }
    }

    for (const dm of data.dms || []) {
      list.push({
        key: `dm:${dm.id}`,
        kind: 'dm',
        id: dm.id,
        name: dm.user?.displayName || 'Direct message',
        meta: 'Direct message',
        user: dm.user
      });
    }

    for (const user of data.users || []) {
      if (user.id === me?.id) continue;
      list.push({
        key: `user:${user.id}`,
        kind: 'person',
        id: user.id,
        name: user.displayName,
        meta: user.username ? `@${user.username}` : 'Person',
        user
      });
    }

    return list;
  }, [data, me]);

  const results = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      return items.slice(0, 12);
    }
    return items
      .map((item) => ({ item, rank: score(item.name, trimmed) }))
      .filter((entry) => entry.rank >= 0)
      .sort((left, right) => left.rank - right.rank || KIND_ORDER[left.item.kind] - KIND_ORDER[right.item.kind])
      .slice(0, 12)
      .map((entry) => entry.item);
  }, [items, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function choose(item) {
    if (!item) return;
    if (item.kind === 'channel') onOpenChannel?.(item.serverId, item.id);
    else if (item.kind === 'dm') onOpenDm?.(item.id);
    else onOpenPerson?.(item.id);
  }

  function onKeyDown(event) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((value) => (results.length ? (value + 1) % results.length : 0));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((value) => (results.length ? (value - 1 + results.length) % results.length : 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      choose(results[active]);
    }
  }

  return (
    <Modal onClose={onClose} headless width={560} className="quick-switch">
      <div className="quick-switch-head">
        <Search size={17} />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Jump to a channel, conversation, or person…"
          aria-label="Quick switch"
        />
        <kbd>Esc</kbd>
      </div>

      <div className="quick-switch-list">
        {results.length === 0 && (
          <div className="quick-switch-empty">Nothing matches “{query.trim()}”.</div>
        )}
        {results.map((item, index) => (
          <button
            type="button"
            key={item.key}
            className={`quick-switch-row ${index === active ? 'active' : ''}`}
            onMouseEnter={() => setActive(index)}
            onClick={() => choose(item)}
          >
            <span className="quick-switch-icon">
              {item.kind === 'channel' && <Hash size={15} />}
              {item.kind === 'dm' && <MessageSquare size={15} />}
              {item.kind === 'person' && (item.user ? <Avatar user={item.user} size={20} /> : <User size={15} />)}
            </span>
            <span className="quick-switch-name">{item.name}</span>
            <span className="quick-switch-meta">{item.meta}</span>
            {index === active && <CornerDownLeft size={13} className="quick-switch-enter" />}
          </button>
        ))}
      </div>
    </Modal>
  );
}
