import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, LogOut, Settings, Shield, UserRound } from 'lucide-react';
import { Link } from 'react-router-dom';
import Avatar from './Avatar';
import ListeningTo, { ListeningLine } from './ListeningTo';
import { presenceLabel } from '../utils';

const STATUS_OPTIONS = [
  { value: 'online', label: 'Online', color: '#34d399' },
  { value: 'idle', label: 'Idle', color: '#fbbf24' },
  { value: 'dnd', label: 'Do not disturb', color: '#f87171' }
];

export default function UserPanel({
  user,
  presence,
  onPresenceChange,
  onStatusTextChange,
  onOpenProfile,
  onOpenSettings,
  onLogout
}) {
  const panelRef = useRef(null);
  const [menuPos, setMenuPos] = useState(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [statusDraft, setStatusDraft] = useState(user.statusText || '');
  const [savingStatus, setSavingStatus] = useState(false);

  useEffect(() => {
    if (statusOpen) setStatusDraft(user.statusText || '');
  }, [statusOpen, user.statusText]);

  // The status menu is portalled to the body because the sidebar owns a
  // stacking context below the voice dock: a menu living inside the sidebar
  // would paint underneath the dock and be unusable while in a call.
  useEffect(() => {
    if (!statusOpen) {
      setMenuPos(null);
      return;
    }
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenuPos({
      left: rect.left + 8,
      width: Math.max(190, rect.width - 16),
      bottom: window.innerHeight - rect.top + 7,
      // Never let the menu run off the top of the window; it scrolls instead.
      maxHeight: Math.max(180, rect.top - 14)
    });
  }, [statusOpen]);

  useEffect(() => {
    if (!statusOpen) return undefined;

    function onPointerDown(event) {
      if (
        !event.target.closest?.('.user-panel-status-menu') &&
        !event.target.closest?.('.user-panel-main')
      ) {
        setStatusOpen(false);
      }
    }

    function onKeyDown(event) {
      if (event.key === 'Escape') setStatusOpen(false);
    }

    function closeMenu() {
      setStatusOpen(false);
    }

    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', closeMenu);
      window.removeEventListener('resize', closeMenu);
    };
  }, [statusOpen]);

  function chooseStatus(value) {
    setStatusOpen(false);
    if (value !== user.presence) onPresenceChange?.(value);
  }

  async function saveCustomStatus(event) {
    event.preventDefault();
    if (savingStatus) return;
    const next = statusDraft.trim();
    if (next === (user.statusText || '')) return;
    setSavingStatus(true);
    try {
      const saved = await onStatusTextChange(next);
      if (saved !== false) setStatusOpen(false);
    } finally {
      setSavingStatus(false);
    }
  }

  function openProfile() {
    setStatusOpen(false);
    onOpenProfile(user.id);
  }

  return (
    <div className="user-panel" ref={panelRef}>
      {statusOpen &&
        menuPos &&
        createPortal(
        <div
          className="user-panel-status-menu"
          role="menu"
          aria-label="Set status"
          style={{
            left: menuPos.left,
            width: menuPos.width,
            bottom: menuPos.bottom,
            maxHeight: menuPos.maxHeight
          }}
        >
          <div className="user-panel-status-head">
            <span>Set status</span>
            <strong>{presenceLabel(user, presence)}</strong>
          </div>
          {STATUS_OPTIONS.map((option) => {
            const active = user.presence === option.value;
            return (
              <button
                key={option.value}
                className={`user-panel-status-option ${active ? 'active' : ''}`}
                onClick={() => chooseStatus(option.value)}
                role="menuitemradio"
                aria-checked={active}
              >
                <span
                  className="user-panel-status-dot"
                  style={{ background: option.color }}
                />
                <span>{option.label}</span>
                {active && <Check className="user-panel-status-check" size={15} />}
              </button>
            );
          })}
          {user.activity && (
            <div className="user-panel-listening">
              <ListeningTo activity={user.activity} compact />
            </div>
          )}
          <form className="user-panel-custom-status" onSubmit={saveCustomStatus}>
            <input
              value={statusDraft}
              onChange={(event) => setStatusDraft(event.target.value)}
              placeholder="Set a custom status"
              maxLength={80}
              aria-label="Custom status"
            />
            <button
              type="submit"
              title="Save custom status"
              disabled={
                savingStatus ||
                statusDraft.trim() === (user.statusText || '') ||
                statusDraft.length > 80
              }
            >
              <Check size={14} />
            </button>
          </form>
          <div className="user-panel-status-divider" />
          <button className="user-panel-status-link" onClick={openProfile}>
            <UserRound size={14} />
            <span>View profile</span>
          </button>
        </div>,
        document.body
      )}
      <button
        className="user-panel-main"
        onClick={() => setStatusOpen((open) => !open)}
        title="Set your status"
        aria-haspopup="menu"
        aria-expanded={statusOpen}
      >
        <Avatar user={user} size={34} presence={presence} showPresence />
        <span className="user-panel-meta">
          <strong>{user.displayName}</strong>
          {user.activity ? (
            <ListeningLine activity={user.activity} />
          ) : (
            <span>{user.statusText || presenceLabel(user, presence)}</span>
          )}
        </span>
      </button>
      <div className="user-panel-actions">
        {user.role === 'admin' && (
          <Link className="icon-btn" to="/admin" title="Admin console">
            <Shield size={16} />
          </Link>
        )}
        <button className="icon-btn" onClick={onOpenSettings} title="Profile settings">
          <Settings size={16} />
        </button>
        <button className="icon-btn" onClick={onLogout} title="Sign out">
          <LogOut size={16} />
        </button>
      </div>
    </div>
  );
}
