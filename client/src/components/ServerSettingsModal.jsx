import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Crown,
  Loader2,
  LogOut,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  UserMinus
} from 'lucide-react';
import Modal from './Modal';
import Avatar from './Avatar';
import api from '../api';
import { AVATAR_COLORS, inviteLink } from '../utils';

export default function ServerSettingsModal({
  server,
  me,
  presence,
  onClose,
  onUpdated,
  onDeleted,
  onLeft
}) {
  const [tab, setTab] = useState('general');
  const [name, setName] = useState(server.name);
  const [iconColor, setIconColor] = useState(server.iconColor);
  const [inviteCode, setInviteCode] = useState(server.inviteCode);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const inviteUrl = inviteLink(inviteCode);

  const membership = server.members.find((member) => member.id === me.id);
  const isOwner = membership?.serverRole === 'owner';
  const canKick = isOwner || me.role === 'admin';
  const canChangeRole = isOwner;

  useEffect(() => {
    setInviteCode(server.inviteCode);
    setName(server.name);
    setIconColor(server.iconColor);
  }, [server]);

  async function saveGeneral() {
    setBusy('save');
    setError('');
    try {
      const data = await api.patch(`/api/servers/${server.id}`, { name, iconColor });
      onUpdated(data.server);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function regenerate() {
    setBusy('regen');
    setError('');
    try {
      const data = await api.post(`/api/servers/${server.id}/invite/regenerate`);
      setInviteCode(data.inviteCode);
      onUpdated(data.server);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('Could not copy. Select the link and copy manually.');
    }
  }

  async function changeRole(member, role) {
    setBusy(`role-${member.id}`);
    setError('');
    try {
      const data = await api.patch(`/api/servers/${server.id}/members/${member.id}`, { role });
      onUpdated(data.server);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function kick(member) {
    if (!window.confirm(`Remove ${member.displayName} from ${server.name}?`)) return;
    setBusy(`kick-${member.id}`);
    setError('');
    try {
      await api.del(`/api/servers/${server.id}/members/${member.id}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function leave() {
    if (!window.confirm(`Leave ${server.name}?`)) return;
    setBusy('leave');
    try {
      await api.post(`/api/servers/${server.id}/leave`);
      onLeft(server.id);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy('');
    }
  }

  async function destroy() {
    if (!window.confirm(`Delete ${server.name} permanently? All channels and messages will be lost.`)) {
      return;
    }
    setBusy('delete');
    try {
      await api.del(`/api/servers/${server.id}`);
      onDeleted(server.id);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy('');
    }
  }

  return (
    <Modal
      title={server.name}
      subtitle="Server settings"
      onClose={onClose}
      width={620}
      footer={
        tab === 'general' && isOwner ? (
          <div className="settings-footer-right">
            <button className="btn btn-primary btn-sm" onClick={saveGeneral} disabled={busy === 'save'}>
              {busy === 'save' ? <Loader2 size={15} className="spin" /> : <Save size={15} />} Save
              changes
            </button>
          </div>
        ) : null
      }
    >
      <div className="tabs">
        <button className={`tab ${tab === 'general' ? 'active' : ''}`} onClick={() => setTab('general')}>
          General
        </button>
        <button className={`tab ${tab === 'members' ? 'active' : ''}`} onClick={() => setTab('members')}>
          Members
        </button>
      </div>

      {error && <div className="form-error">{error}</div>}

      {tab === 'general' && (
        <div className="server-settings">
          <label className="field">
            <span>Server name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={48}
              disabled={!isOwner}
            />
          </label>

          <div className="field">
            <span>Server accent</span>
            <div className="swatches">
              {AVATAR_COLORS.map((color) => (
                <button
                  key={color}
                  className={`swatch ${iconColor === color ? 'active' : ''}`}
                  style={{ background: color }}
                  onClick={() => isOwner && setIconColor(color)}
                  disabled={!isOwner}
                  aria-label={`Server color ${color}`}
                />
              ))}
            </div>
          </div>

          <div className="invite-code-box">
            <div>
              <span className="settings-label">Invite link</span>
              <strong className="invite-code" style={{ letterSpacing: 0, overflowWrap: 'anywhere' }}>
                {inviteUrl}
              </strong>
            </div>
            <div className="invite-code-actions">
              <button className="btn btn-ghost btn-sm" onClick={copyInvite}>
                {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy link'}
              </button>
              {isOwner && (
                <button className="btn btn-ghost btn-sm" onClick={regenerate} disabled={busy === 'regen'}>
                  {busy === 'regen' ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
                  New link
                </button>
              )}
            </div>
          </div>

          <div className="danger-zone">
            <div>
              <h4>Danger zone</h4>
              <p>
                {isOwner
                  ? 'Deleting a server removes every channel, message and membership forever.'
                  : 'Leaving is reversible with a new invite.'}
              </p>
            </div>
            {isOwner || me.role === 'admin' ? (
              <button className="btn btn-danger btn-sm" onClick={destroy} disabled={busy === 'delete'}>
                <Trash2 size={15} /> Delete server
              </button>
            ) : (
              <button className="btn btn-danger btn-sm" onClick={leave} disabled={busy === 'leave'}>
                <LogOut size={15} /> Leave server
              </button>
            )}
          </div>
        </div>
      )}

      {tab === 'members' && (
        <div className="server-members-admin">
          {server.members.map((member) => (
            <div className="member-admin-row" key={member.id}>
              <Avatar user={member} size={34} presence={presence} showPresence />
              <div className="member-admin-meta">
                <strong>
                  {member.displayName}
                  {member.id === me.id && <span className="you-tag">you</span>}
                </strong>
                <span>@{member.username}</span>
              </div>
              <div className="member-admin-role">
                {member.serverRole === 'owner' ? (
                  <span className="role-pill owner">
                    <Crown size={12} /> Owner
                  </span>
                ) : canChangeRole ? (
                  <select
                    value={member.serverRole}
                    onChange={(event) => changeRole(member, event.target.value)}
                    disabled={busy === `role-${member.id}`}
                  >
                    <option value="member">Member</option>
                    <option value="admin">Admin</option>
                  </select>
                ) : (
                  <span className={`role-pill ${member.serverRole}`}>
                    {member.serverRole === 'admin' ? <ShieldCheck size={12} /> : null}
                    {member.serverRole}
                  </span>
                )}
              </div>
              {member.serverRole !== 'owner' && member.id !== me.id && canKick && (
                <button
                  className="icon-btn danger-hover"
                  title="Remove member"
                  onClick={() => kick(member)}
                  disabled={busy === `kick-${member.id}`}
                >
                  <UserMinus size={16} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
