import { useEffect, useState } from 'react';
import { History, Loader2 } from 'lucide-react';
import Modal from './Modal';
import api from '../api';
import { formatDate } from '../utils';

// A word-level diff, kept small on purpose: the question this answers is "what
// changed", and for that a common-prefix/suffix trim plus a longest-common-
// subsequence over the middle is plenty. Long messages fall back to two blocks,
// because a diff nobody can read is worse than no diff.
const DIFF_LIMIT = 160;

function tokenize(text) {
  return String(text || '')
    .split(/(\s+)/)
    .filter((part) => part !== '');
}

function diffWords(before, after) {
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length > DIFF_LIMIT || b.length > DIFF_LIMIT) return null;

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const left = a.slice(start, endA);
  const right = b.slice(start, endB);

  // LCS over the changed middle.
  const table = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const parts = [];
  const push = (type, text) => {
    const last = parts[parts.length - 1];
    if (last && last.type === type) last.text += text;
    else parts.push({ type, text });
  };
  for (let i = 0; i < start; i += 1) push('same', a[i]);
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      push('same', left[i]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      push('remove', left[i]);
      i += 1;
    } else {
      push('add', right[j]);
      j += 1;
    }
  }
  while (i < left.length) {
    push('remove', left[i]);
    i += 1;
  }
  while (j < right.length) {
    push('add', right[j]);
    j += 1;
  }
  for (let k = endA; k < a.length; k += 1) push('same', a[k]);
  return parts;
}

export default function EditHistoryModal({ message, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .get('/api/messages/' + message.id + '/edits')
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setData({ edits: [] });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [message.id]);

  const edits = data?.edits || [];

  return (
    <Modal onClose={onClose} width={480} className="edit-history-modal" ariaLabel="Edit history">
      <div className="saved-head">
        <div>
          <span className="eyebrow-mini">Message</span>
          <h2>Edit history</h2>
          <p>Every version of this message, oldest first.</p>
        </div>
        <History size={20} />
      </div>

      {error && <div className="form-error">{error}</div>}

      {data === null ? (
        <div className="saved-empty">
          <Loader2 size={18} className="spin" />
          <span>Loading…</span>
        </div>
      ) : edits.length === 0 ? (
        <div className="saved-empty">
          <History size={22} />
          <strong>No edits</strong>
          <span>This message has not been changed since it was sent.</span>
        </div>
      ) : (
        <div className="edit-history-list">
          <div className="edit-version">
            <div className="edit-version-head">
              <strong>Original</strong>
              <small>{formatDate(message.createdAt)}</small>
            </div>
            <p className="edit-version-text">{edits[0].before}</p>
          </div>
          {edits.map((edit, index) => {
            const parts = diffWords(edit.before, edit.after);
            return (
              <div className="edit-version" key={edit.id}>
                <div className="edit-version-head">
                  <strong>
                    {index === edits.length - 1 ? 'Current' : 'Version ' + (index + 2)}
                  </strong>
                  <small>
                    {edit.editor?.displayName ? edit.editor.displayName + ' · ' : ''}
                    {formatDate(edit.at)}
                  </small>
                </div>
                <p className="edit-version-text">
                  {parts
                    ? parts.map((part, partIndex) =>
                        part.type === 'same' ? (
                          <span key={partIndex}>{part.text}</span>
                        ) : part.type === 'remove' ? (
                          <del key={partIndex} className="diff-removed">
                            {part.text}
                          </del>
                        ) : (
                          <ins key={partIndex} className="diff-added">
                            {part.text}
                          </ins>
                        )
                      )
                    : edit.after}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
