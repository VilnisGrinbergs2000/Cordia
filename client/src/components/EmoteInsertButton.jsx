import { useEffect, useRef, useState } from 'react';
import { Smile } from 'lucide-react';
import EmojiPicker from './EmojiPicker';
import api from '../api';

// One request per page load. The pool is every emote across every server the
// user belongs to, so a bio editor, a doc and a channel topic all offer the
// same set the composer does - the whole point of "usable everywhere".
let cache = null;
let inflight = null;

function load() {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = api
      .get('/api/emotes/mine')
      .then((data) => {
        cache = Array.isArray(data?.emotes) ? data.emotes : [];
        return cache;
      })
      .catch(() => {
        cache = [];
        return cache;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function invalidateMyEmotes() {
  cache = null;
}

export function useMyEmotes(enabled = true) {
  const [emotes, setEmotes] = useState(cache || []);
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    load().then((list) => {
      if (!cancelled) setEmotes(list);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return emotes;
}

// Drop-in emoji button for any text field. onInsert receives the snippet to
// splice at the caret: a literal character for unicode, :name: for an emote.
export default function EmoteInsertButton({ onInsert, title = 'Emoji', emotes: pool, size = 17 }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const mine = useMyEmotes(!pool);
  const emotes = pool || mine;

  useEffect(() => {
    if (!open) return undefined;
    function onDown(event) {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false);
    }
    function onKey(event) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="toolbar-pop-wrap" ref={wrapRef}>
      <button
        type="button"
        className="composer-icon"
        title={title}
        aria-label={title}
        onClick={() => setOpen((value) => !value)}
      >
        <Smile size={size} />
      </button>
      {open && (
        <div className="emoji-popover emote-insert-popover">
          <EmojiPicker
            emotes={emotes}
            compact
            onPickEmoji={(char) => onInsert?.(char)}
            onPickEmote={(emote) => onInsert?.(`:${emote.name}:`)}
          />
        </div>
      )}
    </div>
  );
}
