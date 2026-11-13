import { useMemo, useState } from 'react';
import { Bell, Loader2 } from 'lucide-react';
import Modal from './Modal';
import api from '../api';

// Presets instead of a date picker by default: "tonight" and "tomorrow morning"
// are what people mean, and a native datetime control is the fallback for
// everything else.
function tonight() {
  const now = new Date();
  const at = new Date(now);
  at.setHours(20, 0, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at;
}

function tomorrowMorning() {
  const at = new Date();
  at.setDate(at.getDate() + 1);
  at.setHours(9, 0, 0, 0);
  return at;
}

function inHours(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

export default function RemindModal({ message, onClose, onScheduled }) {
  const presets = useMemo(
    () => [
      { key: '1h', label: 'In 1 hour', at: inHours(1) },
      { key: '3h', label: 'In 3 hours', at: inHours(3) },
      { key: 'tonight', label: 'Tonight at 20:00', at: tonight() },
      { key: 'tomorrow', label: 'Tomorrow at 09:00', at: tomorrowMorning() }
    ],
    []
  );
  const [preset, setPreset] = useState('1h');
  const [custom, setCustom] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const chosen = preset === 'custom' ? (custom ? new Date(custom) : null) : presets.find((p) => p.key === preset)?.at;

  async function submit(event) {
    event.preventDefault();
    if (!chosen || Number.isNaN(chosen.getTime())) {
      setError('Pick a time.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const data = await api.post('/api/messages/' + message.id + '/remind', {
        at: chosen.getTime(),
        note: note.trim()
      });
      onScheduled?.(data.reminder);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      onClose={onClose}
      width={440}
      className="remind-modal"
      ariaLabel="Remind me"
      footer={
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="remind-form" className="btn btn-primary" disabled={busy}>
            {busy ? <Loader2 size={14} className="spin" /> : <Bell size={14} />} Remind me
          </button>
        </div>
      }
    >
      <div className="saved-head">
        <div>
          <span className="eyebrow-mini">Message</span>
          <h2>Remind me</h2>
          <p>Cordia will bring this message back when you ask.</p>
        </div>
        <Bell size={20} />
      </div>

      {error && <div className="form-error">{error}</div>}

      <form id="remind-form" onSubmit={submit}>
        <div className="remind-presets">
          {presets.map((option) => (
            <button
              type="button"
              key={option.key}
              className={'remind-preset' + (preset === option.key ? ' active' : '')}
              onClick={() => setPreset(option.key)}
            >
              {option.label}
            </button>
          ))}
          <button
            type="button"
            className={'remind-preset' + (preset === 'custom' ? ' active' : '')}
            onClick={() => setPreset('custom')}
          >
            Pick a time
          </button>
        </div>
        {preset === 'custom' && (
          <label className="field">
            <span>When</span>
            <input
              type="datetime-local"
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
              required
            />
          </label>
        )}
        <label className="field">
          <span>Note (optional)</span>
          <input
            value={note}
            maxLength={200}
            placeholder="Why this message matters"
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <p className="remind-preview">
          {chosen && !Number.isNaN(chosen.getTime())
            ? 'Reminder set for ' + chosen.toLocaleString()
            : 'Choose when to be reminded.'}
        </p>
      </form>
    </Modal>
  );
}
