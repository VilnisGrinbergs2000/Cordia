import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Plus, Server, X } from 'lucide-react';
import ServerSettingsPanel from './ServerSettingsPanel';
import ServerIcon from './ServerIcon';
import { hasServerPermission } from '../permissions';

export default function ServerSettingsPage({
  user,
  servers,
  presence,
  socket,
  initialServerId,
  initialFocus = '',
  onClose,
  onUpdated,
  onRemoved,
  onAddServer
}) {
  const accessibleServers = useMemo(
    () =>
      servers.filter((server) => hasServerPermission(server, user, 'viewServerSettings')),
    [servers, user]
  );
  const initialServer =
    accessibleServers.find((server) => server.id === initialServerId) ||
    accessibleServers[0] ||
    null;
  const [selectedServerId, setSelectedServerId] = useState(initialServer?.id || null);

  const selectedServer =
    accessibleServers.find((server) => server.id === selectedServerId) || null;

  useEffect(() => {
    if (!accessibleServers.some((server) => server.id === selectedServerId)) {
      setSelectedServerId(accessibleServers[0]?.id || null);
    }
  }, [accessibleServers, selectedServerId]);

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  function removeServer(serverId) {
    onRemoved(serverId);
    const next = accessibleServers.find((server) => server.id !== serverId);
    setSelectedServerId(next?.id || null);
  }

  return (
    <div className="settings-page server-settings-page">
      <aside className="settings-sidebar">
        <div className="settings-account-card server-settings-account">
          {selectedServer ? (
            <ServerIcon server={selectedServer} className="settings-server-icon" />
          ) : (
            <span className="settings-server-icon settings-server-icon-empty">
              <Server size={16} />
            </span>
          )}
          <div>
            <strong>{selectedServer?.name || 'No server selected'}</strong>
            <span>Server settings</span>
          </div>
        </div>

        <div className="settings-nav-label">Servers</div>
        <nav className="settings-nav server-settings-nav">
          {accessibleServers.map((server) => (
            <button
              key={server.id}
              className={`settings-nav-item ${server.id === selectedServerId ? 'active' : ''}`}
              onClick={() => setSelectedServerId(server.id)}
              title={server.name}
            >
              <ServerIcon
                server={server}
                className="settings-server-icon server-settings-nav-icon"
              />
              <span className="server-settings-nav-name">{server.name}</span>
            </button>
          ))}
        </nav>

        <div className="settings-sidebar-footer">
          <button className="settings-nav-item" onClick={onAddServer}>
            <Plus size={17} />
            Add a server
          </button>
          <button className="settings-nav-item" onClick={onClose}>
            <ArrowLeft size={17} />
            Back to Cordia
          </button>
        </div>
      </aside>

      <main className="settings-content">
        <header className="settings-topbar">
          <button className="icon-btn" onClick={onClose} title="Back to Cordia">
            <ArrowLeft size={18} />
          </button>
          <div>
            <span>Server settings</span>
            <strong>{selectedServer?.name || 'Servers'}</strong>
          </div>
          <button className="icon-btn" onClick={onClose} title="Close server settings">
            <X size={18} />
          </button>
        </header>

        <div className="settings-scroll">
          {selectedServer ? (
            <section className="settings-section settings-section-wide">
              <div className="settings-section-head">
                <div>
                  <h1>Server settings</h1>
                  <p>Manage this server's identity, channels, groups, permissions, and members.</p>
                </div>
              </div>
              <div className="settings-server-panel">
                <ServerSettingsPanel
                  server={selectedServer}
                  me={user}
                  presence={presence}
                  socket={socket}
                  onUpdated={onUpdated}
                  onRemoved={removeServer}
                  focus={initialFocus}
                />
              </div>
            </section>
          ) : (
            <div className="settings-empty server-settings-empty">
              <Server size={28} />
              <h3>{servers.length ? 'No server settings available' : 'No servers yet'}</h3>
              <p>
                {servers.length
                  ? 'You need permission to view server settings.'
                  : 'Create a server or join one with an invite link.'}
              </p>
              <button className="btn btn-primary btn-sm" onClick={onAddServer}>
                <Plus size={15} /> Add a server
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
