import { useEffect, useState } from 'react';
import {
  Award,
  Ban,
  CalendarDays,
  Check,
  Clock,
  Gamepad2,
  Link2,
  Loader2,
  Lock,
  MessageSquare,
  Pencil,
  Server,
  ShieldCheck,
  UserMinus,
  UserPlus,
  X
} from 'lucide-react';
import Modal from './Modal';
import Avatar from './Avatar';
import ServerIcon from './ServerIcon';
import { BADGE_META, BadgeButton } from './Badges';
import Markdown from './Markdown';
import ListeningTo from './ListeningTo';
import EmoteInsertButton, { useMyEmotes } from './EmoteInsertButton';
import api from '../api';
import { assetUrl } from '../runtime';
import { formatDate, presenceColor, presenceLabel } from '../utils';

const LINK_LABELS = {
  website: 'Website',
  x: 'X',
  github: 'GitHub',
  gitlab: 'GitLab',
  youtube: 'YouTube',
  twitch: 'Twitch',
  bluesky: 'Bluesky',
  mastodon: 'Mastodon',
  steam: 'Steam',
  spotify: 'Spotify',
  itch: 'itch.io',
  linkedin: 'LinkedIn'
};

function formatHours(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  if (total < 3600) return `${Math.round(total / 60)}m`;
  const hours = total / 3600;
  return hours >= 100 ? `${Math.round(hours)}h` : `${hours.toFixed(1)}h`;
}

function ProfileSkeleton() {
  return (
    <div className="profile-skeleton" aria-hidden="true">
      <div className="profile-skeleton-cover" />
      <div className="profile-skeleton-body">
        <span className="profile-skeleton-avatar" />
        <span className="profile-skeleton-line wide" />
        <span className="profile-skeleton-line" />
        <span className="profile-skeleton-card" />
      </div>
    </div>
  );
}

function BadgeTile({ badge }) {
  const meta = BADGE_META[badge.key] || {};
  const color = badge.color || meta.color || '#94a3b8';
  return <BadgeButton badge={badge.key} size={36} color={color} className="profile-badge-button" />;
}

