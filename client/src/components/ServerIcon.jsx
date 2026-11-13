import { assetUrl } from '../runtime';
import { initials, serverIdentityStyle } from '../utils';

export default function ServerIcon({ server, className = '' }) {
  if (!server) return null;
  return (
    <span
      className={`server-icon ${className}`}
      style={serverIdentityStyle(server)}
    >
      {server.iconUrl ? (
        <img src={assetUrl(server.iconUrl)} alt="" draggable={false} />
      ) : (
        <span className="server-icon-initials">{initials(server.name)}</span>
      )}
    </span>
  );
}
