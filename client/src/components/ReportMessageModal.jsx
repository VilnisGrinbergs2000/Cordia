import { useState } from 'react';
import { Flag, Loader2, ShieldAlert } from 'lucide-react';
import Modal from './Modal';

const REASONS = [
  { value: 'harassment', label: 'Harassment or bullying' },
  { value: 'hate_speech', label: 'Hate speech' },
  { value: 'threats', label: 'Threats or violence' },
  { value: 'spam', label: 'Spam or scam' },
  { value: 'sexual_content', label: 'Sexual or explicit content' },
  { value: 'self_harm', label: 'Self-harm or suicide' },
  { value: 'other', label: 'Something else' }
];

export default function ReportMessageModal({ message, plaintext = '', onClose, onSubmit }) {
  const [reason, setReason] = useState('harassment');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const excerpt = (plaintext || '').trim();

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSubmit({
        messageId: message.id,
        reason,
        details: details.trim(),
        evidenceText: message.encrypted ? excerpt : ''
      });
      onClose();
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Report message"
      subtitle={`Report ${message.author?.displayName || 'this user'} to the Cordia team.`}
      onClose={onClose}
      width={520}
      footer={
        <div className="settings-footer-right">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="submit"
            form="report-message-form"
            className="btn btn-danger btn-sm"
            disabled={busy}
          >
            {busy ? <Loader2 size={14} className="spin" /> : <Flag size={14} />}
            Submit report
          </button>
        </div>
      }
    >
      <form id="report-message-form" className="report-form" onSubmit={submit}>
        <label className="field">
          <span>Why are you reporting this?</span>
          <select value={reason} onChange={(event) => setReason(event.target.value)}>
            {REASONS.map((item) => (
              <option value={item.value} key={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Additional details</span>
          <textarea
            value={details}
            onChange={(event) => setDetails(event.target.value)}
            placeholder="Tell us what happened. Do not include passwords or private keys."
            rows={4}
            maxLength={1000}
          />
        </label>

        <div className="report-preview">
          <span>Reported message</span>
          {excerpt ? (
            <blockquote>{excerpt}</blockquote>
          ) : (
            <p>{message.encrypted ? 'Encrypted message content is not available.' : 'No text content.'}</p>
          )}
        </div>

        {message.encrypted && (
          <div className="report-warning">
            <ShieldAlert size={16} />
            <p>
              This is an encrypted direct message. The visible text above will be shared with the
              Cordia team as evidence. Nobody can decrypt it automatically.
            </p>
          </div>
        )}

        {error && <div className="form-error">{error}</div>}
      </form>
    </Modal>
  );
}
