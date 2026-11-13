import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Search, Smile } from 'lucide-react';
import Emoji from './Emoji';
import { assetUrl } from '../runtime';
import { klipyConfigured, klipySearch } from '../klipy';

const RECENT_KEY = 'cordia:emoji-recent';
const RECENT_LIMIT = 24;

function readRecents() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((entry) => typeof entry === 'string').slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

function pushRecent(char) {
  const next = [char, ...readRecents().filter((entry) => entry !== char)].slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // storage can be unavailable
  }
  return next;
}

function EmojiButton({ emoji, onPick, onHover }) {
  return (
    <button
      type="button"
      className="emoji-cell"
      onClick={() => onPick(emoji)}
      onMouseEnter={() => onHover?.(emoji)}
      title={emoji.name}
    >
      <Emoji char={emoji.char} size={32} loading="lazy" />
    </button>
  );
}

// The GIF tab is its own component so a search here never touches the emoji
// catalogue, and so the request only happens when somebody opens the tab.
function GifPanel({ query, onPick, onHover }) {
  const term = query.trim();
  const [state, setState] = useState({ items: [], page: 1, hasMore: false, loading: true, error: '' });

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, loading: true, error: '' }));
    // Typing is a stream of keystrokes; wait for the pause before asking.
    const timer = setTimeout(
      () => {
        klipySearch({ query: term, page: 1 })
          .then((result) => {
            if (cancelled) return;
            setState({ items: result.items, page: 1, hasMore: result.hasMore, loading: false, error: '' });
          })
          .catch((error) => {
            if (cancelled) return;
            setState({ items: [], page: 1, hasMore: false, loading: false, error: error.message });
          });
      },
      term ? 320 : 0
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term]);

  function loadMore() {
    const next = state.page + 1;
    setState((prev) => ({ ...prev, loading: true, error: '' }));
    klipySearch({ query: term, page: next })
      .then((result) => {
        setState((prev) => ({
          items: [...prev.items, ...result.items],
          page: next,
          hasMore: result.hasMore,
          loading: false,
          error: ''
        }));
      })
      .catch((error) => setState((prev) => ({ ...prev, loading: false, error: error.message })));
  }

  if (!state.items.length) {
    if (state.loading) {
      return (
        <div className="picker-state">
          <Loader2 size={16} className="spin" /> {term ? 'Searching KLIPY…' : 'Loading KLIPY…'}
        </div>
      );
    }
    return (
      <div className="picker-state">
        {state.error || (term ? `Nothing on KLIPY for “${term}”.` : 'KLIPY has nothing to show right now.')}
      </div>
    );
  }

  return (
    <>
      <div className="gif-picker-grid">
        {state.items.map((item) => (
          <button
            type="button"
            key={item.id}
            className="gif-picker-cell"
            title={item.title || 'GIF'}
            onMouseEnter={() => onHover?.({ kind: 'gif', url: item.preview, name: item.title || 'GIF' })}
            onClick={() => onPick?.(item)}
          >
            <img src={item.preview} alt={item.title || 'GIF'} loading="lazy" draggable={false} />
          </button>
        ))}
      </div>
      {state.loading ? (
        <div className="picker-state picker-more-state">
          <Loader2 size={15} className="spin" />
        </div>
      ) : state.hasMore ? (
        <button type="button" className="picker-more" onClick={loadMore}>
          {state.error ? 'Try again' : 'Load more'}
        </button>
      ) : null}
      <a className="picker-credit" href="https://klipy.com" target="_blank" rel="noreferrer noopener">
        Powered by KLIPY
      </a>
    </>
  );
}

