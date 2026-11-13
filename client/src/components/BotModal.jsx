import { useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import api from '../api';
import Modal from './Modal';

// A form a bot asked for. It renders only the fields the server stored, and the
// server validates the answers against the same definition — the client is a
// renderer here, not an authority.
export default function BotModal({ interaction, onClose }) {
  const fields = interaction.modal.fields || [];
  const [values, setValues] = useState(() =>
    Object.fromEntries(fields.map((field) => [field.customId, field.value || '']))
  );
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState('');
  const [error, setError] = useState('');

  // The file is uploaded the moment it is chosen, not when the form is sent:
  // a 10 MB upload inside a submit that also has a deadline is a submit that
  // times out.
  async function upload(customId, file) {
    if (!file) return;
    setUploading(customId);
    setError('');
    try {
      const payload = await api.upload(file);
      update(customId, payload.attachment);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading('');
    }
  }

  function update(customId, value) {
    setValues((previous) => ({ ...previous, [customId]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post(`/api/interactions/${interaction.interactionId}/modal-submit`, { values });
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={interaction.modal.title}
      subtitle="Sent by an application"
      onClose={onClose}
      width={460}
      className="bot-modal"
      footer={
        <div className="bot-modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            form="bot-modal-form"
            className="btn btn-primary"
            disabled={busy || !!uploading}
          >
            {busy ? <Loader2 size={15} className="spin" /> : <Send size={15} />}
            Submit
          </button>
        </div>
      }
    >
      <form id="bot-modal-form" className="bot-modal-form" onSubmit={submit}>
        {fields.map((field) => (
          <label className="field" key={field.customId}>
            <span>
              {field.label}
              {field.required === false ? ' (optional)' : ''}
            </span>
            {field.type === 'file' ? (
              <span className="bot-modal-file">
                <input
                  type="file"
                  onChange={(event) => upload(field.customId, event.target.files?.[0])}
                  disabled={!!uploading}
                />
                {uploading === field.customId && <span className="field-hint">Uploading…</span>}
                {values[field.customId]?.name && (
                  <span className="field-hint">{values[field.customId].name}</span>
                )}
              </span>
            ) : field.type === 'select' ? (
              <select
                value={values[field.customId] || ''}
                onChange={(event) => update(field.customId, event.target.value)}
              >
                <option value="">{field.placeholder || 'Choose one'}</option>
                {(field.options || []).map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </select>
            ) : field.style === 'paragraph' ? (
              <textarea
                rows={4}
                value={values[field.customId] || ''}
                placeholder={field.placeholder}
                maxLength={field.maxLength}
                onChange={(event) => update(field.customId, event.target.value)}
              />
            ) : (
              <input
                value={values[field.customId] || ''}
                placeholder={field.placeholder}
                maxLength={field.maxLength}
                onChange={(event) => update(field.customId, event.target.value)}
              />
            )}
          </label>
        ))}
        {error && <div className="form-error">{error}</div>}
      </form>
    </Modal>
  );
}
