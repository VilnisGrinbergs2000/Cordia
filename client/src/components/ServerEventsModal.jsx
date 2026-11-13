import { useEffect, useState } from 'react';
import { CalendarDays, Loader2, MapPin, Pencil, Plus, Trash2, Users } from 'lucide-react';
import Markdown from './Markdown';
import Modal from './Modal';
import api from '../api';

function toLocalInput(value) {
  if (!value) return '';
  const date = new Date(value);
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function formatEventTime(value) {
  return new Date(value).toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function emptyForm() {
  return {
    title: '',
    description: '',
    location: '',
    startsAt: toLocalInput(Date.now() + 60 * 60 * 1000),
    endsAt: ''
  };
}

export default function ServerEventsModal({ server, me, refreshKey, onClose, onChanged }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .get(`/api/servers/${server.id}/events`)
      .then((payload) => {
        if (!cancelled) setEvents(payload.events || []);
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
  }, [server.id, refreshKey]);

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm());
    setFormOpen(true);
    setError('');
  }

  function openEdit(event) {
    setEditingId(event.id);
    setForm({
      title: event.title,
      description: event.description,
      location: event.location,
      startsAt: toLocalInput(event.startsAt),
      endsAt: event.endsAt ? toLocalInput(event.endsAt) : ''
    });
    setFormOpen(true);
    setError('');
  }

  async function save(event) {
    event.preventDefault();
    if (saving) return;
    const startsAt = fromLocalInput(form.startsAt);
    if (!startsAt) {
      setError('Choose a start time.');
      return;
    }
    const payload = {
      title: form.title.trim(),
      description: form.description.trim(),
      location: form.location.trim(),
      startsAt,
      endsAt: fromLocalInput(form.endsAt)
    };
    if (payload.title.length < 2) {
      setError('Event title must be at least 2 characters.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (editingId) {
        await api.patch(`/api/servers/${server.id}/events/${editingId}`, payload);
      } else {
        await api.post(`/api/servers/${server.id}/events`, payload);
      }
      const next = await api.get(`/api/servers/${server.id}/events`);
      setEvents(next.events || []);
      setFormOpen(false);
      setEditingId(null);
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(event) {
    if (!window.confirm(`Delete "${event.title}"?`)) return;
    setBusyId(event.id);
    setError('');
    try {
      await api.del(`/api/servers/${server.id}/events/${event.id}`);
      setEvents((current) => current.filter((entry) => entry.id !== event.id));
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function rsvp(event, status) {
    setBusyId(event.id);
    setError('');
    try {
      const payload = await api.post(`/api/servers/${server.id}/events/${event.id}/rsvp`, {
        status
      });
      setEvents((current) =>
        current.map((entry) => (entry.id === event.id ? payload.event : entry))
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Modal
      title="Events"
      subtitle={`Plan something with ${server.name}`}
      onClose={onClose}
      width={720}
    >
      <div className="events-modal">
        {error && <div className="form-error">{error}</div>}

        {formOpen ? (
          <form className="form event-form" onSubmit={save}>
            <div className="event-form-head">
              <strong>{editingId ? 'Edit event' : 'New event'}</strong>
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={() => setFormOpen(false)}
              >
                Cancel
              </button>
            </div>
            <label className="field">
              <span>Title</span>
              <input
                value={form.title}
                onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))}
                placeholder="Game night"
                maxLength={100}
                autoFocus
              />
            </label>
            <label className="field">
              <span>Description (optional)</span>
              <textarea
                value={form.description}
                onChange={(event) =>
                  setForm((current) => ({ ...current, description: event.target.value }))
                }
                placeholder="What is the plan?"
                rows={3}
                maxLength={1000}
              />
            </label>
            <div className="event-form-grid">
              <label className="field">
                <span>Starts</span>
                <input
                  type="datetime-local"
                  value={form.startsAt}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, startsAt: event.target.value }))
                  }
                />
              </label>
              <label className="field">
                <span>Ends (optional)</span>
                <input
                  type="datetime-local"
                  value={form.endsAt}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, endsAt: event.target.value }))
                  }
                />
              </label>
            </div>
            <label className="field">
              <span>Location (optional)</span>
              <input
                value={form.location}
                onChange={(event) =>
                  setForm((current) => ({ ...current, location: event.target.value }))
                }
                placeholder="Voice lounge, a game, or a link"
                maxLength={120}
              />
            </label>
            <div className="event-form-actions">
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? <Loader2 size={15} className="spin" /> : null}
                {editingId ? 'Save changes' : 'Create event'}
              </button>
            </div>
          </form>
        ) : (
          <div className="events-toolbar">
            <span>
              {events.length} upcoming event{events.length === 1 ? '' : 's'}
            </span>
            <button type="button" className="btn btn-primary btn-sm" onClick={openCreate}>
              <Plus size={15} />
              New event
            </button>
          </div>
        )}

        {loading ? (
          <div className="events-loading">
            <Loader2 size={18} className="spin" />
            Loading events
          </div>
        ) : events.length === 0 ? (
          <div className="events-empty">
            <CalendarDays size={28} />
            <strong>No events yet</strong>
            <p>Put a game night, watch party, or voice hangout on the calendar.</p>
          </div>
        ) : (
          <div className="event-list">
            {events.map((event) => {
              const busy = busyId === event.id;
              return (
                <article className="event-card" key={event.id}>
                  <div className="event-date">
                    <span>
                      {new Date(event.startsAt).toLocaleDateString([], { month: 'short' })}
                    </span>
                    <strong>{new Date(event.startsAt).getDate()}</strong>
                    <small>
                      {new Date(event.startsAt).toLocaleTimeString([], {
                        hour: 'numeric',
                        minute: '2-digit'
                      })}
                    </small>
                  </div>
                  <div className="event-copy">
                    <div className="event-title-row">
                      <strong>{event.title}</strong>
                      {event.canManage && (
                        <span className="event-manage">
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() => openEdit(event)}
                            title="Edit event"
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            type="button"
                            className="icon-btn danger-hover"
                            onClick={() => remove(event)}
                            disabled={busy}
                            title="Delete event"
                          >
                            <Trash2 size={14} />
                          </button>
                        </span>
                      )}
                    </div>
                    <div className="event-meta">
                      <span>
                        <CalendarDays size={13} />
                        {formatEventTime(event.startsAt)}
                        {event.endsAt ? ` - ${formatEventTime(event.endsAt)}` : ''}
                      </span>
                      {event.location && (
                        <span>
                          <MapPin size={13} />
                          {event.location}
                        </span>
                      )}
                      <span>
                        <Users size={13} />
                        {event.goingCount} going · {event.interestedCount} interested
                      </span>
                    </div>
                    {event.description && (
                      <div className="event-description">
                        <Markdown className="md-prose" text={event.description} meUsername="" />
                      </div>
                    )}
                    <div className="event-actions">
                      <button
                        type="button"
                        className={`btn btn-xs ${event.myStatus === 'going' ? 'btn-primary' : 'btn-ghost'}`}
                        onClick={() => rsvp(event, event.myStatus === 'going' ? null : 'going')}
                        disabled={busy}
                      >
                        {busy ? <Loader2 size={13} className="spin" /> : null}
                        Going
                      </button>
                      <button
                        type="button"
                        className={`btn btn-xs ${
                          event.myStatus === 'interested' ? 'btn-primary' : 'btn-ghost'
                        }`}
                        onClick={() =>
                          rsvp(event, event.myStatus === 'interested' ? null : 'interested')
                        }
                        disabled={busy}
                      >
                        Interested
                      </button>
                      <span className="event-creator">
                        by {event.creator.id === me.id ? 'you' : event.creator.displayName}
                      </span>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
