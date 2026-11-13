import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Lock, Minus, Trash2, Users, X } from 'lucide-react';
import Modal from './Modal';
import Avatar from './Avatar';
import api from '../api';

const PERMISSION_LABELS = {
  viewChannel: 'View channel',
  sendMessages: 'Send messages',
  attachFiles: 'Attach files',
  addReactions: 'Add reactions',
  startThreads: 'Start threads',
  manageMessages: 'Manage messages',
  connectVoice: 'Connect',
  speak: 'Speak'
};

// Three states per permission, which is the whole point of an override:
// inherit (no opinion), allow, deny. Anything not set here falls back to what
// the member's groups already say at the server level.
const STATES = [
  { id: 'inherit', label: 'Inherit', icon: Minus, title: 'Use the server setting' },
  { id: 'allow', label: 'Allow', icon: Check, title: 'Always allow here' },
  { id: 'deny', label: 'Deny', icon: X, title: 'Never allow here' }
];

function stateFor(permission, allow, deny) {
  if (deny.includes(permission)) return 'deny';
  if (allow.includes(permission)) return 'allow';
  return 'inherit';
}

export default function ChannelPermissionsModal({ channel, server, onClose }) {
  const [data, setData] = useState(null);
  const [target, setTarget] = useState(null);
  const [allow, setAllow] = useState([]);
  const [deny, setDeny] = useState([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/api/channels/${channel.id}/overrides`)
      .then((payload) => {
        if (!cancelled) setData(payload);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [channel.id]);

  const groups = server.groups || [];
  const members = useMemo(
    () => (server.members || []).filter((member) => member.serverRole !== 'owner'),
    [server.members]
  );

  function selectTarget(next) {
    setTarget(next);
    setNotice('');
    const existing = (data?.overrides || []).find(
      (row) => row.targetType === next.type && row.targetId === next.id
    );
    setAllow(existing ? [...existing.allow] : []);
    setDeny(existing ? [...existing.deny] : []);
  }

  function setState(permission, state) {
    setAllow((prev) => {
      const next = prev.filter((entry) => entry !== permission);
      return state === 'allow' ? [...next, permission] : next;
    });
    setDeny((prev) => {
      const next = prev.filter((entry) => entry !== permission);
      return state === 'deny' ? [...next, permission] : next;
    });
  }

  async function save() {
    if (!target) return;
    setBusy('save');
    setError('');
    try {
      const payload = await api.put(
        `/api/channels/${channel.id}/overrides/${target.type}/${target.id}`,
        { allow, deny }
      );
      setData((prev) => ({
        ...prev,
        overrides: prev.overrides
          .filter((row) => !(row.targetType === target.type && row.targetId === target.id))
          .concat(payload.override ? [{ ...payload.override }] : [])
      }));
      setNotice(payload.cleared ? 'Override cleared.' : 'Override saved.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function clear() {
    if (!target) return;
    setBusy('clear');
    setError('');
    try {
      await api.del(`/api/channels/${channel.id}/overrides/${target.type}/${target.id}`);
      setData((prev) => ({
        ...prev,
        overrides: prev.overrides.filter(
          (row) => !(row.targetType === target.type && row.targetId === target.id)
        )
      }));
      setAllow([]);
      setDeny([]);
      setNotice('Override cleared.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  const overridden = (type, id) =>
    (data?.overrides || []).some((row) => row.targetType === type && row.targetId === id);

  return (
    <Modal title={`Permissions for #${channel.name}`} onClose={onClose} width={720}>
      <div className="channel-perms">
        <p className="channel-perms-hint">
          <Lock size={14} /> Group rules apply from the lowest rank up, then the member's own
          rule wins. A channel nobody may view disappears from that member's sidebar.
        </p>
        {error && <div className="form-error">{error}</div>}
        {notice && <div className="channel-perms-notice">{notice}</div>}

        <div className="channel-perms-layout">
          <div className="channel-perms-targets">
            <span className="settings-label">Roles</span>
            {groups.map((group) => (
              <button
                key={`group-${group.id}`}
                type="button"
                className={`channel-perms-target ${
                  target?.type === 'group' && target.id === group.id ? 'active' : ''
                }`}
                onClick={() => selectTarget({ type: 'group', id: group.id, name: group.name })}
              >
                <span className="group-color-dot" style={{ background: group.color }} />
                <span>{group.name}</span>
                {overridden('group', group.id) && <span className="channel-perms-dot" />}
              </button>
            ))}
            <span className="settings-label">Members</span>
            {members.map((member) => (
              <button
                key={`member-${member.id}`}
                type="button"
                className={`channel-perms-target ${
                  target?.type === 'member' && target.id === member.id ? 'active' : ''
                }`}
                onClick={() =>
                  selectTarget({ type: 'member', id: member.id, name: member.displayName })
                }
              >
                <Avatar user={member} size={20} />
                <span>{member.displayName}</span>
                {overridden('member', member.id) && <span className="channel-perms-dot" />}
              </button>
            ))}
          </div>

          <div className="channel-perms-editor">
            {!target && (
              <p className="channel-empty">
                <Users size={16} /> Pick a role or a member to edit.
              </p>
            )}
            {target && (
              <>
                <h4>{target.name}</h4>
                <div className="channel-perms-rows">
                  {(data?.permissions || []).map((permission) => {
                    const current = stateFor(permission, allow, deny);
                    return (
                      <div className="channel-perms-row" key={permission}>
                        <span>{PERMISSION_LABELS[permission] || permission}</span>
                        <div className="channel-perms-states">
                          {STATES.map((state) => {
                            const Icon = state.icon;
                            return (
                              <button
                                key={state.id}
                                type="button"
                                title={state.title}
                                aria-label={`${PERMISSION_LABELS[permission] || permission}: ${state.label}`}
                                className={`channel-perms-state ${state.id} ${
                                  current === state.id ? 'active' : ''
                                }`}
                                onClick={() => setState(permission, state.id)}
                              >
                                <Icon size={13} />
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="channel-perms-actions">
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={clear}
                    disabled={busy === 'clear' || !overridden(target.type, target.id)}
                  >
                    <Trash2 size={14} /> Clear override
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={save}
                    disabled={busy === 'save'}
                  >
                    {busy === 'save' ? <Loader2 size={14} className="spin" /> : 'Save'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
