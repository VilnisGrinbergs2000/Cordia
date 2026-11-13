import { useMemo, useState } from 'react';
import {
  ArrowLeft,
  Ban,
  Check,
  Clock,
  Inbox,
  MessageSquare,
  Search,
  Send,
  ShieldOff,
  UserMinus,
  UserPlus,
  Users,
  X
} from 'lucide-react';
import Avatar from './Avatar';
import { formatTime, onlineOf, presenceLabel } from '../utils';

const TABS = [
  { key: 'all', label: 'All', icon: Users },
  { key: 'online', label: 'Online', icon: Check },
  { key: 'pending', label: 'Pending', icon: Clock },
  { key: 'blocked', label: 'Blocked', icon: Ban },
  { key: 'add', label: 'Add friend', icon: UserPlus }
];

function recentStamp(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (date.toDateString() === new Date().toDateString()) return formatTime(timestamp);
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function dmPreview(dm, userId) {
  if (!dm.lastMessage) return 'Say hello';
  return `${dm.lastMessage.authorId === userId ? 'You: ' : ''}${
    dm.lastMessage.encrypted
      ? 'Encrypted message'
      : dm.lastMessage.content || 'Sent an attachment'
  }`;
}

function FriendRow({ friend, presence, onMessage, onProfile, canMessage = true, children }) {
  return (
    <div className="friend-row">
      <button className="friend-main" onClick={() => onProfile(friend.user.id)}>
        <Avatar user={friend.user} size={40} presence={presence} showPresence />
        <span className="friend-meta">
          <strong>{friend.user.displayName}</strong>
          <span>
            {friend.user.statusText || presenceLabel(friend.user, presence)}
            {friend.user.username ? ` · @${friend.user.username}` : ''}
          </span>
        </span>
      </button>
      <div className="friend-actions">
        {canMessage && (
          <button className="btn btn-ghost btn-sm" onClick={() => onMessage(friend.user.id)}>
            <MessageSquare size={15} /> Message
          </button>
        )}
        {children}
      </div>
    </div>
  );
}

function FriendEmptyCard({ icon: Icon, title, description }) {
  return (
    <div className="friends-empty-card">
      <span className="friends-empty-icon">
        <Icon size={17} />
      </span>
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
    </div>
  );
}

export default function HomeView({
  user,
  friends,
  presence,
  dms = [],
  unread = {},
  onSelectDm,
  onMessageUser,
  onOpenProfile,
  onAddFriend,
  onAcceptFriend,
  onDeclineFriend,
  onCancelRequest,
  onRemoveFriend,
  onBlockUser,
  onUnblockUser,
  onBackToList
}) {
  const [tab, setTab] = useState('all');
  const [addName, setAddName] = useState('');
  const [addState, setAddState] = useState({ loading: false, message: '', error: '' });
  const [busy, setBusy] = useState('');
  const [search, setSearch] = useState('');

  const visibleFriends = useMemo(() => {
    const list =
      tab === 'online'
        ? friends.friends.filter((friend) => onlineOf(friend.user, presence))
        : friends.friends;
    const needle = search.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(
      (friend) =>
        friend.user.displayName.toLowerCase().includes(needle) ||
        friend.user.username.toLowerCase().includes(needle)
    );
  }, [friends.friends, tab, presence, search]);

  const onlineFriends = useMemo(
    () => friends.friends.filter((friend) => onlineOf(friend.user, presence)),
    [friends.friends, presence]
  );
  const recentDms = useMemo(() => dms.filter((dm) => !dm.closed).slice(0, 4), [dms]);
  const friendCount = friends.friends.length;
  const pendingCount = friends.incoming.length;
  const summary = [
    `${friendCount} ${friendCount === 1 ? 'friend' : 'friends'}`,
    `${onlineFriends.length} online`,
    pendingCount > 0 ? `${pendingCount} pending` : null
  ]
    .filter(Boolean)
    .join(' · ');

  async function run(key, action) {
    setBusy(key);
    try {
      await action();
    } finally {
      setBusy('');
    }
  }

  async function submitAdd(event) {
    event.preventDefault();
    if (!addName.trim()) return;
    setAddState({ loading: true, message: '', error: '' });
    try {
      await onAddFriend(addName.trim());
      setAddState({ loading: false, message: `Request sent to ${addName.trim()}.`, error: '' });
      setAddName('');
    } catch (error) {
      setAddState({ loading: false, message: '', error: error.message });
    }
  }

  return (
    <section className="home-view">
      <header className="friends-header">
        <button className="icon-btn chat-back" onClick={onBackToList} title="Back to conversations" aria-label="Back to conversations">
          <ArrowLeft size={18} />
        </button>
        <div className="friends-header-copy">
          <span className="eyebrow-mini">Home</span>
          <h1>Friends</h1>
          <p>{summary}</p>
        </div>
        <button className="btn btn-primary" onClick={() => setTab('add')}>
          <UserPlus size={16} /> Add friend
        </button>
      </header>

      <div className="home-grid">
        <div className="friends-panel">
        <div className="friends-tabs">
          {TABS.map((item) => {
            const Icon = item.icon;
            const count =
              item.key === 'pending'
                ? friends.incoming.length
                : item.key === 'blocked'
                  ? friends.blocked.length
                  : null;
            return (
              <button
                key={item.key}
                className={`friends-tab ${tab === item.key ? 'active' : ''}`}
                onClick={() => setTab(item.key)}
              >
                <Icon size={15} />
                {item.label}
                {count > 0 && <span className="friends-tab-count">{count}</span>}
              </button>
            );
          })}
        </div>

        {(tab === 'all' || tab === 'online') && (
          <>
            <div className="friends-toolbar">
              <label className="search-box">
                <Search size={15} />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={tab === 'online' ? 'Search online friends' : 'Search friends'}
                />
              </label>
            </div>
            <div className="friends-list">
              <div className="friends-list-label">
                {tab === 'online' ? 'Online' : 'All friends'} · {visibleFriends.length}
              </div>
              {visibleFriends.map((friend) => (
                <FriendRow
                  key={friend.user.id}
                  friend={friend}
                  presence={presence}
                  onMessage={onMessageUser}
                  onProfile={onOpenProfile}
                >
                  <button
                    className="icon-btn"
                    title="Remove friend"
                    disabled={busy === `remove-${friend.user.id}`}
                    onClick={() =>
                      run(`remove-${friend.user.id}`, () => onRemoveFriend(friend.user.id))
                    }
                  >
                    <UserMinus size={16} />
                  </button>
                  <button
                    className="icon-btn danger-hover"
                    title="Block"
                    disabled={busy === `block-${friend.user.id}`}
                    onClick={() => run(`block-${friend.user.id}`, () => onBlockUser(friend.user.id))}
                  >
                    <Ban size={16} />
                  </button>
                </FriendRow>
              ))}
              {visibleFriends.length === 0 && (
                <div className="friends-empty">
                  <Users size={26} />
                  <h3>{tab === 'online' ? 'No friends online' : 'No friends yet'}</h3>
                  <p>
                    {tab === 'online'
                      ? 'Try the All tab or check back later.'
                      : 'Add someone you know by their exact username.'}
                  </p>
                  <button className="btn btn-primary btn-sm" onClick={() => setTab('add')}>
                    <UserPlus size={15} /> Add a friend
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        {tab === 'pending' && (
          <div className="friends-list">
            <div className="friends-list-label">Incoming · {friends.incoming.length}</div>
            {friends.incoming.map((request) => (
              <FriendRow
                key={`in-${request.requestId}`}
                friend={request}
                presence={presence}
                onMessage={onMessageUser}
                onProfile={onOpenProfile}
                canMessage={false}
              >
                <button
                  className="btn btn-primary btn-xs"
                  disabled={busy === `accept-${request.requestId}`}
                  onClick={() => run(`accept-${request.requestId}`, () => onAcceptFriend(request))}
                >
                  <Check size={14} /> Accept
                </button>
                <button
                  className="btn btn-ghost btn-xs"
                  disabled={busy === `decline-${request.requestId}`}
                  onClick={() => run(`decline-${request.requestId}`, () => onDeclineFriend(request))}
                >
                  <X size={14} /> Decline
                </button>
              </FriendRow>
            ))}
            {friends.incoming.length === 0 && (
              <FriendEmptyCard
                icon={Inbox}
                title="No incoming requests"
                description="When someone sends you a friend request, it will show up here."
              />
            )}

            <div className="friends-list-label">Sent · {friends.outgoing.length}</div>
            {friends.outgoing.map((request) => (
              <FriendRow
                key={`out-${request.requestId}`}
                friend={request}
                presence={presence}
                onMessage={onMessageUser}
                onProfile={onOpenProfile}
                canMessage={false}
              >
                <button
                  className="btn btn-ghost btn-xs"
                  disabled={busy === `cancel-${request.requestId}`}
                  onClick={() => run(`cancel-${request.requestId}`, () => onCancelRequest(request))}
                >
                  Cancel
                </button>
              </FriendRow>
            ))}
            {friends.outgoing.length === 0 && (
              <FriendEmptyCard
                icon={Send}
                title="No sent requests"
                description="Requests you send will appear here until they are answered."
              />
            )}
          </div>
        )}

        {tab === 'blocked' && (
          <div className="friends-list">
            <div className="friends-list-label">Blocked · {friends.blocked.length}</div>
            {friends.blocked.map((entry) => (
              <FriendRow
                key={`blocked-${entry.user.id}`}
                friend={entry}
                presence={presence}
                onMessage={onMessageUser}
                onProfile={onOpenProfile}
                canMessage={false}
              >
                <button
                  className="btn btn-ghost btn-xs"
                  disabled={busy === `unblock-${entry.user.id}`}
                  onClick={() => run(`unblock-${entry.user.id}`, () => onUnblockUser(entry.user.id))}
                >
                  Unblock
                </button>
              </FriendRow>
            ))}
            {friends.blocked.length === 0 && (
              <FriendEmptyCard
                icon={ShieldOff}
                title="No blocked users"
                description="People you block will appear here. You can unblock them anytime."
              />
            )}
          </div>
        )}

        {tab === 'add' && (
          <div className="add-friend-panel">
            <div className="add-friend-card">
              <h3>Add a friend</h3>
              <p>Enter their exact Cordia username. They will receive a request you can cancel.</p>
              <form className="add-friend-form" onSubmit={submitAdd}>
                <input
                  value={addName}
                  onChange={(event) => setAddName(event.target.value)}
                  placeholder="Username"
                  maxLength={24}
                />
                <button className="btn btn-primary" disabled={addState.loading || !addName.trim()}>
                  <UserPlus size={16} /> Send request
                </button>
              </form>
              {addState.error && <div className="form-error">{addState.error}</div>}
              {addState.message && <div className="form-success">{addState.message}</div>}
            </div>
          </div>
        )}
        </div>

        <aside className="home-side">
          <section className="home-side-card">
            <div className="home-side-head">
              <h2>Online now</h2>
              <span className="home-side-count">{onlineFriends.length}</span>
            </div>
            {onlineFriends.length > 0 ? (
              <div className="home-online-list">
                {onlineFriends.slice(0, 5).map((friend) => (
                  <div className="home-online-row" key={friend.user.id}>
                    <button
                      className="home-online-person"
                      onClick={() => onOpenProfile(friend.user.id)}
                    >
                      <Avatar user={friend.user} size={34} presence={presence} showPresence />
                      <span className="home-online-meta">
                        <strong>{friend.user.displayName}</strong>
                        <span>{presenceLabel(friend.user, presence)}</span>
                      </span>
                    </button>
                    <button
                      className="icon-btn"
                      title={`Message ${friend.user.displayName}`}
                      onClick={() => onMessageUser(friend.user.id)}
                    >
                      <MessageSquare size={15} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="home-side-empty">
                <p>No one is online right now.</p>
                <button className="btn btn-ghost btn-sm" onClick={() => setTab('all')}>
                  <Users size={14} /> View all friends
                </button>
              </div>
            )}
          </section>

          <section className="home-side-card">
            <div className="home-side-head">
              <h2>Recent conversations</h2>
              {recentDms.length > 0 && (
                <span className="home-side-count">{recentDms.length}</span>
              )}
            </div>
            {recentDms.length > 0 ? (
              <div className="home-dm-list">
                {recentDms.map((dm) => {
                  const unreadCount = unread[`dm:${dm.id}`] || 0;
                  return (
                    <button className="home-dm-row" key={dm.id} onClick={() => onSelectDm(dm)}>
                      <Avatar user={dm.user} size={34} presence={presence} showPresence />
                      <span className="home-dm-meta">
                        <span className="home-dm-top">
                          <strong>{dm.user.displayName}</strong>
                          <time>{recentStamp(dm.lastMessage?.createdAt || dm.createdAt)}</time>
                        </span>
                        <span className="home-dm-preview">{dmPreview(dm, user.id)}</span>
                      </span>
                      {unreadCount > 0 && (
                        <span className="home-dm-unread">
                          {unreadCount > 9 ? '9+' : unreadCount}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="home-side-empty">
                <p>No conversations yet.</p>
                <button className="btn btn-ghost btn-sm" onClick={() => setTab('all')}>
                  <MessageSquare size={14} /> Find someone to message
                </button>
              </div>
            )}
          </section>
        </aside>
      </div>
    </section>
  );
}
