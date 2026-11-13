import { useEffect, useState } from 'react';
import { Check, ListChecks, Loader2, Plus, Trash2 } from 'lucide-react';
import api from '../api';

// Shared checklists. Anybody who can see the channel can add, tick and assign —
// a list that only one person can edit is a note, not a list.
export default function ListsView({ channel, members = [], canWrite, onBackToList }) {
  const [lists, setLists] = useState(null);
  const [draft, setDraft] = useState('');
  const [itemDrafts, setItemDrafts] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .get('/api/channels/' + channel.id + '/lists')
      .then((data) => {
        if (!cancelled) setLists(data.lists || []);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setLists([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [channel.id]);

  async function createList(event) {
    event.preventDefault();
    const title = draft.trim();
    if (!title) return;
    setBusy(true);
    try {
      const data = await api.post('/api/channels/' + channel.id + '/lists', { title });
      setLists((current) => [...(current || []), data.list]);
      setDraft('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function addItem(list) {
    const text = (itemDrafts[list.id] || '').trim();
    if (!text) return;
    try {
      const data = await api.post('/api/lists/' + list.id + '/items', { text });
      setLists((current) =>
        (current || []).map((entry) =>
          entry.id === list.id ? { ...entry, items: [...entry.items, data.item] } : entry
        )
      );
      setItemDrafts((current) => ({ ...current, [list.id]: '' }));
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggle(list, item) {
    try {
      const data = await api.patch('/api/list-items/' + item.id, { done: !item.done });
      setLists((current) =>
        (current || []).map((entry) =>
          entry.id === list.id
            ? { ...entry, items: entry.items.map((row) => (row.id === item.id ? { ...row, ...data.item } : row)) }
            : entry
        )
      );
    } catch (err) {
      setError(err.message);
    }
  }

  async function assign(list, item, assigneeId) {
    try {
      const data = await api.patch('/api/list-items/' + item.id, {
        assigneeId: assigneeId ? Number(assigneeId) : null
      });
      setLists((current) =>
        (current || []).map((entry) =>
          entry.id === list.id
            ? { ...entry, items: entry.items.map((row) => (row.id === item.id ? { ...row, ...data.item } : row)) }
            : entry
        )
      );
    } catch (err) {
      setError(err.message);
    }
  }

  async function removeItem(list, item) {
    try {
      await api.del('/api/list-items/' + item.id);
      setLists((current) =>
        (current || []).map((entry) =>
          entry.id === list.id
            ? { ...entry, items: entry.items.filter((row) => row.id !== item.id) }
            : entry
        )
      );
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="tool-view lists-view">
      <div className="tool-head">
        <div>
          <span className="eyebrow-mini">Lists</span>
          <h2>#{channel.name}</h2>
        </div>
        <button type="button" className="btn btn-ghost btn-sm mobile-only" onClick={onBackToList}>
          Back
        </button>
      </div>

      {error && <div className="form-error">{error}</div>}

      {canWrite && (
        <form className="list-create" onSubmit={createList}>
          <input
            value={draft}
            maxLength={120}
            placeholder="New list name"
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !draft.trim()}>
            <Plus size={14} /> Add list
          </button>
        </form>
      )}

      {lists === null ? (
        <div className="tool-empty"><Loader2 size={16} className="spin" /> Loading…</div>
      ) : lists.length === 0 ? (
        <div className="tool-empty"><ListChecks size={22} /> No lists yet.</div>
      ) : (
        <div className="lists-grid">
          {lists.map((list) => {
            const done = list.items.filter((item) => item.done).length;
            return (
              <div className="list-card" key={list.id}>
                <div className="list-card-head">
                  <strong>{list.title}</strong>
                  <small>
                    {done}/{list.items.length} done
                  </small>
                </div>
                <div className="list-items">
                  {list.items.map((item) => (
                    <div className={'list-item' + (item.done ? ' done' : '')} key={item.id}>
                      <button
                        type="button"
                        className={'list-check' + (item.done ? ' on' : '')}
                        onClick={() => toggle(list, item)}
                        aria-label={item.done ? 'Mark as not done' : 'Mark as done'}
                      >
                        {item.done && <Check size={12} />}
                      </button>
                      <span className="list-text">{item.text}</span>
                      <select
                        className="list-assignee"
                        value={item.assigneeId || ''}
                        onChange={(event) => assign(list, item, event.target.value)}
                        aria-label="Assign to"
                      >
                        <option value="">Unassigned</option>
                        {members.map((member) => (
                          <option value={member.id} key={member.id}>
                            {member.displayName}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => removeItem(list, item)}
                        aria-label="Remove item"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="list-add">
                  <input
                    value={itemDrafts[list.id] || ''}
                    placeholder="Add an item"
                    maxLength={300}
                    onChange={(event) =>
                      setItemDrafts((current) => ({ ...current, [list.id]: event.target.value }))
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        addItem(list);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => addItem(list)}
                    aria-label="Add item"
                  >
                    <Plus size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
