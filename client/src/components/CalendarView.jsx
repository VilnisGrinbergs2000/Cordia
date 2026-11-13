import { useEffect, useState } from 'react';
import { CalendarDays, Loader2, MapPin, Plus, Users } from 'lucide-react';
import api from '../api';

// The server calendar: an agenda rather than a grid, because a month grid on a
// 380px sidebar is a decoration, not a calendar.
function dayLabel(value) {
  return new Date(value).toLocaleDateString([], {
    weekday: 'long',
    month: 'short',
    day: 'numeric'
  });
}

function timeLabel(value) {
  return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function toLocalInput(value) {
  const date = new Date(value);
  const pad = (part) => String(part).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

export default function CalendarView({ server, channel, canWrite, canCreateEvent, onBackToList }) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ title: '', startsAt: toLocalInput(Date.now() + 86400000), recurrence: 'none' });
  const [busy, setBusy] = useState(false);

  async function load() {
    const from = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const to = Date.now() + 60 * 24 * 60 * 60 * 1000;
    const data = await api.get('/api/servers/' + server.id + '/events?from=' + from + '&to=' + to);
    return data.events || [];
  }

  useEffect(() => {
    let cancelled = false;
    load()
      .then((found) => {
        if (!cancelled) setEvents(found);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setEvents([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [server.id, channel.id]);

  async function create(event) {
    event.preventDefault();
    if (!form.title.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api.post('/api/servers/' + server.id + '/events', {
        title: form.title.trim(),
        startsAt: new Date(form.startsAt).getTime(),
        recurrence: form.recurrence,
        channelId: channel.id
      });
      setEvents(await load());
      setCreating(false);
      setForm({ title: '', startsAt: toLocalInput(Date.now() + 86400000), recurrence: 'none' });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function rsvp(item, status) {
    try {
      await api.post('/api/servers/' + server.id + '/events/' + item.id + '/rsvp', {
        status: item.myStatus === status ? null : status
      });
      setEvents(await load());
    } catch (err) {
      setError(err.message);
    }
  }

  const grouped = [];
  for (const item of events || []) {
    const key = dayLabel(item.occurrenceStart || item.startsAt);
    const last = grouped[grouped.length - 1];
    if (last && last.key === key) last.items.push(item);
    else grouped.push({ key, items: [item] });
  }

  return (
    <div className="tool-view calendar-view">
      <div className="tool-head">
        <div>
          <span className="eyebrow-mini">Calendar</span>
          <h2>#{channel.name}</h2>
        </div>
        <div className="tool-head-actions">
          {(canCreateEvent ?? canWrite) && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCreating((value) => !value)}>
              <Plus size={14} /> New event
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm mobile-only" onClick={onBackToList}>
            Back
          </button>
        </div>
      </div>

      {error && <div className="form-error">{error}</div>}

      {creating && (
        <form className="calendar-form" onSubmit={create}>
          <input
            value={form.title}
            placeholder="What is happening?"
            maxLength={100}
            onChange={(event) => setForm({ ...form, title: event.target.value })}
          />
          <input
            type="datetime-local"
            value={form.startsAt}
            onChange={(event) => setForm({ ...form, startsAt: event.target.value })}
          />
          <select
            value={form.recurrence}
            onChange={(event) => setForm({ ...form, recurrence: event.target.value })}
          >
            <option value="none">Once</option>
            <option value="weekly">Every week</option>
            <option value="monthly">Every month</option>
          </select>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" /> : <CalendarDays size={14} />} Add
          </button>
        </form>
      )}

      {events === null ? (
        <div className="tool-empty"><Loader2 size={16} className="spin" /> Loading…</div>
      ) : grouped.length === 0 ? (
        <div className="tool-empty"><CalendarDays size={22} /> Nothing scheduled.</div>
      ) : (
        grouped.map((group) => (
          <div className="calendar-day" key={group.key}>
            <div className="calendar-day-label">{group.key}</div>
            {group.items.map((item) => (
              <div className="calendar-event" key={item.id + ':' + (item.occurrenceStart || item.startsAt)}>
                <div className="calendar-time">
                  {timeLabel(item.occurrenceStart || item.startsAt)}
                </div>
                <div className="calendar-body">
                  <strong>{item.title}</strong>
                  {item.location && (
                    <span className="calendar-where"><MapPin size={12} /> {item.location}</span>
                  )}
                  <span className="calendar-where">
                    <Users size={12} /> {item.goingCount} going
                  </span>
                </div>
                <div className="calendar-actions">
                  <button
                    type="button"
                    className={'btn btn-xs ' + (item.myStatus === 'going' ? 'btn-primary' : 'btn-ghost')}
                    onClick={() => rsvp(item, 'going')}
                  >
                    Going
                  </button>
                  <button
                    type="button"
                    className={'btn btn-xs ' + (item.myStatus === 'interested' ? 'btn-primary' : 'btn-ghost')}
                    onClick={() => rsvp(item, 'interested')}
                  >
                    Interested
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
