import { useCallback, useEffect, useState } from 'react';
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  KeyRound,
  Link2,
  Loader2,
  Pencil,
  Plus,
  Radio,
  RotateCw,
  Server,
  Terminal,
  Trash2
} from 'lucide-react';
import api from '../api';
import { API_BASE } from '../runtime';

// The install link is the app's public door: /authorize?client_id=...
// window.location.origin is "null" when the client is loaded from file://, so
// the API host is the fallback rather than an empty string.
function installLink(clientId) {
  let origin = '';
  try {
    if (window.location.origin && window.location.origin !== 'null') origin = window.location.origin;
  } catch {
    origin = '';
  }
  if (!origin) origin = String(API_BASE || '').replace(/\/+$/, '');
  return `${origin}/authorize?client_id=${encodeURIComponent(clientId)}`;
}

// Applications are the only settings tab that hands out a credential, so the
// token is shown exactly once and never fetched again — the server keeps a
// hash. Everything else here is plain management.
function CopyField({ value, label }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="dev-copy">
      <span className="dev-copy-label">{label}</span>
      <code>{value}</code>
      <button type="button" className="icon-btn" onClick={copy} title={`Copy ${label}`}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

// The permissions worth gating a command on, in the order people reach for them.
// The API accepts any of the twelve; these are the six that make a difference in
// a command, and a checkbox list of all twelve is a settings screen, not a form.
const COMMAND_PERMISSIONS = [
  { key: 'manageServer', label: 'Managers' },
  { key: 'manageMessages', label: 'Moderators' },
  { key: 'kickMembers', label: 'Kick' },
  { key: 'manageChannels', label: 'Channels' },
  { key: 'sendMessages', label: 'Can post' },
  { key: 'connectVoice', label: 'Voice' }
];

const ACCESS_LABEL = {
  manageMessages: 'Moderators only',
  manageServer: 'Managers only',
  kickMembers: 'Kick only',
  manageChannels: 'Channels only',
  sendMessages: 'Posters only',
  connectVoice: 'Voice only'
};

export default function DevelopersPanel() {
  const [apps, setApps] = useState([]);
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creating, setCreating] = useState(false);
  const [freshToken, setFreshToken] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [commands, setCommands] = useState({});
  const [commandDraft, setCommandDraft] = useState({ name: '', description: '', permissions: [] });
  const [editingCommand, setEditingCommand] = useState(null);
  const [busy, setBusy] = useState('');
  const [installChoice, setInstallChoice] = useState({});

  const load = useCallback(async () => {
    try {
      const data = await api.get('/api/applications');
      setApps(data.applications || []);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    api
      .get('/api/applications/servers')
      .then((data) => setServers(data.servers || []))
      .catch(() => setServers([]));
  }, [load]);

  async function create(event) {
    event.preventDefault();
    setCreating(true);
    setError('');
    try {
      const data = await api.post('/api/applications', { name, description });
      setFreshToken({ id: data.application.id, token: data.token });
      setName('');
      setDescription('');
      await load();
    } catch (createError) {
      setError(createError.message);
    } finally {
      setCreating(false);
    }
  }

  async function rotate(app) {
    if (!window.confirm(`Rotate the token for ${app.name}? The old token stops working immediately.`)) return;
    setBusy('rotate:' + app.id);
    try {
      const data = await api.post(`/api/applications/${app.id}/token`, {});
      setFreshToken({ id: app.id, token: data.token });
      await load();
    } catch (rotateError) {
      setError(rotateError.message);
    } finally {
      setBusy('');
    }
  }

  async function remove(app) {
    if (!window.confirm(`Delete ${app.name}? Its commands stop working and the bot leaves every server.`)) return;
    setBusy('delete:' + app.id);
    try {
      await api.del(`/api/applications/${app.id}`);
      await load();
    } catch (removeError) {
      setError(removeError.message);
    } finally {
      setBusy('');
    }
  }

  async function toggle(app) {
    if (expanded === app.id) {
      setExpanded(null);
      return;
    }
    setExpanded(app.id);
    if (!commands[app.id]) {
      try {
        const data = await api.get(`/api/applications/${app.id}/commands`);
        setCommands((prev) => ({ ...prev, [app.id]: data.commands || [] }));
      } catch {
        setCommands((prev) => ({ ...prev, [app.id]: [] }));
      }
    }
  }

  function editCommand(app, command) {
    setEditingCommand(command.id);
    setCommandDraft({
      name: command.name,
      description: command.description,
      permissions: command.permissions || []
    });
  }

  function resetDraft() {
    setEditingCommand(null);
    setCommandDraft({ name: '', description: '', permissions: [] });
  }

  function togglePermission(key) {
    setCommandDraft((prev) => ({
      ...prev,
      permissions: prev.permissions.includes(key)
        ? prev.permissions.filter((entry) => entry !== key)
        : [...prev.permissions, key]
    }));
  }

  async function saveCommand(app) {
    setBusy('command:' + app.id);
    setError('');
    try {
      if (editingCommand) {
        const data = await api.patch(
          `/api/applications/${app.id}/commands/${editingCommand}`,
          { description: commandDraft.description, permissions: commandDraft.permissions }
        );
        setCommands((prev) => ({
          ...prev,
          [app.id]: (prev[app.id] || []).map((entry) =>
            entry.id === editingCommand ? data.command : entry
          )
        }));
      } else {
        const data = await api.post(`/api/applications/${app.id}/commands`, {
          name: commandDraft.name,
          description: commandDraft.description,
          permissions: commandDraft.permissions
        });
        setCommands((prev) => ({ ...prev, [app.id]: [...(prev[app.id] || []), data.command] }));
      }
      resetDraft();
      await load();
    } catch (commandError) {
      setError(commandError.message);
    } finally {
      setBusy('');
    }
  }

  async function dropCommand(app, command) {
    setBusy('drop:' + command.id);
    try {
      await api.del(`/api/applications/${app.id}/commands/${command.id}`);
      setCommands((prev) => ({
        ...prev,
        [app.id]: (prev[app.id] || []).filter((entry) => entry.id !== command.id)
      }));
      await load();
    } catch (dropError) {
      setError(dropError.message);
    } finally {
      setBusy('');
    }
  }

  const ALL_INTENTS = ['messages', 'reactions', 'members'];

  async function toggleIntent(app, intent) {
    // An app with no explicit intents gets all of them, so the toggle starts
    // from that effective list rather than from an empty one.
    const current = app.intents?.length ? app.intents : ALL_INTENTS;
    const next = current.includes(intent)
      ? current.filter((entry) => entry !== intent)
      : [...current, intent];
    setBusy('intents:' + app.id);
    try {
      await api.patch(`/api/applications/${app.id}`, { intents: next });
      await load();
    } catch (intentError) {
      setError(intentError.message);
    } finally {
      setBusy('');
    }
  }

  async function install(app, serverId) {
    if (!serverId) return;
    setBusy('install:' + app.id);
    try {
      await api.post(`/api/applications/${app.id}/install`, { serverId: Number(serverId) });
      await load();
    } catch (installError) {
      setError(installError.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <div>
          <h1>Developers</h1>
          <p>
            Build an application, give it a bot, and install it into a server. Bots talk to the REST
            API with <code>Authorization: Bot &lt;token&gt;</code> and to the gateway at
            <code> /gateway</code>.
          </p>
        </div>
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className="settings-group">
        <div className="settings-group-head">
          <h3>New application</h3>
          <span>Up to 10 per account</span>
        </div>
        <form className="dev-create" onSubmit={create}>
          <label className="field">
            <span>Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Helper"
              maxLength={32}
            />
          </label>
          <label className="field">
            <span>Description</span>
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What does it do?"
              maxLength={200}
            />
          </label>
          <button className="btn btn-primary" type="submit" disabled={creating || name.trim().length < 2}>
            {creating ? <Loader2 size={15} className="spin" /> : <Plus size={15} />}
            Create
          </button>
        </form>
      </div>

      {freshToken && (
        <div className="dev-token-banner">
          <KeyRound size={16} />
          <div>
            <strong>Copy this token now</strong>
            <p>It is stored as a hash, so this is the only time it is shown.</p>
            <CopyField value={freshToken.token} label="Bot token" />
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFreshToken(null)}>
            Done
          </button>
        </div>
      )}

      {loading ? (
        <div className="admin-loading">
          <Loader2 className="spin" size={22} />
          <span>Loading applications...</span>
        </div>
      ) : apps.length === 0 ? (
        <div className="settings-empty">
          <Bot size={26} />
          <strong>No applications yet</strong>
          <span>Create one above to get a bot, a token and slash commands.</span>
        </div>
      ) : (
        apps.map((app) => (
          <div className="dev-app" key={app.id}>
            <div className="dev-app-head">
              <button type="button" className="dev-app-title" onClick={() => toggle(app)}>
                {expanded === app.id ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <Bot size={16} />
                <strong>{app.name}</strong>
                <span className="dev-app-meta">
                  {app.commandCount} command{app.commandCount === 1 ? '' : 's'} · {app.installCount} server
                  {app.installCount === 1 ? '' : 's'}
                </span>
              </button>
              <div className="dev-app-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => rotate(app)}
                  disabled={busy === 'rotate:' + app.id}
                >
                  {busy === 'rotate:' + app.id ? <Loader2 size={13} className="spin" /> : <RotateCw size={13} />}
                  Rotate token
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm dev-danger"
                  onClick={() => remove(app)}
                  disabled={busy === 'delete:' + app.id}
                >
                  {busy === 'delete:' + app.id ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />}
                  Delete
                </button>
              </div>
            </div>

            {expanded === app.id && (
              <div className="dev-app-body">
                <div className="dev-app-facts">
                  <CopyField value={app.clientId} label="Client id" />
                  <div className="dev-copy">
                    <span className="dev-copy-label">Token</span>
                    <code>••••••{app.tokenHint}</code>
                  </div>
                  <div className="dev-copy">
                    <span className="dev-copy-label">Bot user</span>
                    <code>@{app.bot.username}</code>
                  </div>
                </div>

                <div className="dev-subsection">
                  <h4>
                    <Terminal size={14} /> Slash commands
                  </h4>
                  {(commands[app.id] || []).length === 0 ? (
                    <p className="dev-hint">No commands yet. Add one and it appears in the composer after typing /.</p>
                  ) : (
                    <ul className="dev-command-list">
                      {(commands[app.id] || []).map((command) => (
                        <li key={command.id}>
                          <code>/{command.name}</code>
                          <span>{command.description}</span>
                          {(command.permissions || []).length > 0 && (
                            <span className="dev-command-access">
                              {ACCESS_LABEL[command.permissions[0]] || command.permissions[0]}
                            </span>
                          )}
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() => editCommand(app, command)}
                            title="Edit command"
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            className="icon-btn"
                            onClick={() => dropCommand(app, command)}
                            disabled={busy === 'drop:' + command.id}
                            title="Delete command"
                          >
                            <Trash2 size={13} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="dev-command-form">
                    <input
                      value={commandDraft.name}
                      onChange={(event) =>
                        setCommandDraft((prev) => ({ ...prev, name: event.target.value }))
                      }
                      placeholder="command-name"
                      maxLength={32}
                    />
                    <input
                      value={commandDraft.description}
                      onChange={(event) =>
                        setCommandDraft((prev) => ({ ...prev, description: event.target.value }))
                      }
                      placeholder="What it does"
                      maxLength={100}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => saveCommand(app)}
                      disabled={busy === 'command:' + app.id || !commandDraft.name.trim()}
                    >
                      {busy === 'command:' + app.id ? (
                        <Loader2 size={13} className="spin" />
                      ) : editingCommand ? (
                        <Check size={13} />
                      ) : (
                        <Plus size={13} />
                      )}
                      {editingCommand ? 'Save' : 'Add'}
                    </button>
                    {editingCommand && (
                      <button type="button" className="btn btn-ghost btn-sm" onClick={resetDraft}>
                        Cancel
                      </button>
                    )}
                  </div>
                  <div className="dev-command-access-row">
                    <span className="dev-hint">Who can run it</span>
                    {COMMAND_PERMISSIONS.map((permission) => (
                      <button
                        type="button"
                        key={permission.key}
                        className={'dev-intent' + (commandDraft.permissions.includes(permission.key) ? ' on' : '')}
                        onClick={() => togglePermission(permission.key)}
                        title={permission.key}
                      >
                        {permission.label}
                      </button>
                    ))}
                    {commandDraft.permissions.length === 0 && (
                      <span className="dev-hint">Anyone</span>
                    )}
                  </div>
                </div>

                <div className="dev-subsection">
                  <h4>
                    <Radio size={14} /> Events
                  </h4>
                  <div className="dev-intents">
                    {ALL_INTENTS.map((intent) => {
                      const active = (app.intents?.length ? app.intents : ALL_INTENTS).includes(intent);
                      return (
                        <button
                          key={intent}
                          type="button"
                          className={`dev-intent ${active ? 'on' : ''}`}
                          onClick={() => toggleIntent(app, intent)}
                          disabled={busy === 'intents:' + app.id}
                        >
                          {intent}
                        </button>
                      );
                    })}
                  </div>
                  <p className="dev-hint">
                    Message events include create, edit and delete. Turning one off stops it reaching
                    the gateway for this app.
                  </p>
                </div>

                <div className="dev-subsection">
                  <h4>
                    <Server size={14} /> Install
                  </h4>
                  {servers.length === 0 ? (
                    <p className="dev-hint">You need the Manage server permission somewhere to install a bot.</p>
                  ) : (
                    <div className="dev-install">
                      <select
                        value={installChoice[app.id] || ''}
                        onChange={(event) =>
                          setInstallChoice((prev) => ({ ...prev, [app.id]: event.target.value }))
                        }
                      >
                        <option value="">Pick a server...</option>
                        {servers.map((server) => (
                          <option value={server.id} key={server.id}>
                            {server.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => install(app, installChoice[app.id])}
                        disabled={!installChoice[app.id] || busy === 'install:' + app.id}
                      >
                        {busy === 'install:' + app.id ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}
                        Add to server
                      </button>
                    </div>
                  )}
                </div>

                <div className="dev-subsection">
                  <h4>
                    <Link2 size={14} /> Install link
                  </h4>
                  <p className="dev-hint">
                    Share this with anyone who manages a server. They see what the bot can read before
                    adding it, and only a manager can finish.
                  </p>
                  <CopyField value={installLink(app.clientId)} label="Install link" />
                </div>
              </div>
            )}
          </div>
        ))
      )}
    </section>
  );
}
