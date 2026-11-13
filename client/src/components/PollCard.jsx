import { useEffect, useState } from 'react';
import { BarChart3, Check, Loader2, Lock } from 'lucide-react';

function formatClose(value) {
  if (!value) return '';
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function votedFor(option, me) {
  return Array.isArray(option.users) ? option.users.includes(me.id) : !!option.me;
}

function myOptionIds(poll, me) {
  return (poll.options || []).filter((option) => votedFor(option, me)).map((option) => option.id);
}

export default function PollCard({ message, me, canVote, canClose, onVote, onClose }) {
  const poll = message.poll;
  const [selected, setSelected] = useState(() => myOptionIds(poll, me));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setSelected(myOptionIds(poll, me));
  }, [poll, me]);

  const closed = !!poll.closed || (!!poll.closesAt && poll.closesAt <= Date.now());
  const total = Number(poll.totalVotes) || 0;
  const maxCount = Math.max(1, ...poll.options.map((option) => Number(option.count) || 0));

  async function submit(optionIds) {
    if (!canVote || closed || busy) return;
    setBusy(true);
    setError('');
    try {
      await onVote(message, optionIds);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function choose(option) {
    if (!canVote || closed || busy) return;
          const mine = votedFor(option, me);
    if (poll.allowMultiple) {
      setSelected((current) =>
        current.includes(option.id)
          ? current.filter((id) => id !== option.id)
          : [...current, option.id]
      );
      return;
    }
    submit(mine ? [] : [option.id]);
  }

  async function closePoll() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onClose(message);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`poll-card ${closed ? 'closed' : ''}`}>
      <div className="poll-card-head">
        <span>
          <BarChart3 size={14} />
          Poll
        </span>
        {closed ? (
          <span className="poll-state">
            <Lock size={12} />
            Closed
          </span>
        ) : (
          <span className="poll-state">
            {poll.allowMultiple ? 'Choose any' : 'Choose one'}
          </span>
        )}
      </div>

      <strong className="poll-question">{poll.question}</strong>

      <div className="poll-options">
        {poll.options.map((option) => {
    const mine = votedFor(option, me);
          const count = Number(option.count) || 0;
          const percent = total ? Math.round((count / total) * 100) : 0;
          return (
            <button
              type="button"
              key={option.id}
              className={`poll-option ${mine ? 'selected' : ''}`}
              onClick={() => choose(option)}
              disabled={!canVote || closed || busy}
            >
              <span className="poll-option-track">
                <span
                  className="poll-option-fill"
                  style={{ width: `${closed || mine || total ? percent : 0}%` }}
                />
              </span>
              <span className="poll-option-main">
                <span className="poll-option-label">{option.label}</span>
                <span className="poll-option-count">
                  {count} · {percent}%
                </span>
              </span>
              {mine && <Check className="poll-option-check" size={14} />}
            </button>
          );
        })}
      </div>

      <div className="poll-card-foot">
        <span>
          {total} vote{total === 1 ? '' : 's'} · {poll.voterCount} voter
          {poll.voterCount === 1 ? '' : 's'}
          {poll.closesAt && !closed ? ` · Closes ${formatClose(poll.closesAt)}` : ''}
        </span>
        <span className="poll-card-actions">
          {poll.allowMultiple && canVote && !closed && (
            <button
              type="button"
              className="btn btn-primary btn-xs"
              onClick={() => submit(selected)}
              disabled={busy || selected.length === 0}
            >
              {busy ? <Loader2 size={13} className="spin" /> : null}
              Vote
            </button>
          )}
          {canClose && !closed && (
            <button type="button" className="poll-close-btn" onClick={closePoll} disabled={busy}>
              Close poll
            </button>
          )}
        </span>
      </div>
      {error && <div className="poll-error">{error}</div>}
    </div>
  );
}