export default function EmojiPicker({
  emotes = [],
  compact = false,
  onPickEmoji,
  onPickEmote,
  onPickGif,
  onHover
}) {
  const serverEmotes = useMemo(
    () => emotes.filter((emote) => emote.kind !== 'sticker'),
    [emotes]
  );
  const serverStickers = useMemo(
    () => emotes.filter((emote) => emote.kind === 'sticker'),
    [emotes]
  );

  const [gifs, setGifs] = useState(false);

  useEffect(() => {
    let alive = true;
    klipyConfigured().then((ok) => {
      if (alive) setGifs(ok);
    });
    return () => {
      alive = false;
    };
  }, []);

  const tabs = useMemo(() => {
    const list = [{ id: 'emoji', label: 'Emoji' }];
    if (serverEmotes.length) list.push({ id: 'emotes', label: 'Emotes' });
    if (serverStickers.length) list.push({ id: 'stickers', label: 'Stickers' });
    if (gifs) list.push({ id: 'gifs', label: 'GIFs' });
    return list;
  }, [serverEmotes.length, serverStickers.length, gifs]);

  const [tab, setTab] = useState('emoji');
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState(null);
  const [recents, setRecents] = useState(readRecents);
  const [preview, setPreview] = useState(null);
  const inputRef = useRef(null);
  const scrollRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    import('../emojiData')
      .then((module) => {
        if (!cancelled) setCatalog(module);
      })
      .catch(() => {
        if (!cancelled) setCatalog({ EMOJI_GROUPS: [], ALL_EMOJIS: [], EMOJI_BY_CHAR: new Map() });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!tabs.some((entry) => entry.id === tab)) setTab('emoji');
  }, [tabs, tab]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [tab, query]);

  const results = useMemo(() => {
    if (!catalog) return null;
    const term = query.trim().toLowerCase();
    if (!term) return null;
    return catalog.ALL_EMOJIS.filter(
      (emoji) => emoji.name.includes(term) || emoji.keys.includes(term)
    ).slice(0, 180);
  }, [catalog, query]);

  const recentEmojis = useMemo(() => {
    if (!catalog) return [];
    return recents.map((char) => catalog.EMOJI_BY_CHAR.get(char)).filter(Boolean);
  }, [catalog, recents]);

  function pickEmoji(emoji) {
    pushRecent(emoji.char);
    setRecents(readRecents());
    onPickEmoji?.(emoji.char);
  }

  function onSearchKeyDown(event) {
    if (event.key !== 'Enter') return;
    if (tab === 'emoji' && results?.length) {
      event.preventDefault();
      pickEmoji(results[0]);
      return;
    }
    if (tab === 'emotes' && serverEmotes.length) {
      event.preventDefault();
      onPickEmote?.(serverEmotes[0]);
      return;
    }
    if (tab === 'stickers' && serverStickers.length) {
      event.preventDefault();
      onPickEmote?.(serverStickers[0]);
    }
  }

  const term = query.trim().toLowerCase();
  const filteredEmotes = term
    ? serverEmotes.filter((emote) => emote.name.toLowerCase().includes(term))
    : serverEmotes;
  const filteredStickers = term
    ? serverStickers.filter((emote) => emote.name.toLowerCase().includes(term))
    : serverStickers;

  const placeholder =
    tab === 'emoji'
      ? 'Search emoji'
      : tab === 'emotes'
        ? 'Search emotes'
        : tab === 'stickers'
          ? 'Search stickers'
          : 'Search KLIPY';

  return (
    <div className={`picker-panel ${compact ? 'compact' : ''}`}>
      <div className="picker-head">
        <div className="picker-tabs" role="tablist">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              className={`picker-tab ${tab === entry.id ? 'active' : ''}`}
              onClick={() => {
                setTab(entry.id);
                setQuery('');
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="picker-preview">
          {preview ? (
            preview.kind === 'emote' || preview.kind === 'gif' ? (
              <img
                src={preview.url}
                alt={preview.name}
                title={preview.kind === 'gif' ? preview.name : `:${preview.name}:`}
              />
            ) : (
              <Emoji char={preview.char} size={28} />
            )
          ) : (
            <Smile size={18} className="picker-preview-hint" />
          )}
        </div>
      </div>

      <label className="picker-search">
        <Search size={15} />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder={placeholder}
          maxLength={48}
          autoFocus
        />
      </label>

      <div className="picker-scroll" ref={scrollRef}>
        {tab === 'emoji' &&
          (!catalog ? (
            <div className="picker-state">
              <Loader2 size={16} className="spin" /> Loading emoji…
            </div>
          ) : results ? (
            results.length ? (
              <div className="emoji-grid">
                {results.map((emoji) => (
                  <EmojiButton
                    key={emoji.char}
                    emoji={emoji}
                    onPick={pickEmoji}
                    onHover={(entry) => {
                      setPreview(entry);
                      onHover?.(entry);
                    }}
                  />
                ))}
              </div>
            ) : (
              <div className="picker-state">No emoji matches “{query.trim()}”.</div>
            )
          ) : (
            <>
              {recentEmojis.length > 0 && (
                <section className="emoji-section">
                  <h4>Frequently used</h4>
                  <div className="emoji-grid">
                    {recentEmojis.map((emoji) => (
                      <EmojiButton
                        key={`recent-${emoji.char}`}
                        emoji={emoji}
                        onPick={pickEmoji}
                        onHover={setPreview}
                      />
                    ))}
                  </div>
                </section>
              )}
              {catalog.EMOJI_GROUPS.map((group) => (
                <section className="emoji-section" key={group.id}>
                  <h4>
                    <span>{group.icon}</span>
                    {group.label}
                  </h4>
                  <div className="emoji-grid">
                    {group.emojis.map((emoji) => (
                      <EmojiButton
                        key={emoji.char}
                        emoji={emoji}
                        onPick={pickEmoji}
                        onHover={setPreview}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </>
          ))}

        {tab === 'emotes' &&
          (filteredEmotes.length ? (
            <div className="emote-picker-grid">
              {filteredEmotes.map((emote) => (
                <button
                  type="button"
                  key={emote.id}
                  className="emote-picker-cell"
                  title={`:${emote.name}:`}
                  onMouseEnter={() =>
                    setPreview({ kind: 'emote', url: assetUrl(emote.url), name: emote.name })
                  }
                  onClick={() => onPickEmote?.(emote)}
                >
                  <img src={assetUrl(emote.url)} alt={emote.name} draggable={false} />
                  <span>:{emote.name}:</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="picker-state">
              {serverEmotes.length
                ? `No emotes match “${query.trim()}”.`
                : 'This server has no emotes yet. Add some in Server settings → Emotes.'}
            </div>
          ))}

        {tab === 'gifs' && (
          <GifPanel query={query} onPick={(item) => onPickGif?.(item)} onHover={setPreview} />
        )}

        {tab === 'stickers' &&
          (filteredStickers.length ? (
            <div className="sticker-picker-grid">
              {filteredStickers.map((sticker) => (
                <button
                  type="button"
                  key={sticker.id}
                  className="sticker-picker-cell"
                  title={`:${sticker.name}:`}
                  onMouseEnter={() =>
                    setPreview({ kind: 'emote', url: assetUrl(sticker.url), name: sticker.name })
                  }
                  onClick={() => onPickEmote?.(sticker)}
                >
                  <img src={assetUrl(sticker.url)} alt={sticker.name} draggable={false} />
                </button>
              ))}
            </div>
          ) : (
            <div className="picker-state">
              {serverStickers.length
                ? `No stickers match “${query.trim()}”.`
                : 'This server has no stickers yet.'}
            </div>
          ))}
      </div>
    </div>
  );
}
