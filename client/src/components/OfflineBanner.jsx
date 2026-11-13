import { WifiOff } from 'lucide-react';
import { useOnlineStatus } from '../pwa';

export default function OfflineBanner() {
  const online = useOnlineStatus();
  if (online) return null;

  return (
    <div className="offline-banner" role="status">
      <WifiOff size={14} />
      <span>You're offline. Cached content may still be available.</span>
    </div>
  );
}
