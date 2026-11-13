import { useEffect, useState } from 'react';
import { Check, ChevronDown, Copy, Link2, Loader2, Plus, Trash2 } from 'lucide-react';
import api from '../api';
import Modal from './Modal';
import { inviteLink } from '../utils';

const USES = [0, 1, 5, 10, 25];
const EXPIRY = [60, 1440, 10080, 43200, 0];

function left(expiresAt) {
  if (!expiresAt) return 'Never expires';
  const minutes = Math.round((expiresAt - Date.now()) / 60000);
  if (minutes <= 0) return 'Expired';
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h left` : `${Math.round(hours / 24)}d left`;
}

function statusText(invite) {
  if (invite.status === 'revoked') return 'Revoked';
  if (invite.status === 'spent') return 'Used up';
  return left(invite.expiresAt);
}

export default function InviteManager({ server, onClose }) {
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [maxUses, setMaxUses] = useState(0);
  const [expiry, setExpiry] = useState(1440);
  const [inactive, setInactive] = useState(false);
  const [expanded, setExpanded] = useState(0);
  const [busy, setBusy] = useState('');
  const [copied, setCopied] = useState(0);

  async function load(showInactive) {
    setLoading(true);
    try {
      const data = await api.get(
        `/api/servers/${server.id}/invites${showInactive ? '?includeInactive=1' : ''}`
      );
      setInvites(data.invites || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(false);
  }, [server.id]);

  function toggleInactive() {
    const next = !inactive;
    setInactive(next);
    load(next);
  }

  async function create() {
    setBusy('create');
    setError('');
    try {
      const data = await api.post(`/api/servers/${server.id}/invites`, {
        maxUses,
        expiresInMinutes: expiry
      });
      setInvites((prev) => [data.invite, ...prev]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function revoke(invite) {
    setBusy(`revoke:${invite.id}`);
    setError('');
    try {
      await api.del(`/api/invites/${invite.id}`);
      if (inactive) {
        setInvites((prev) =>
          prev.map((entry) =>
            entry.id === invite.id ? { ...entry, status: 'revoked', revokedAt: Date.now() } : entry
          )
        );
      } else {
        setInvites((prev) => prev.filter((entry) => entry.id !== invite.id));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function copy(invite) {
    try {
      await navigator.clipboard.writeText(inviteLink(invite.code));
      setCopied(invite.id);
      setTimeout(() => setCopied(0), 1600);
    } catch {
      setCopied(0);
    }
  }

  return (
    <Modal
      title="Invite links"
      subtitle="Time-limited or use-limited links. The permanent link keeps working."
      onClose={onClose}
      width={560}
    >
      <div className="invite-create">
        <label className="field invite-create-field">
          <span>Uses</span>
          <select value={maxUses} onChange={(event) => setMaxUses(Number(event.target.value))}>
            {USES.map((value) => (
              <option key={value} value={value}>
                {value === 0 ? 'No use limit' : `${value} use${value === 1 ? '' : 's'}`}
              </option>
            ))}
          </select>
        </label>
        <label className="field invite-create-field">
          <span>Expires</span>
          <select value={expiry} onChange={(event) => setExpiry(Number(event.target.value))}>
            {EXPIRY.map((value) => (
              <option key={value} value={value}>
                {value === 0 ? 'Never expires' : left(Date.now() + value * 60000).replace(' left', '')}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-primary btn-sm" onClick={create} disabled={busy === 'create'}>
          {busy === 'create' ? <Loader2 size={15} className="spin" /> : <Plus size={15} />}
          Create
        </button>
      </div>

      {error && <p className="form-error">{error}</p>}

      <div className="invite-toolbar">
        <button className="btn btn-ghost btn-sm" onClick={toggleInactive}>
          {inactive ? 'Hide inactive' : 'Show inactive'}
        </button>
      </div>

      {loading ? (
        <p className="invite-empty">Loading links…</p>
      ) : invites.length === 0 ? (
        <p className="invite-empty">
          <Link2 size={16} /> {inactive ? 'No links yet.' : 'No limited links yet. Create one above.'}
        </p>
      ) : (
        <ul className="invite-list">
          {invites.map((invite) => (
            <li key={invite.id} className={`invite-row ${invite.status}`}>
              <button
                className="invite-row-main"
                onClick={() => setExpanded(expanded === invite.id ? 0 : invite.id)}
                aria-expanded={expanded === invite.id}
              >
                <strong>{invite.code}</strong>
                <span className="invite-meta">
                  {invite.maxUses
                    ? `${invite.uses}/${invite.maxUses} uses`
                    : `${invite.uses} use${invite.uses === 1 ? '' : 's'}`}
                  {' · '}
                  {statusText(invite)}
                  {invite.joinedCount > 0 && ` · ${invite.joinedCount} joined`}
                </span>
                {expanded === invite.id && (
                  <span className="invite-joined">
                    {invite.joined.length
                      ? `Joined by ${invite.joined.map((entry) => entry.displayName).join(', ')}${
                          invite.joinedCount > invite.joined.length ? '…' : ''
                        }`
                      : 'Nobody has joined through this link yet.'}
                    {invite.creator && ` · Created by ${invite.creator}`}
                  </span>
                )}
              </button>
              <ChevronDown
                size={15}
                className={`invite-caret ${expanded === invite.id ? 'open' : ''}`}
                aria-hidden="true"
              />
              <button className="icon-btn" onClick={() => copy(invite)} aria-label="Copy link">
                {copied === invite.id ? <Check size={16} /> : <Copy size={16} />}
              </button>
              {invite.status === 'active' && (
                <button
                  className="icon-btn danger"
                  onClick={() => revoke(invite)}
                  disabled={busy === `revoke:${invite.id}`}
                  aria-label="Revoke link"
                >
                  {busy === `revoke:${invite.id}` ? (
                    <Loader2 size={16} className="spin" />
                  ) : (
                    <Trash2 size={16} />
                  )}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
