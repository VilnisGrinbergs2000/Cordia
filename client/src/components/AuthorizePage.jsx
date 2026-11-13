import { useEffect, useState } from 'react';
import { Bot, CheckCircle2, Loader2, ShieldCheck, X } from 'lucide-react';
import api from '../api';
import AuthPage from './AuthPage';
import Avatar from './Avatar';
import Logo from './Logo';

// What each intent actually grants, in the words a person installing a bot
// needs rather than the words the gateway uses.
const INTENT_COPY = {
  messages: 'Read messages in channels and post replies',
  reactions: 'See when people react to messages',
  members: 'See who joins and leaves the server'
};

export default function AuthorizePage({ clientId, user, onAuth }) {
  const [app, setApp] = useState(null);
  const [commands, setCommands] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [servers, setServers] = useState(null);
  const [serverId, setServerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [installed, setInstalled] = useState([]);
  const [removing, setRemoving] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  // Read once, at mount: a scope list in the URL is part of the link, not state
  // that changes while somebody is looking at the page.
  const [scopes] = useState(() => {
    try {
      const raw = new URLSearchParams(window.location.search).get('intents') || '';
      return raw
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
    } catch {
      return [];
    }
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get(`/api/applications/public/${encodeURIComponent(clientId)}`)
      .then((payload) => {
        if (cancelled) return;
        setApp(payload.application);
        setCommands(payload.commands || []);
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
  }, [clientId]);

  // The server list is filtered server-side to the ones this person can
  // actually manage, so the picker cannot offer an install that will fail.
  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    api
      .get('/api/applications/servers')
      .then((payload) => {
        if (cancelled) return;
        const list = payload.servers || [];
        setServers(list);
        setServerId((current) => current || (list[0] ? String(list[0].id) : ''));
      })
      .catch(() => {
        if (!cancelled) setServers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Which of the servers in the picker already have this application. Without
  // this the page offers to add a bot that is already a member.
  useEffect(() => {
    if (!user || !app) return undefined;
    let cancelled = false;
    api
      .get(`/api/applications/installed?clientId=${encodeURIComponent(clientId)}`)
      .then((payload) => {
        if (!cancelled) setInstalled(payload.servers || []);
      })
      .catch(() => {
        if (!cancelled) setInstalled([]);
      });
    return () => {
      cancelled = true;
    };
  }, [user, app, clientId]);

  async function remove() {
    if (!app || !serverId) return;
    setRemoving(true);
    setError('');
    try {
      await api.del(`/api/applications/${app.id}/install/${serverId}`);
      setInstalled((rows) => rows.filter((row) => String(row.serverId) !== String(serverId)));
      setConfirmingRemove(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setRemoving(false);
    }
  }

  async function authorize() {
    if (!serverId) return;
    if (!user) {
      setAuthOpen(true);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const payload = await api.post('/api/applications/authorize', {
        clientId,
        serverId: Number(serverId),
        // A link can ask for less than the app declared. Absent means "whatever
        // the app asked for", which is what every link meant before this.
        ...(scopes.length ? { intents: scopes } : {})
      });
      setDone({ name: payload.name || 'the server' });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    window.location.assign(user ? '/app' : '/');
  }

  if (authOpen) {
    return (
      <AuthPage
        onAuth={(nextUser) => {
          onAuth(nextUser);
          setAuthOpen(false);
        }}
      />
    );
  }

  const intents = app?.intents || [];
  const isInstalled = installed.some((row) => String(row.serverId) === String(serverId));

  return (
    <div className="auth-page" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <section className="auth-panel">
        <div className="auth-card" style={{ maxWidth: 480 }}>
          <div className="auth-brand">
            <Logo size={40} withText />
          </div>

          {loading ? (
            <div className="server-template-loading">
              <Loader2 size={17} className="spin" />
              Loading application...
            </div>
          ) : !app ? (
            <>
              <div className="auth-card-head">
                <div>
                  <h2>Application unavailable</h2>
                  <p>{error || 'This install link is invalid, or the application was deleted.'}</p>
                </div>
              </div>
              <button className="btn btn-ghost invite-copy" onClick={cancel}>
                <X size={16} /> Cancel
              </button>
            </>
          ) : done ? (
            <>
              <div className="auth-card-head">
                <div>
                  <h2>Added to {done.name}</h2>
                  <p>{app.name} is now a member and will show up in the member list with a BOT tag.</p>
                </div>
              </div>
              <button className="btn btn-primary invite-copy" onClick={() => window.location.assign('/app')}>
                <CheckCircle2 size={16} /> Open Cordia
              </button>
            </>
          ) : (
            <>
              <div className="invite-visual">
                <Avatar user={{ ...app.bot, avatarColor: app.bot.avatarColor }} size={48} />
                <div>
                  <span className="settings-label">Add a bot to your server</span>
                  <strong style={{ display: 'block', fontSize: 20, lineHeight: 1.25 }}>
                    {app.name}
                    {app.verified && <span className="authorize-verified">Verified</span>}
                  </strong>
                  <span className="field-hint">
                    {app.installs === 0
                      ? 'Not in any server yet'
                      : `In ${app.installs} ${app.installs === 1 ? 'server' : 'servers'}`}
                  </span>
                </div>
              </div>

              {app.description && <p className="invite-description" style={{ marginTop: 14 }}>{app.description}</p>}

              {scopes.length > 0 && (
                <p className="field-hint" style={{ marginTop: 10 }}>
                  This link asks for less than the app normally receives: {scopes.join(', ')} only.
                </p>
              )}

              <div className="authorize-perms">
                <span className="settings-label">
                  <ShieldCheck size={14} /> This bot will be able to
                </span>
                <ul>
                  {intents.map((intent) => (
                    <li key={intent}>{INTENT_COPY[intent] || intent}</li>
                  ))}
                </ul>
                {commands.length > 0 && (
                  <p className="field-hint">
                    It also adds {commands.length} command{commands.length === 1 ? '' : 's'}:{' '}
                    {commands.map((command) => '/' + command.name).join(', ')}
                  </p>
                )}
              </div>

              {error && <div className="form-error">{error}</div>}

              {!user ? (
                <button
                  className="btn btn-primary invite-copy"
                  style={{ marginTop: 14 }}
                  onClick={() => setAuthOpen(true)}
                >
                  <Bot size={16} /> Sign in to add
                </button>
              ) : servers && servers.length === 0 ? (
                <div className="form-error">
                  You do not manage any servers yet. Create one first, then open this link again.
                </div>
              ) : (
                <>
                  <div className="dev-install" style={{ marginTop: 14 }}>
                    <select value={serverId} onChange={(event) => setServerId(event.target.value)}>
                      {(servers || []).map((server) => (
                        <option value={server.id} key={server.id}>
                          {server.name}
                          {installed.some((row) => String(row.serverId) === String(server.id))
                            ? ' · installed'
                            : ''}
                        </option>
                      ))}
                    </select>
                    {isInstalled ? (
                      // Two steps. Removing a bot from a server is not reversible
                      // by the person who does it — they would have to install it
                      // again — so it asks first.
                      confirmingRemove ? (
                        <div className="authorize-confirm">
                          <button className="btn btn-ghost" onClick={() => setConfirmingRemove(false)} disabled={removing}>
                            Keep it
                          </button>
                          <button className="btn btn-danger" onClick={remove} disabled={removing}>
                            {removing ? <Loader2 size={16} className="spin" /> : <X size={16} />}
                            {removing ? 'Removing...' : 'Yes, remove'}
                          </button>
                        </div>
                      ) : (
                        <button className="btn btn-ghost" onClick={() => setConfirmingRemove(true)} disabled={removing}>
                          <X size={16} />
                          Remove
                        </button>
                      )
                    ) : (
                      <button className="btn btn-primary" onClick={authorize} disabled={busy || !serverId}>
                        {busy ? <Loader2 size={16} className="spin" /> : <Bot size={16} />}
                        {busy ? 'Adding...' : 'Add to server'}
                      </button>
                    )}
                  </div>
                  {isInstalled && (
                    <p className="field-hint" style={{ marginTop: 6 }}>
                      {app.name} is already in this server. Removing it takes the bot out and deletes its
                      membership.
                    </p>
                  )}
                </>
              )}

              <button
                className="btn btn-ghost"
                style={{ width: '100%', marginTop: 8 }}
                onClick={cancel}
                disabled={busy}
              >
                <X size={16} /> Cancel
              </button>

              <p className="invite-note">
                Adding a bot gives it access to the channels in that server. A manager can remove it
                from Server settings at any time.
              </p>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
