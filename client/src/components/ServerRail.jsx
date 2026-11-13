import { Compass, Home, Plus, Shield } from 'lucide-react';
import { Link } from 'react-router-dom';
import Logo from './Logo';
import { assetUrl } from '../runtime';
import { initials, serverIdentityStyle } from '../utils';

export default function ServerRail({
  servers,
  activeServerId,
  homeActive,
  user,
  serverUnread,
  onHome,
  onSelectServer,
  onAddServer,
  onDiscover,
  discoverActive
}) {
  return (
    <nav className="server-rail">
      <button
        className={`rail-btn rail-home ${homeActive ? 'active' : ''}`}
        onClick={onHome}
        data-tooltip="Home"
        aria-label="Home"
      >
        <Logo size={26} />
      </button>

      <div className="rail-divider" />

      <div className="rail-servers">
        {servers.map((server) => {
          const unread = serverUnread[server.id] || 0;
          return (
            <button
              key={server.id}
              className={`rail-btn rail-server ${server.iconUrl ? 'rail-server-icon' : ''} ${
                activeServerId === server.id ? 'active' : ''
              }`}
              style={
                // An icon covers the button, so the identity colour would only
                // show as a fringe around its rounded corners - skip it.
                server.iconUrl
                  ? { '--server-color': server.iconColor || '#6366f1' }
                  : serverIdentityStyle(server)
              }
              onClick={() => onSelectServer(server.id)}
              data-tooltip={server.name}
              aria-label={server.name}
            >
              {server.iconUrl ? (
                <img
                  className="rail-server-image"
                  src={assetUrl(server.iconUrl)}
                  alt=""
                  draggable={false}
                />
              ) : (
                <span>{initials(server.name)}</span>
              )}
              {unread > 0 && <span className="rail-unread">{unread > 9 ? '9+' : unread}</span>}
            </button>
          );
        })}
      </div>

      <button
        className={`rail-btn rail-discover ${discoverActive ? 'active' : ''}`}
        onClick={onDiscover}
        data-tooltip="Discover"
        aria-label="Discover"
      >
        <Compass size={20} />
      </button>

      <button className="rail-btn rail-add" onClick={onAddServer} data-tooltip="Add a server" aria-label="Add a server">
        <Plus size={22} />
      </button>

      <div className="rail-spacer" />

      {user.role === 'admin' && (
        <Link className="rail-btn rail-admin" to="/admin" data-tooltip="Admin console" aria-label="Admin console">
          <Shield size={20} />
        </Link>
      )}
    </nav>
  );
}
