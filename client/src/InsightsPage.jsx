import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2 } from 'lucide-react';
import api from './api';
import InsightsCard from './components/InsightsCard';
import ServerIcon from './components/ServerIcon';

// A bookmarkable home for the numbers the settings card shows. It fetches the
// server for the header and lets the card do the rest, so the two views cannot
// drift apart.
export default function InsightsPage() {
  const { serverId } = useParams();
  const [server, setServer] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setError('');
    api
      .get(`/api/servers/${serverId}`)
      .then((payload) => {
        if (!cancelled) setServer(payload.server);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  return (
    <div className="insights-page">
      <header className="insights-page-head">
        <Link className="btn btn-ghost btn-sm insights-back" to="/">
          <ArrowLeft size={15} />
          Back to Cordia
        </Link>
        <div className="insights-page-title">
          <ServerIcon server={server || { name: '?' }} />
          <div>
            <h1>{server ? server.name : 'Server insights'}</h1>
            <p>Who joined, who talked, and whether it is growing.</p>
          </div>
        </div>
      </header>
      {error && <p className="field-hint insights-page-note">{error}</p>}
      {server && <InsightsCard serverId={server.id} expanded />}
      {!server && !error && (
        <p className="field-hint insights-page-note">
          <Loader2 size={15} className="spin" /> Loading
        </p>
      )}
    </div>
  );
}