export default function ProfileModal({
  userId,
  serverId = null,
  refreshKey = 0,
  me,
  presence,
  onClose,
  onOpenSettings,
  onMessageUser,
  onAddFriend,
  onAcceptFriendByUser,
  onRemoveFriend,
  onBlockUser,
  onUnblockUser
}) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [note, setNote] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteNotice, setNoteNotice] = useState('');
  const [bioEditing, setBioEditing] = useState(false);
  const [bioDraft, setBioDraft] = useState('');
  const [bioBusy, setBioBusy] = useState(false);
  const emotes = useMyEmotes();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .get(`/api/users/${userId}/profile${serverId ? `?serverId=${serverId}` : ''}`)
      .then((data) => {
        if (!cancelled) setProfile(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, serverId, reloadKey, refreshKey]);

  useEffect(() => {
    if (!userId || userId === me.id) return undefined;
    let cancelled = false;
    api
      .get(`/api/users/${userId}/note`)
      .then((data) => {
        if (cancelled) return;
        setNote(data.note || '');
        setNoteDraft(data.note || '');
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [userId, me.id, reloadKey]);

  async function saveNote() {
    setNoteBusy(true);
    setNoteNotice('');
    try {
      const data = await api.put(`/api/users/${userId}/note`, { note: noteDraft });
      setNote(data.note);
      setNoteDraft(data.note);
      setNoteNotice(data.note ? 'Note saved.' : 'Note cleared.');
    } catch (err) {
      setNoteNotice(err.message);
    } finally {
      setNoteBusy(false);
    }
  }

  // The per-server bio belongs to one server, so it is saved through the
  // server-scoped route rather than the global profile patch. Reloading after
  // the save re-reads it from the same place the view just rendered.
  async function saveServerBio() {
    if (!serverId) return;
    setBioBusy(true);
    setActionError('');
    try {
      await api.patch(`/api/servers/${serverId}/members/me/bio`, { bio: bioDraft });
      setBioEditing(false);
      setReloadKey((value) => value + 1);
    } catch (err) {
      setActionError(err.message);
    } finally {
      setBioBusy(false);
    }
  }

  async function run(name, action, reload = true) {
    setBusy(name);
    setActionError('');
    try {
      await action();
      if (reload) setReloadKey((value) => value + 1);
    } catch (err) {
      setActionError(err.message);
    } finally {
      setBusy('');
    }
  }

  const isSelf = profile?.user.id === me.id;
  const user = profile?.user;
  const relationship = profile?.relationship;

  return (
    <Modal
      onClose={onClose}
      width={620}
      headless
      className="profile-modal"
      ariaLabel="User profile"
    >
      {loading ? (
        <ProfileSkeleton />
      ) : error ? (
        <div className="profile-error">
          <div className="form-error">{error}</div>
        </div>
      ) : (
        <div className="profile-card">
          <div
            className={`profile-cover ${user.bannerUrl ? 'has-image' : ''}`}
            style={{
              '--profile-banner': user.bannerColor || '#242a52',
              '--profile-accent': user.avatarColor || '#6366f1',
              ...(user.bannerUrl
                ? {
                    backgroundImage: `linear-gradient(180deg, rgba(5, 9, 20, 0.08), rgba(5, 9, 20, 0.66)), url("${assetUrl(user.bannerUrl)}")`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center'
                  }
                : {})
            }}
          >
            <div className="profile-cover-meta">
              {user.role === 'admin' && (
                <span className="profile-role">
                  <ShieldCheck size={12} /> STAFF
                </span>
              )}
            </div>
            <button className="profile-close" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </div>

          <div className="profile-body">
            <div className="profile-identity">
              <div className="profile-avatar-wrap">
                <Avatar user={user} size={104} presence={presence} showPresence />
              </div>
              <div className="profile-actions">
                {isSelf ? (
                  <button className="btn btn-primary btn-sm" onClick={() => onOpenSettings()}>
                    <Pencil size={15} /> Edit profile
                  </button>
                ) : (
                  <>
                    {relationship !== 'blockedBy' &&
                      relationship !== 'blocked' &&
                      (profile.canMessage ? (
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => run('dm', () => onMessageUser(user.id), false)}
                          disabled={busy === 'dm'}
                        >
                          <MessageSquare size={15} /> Message
                        </button>
                      ) : (
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled
                          title="This person only accepts messages from friends."
                        >
                          <Lock size={15} /> Friends only
                        </button>
                      ))}
                    {relationship === 'none' &&
                      (profile.canRequestFriend === false ? (
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled
                          title="This person is not accepting friend requests."
                        >
                          <UserPlus size={15} /> Requests closed
                        </button>
                      ) : (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => run('add', () => onAddFriend(user.username))}
                          disabled={busy === 'add'}
                        >
                          <UserPlus size={15} /> Add friend
                        </button>
                      ))}
                    {relationship === 'outgoing' && (
                      <button className="btn btn-ghost btn-sm" disabled>
                        <Clock size={15} /> Request sent
                      </button>
                    )}
                    {relationship === 'incoming' && (
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => run('accept', () => onAcceptFriendByUser(user.id))}
                        disabled={busy === 'accept'}
                      >
                        <Check size={15} /> Accept request
                      </button>
                    )}
                    {relationship === 'friends' && (
                      <button
                        className="btn btn-ghost btn-sm profile-muted-action"
                        onClick={() => run('remove', () => onRemoveFriend(user.id))}
                        disabled={busy === 'remove'}
                      >
                        <UserMinus size={15} /> Remove friend
                      </button>
                    )}
                    {relationship === 'blocked' && (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => run('unblock', () => onUnblockUser(user.id))}
                        disabled={busy === 'unblock'}
                      >
                        Unblock
                      </button>
                    )}
                    {relationship === 'blockedBy' && (
                      <span className="profile-blocked-note">
                        <Ban size={14} /> This user blocked you.
                      </span>
                    )}
                    {relationship !== 'blocked' && relationship !== 'blockedBy' && (
                      <button
                        className="icon-btn danger-hover"
                        title="Block user"
                        onClick={() => run('block', () => onBlockUser(user.id))}
                        disabled={busy === 'block'}
                      >
                        <Ban size={16} />
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>

            <div className="profile-names">
              <h2>
                {user.displayName}
              </h2>
              <div className="profile-handle-row">
                <span className="profile-handle">@{user.username}</span>
                <span
                  className="profile-presence-pill"
                  style={{ '--presence-color': presenceColor(user, presence) }}
                >
                  <span className="profile-presence-dot" />
                  {presenceLabel(user, presence)}
                </span>
              </div>
              {user.statusText && <p className="profile-status">{user.statusText}</p>}
              {user.activity && (
                <div className="profile-listening">
                  <ListeningTo activity={user.activity} />
                </div>
              )}
            </div>

            <div className="profile-facts">
              <div className="profile-fact">
                <CalendarDays size={16} />
                <span>
                  <strong>{profile.memberSince ? formatDate(profile.memberSince) : '—'}</strong>
                  <small>Member since</small>
                </span>
              </div>
              {!profile.restricted && (
                <>
                  <div className="profile-fact">
                    <Award size={16} />
                    <span>
                      <strong>{profile.badges.length}</strong>
                      <small>Badges</small>
                    </span>
                  </div>
                  <div className="profile-fact">
                    <Server size={16} />
                    <span>
                      <strong>{profile.mutualServers.length}</strong>
                      <small>
                        {profile.mutualServers.length === 1 ? 'Mutual server' : 'Mutual servers'}
                      </small>
                    </span>
                  </div>
                </>
              )}
            </div>

            {actionError && <div className="profile-alert form-error">{actionError}</div>}
            {!isSelf && relationship === 'none' && !profile.canMessage && (
              <p className="profile-dm-note">
                <Lock size={14} /> This person only accepts messages from friends. Add them first.
              </p>
            )}

            {profile.restricted ? (
              <section className="profile-panel">
                <div className="profile-panel-head">
                  <h3>Private profile</h3>
                </div>
                <p className="profile-empty">
                  <Lock size={14} />{' '}
                  {profile.restrictedReason === 'friends'
                    ? 'This person shares their bio, badges and servers with friends only.'
                    : 'This person shares their bio, badges and servers with people in their servers.'}
                </p>
                {profile.mutualFriendCount > 0 && (
                  <p className="profile-empty">
                    You have {profile.mutualFriendCount} mutual{' '}
                    {profile.mutualFriendCount === 1 ? 'friend' : 'friends'}.
                  </p>
                )}
              </section>
            ) : (
              <>
            <section className="profile-panel">
              <div className="profile-panel-head">
                <h3>About</h3>
              </div>
              {user.bio ? (
                <div className="profile-bio">
                  <Markdown text={user.bio} meUsername={me?.username} emotes={emotes} />
                </div>
              ) : (
                <p className="profile-bio muted">No bio yet.</p>
              )}
            </section>

            {serverId && (profile.serverBio || isSelf) && (
              <section className="profile-panel">
                <div className="profile-panel-head">
                  <h3>In this server</h3>
                  {isSelf && !bioEditing && (
                    <button
                      type="button"
                      className="profile-panel-action"
                      onClick={() => {
                        setBioDraft(profile.serverBio || '');
                        setBioEditing(true);
                      }}
                    >
                      <Pencil size={13} /> Edit
                    </button>
                  )}
                </div>
                {bioEditing ? (
                  <div className="profile-bio-editor">
                    <textarea
                      className="input profile-bio-input"
                      value={bioDraft}
                      maxLength={190}
                      rows={3}
                      placeholder="How you want to be introduced here"
                      onChange={(event) => setBioDraft(event.target.value)}
                    />
                    <div className="profile-bio-actions">
                      <span className="muted">{bioDraft.length}/190</span>
                      <EmoteInsertButton
                        title="Emoji"
                        onInsert={(snippet) => setBioDraft((value) => (value + snippet).slice(0, 190))}
                      />
                      <button
                        type="button"
                        className="btn ghost small"
                        onClick={() => setBioEditing(false)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="btn primary small"
                        disabled={bioBusy}
                        onClick={saveServerBio}
                      >
                        {bioBusy ? <Loader2 size={14} className="spin" /> : 'Save'}
                      </button>
                    </div>
                  </div>
                ) : profile.serverBio ? (
                  <div className="profile-bio">
                    <Markdown text={profile.serverBio} meUsername={me?.username} emotes={emotes} />
                  </div>
                ) : (
                  <p className="profile-bio muted">
                    No bio for this server yet. Add one to introduce yourself here only.
                  </p>
                )}
              </section>
            )}

            {user.socialLinks?.length > 0 && (
              <section className="profile-panel">
                <div className="profile-panel-head">
                  <h3>Links</h3>
                  <span className="profile-panel-count">{user.socialLinks.length}</span>
                </div>
                <div className="profile-link-list">
                  {user.socialLinks.map((link) => (
                    <a
                      key={link.url}
                      className="profile-link"
                      href={link.url}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      <Link2 size={14} />
                      <span>{link.label || LINK_LABELS[link.platform] || link.platform}</span>
                    </a>
                  ))}
                </div>
              </section>
            )}

            {user.games?.length > 0 && (
              <section className="profile-panel">
                <div className="profile-panel-head">
                  <h3>Games</h3>
                  <span className="profile-panel-count">{user.games.length}</span>
                </div>
                <div className="profile-game-list">
                  {user.games.map((game) => (
                    <div className="profile-game" key={game.name}>
                      <Gamepad2 size={15} />
                      <span className="profile-game-name">{game.name}</span>
                      {game.platform && <span className="profile-game-platform">{game.platform}</span>}
                      {game.hours > 0 && <span className="profile-game-hours">{game.hours}h</span>}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {profile.stats && (
              <section className="profile-panel">
                <div className="profile-panel-head">
                  <h3>Activity</h3>
                </div>
                <div className="profile-stat-grid">
                  <div className="profile-stat">
                    <MessageSquare size={15} />
                    <strong>{profile.stats.messages.toLocaleString()}</strong>
                    <span>messages</span>
                  </div>
                  <div className="profile-stat">
                    <Clock size={15} />
                    <strong>{formatHours(profile.stats.voiceSeconds)}</strong>
                    <span>in voice</span>
                  </div>
                  <div className="profile-stat">
                    <Server size={15} />
                    <strong>{profile.stats.servers.toLocaleString()}</strong>
                    <span>servers</span>
                  </div>
                </div>
              </section>
            )}

            <section className="profile-panel">
              <div className="profile-panel-head">
                <h3>Badges</h3>
                <span className="profile-panel-count">{profile.badges.length}</span>
              </div>
              {profile.badges.length > 0 ? (
                <div className="profile-badge-grid">
                  {profile.badges.map((badge) => (
                    <BadgeTile key={badge.key} badge={badge} />
                  ))}
                </div>
              ) : (
                <p className="profile-empty">No badges yet.</p>
              )}
            </section>

            <section className="profile-panel">
              <div className="profile-panel-head">
                <h3>Mutual servers</h3>
                <span className="profile-panel-count">{profile.mutualServers.length}</span>
              </div>
              {profile.mutualServers.length > 0 ? (
                <div className="profile-server-grid">
                  {profile.mutualServers.map((server) => (
                    <div className="profile-server" key={server.id}>
                      <ServerIcon server={server} className="profile-server-icon" />
                      <span className="profile-server-name">{server.name}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="profile-empty">No shared servers yet.</p>
              )}
            </section>
              </>
            )}

            {!isSelf && (
              <section className="profile-panel">
                <div className="profile-panel-head">
                  <h3>Your note</h3>
                  <span className="profile-panel-count">private</span>
                </div>
                <textarea
                  className="profile-note-input"
                  value={noteDraft}
                  onChange={(event) => {
                    setNoteDraft(event.target.value);
                    setNoteNotice('');
                  }}
                  rows={3}
                  maxLength={500}
                  placeholder="Only you can see this. Reminders, context, why you know them."
                  aria-label="Private note"
                />
                <div className="profile-note-actions">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={saveNote}
                    disabled={noteBusy || noteDraft === note}
                  >
                    {noteBusy ? <Loader2 size={14} className="spin" /> : 'Save note'}
                  </button>
                  {noteNotice && <span className="profile-note-notice">{noteNotice}</span>}
                </div>
              </section>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
