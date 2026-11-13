import { Crown, MessageSquare, ShieldCheck } from 'lucide-react';
import Avatar from './Avatar';
import { ListeningLine } from './ListeningTo';
import { onlineOf } from '../utils';
import { separateGroup, topGroup } from '../permissions';

export default function MemberList({ server, user, presence, onOpenProfile, onMessageUser }) {
  const online = [];
  const offline = [];
  const seen = new Set();
  const separateGroups = (server.groups || [])
    .filter((group) => group.displaySeparately && !group.isDefault)
    .sort((a, b) => b.position - a.position);
  const separateMembers = new Map(separateGroups.map((group) => [group.id, []]));

  for (const member of server.members) {
    if (seen.has(member.id)) continue;
    seen.add(member.id);
    const group = separateGroup(member);
    if (group && separateMembers.has(group.id)) {
      separateMembers.get(group.id).push(member);
    } else if (onlineOf(member, presence)) {
      online.push(member);
    } else {
      offline.push(member);
    }
  }

  online.sort((a, b) => a.displayName.localeCompare(b.displayName));
  offline.sort((a, b) => a.displayName.localeCompare(b.displayName));
  for (const members of separateMembers.values()) {
    members.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  function Row({ member, sectionGroupId = null }) {
    const group = topGroup(member);
    return (
      <div className="member-row">
        <button className="member-main" onClick={() => onOpenProfile(member.id)}>
          <Avatar user={member} size={32} presence={presence} showPresence />
          <span className="member-meta">
            <span className="member-name">
              {member.displayName}
              {member.serverRole === 'owner' && (
                <Crown size={13} className="role-crown" title="Server owner" />
              )}
              {member.serverRole === 'admin' && (
                <ShieldCheck size={13} className="role-admin" title="Server admin" />
              )}
              {group && group.id !== sectionGroupId && (
                <span
                  className="member-group-badge"
                  style={{
                    color: group.color,
                    borderColor: `${group.color}55`,
                    background: `${group.color}18`
                  }}
                >
                  {group.name}
                </span>
              )}
              {member.bot && <span className="bot-tag">BOT</span>}
              {member.role === 'admin' && <span className="staff-tag">STAFF</span>}
            </span>
            {member.activity ? (
              <ListeningLine activity={member.activity} />
            ) : (
              member.statusText && <span className="member-status">{member.statusText}</span>
            )}
          </span>
        </button>
        {member.id !== user.id && (
          <button
            className="member-dm"
            onClick={() => onMessageUser(member.id)}
            title={`Message ${member.displayName}`}
          >
            <MessageSquare size={14} />
          </button>
        )}
      </div>
    );
  }

  return (
    <aside className="members">
      <div className="members-head">
        <span>Members</span>
        <span className="members-count">{server.members.length}</span>
      </div>
      <div className="members-scroll">
        {separateGroups.map((group) => {
          const members = separateMembers.get(group.id) || [];
          if (!members.length) return null;
          return (
            <div className="member-group" key={`separate-${group.id}`}>
              <div className="member-group-label">
                <span className="member-group-dot" style={{ background: group.color }} />
                <span style={{ color: group.color }}>{group.name}</span>
                <span className="member-group-count">{members.length}</span>
              </div>
              {members.map((member) => (
                <Row key={member.id} member={member} sectionGroupId={group.id} />
              ))}
            </div>
          );
        })}
        {online.length > 0 && (
          <div className="member-group">
            <div className="member-group-label">
              <span>Online</span>
              <span className="member-group-count">{online.length}</span>
            </div>
            {online.map((member) => (
              <Row key={member.id} member={member} />
            ))}
          </div>
        )}
        {offline.length > 0 && (
          <div className="member-group">
            <div className="member-group-label">
              <span>Offline</span>
              <span className="member-group-count">{offline.length}</span>
            </div>
            {offline.map((member) => (
              <Row key={member.id} member={member} />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
