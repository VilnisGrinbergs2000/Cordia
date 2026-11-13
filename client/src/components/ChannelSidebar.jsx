import { Fragment, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive,
  AtSign,
  BellOff,
  Bookmark,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  FileText,
  GripVertical,
  Hash,
  Image,
  Inbox,
  Lightbulb,
  ListChecks,
  MessagesSquare,
  MicOff,
  MonitorUp,
  Plus,
  Radio,
  Settings,
  Trash2,
  UserPlus,
  UserRound,
  Users,
  Volume2,
  X
} from 'lucide-react';
import Avatar from './Avatar';
import UserPanel from './UserPanel';
import { hasServerPermission } from '../permissions';

function UserPanelSlot(props) {
  return <UserPanel {...props} />;
}

export default function ChannelSidebar({
  mode,
  user,
  presence,
  server,
  dms,
  unread,
  mentionUnread = {},
  mentionTotal = 0,
  awayTotal = 0,
  mutedScopes = {},
  activeChannelId,
  activeDmId,
  voiceChannelId,
  voiceOccupancy = {},
  onSelectChannel,
  onCreateChannel,
  onInvite,
  onOpenEvents,
  onOpenIconSuggestions,
  onOpenServerSettings,
  onDeleteChannel,
  onReorderChannels,
  onReorderCategories,
  onSelectDm,
  onCloseDm,
  onHome,
  onOpenMentions,
  onOpenSaved,
  onOpenAway,
  onOpenProfile,
  onOpenSettings,
  onPresenceChange,
  onStatusTextChange,
  onLogout
}) {
  const [dmMenu, setDmMenu] = useState(null);
  const visibleDms = useMemo(() => dms.filter((dm) => !dm.closed), [dms]);
  const canManageChannels = useMemo(
    () => hasServerPermission(server, user, 'manageChannels'),
    [server, user]
  );
  const canViewServerSettings = useMemo(
    () => hasServerPermission(server, user, 'viewServerSettings'),
    [server, user]
  );
  const [collapsedCategories, setCollapsedCategories] = useState({});
  const [threadsCollapsed, setThreadsCollapsed] = useState(false);
  const [dragState, setDragState] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const categories = server?.categories || [];
  const channels = server?.channels || [];
  const uncategorizedChannels = channels.filter((channel) => !channel.categoryId);
  // Forum posts live inside the forum view, so the sidebar only lists threads
  // that hang off a text channel.
  const sidebarThreads = (server?.threads || []).filter((thread) => thread.parentType !== 'forum');
  // Archived threads stay reachable, just quiet - auto-archiving should never
  // look like a conversation vanished.
  const activeThreads = sidebarThreads.filter((thread) => !thread.archived);
  const archivedThreads = sidebarThreads.filter((thread) => thread.archived);

  useEffect(() => {
    setDragState(null);
    setDropTarget(null);
  }, [server?.id]);

  function finishDrag() {
    setDragState(null);
    setDropTarget(null);
  }

  function startChannelDrag(event, channel) {
    if (!canManageChannels || event.target.closest?.('.channel-action')) {
      event.preventDefault();
      return;
    }
    setDragState({ kind: 'channel', id: channel.id });
    setDropTarget(null);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', `channel:${channel.id}`);
  }

  function startCategoryDrag(event, category) {
    if (!canManageChannels || event.target.closest?.('.channel-add')) {
      event.preventDefault();
      return;
    }
    setDragState({ kind: 'category', id: category.id });
    setDropTarget(null);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', `category:${category.id}`);
  }

  function channelDragOver(event, channel) {
    if (dragState?.kind !== 'channel') return;
    if (dragState.id === channel.id) {
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    setDropTarget({
      kind: 'channel',
      id: channel.id,
      after: event.clientY > rect.top + rect.height / 2
    });
  }

  function channelDrop(event, channel) {
    if (dragState?.kind !== 'channel') return;
    event.preventDefault();
    event.stopPropagation();
    if (dragState.id === channel.id) {
      finishDrag();
      return;
    }
    const after =
      dropTarget?.kind === 'channel' && dropTarget.id === channel.id ? dropTarget.after : false;
    moveChannel(dragState.id, channel.id, after, channel.categoryId ?? null);
    finishDrag();
  }

  function categoryDragOver(event, category) {
    if (dragState?.kind !== 'channel') return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget({ kind: 'category', id: category.id });
  }

  function categoryDrop(event, category) {
    if (dragState?.kind !== 'channel') return;
    event.preventDefault();
    event.stopPropagation();
    moveChannel(dragState.id, null, false, category.id);
    finishDrag();
  }

  function categoryHeaderDragOver(event, category) {
    if (dragState?.kind !== 'category' || dragState.id === category.id) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    setDropTarget({
      kind: 'category-order',
      id: category.id,
      after: event.clientY > rect.top + rect.height / 2
    });
  }

  function categoryHeaderDrop(event, category) {
    if (dragState?.kind !== 'category' || dragState.id === category.id) return;
    event.preventDefault();
    event.stopPropagation();
    const after =
      dropTarget?.kind === 'category-order' && dropTarget.id === category.id
        ? dropTarget.after
        : false;
    moveCategory(dragState.id, category.id, after);
    finishDrag();
  }

  function uncategorizedDragOver(event) {
    if (dragState?.kind !== 'channel') return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget({ kind: 'uncategorized' });
  }

  function uncategorizedDrop(event) {
    if (dragState?.kind !== 'channel') return;
    event.preventDefault();
    event.stopPropagation();
    moveChannel(dragState.id, null, false, null);
    finishDrag();
  }

  function moveChannel(channelId, targetId, after, categoryId) {
    const next = [...channels];
    const from = next.findIndex((channel) => channel.id === channelId);
    if (from < 0) return;
    const [moved] = next.splice(from, 1);
    const nextCategoryId = categoryId ?? null;
    const movedChannel = { ...moved, categoryId: nextCategoryId };
    let index = -1;
    if (targetId != null) {
      index = next.findIndex((channel) => channel.id === targetId);
      if (index < 0) return;
      if (after) index += 1;
    } else {
      let lastInCategory = -1;
      next.forEach((channel, channelIndex) => {
        if ((channel.categoryId ?? null) === nextCategoryId) lastInCategory = channelIndex;
      });
      index = lastInCategory >= 0 ? lastInCategory + 1 : next.length;
    }
    next.splice(index, 0, movedChannel);
    onReorderChannels?.(next.map((channel, position) => ({ ...channel, position })));
  }

  function moveCategory(categoryId, targetId, after) {
    const ids = categories.map((category) => category.id);
    const from = ids.indexOf(categoryId);
    if (from < 0 || categoryId === targetId) return;
    const [moved] = ids.splice(from, 1);
    const targetIndex = ids.indexOf(targetId);
    if (targetIndex < 0) return;
    ids.splice(after ? targetIndex + 1 : targetIndex, 0, moved);
    onReorderCategories?.(ids);
  }

  function renderChannel(channel) {
    const key = `ch:${channel.id}`;
    const unreadCount = unread[key] || 0;
    const mentionCount = mentionUnread[key] || 0;
    const muted = !!mutedScopes[key];
    const occupants = voiceOccupancy[channel.id] || [];
    const voiceLike = channel.type === 'voice' || channel.type === 'stage';
    const dragging = dragState?.kind === 'channel' && dragState.id === channel.id;
    const channelTarget = dropTarget?.kind === 'channel' && dropTarget.id === channel.id;
    return (
      <Fragment key={channel.id}>
        <div
          className={`channel-row ${activeChannelId === channel.id ? 'active' : ''} ${
            dragging ? 'is-dragging' : ''
          } ${channelTarget ? (dropTarget.after ? 'drag-over-after' : 'drag-over-before') : ''}`}
          draggable={canManageChannels}
          data-channel-id={channel.id}
          title={canManageChannels ? 'Drag to reorder channel' : undefined}
          onDragStart={(event) => startChannelDrag(event, channel)}
          onDragEnd={finishDrag}
          onDragOver={(event) => channelDragOver(event, channel)}
          onDrop={(event) => channelDrop(event, channel)}
        >
          <button className="channel-main" onClick={() => onSelectChannel(channel)}>
            {channel.type === 'voice' ? (
              <Volume2 size={17} />
            ) : channel.type === 'stage' ? (
              <Radio size={17} />
            ) : channel.type === 'forum' ? (
              <MessagesSquare size={17} />
            ) : channel.type === 'docs' ? (
              <FileText size={17} />
            ) : channel.type === 'list' ? (
              <ListChecks size={17} />
            ) : channel.type === 'media' ? (
              <Image size={17} />
            ) : channel.type === 'calendar' ? (
              <CalendarDays size={17} />
            ) : (
              <Hash size={17} />
            )}
            <span>{channel.name}</span>
            {muted && <BellOff size={12} className="channel-muted" />}
            {voiceLike && voiceChannelId === channel.id && (
              <span className="voice-live">LIVE</span>
            )}
            {!voiceLike &&
              (mentionCount > 0 ? (
                <span className="channel-mention">
                  {mentionCount > 99 ? '99+' : mentionCount}
                </span>
              ) : (
                !muted &&
                unreadCount > 0 && (
                  <span className="channel-unread">
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )
              ))}
          </button>
          {canManageChannels && (
            <button
              className="channel-action"
              onClick={() => onDeleteChannel(channel)}
              title="Delete channel"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
        {voiceLike && occupants.length > 0 && (
          <div className="voice-channel-people">
            {occupants.map((person) => (
              <button
                className="voice-channel-person"
                key={person.socketId || person.id}
                onClick={() => onOpenProfile(person.id)}
                title={person.displayName}
              >
                <Avatar user={person} size={21} />
                <span className="voice-channel-person-name">{person.displayName}</span>
                {person.sharing && <MonitorUp size={12} className="voice-channel-share" />}
                {person.muted && <MicOff size={12} className="voice-channel-mute" />}
              </button>
            ))}
          </div>
        )}
      </Fragment>
    );
  }

  useEffect(() => {
    if (!dmMenu) return undefined;
    function closeMenu() {
      setDmMenu(null);
    }
    function onPointerDown(event) {
      if (!event.target.closest?.('.dm-context-menu')) closeMenu();
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') closeMenu();
    }
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', closeMenu);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
    };
  }, [dmMenu]);

  return (
    <aside className="sidebar">
      {mode === 'server' && server ? (
        <>
          <div className="sidebar-header server-header">
            {canViewServerSettings ? (
              <button className="server-title" onClick={onOpenServerSettings}>
                <span>{server.name}</span>
                <ChevronDown size={16} />
              </button>
            ) : (
              <div className="server-title server-title-static">
                <span>{server.name}</span>
              </div>
            )}
            <div className="sidebar-header-actions">
              <button
                className="icon-btn mention-inbox-button"
                onClick={onOpenAway}
                title="Catch up"
              >
                <Inbox size={17} />
                {awayTotal > 0 && (
                  <span className="sidebar-mention-count">{awayTotal > 9 ? '9+' : awayTotal}</span>
                )}
              </button>
              <button
                className="icon-btn mention-inbox-button"
                onClick={onOpenMentions}
                title="Mentions"
              >
                <AtSign size={17} />
                {mentionTotal > 0 && (
                  <span className="sidebar-mention-count">{mentionTotal > 9 ? '9+' : mentionTotal}</span>
                )}
              </button>
              <button className="icon-btn" onClick={onInvite} title="Invite people">
                <UserPlus size={17} />
              </button>
              <button className="icon-btn" onClick={onOpenSaved} title="Bookmarks">
                <Bookmark size={17} />
              </button>
              <button className="icon-btn" onClick={onOpenIconSuggestions} title="Icon ideas">
                <Lightbulb size={17} />
              </button>
              {canManageChannels && (
                <button
                  className="icon-btn"
                  onClick={() => onCreateChannel()}
                  title="Create channel or category"
                >
                  <Plus size={18} />
                </button>
              )}
              {canViewServerSettings && (
                <button className="icon-btn" onClick={onOpenServerSettings} title="Server settings">
                  <Settings size={16} />
                </button>
              )}
              <button
                className="icon-btn mobile-user-settings"
                onClick={onOpenSettings}
                title="Profile settings"
              >
                <UserRound size={17} />
              </button>
            </div>
          </div>

          <div className="channel-scroll">
            <div className="channel-section channel-section--events">
              <div className="channel-row channel-row--top">
                <button className="channel-main" onClick={onOpenEvents}>
                  <CalendarDays size={17} />
                  <span>Upcoming events</span>
                </button>
              </div>
            </div>

            {dragState?.kind === 'channel' && (
              <div
                className={`channel-uncategorized-drop ${
                  dropTarget?.kind === 'uncategorized' ? 'drag-over' : ''
                }`}
                onDragOver={uncategorizedDragOver}
                onDrop={uncategorizedDrop}
              >
                Drop here for no category
              </div>
            )}

            {uncategorizedChannels.length > 0 && (
              <div
                className={`channel-section channel-section--uncategorized ${
                  dropTarget?.kind === 'uncategorized' ? 'drag-target' : ''
                }`}
                onDragOver={uncategorizedDragOver}
                onDrop={uncategorizedDrop}
              >
                {uncategorizedChannels.map(renderChannel)}
              </div>
            )}

            {categories.map((category) => {
              const categoryChannels = channels.filter(
                (channel) => channel.categoryId === category.id
              );
              const collapsed = !!collapsedCategories[category.id];
              const categoryTarget =
                dropTarget?.kind === 'category' && dropTarget.id === category.id;
              const categoryOrderTarget =
                dropTarget?.kind === 'category-order' && dropTarget.id === category.id;
              return (
                <div
                  className={`channel-section channel-section--category ${
                    categoryTarget ? 'drag-target' : ''
                  }`}
                  key={category.id}
                  data-category-id={category.id}
                  onDragOver={(event) => categoryDragOver(event, category)}
                  onDrop={(event) => categoryDrop(event, category)}
                >
                  <div
                    className={`channel-section-label channel-category-label ${
                      categoryOrderTarget
                        ? dropTarget.after
                          ? 'drag-over-after'
                          : 'drag-over-before'
                        : ''
                    }`}
                    draggable={canManageChannels}
                    onDragStart={(event) => startCategoryDrag(event, category)}
                    onDragEnd={finishDrag}
                    onDragOver={(event) => categoryHeaderDragOver(event, category)}
                    onDrop={(event) => categoryHeaderDrop(event, category)}
                    title={canManageChannels ? 'Drag to reorder category' : undefined}
                  >
                    <div className="channel-category-title">
                      {canManageChannels && (
                        <GripVertical
                          size={12}
                          className="channel-category-grip"
                          aria-hidden="true"
                        />
                      )}
                      <button
                        type="button"
                        className="channel-category-toggle"
                        onClick={() =>
                          setCollapsedCategories((prev) => ({
                            ...prev,
                            [category.id]: !prev[category.id]
                          }))
                        }
                        aria-expanded={!collapsed}
                      >
                        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                        <span>{category.name}</span>
                      </button>
                    </div>
                    {canManageChannels && (
                      <button
                        type="button"
                        className="channel-add"
                        onClick={() => onCreateChannel(category.id)}
                        title={`Create a channel in ${category.name}`}
                      >
                        <Plus size={13} />
                      </button>
                    )}
                  </div>
                  {!collapsed && categoryChannels.map(renderChannel)}
                </div>
              );
            })}

            {categories.length === 0 && uncategorizedChannels.length === 0 && (
              <p className="channel-empty">No channels yet.</p>
            )}

            {sidebarThreads.length > 0 && (
              <div className="channel-section channel-section--threads">
                <div className="channel-section-label">
                  <div className="channel-category-title">
                    <button
                      type="button"
                      className="channel-category-toggle"
                      onClick={() => setThreadsCollapsed((value) => !value)}
                      aria-expanded={!threadsCollapsed}
                    >
                      {threadsCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                      <span>Threads</span>
                    </button>
                  </div>
                </div>
                {!threadsCollapsed && (
                  <>
                    {activeThreads.map((thread) => (
                      <div
                        className={`channel-row ${activeChannelId === thread.id ? 'active' : ''}`}
                        key={`thread:${thread.id}`}
                        data-channel-id={thread.id}
                      >
                        <button className="channel-main" onClick={() => onSelectChannel(thread)}>
                          <MessagesSquare size={16} />
                          <span>{thread.name}</span>
                          {thread.messageCount > 0 && (
                            <span className="channel-count">{thread.messageCount}</span>
                          )}
                        </button>
                      </div>
                    ))}
                    {archivedThreads.length > 0 && (
                      <>
                        <div className="channel-sublabel">Archived</div>
                        {archivedThreads.map((thread) => (
                          <div
                            className={`channel-row archived ${
                              activeChannelId === thread.id ? 'active' : ''
                            }`}
                            key={`thread:${thread.id}`}
                            data-channel-id={thread.id}
                          >
                            <button
                              className="channel-main"
                              onClick={() => onSelectChannel(thread)}
                              title={`Archived thread in #${thread.parentName || 'channel'}`}
                            >
                              <Archive size={15} />
                              <span>{thread.name}</span>
                            </button>
                          </div>
                        ))}
                      </>
                    )}
                  </>
                )}
              </div>
            )}

            {canViewServerSettings && (
              <button className="sidebar-server-settings" onClick={onOpenServerSettings}>
                <Settings size={15} />
                Server settings
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="sidebar-header home-header">
            <div>
              <span className="eyebrow-mini">Messages</span>
              <h2>Direct messages</h2>
            </div>
            <div className="sidebar-header-actions">
              <button
                className="icon-btn mention-inbox-button"
                onClick={onOpenAway}
                title="Catch up"
              >
                <Inbox size={17} />
                {awayTotal > 0 && (
                  <span className="sidebar-mention-count">{awayTotal > 9 ? '9+' : awayTotal}</span>
                )}
              </button>
              <button
                className="icon-btn mention-inbox-button"
                onClick={onOpenMentions}
                title="Mentions"
              >
                <AtSign size={17} />
                {mentionTotal > 0 && (
                  <span className="sidebar-mention-count">{mentionTotal > 9 ? '9+' : mentionTotal}</span>
                )}
              </button>
              <button className="icon-btn" onClick={onHome} title="Open friends">
                <Users size={18} />
              </button>
              <button className="icon-btn" onClick={onOpenSaved} title="Bookmarks">
                <Bookmark size={17} />
              </button>
              <button
                className="icon-btn mobile-user-settings"
                onClick={onOpenSettings}
                title="Profile settings"
              >
                <UserRound size={17} />
              </button>
            </div>
          </div>

          <div className="channel-scroll">
            <div className="channel-section">
              <div className="channel-section-label">
                <span>Conversations</span>
                <button className="channel-add" onClick={onHome} title="Open friends">
                  <Plus size={13} />
                </button>
              </div>
              {visibleDms.map((dm) => {
                const key = `dm:${dm.id}`;
                const unreadCount = unread[key] || 0;
                const mentionCount = mentionUnread[key] || 0;
                const muted = !!mutedScopes[key];
                return (
                  <button
                    key={dm.id}
                    className={`dm-row ${activeDmId === dm.id ? 'active' : ''}`}
                    onClick={() => onSelectDm(dm)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setDmMenu({
                        dm,
                        x: Math.min(event.clientX, window.innerWidth - 198),
                        y: Math.min(event.clientY, window.innerHeight - 56)
                      });
                    }}
                  >
                    <Avatar user={dm.user} size={32} presence={presence} showPresence />
                    <span className="dm-meta">
                      <span className="dm-name">
                        {dm.user.displayName}
                        {muted && <BellOff size={11} className="dm-muted" />}
                      </span>
                      <span className="dm-preview">
                        {dm.lastMessage
                          ? `${
                              dm.lastMessage.authorId === user.id ? 'You: ' : ''
                            }${
                              dm.lastMessage.encrypted
                                ? 'Encrypted message'
                                : dm.lastMessage.content || 'Sent an attachment'
                            }`
                          : 'Say hello'}
                      </span>
                    </span>
                    {mentionCount > 0 ? (
                      <span className="dm-mention">{mentionCount > 9 ? '9+' : mentionCount}</span>
                    ) : (
                      !muted &&
                      unreadCount > 0 && (
                        <span className="dm-unread">{unreadCount > 9 ? '9+' : unreadCount}</span>
                      )
                    )}
                  </button>
                );
              })}
              {visibleDms.length === 0 && (
                <p className="channel-empty">No conversations yet. Open friends to start one.</p>
              )}
            </div>

          </div>
        </>
      )}

      <UserPanelSlot
        user={user}
        presence={presence}
        onPresenceChange={onPresenceChange}
        onStatusTextChange={onStatusTextChange}
        onOpenProfile={onOpenProfile}
        onOpenSettings={onOpenSettings}
        onLogout={onLogout}
      />

      {dmMenu &&
        createPortal(
          <div
            className="dm-context-menu"
            role="menu"
            style={{ left: dmMenu.x, top: dmMenu.y }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <button
              type="button"
              className="dm-context-item"
              role="menuitem"
              onClick={() => {
                onCloseDm(dmMenu.dm);
                setDmMenu(null);
              }}
            >
              <X size={14} />
              Close DM
            </button>
          </div>,
          document.body
        )}
    </aside>
  );
}
