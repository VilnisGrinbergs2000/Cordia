import { useEffect, useState } from 'react';
import { Compass, Loader2, Search } from 'lucide-react';
import api from '../api';
import { assetUrl } from '../runtime';
import { DISCOVER_CATEGORIES } from '../utils';
import ServerIcon from './ServerIcon';

const TABS = ['All', ...DISCOVER_CATEGORIES];
const DEBOUNCE_MS = 250;

function notify(detail) {
  window.dispatchEvent(new CustomEvent('cordia:toast', { detail }));
}

export default function DiscoverPage({ onJoined, onOpen }) {
  const [category, setCategory] = useState('All');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  // A failed join is shown on its own card: a banner over the grid reads like a
  // dead button to anyone looking at the card that failed.
  const [joinErrors, setJoinErrors] = useState({});

  // Typing should not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (category !== 'All') params.set('category', category);
    if (query) params.set('q', query);
    const qs = params.toString();

    setLoading(true);
    api
      .get(`/api/discover${qs ? `?${qs}` : ''}`)
      .then((payload) => {
        if (cancelled) return;
        setServers(payload?.servers || []);
        setError('');
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
  }, [category, query]);

  async function handleJoin(serverId) {
    if (busyId !== null) return;
    setBusyId(serverId);
    setJoinErrors((prev) => {
      if (!(serverId in prev)) return prev;
      const next = { ...prev };
      delete next[serverId];
      return next;
    });
    try {
      const payload = await api.post(`/api/discover/${serverId}/join`);
      onJoined(payload.server);
    } catch (err) {
      setJoinErrors((prev) => ({ ...prev, [serverId]: err.message }));
      notify({ type: 'error', title: 'Could not join server', message: err.message });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="discover-page">
      <header className="discover-hero">
        <h1>Find your community on Cordia</h1>
        <p>
          Browse public servers and jump in with one click — gaming crews, music rooms, study
          groups and more.
        </p>
        <div className="search-box discover-search">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search servers"
            aria-label="Search servers"
          />
        </div>
      </header>

      <nav className="friends-tabs discover-tabs" aria-label="Server categories">
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            className={`friends-tab ${category === tab ? 'active' : ''}`}
            onClick={() => setCategory(tab)}
            aria-pressed={category === tab}
          >
            {tab}
          </button>
        ))}
      </nav>

      {error && <p className="form-error">{error}</p>}

      {loading ? (
        <div className="stage-empty">
          <Loader2 size={18} className="spin" />
          <p>Loading servers…</p>
        </div>
      ) : servers.length ? (
        <div className="discover-grid">
          {servers.map((server) => (
            <article
              className={`search-result discover-card${server.banner ? ' has-banner' : ''}`}
              key={server.id}
            >
              {server.banner ? (
                <img
                  className="discover-banner"
                  src={assetUrl(server.banner)}
                  alt=""
                  loading="lazy"
                />
              ) : null}
              <div className="discover-card-body">
                <div className="discover-card-head">
                  <ServerIcon server={server} className="discover-card-icon" />
                  <strong>{server.name}</strong>
                  {server.boostLevel >= 1 && (
                    <span className="discover-boost-badge">Boosted</span>
                  )}
                </div>
                <p>{server.description || 'No description yet.'}</p>
                <div className="discover-card-foot">
                  <div className="search-result-meta">
                    <span className="discover-online">
                      <i aria-hidden="true" />
                      {server.onlineCount} online
                    </span>
                    <span>
                      {server.memberCount} {server.memberCount === 1 ? 'member' : 'members'}
                    </span>
                  </div>
                  {server.joined ? (
                    <button className="btn btn-ghost btn-sm" onClick={() => onOpen(server.id)}>
                      Open
                    </button>
                  ) : (
                    <div className="discover-card-join">
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => handleJoin(server.id)}
                        disabled={busyId !== null}
                      >
                        {busyId === server.id && <Loader2 size={14} className="spin" />}
                        Join
                      </button>
                      {joinErrors[server.id] && (
                        <p className="form-error" role="alert">
                          {joinErrors[server.id]}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="stage-empty">
          <Compass size={30} />
          <h2>No servers found</h2>
          <p>
            {query || category !== 'All'
              ? 'Try another category or a different search.'
              : 'Nobody has listed a server yet. Turn on Discovery in your server settings to be the first.'}
          </p>
        </div>
      )}
    </div>
  );
}
