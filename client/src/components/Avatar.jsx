import { assetUrl } from '../runtime';
import { initials, presenceColor } from '../utils';

export default function Avatar({ user, size = 40, presence, showPresence = false, className = '' }) {
  if (!user) return null;
  const style = {
    width: size,
    height: size,
    '--avatar-color': user.avatarColor || '#6366f1',
    fontSize: Math.max(11, Math.round(size * 0.36))
  };
  return (
    <span className={`avatar ${className}`} style={style}>
      {user.avatarUrl ? (
        <img src={assetUrl(user.avatarUrl)} alt="" />
      ) : (
        <span className="avatar-initials">{initials(user.displayName || user.username)}</span>
      )}
      {showPresence && (
        <span
          className="avatar-presence"
          style={{
            background: presenceColor(user, presence),
            width: Math.max(10, Math.round(size * 0.28)),
            height: Math.max(10, Math.round(size * 0.28))
          }}
        />
      )}
    </span>
  );
}
