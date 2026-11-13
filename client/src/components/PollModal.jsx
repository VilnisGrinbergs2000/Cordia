import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import Modal from './Modal';

export default function PollModal({ channelName, onClose, onCreate }) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [closesAt, setClosesAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const canPost =
    question.trim().length >= 3 && options.filter((option) => option.trim()).length >= 2;

  function updateOption(index, value) {
    setOptions((current) => current.map((option, i) => (i === index ? value : option)));
  }

  function addOption() {
    if (options.length >= 10) return;
    setOptions((current) => [...current, '']);
  }

  function removeOption(index) {
    if (options.length <= 2) return;
    setOptions((current) => current.filter((_, i) => i !== index));
  }

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const cleanQuestion = question.trim();
    const cleanOptions = options.map((option) => option.trim()).filter(Boolean);
    if (cleanQuestion.length < 3) {
      setError('Poll question must be at least 3 characters.');
      return;
    }
    if (cleanOptions.length < 2) {
      setError('Add at least two options.');
      return;
    }
    if (new Set(cleanOptions).size !== cleanOptions.length) {
      setError('Poll options must be unique.');
      return;
    }
    let closeTime = null;
    if (closesAt) {
      closeTime = new Date(closesAt).getTime();
      if (!Number.isFinite(closeTime) || closeTime <= Date.now()) {
        setError('Poll close time must be in the future.');
        return;
      }
    }
    setBusy(true);
    setError('');
    try {
      await onCreate({
        question: cleanQuestion,
        options: cleanOptions,
        allowMultiple,
        closesAt: closeTime
      });
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Create a poll"
      subtitle={channelName ? `Post in #${channelName}` : undefined}
      onClose={onClose}
      width={540}
      footer={
        <div className="poll-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="poll-form" className="btn btn-primary" disabled={busy || !canPost}>
            {busy ? 'Posting...' : 'Post poll'}
          </button>
        </div>
      }
    >
      <form id="poll-form" className="poll-form" onSubmit={submit}>
        {error && <div className="form-error">{error}</div>}
        <label className="field">
          <span>Question</span>
          <input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="What should we watch?"
            maxLength={200}
            autoFocus
          />
        </label>

        <div className="field">
          <span>Options</span>
          <div className="poll-option-editor">
            {options.map((option, index) => (
              <div className="poll-option-row" key={index}>
                <input
                  value={option}
                  onChange={(event) => updateOption(index, event.target.value)}
                  placeholder={`Option ${index + 1}`}
                  maxLength={80}
                />
                {options.length > 2 && (
                  <button
                    type="button"
                    className="poll-option-remove icon-btn danger-hover"
                    onClick={() => removeOption(index)}
                    title="Remove option"
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            ))}
            {options.length < 10 && (
              <button type="button" className="poll-add-option" onClick={addOption}>
                <Plus size={15} />
                Add option
              </button>
            )}
          </div>
        </div>

        <label className="field">
          <span>Closes (optional)</span>
          <input
            type="datetime-local"
            value={closesAt}
            onChange={(event) => setClosesAt(event.target.value)}
          />
        </label>

        <label className="poll-multi-row">
          <input
            type="checkbox"
            checked={allowMultiple}
            onChange={(event) => setAllowMultiple(event.target.checked)}
          />
          <span>
            <strong>Allow multiple choices</strong>
            <small>People can pick more than one option.</small>
          </span>
        </label>
      </form>
    </Modal>
  );
}
