import { Award, CircleCheck, CircleAlert, MessageCircle } from 'lucide-react';
import { BadgeArt } from './Badges';

export default function Toast({ toast }) {
  if (!toast) return null;
  const Icon =
    toast.type === 'badge'
      ? Award
      : toast.type === 'message'
        ? MessageCircle
        : toast.type === 'error'
          ? CircleAlert
          : CircleCheck;
  const badgeArt = toast.type === 'badge' && toast.badge;
  return (
    <div className={`toast toast-${toast.type || 'success'}`}>
      <span className={`toast-icon${badgeArt ? ' toast-icon-art' : ''}`}>
        {badgeArt ? <BadgeArt badge={toast.badge} size={28} /> : <Icon size={16} />}
      </span>
      <div>
        <strong>{toast.title}</strong>
        {toast.message && <p>{toast.message}</p>}
      </div>
    </div>
  );
}
