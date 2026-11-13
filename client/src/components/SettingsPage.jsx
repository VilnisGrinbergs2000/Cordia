import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Bell,
  BellRing,
  Bot,
  Camera,
  Check,
  Copy,
  Eye,
  EyeOff,
  Gamepad2,
  Globe,
  Headphones,
  Image as ImageIcon,
  KeyRound,
  Music2,
  Loader2,
  LockKeyhole,
  LogOut,
  MailCheck,
  MessageSquare,
  Monitor,
  Palette,
  Plus,
  RefreshCw,
  Rocket,
  Save,
  Shield,
  ShieldCheck,
  Smartphone,
  HardDrive,
  Heart,
  Trash2,
  User as UserIcon,
  Users,
  Volume2,
  X
} from 'lucide-react';
import AudioVideoSettings from './AudioVideoSettings';
import SupportSettings from './SupportSettings';
import NowPlayingSettings from './NowPlayingSettings';
import OverlaySettings from './OverlaySettings';
import StorageSettings from './StorageSettings';
import UpdatesPanel from './UpdatesPanel';
import EmoteInsertButton from './EmoteInsertButton';
import DevelopersPanel from './DevelopersPanel';
import Avatar from './Avatar';
import api from '../api';
import { assetUrl, isElectron, isNativeApp } from '../runtime';
import { AVATAR_COLORS, BANNER_COLORS, presenceLabel } from '../utils';

// Mirrors SOCIAL_PLATFORMS on the server. A platform the server does not know
// falls back to 'website', so this list is a convenience, not a constraint.
const SOCIAL_PLATFORMS = [
  { id: 'website', label: 'Website' },
  { id: 'x', label: 'X' },
  { id: 'github', label: 'GitHub' },
  { id: 'gitlab', label: 'GitLab' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'twitch', label: 'Twitch' },
  { id: 'bluesky', label: 'Bluesky' },
  { id: 'mastodon', label: 'Mastodon' },
  { id: 'steam', label: 'Steam' },
  { id: 'spotify', label: 'Spotify' },
  { id: 'itch', label: 'itch.io' },
  { id: 'linkedin', label: 'LinkedIn' }
];
import { applyPreferences, MODES, THEMES } from '../theme';
import {
  notificationPermissionAsync,
  playMessageSound,
  requestNotificationPermission,
  showDesktopNotification
} from '../notifications';
import {
  disableBackgroundPush,
  enableBackgroundPush,
  readBackgroundPushState
} from '../push';
import {
  createIdentity,
  createRecoveryBackup,
  forgetRememberedDevice,
  generateRecoveryCode,
  getE2eeSnapshot,
  hashRecoveryCode,
  activateIdentity,
  isE2eeUnlocked,
  isRememberDeviceAvailable,
  isRememberedDevice,
  lockE2ee,
  unlockIdentity,
  useE2ee
} from '../e2ee';

const TABS = [
  { key: 'profile', label: 'Profile', icon: UserIcon },
  { key: 'storage', label: 'Storage', icon: HardDrive },
  { key: 'appearance', label: 'Appearance', icon: Palette },
  { key: 'audio', label: 'Audio & Video', icon: Headphones },
  { key: 'notifications', label: 'Notifications', icon: Bell },
  { key: 'privacy', label: 'Privacy', icon: Shield },
  { key: 'connections', label: 'Now playing', icon: Music2 },
  { key: 'overlay', label: 'Game overlay', icon: Gamepad2, desktopOnly: true },
  { key: 'encryption', label: 'Encryption', icon: LockKeyhole },
  { key: 'updates', label: 'Updates', icon: Rocket },
  { key: 'developers', label: 'Developers', icon: Bot },
  { key: 'support', label: 'Support Cordia', icon: Heart }
];

// Radio groups in the Privacy tab. Order matters: most open first, most
// private last, matching how the DM group already reads.
const PRIVACY_CHOICES = {
  dmPrivacy: [
    { value: 'friends', icon: Users, title: 'Friends only', hint: "People you haven't added can't start a new conversation." },
    { value: 'anyone', icon: Users, title: 'Anyone', hint: 'Anyone who shares a server with you can start a conversation.' }
  ],
  friendRequests: [
    { value: 'anyone', icon: Globe, title: 'Anyone', hint: 'Anyone who finds your username can send a request.' },
    { value: 'mutual', icon: Users, title: 'Friends of friends', hint: 'Only people who share a friend with you.' },
    { value: 'nobody', icon: Ban, title: 'Nobody', hint: 'Requests are closed. People can still message you if your DM setting allows it.' }
  ],
  profileVisibility: [
    { value: 'everyone', icon: Eye, title: 'Everyone', hint: 'Anyone can read your bio, badges and shared servers.' },
    { value: 'mutual', icon: Users, title: 'People in my servers', hint: 'Only people who share at least one server with you.' },
    { value: 'friends', icon: LockKeyhole, title: 'Friends only', hint: 'Only people on your friends list. Name and avatar stay visible.' }
  ]
};

export default function SettingsPage({
  user,
  presence,
  initialTab,
  onClose,
  onSave,
  onLogout,
  onUserUpdate,
  onOpenE2eeUnlock,
  notificationPrefs,
  onNotificationPrefsChange
}) {
  const [tab, setTab] = useState(initialTab || 'profile');
  const [permission, setPermission] = useState('default');
  const [requestingNotification, setRequestingNotification] = useState(false);
  const [pushState, setPushState] = useState({
    supported: false,
    enabled: false,
    busy: false,
    error: ''
  });
  const [form, setForm] = useState({
    displayName: user.displayName,
    statusText: user.statusText || '',
    bio: user.bio || '',
    socialLinks: Array.isArray(user.socialLinks) ? user.socialLinks : [],
    games: Array.isArray(user.games) ? user.games : [],
    presence: user.presence || 'online',
    avatarColor: user.avatarColor || AVATAR_COLORS[0],
    bannerColor: user.bannerColor || BANNER_COLORS[0],
    avatarUrl: user.avatarUrl || '',
    bannerUrl: user.bannerUrl || '',
    theme: user.theme || 'iris',
    mode: user.mode || 'ink',
    dmPrivacy: user.dmPrivacy || 'friends',
    friendRequests: user.friendRequests || 'anyone',
    profileVisibility: user.profileVisibility || 'everyone',
    presenceVisibility: user.presenceVisibility || 'everyone',
    showTyping: user.showTyping !== false
  });
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // '', 'sending', 'sent', or the error the server returned.
  const [verifyState, setVerifyState] = useState('');

  async function resendVerification() {
    setVerifyState('sending');
    try {
      await api.post('/api/auth/verify/resend', {});
      setVerifyState('sent');
    } catch (err) {
      setVerifyState(err.message || 'Could not send the email.');
    }
  }
  const e2ee = useE2ee();
  const [recoveryCode, setRecoveryCode] = useState('');
  const [showRecoveryCode, setShowRecoveryCode] = useState(false);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState('');
  const [recoveryNotice, setRecoveryNotice] = useState('');
  const [rotatePassword, setRotatePassword] = useState('');
  const [rotateConfirm, setRotateConfirm] = useState('');
  const [rotateBusy, setRotateBusy] = useState(false);
  const [rotateError, setRotateError] = useState('');
  const [rememberAvailable, setRememberAvailable] = useState(false);
  const [deviceRemembered, setDeviceRemembered] = useState(false);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [deviceNotice, setDeviceNotice] = useState('');
  const [deviceError, setDeviceError] = useState('');
  const [blocked, setBlocked] = useState(null);
  const [blockedBusy, setBlockedBusy] = useState(0);

  const previewUser = { ...user, ...form };
  const encryptionUnlocked = isE2eeUnlocked() || e2ee.status === 'ready';

  useEffect(() => {
    applyPreferences(form);
  }, [form.theme, form.mode]);

  useEffect(() => {
    if (tab !== 'notifications') return undefined;
    let cancelled = false;
    notificationPermissionAsync().then((state) => {
      if (!cancelled) setPermission(state);
    });
    readBackgroundPushState().then((state) => {
      if (!cancelled) setPushState((prev) => ({ ...prev, ...state, error: '' }));
    });
    return () => {
      cancelled = true;
    };
  }, [tab]);

  useEffect(() => {
    if (tab !== 'privacy') return undefined;
    let cancelled = false;
    api
      .get('/api/friends')
      .then((data) => {
        if (!cancelled) setBlocked(data.blocked || []);
      })
      .catch(() => {
        if (!cancelled) setBlocked([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tab]);

  useEffect(() => {
    if (tab !== 'encryption') return undefined;
    let cancelled = false;
    (async () => {
      const available = await isRememberDeviceAvailable();
      if (cancelled) return;
      setRememberAvailable(available);
      setDeviceRemembered(available ? await isRememberedDevice(user.id) : false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, user.id]);

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === 'Escape') close();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  async function unblockUser(userId) {
    setBlockedBusy(userId);
    setError('');
    setSuccess('');
    try {
      await api.del(`/api/friends/block/${userId}`);
      setBlocked((list) => (list || []).filter((entry) => entry.user.id !== userId));
      setSuccess('Unblocked. They can contact you again.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBlockedBusy(0);
    }
  }

  function updateNotificationPref(key, value) {
    onNotificationPrefsChange({ ...notificationPrefs, [key]: value });
  }

  async function enableDesktopNotifications() {
    setRequestingNotification(true);
    try {
      const result = await requestNotificationPermission();
      setPermission(result);
      if (result === 'granted' && !notificationPrefs.desktop) {
        updateNotificationPref('desktop', true);
      }
    } finally {
      setRequestingNotification(false);
    }
  }

  async function toggleBackgroundPush() {
    setPushState((prev) => ({ ...prev, busy: true, error: '' }));
    try {
      if (pushState.enabled) await disableBackgroundPush();
      else await enableBackgroundPush();
      const next = await readBackgroundPushState();
      setPermission(next.permission);
      setPushState((prev) => ({ ...prev, ...next, busy: false, error: '' }));
    } catch (error) {
      setPushState((prev) => ({ ...prev, busy: false, error: error.message }));
    }
  }

  function testNotification() {
    if (notificationPrefs.sounds) playMessageSound();
    showDesktopNotification({
      title: 'Cordia notifications are on',
      body: 'New messages and incoming calls will appear like this.'
    });
  }

  function update(field, value) {
    setSuccess('');
    setError('');
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  // Rows are edited in place by index; the server normalises and caps on save,
  // so an empty row simply disappears rather than blocking the whole form.
  function setLink(index, patch) {
    update('socialLinks', form.socialLinks.map((link, i) => (i === index ? { ...link, ...patch } : link)));
  }

  function addLink() {
    if (form.socialLinks.length >= 6) return;
    update('socialLinks', [...form.socialLinks, { platform: 'website', url: '' }]);
  }

  function removeLink(index) {
    update('socialLinks', form.socialLinks.filter((_, i) => i !== index));
  }

  function setGame(index, patch) {
    update('games', form.games.map((game, i) => (i === index ? { ...game, ...patch } : game)));
  }

  function addGame() {
    if (form.games.length >= 8) return;
    update('games', [...form.games, { name: '', platform: '', hours: 0 }]);
  }

  function removeGame(index) {
    update('games', form.games.filter((_, i) => i !== index));
  }

  // One renderer for every privacy radio group so the four groups cannot drift
  // apart in markup or behaviour.
  function privacyChoices(field) {
    return (
      <div className="privacy-options">
        {(PRIVACY_CHOICES[field] || []).map(({ value, icon: Icon, title, hint }) => (
          <button
            key={value}
            className={`privacy-option ${form[field] === value ? 'active' : ''}`}
            onClick={() => update(field, value)}
          >
            <span className="privacy-icon">
              <Icon size={19} />
            </span>
            <span>
              <strong>{title}</strong>
              <small>{hint}</small>
            </span>
            <span className="privacy-check">
              {form[field] === value && <Check size={16} />}
            </span>
          </button>
        ))}
      </div>
    );
  }

  function close() {
    applyPreferences(user);
    onClose();
  }

  function reset() {
    setForm({
      displayName: user.displayName,
      statusText: user.statusText || '',
      bio: user.bio || '',
      socialLinks: Array.isArray(user.socialLinks) ? user.socialLinks : [],
      games: Array.isArray(user.games) ? user.games : [],
      presence: user.presence || 'online',
      avatarColor: user.avatarColor || AVATAR_COLORS[0],
      bannerColor: user.bannerColor || BANNER_COLORS[0],
      avatarUrl: user.avatarUrl || '',
      bannerUrl: user.bannerUrl || '',
      theme: user.theme || 'iris',
      mode: user.mode || 'ink',
      dmPrivacy: user.dmPrivacy || 'friends',
      friendRequests: user.friendRequests || 'anyone',
      profileVisibility: user.profileVisibility || 'everyone',
      presenceVisibility: user.presenceVisibility || 'everyone',
      showTyping: user.showTyping !== false
    });
    setError('');
    setSuccess('');
  }

  // Avatars and banners share the upload path; only the field differs. Animated
  // images are allowed for every account, so there is nothing to gate here.
  async function uploadImage(event, field) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const data = await api.upload(file);
      update(field, data.attachment.url);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await onSave(form);
      setSuccess('Changes saved.');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function createRecovery() {
    const identity = getE2eeSnapshot().identity;
    if (!identity) {
      setRecoveryError('Unlock encrypted messages before creating a recovery code.');
      return;
    }
    setRecoveryBusy(true);
    setRecoveryError('');
    setRecoveryNotice('');
    try {
      const code = generateRecoveryCode();
      const keyBackup = await createRecoveryBackup(identity, user.id, code);
      const recoveryVerifier = await hashRecoveryCode(code);
      const payload = await api.post('/api/e2ee/recovery', { keyBackup, recoveryVerifier });
      setRecoveryCode(code);
      setShowRecoveryCode(true);
      setRecoveryNotice('Recovery code created. Store it somewhere safe.');
      if (payload.user) onUserUpdate?.(payload.user);
    } catch (err) {
      setRecoveryError(err.message);
    } finally {
      setRecoveryBusy(false);
    }
  }

  async function copyRecovery() {
    if (!recoveryCode) return;
    try {
      await navigator.clipboard.writeText(recoveryCode);
      setRecoveryNotice('Recovery code copied.');
    } catch {
      setRecoveryError('Could not copy the recovery code.');
    }
  }

  async function removeRecovery() {
    setRecoveryBusy(true);
    setRecoveryError('');
    setRecoveryNotice('');
    try {
      const payload = await api.del('/api/e2ee/recovery');
      setRecoveryCode('');
      setShowRecoveryCode(false);
      setRecoveryNotice('Recovery code removed.');
      if (payload.user) onUserUpdate?.(payload.user);
    } catch (err) {
      setRecoveryError(err.message);
    } finally {
      setRecoveryBusy(false);
    }
  }

  async function forgetDevice() {
    setDeviceBusy(true);
    setDeviceError('');
    setDeviceNotice('');
    try {
      await forgetRememberedDevice(user.id);
      setDeviceRemembered(false);
      setDeviceNotice('Cordia will ask for your password the next time it starts.');
    } catch (err) {
      setDeviceError(err.message);
    } finally {
      setDeviceBusy(false);
    }
  }

  function lockDevice() {
    lockE2ee();
    setDeviceError('');
    setDeviceNotice('Encrypted messages are locked on this device.');
  }

  async function rotateKey() {
    if (!encryptionUnlocked) {
      setRotateError('Unlock encrypted messages before rotating your key.');
      return;
    }
    if (!rotatePassword) {
      setRotateError('Enter your account password.');
      return;
    }
    if (rotateConfirm !== 'ROTATE') {
      setRotateError('Type ROTATE to confirm.');
      return;
    }
    setRotateBusy(true);
    setRotateError('');
    try {
      const current = await api.get('/api/e2ee/me');
      await unlockIdentity(
        user.id,
        rotatePassword,
        current.e2ee.keyBackup,
        current.e2ee.publicKey,
        current.e2ee.keyVersion
      );
      const next = await createIdentity(user.id, rotatePassword);
      const payload = await api.post('/api/e2ee/rotate', {
        publicKey: next.publicKey,
        keyBackup: next.backup,
        confirm: 'ROTATE'
      });
      await activateIdentity({ ...next, keyVersion: payload.e2ee.keyVersion });
      await forgetRememberedDevice(user.id).catch(() => {});
      setDeviceRemembered(false);
      if (payload.user) onUserUpdate?.(payload.user);
      setRotatePassword('');
      setRotateConfirm('');
      setRecoveryCode('');
      setRecoveryNotice('Encryption key rotated. Older messages can no longer be decrypted.');
    } catch (err) {
      setRotateError(err.message);
    } finally {
      setRotateBusy(false);
    }
  }

  return (
    <div className="settings-page">
      <aside className="settings-sidebar">
        <div className="settings-account-card">
          <Avatar user={previewUser} size={52} presence={presence} showPresence />
          <div>
            <strong>{form.displayName}</strong>
            <span>{presenceLabel(previewUser, presence)}</span>
          </div>
        </div>

        <div className="settings-nav-label">Settings</div>
        <nav className="settings-nav">
          {TABS.filter((entry) => !entry.desktopOnly || isElectron).map((entry) => {
            const Icon = entry.icon;
            return (
              <button
                key={entry.key}
                className={`settings-nav-item ${tab === entry.key ? 'active' : ''}`}
                onClick={() => setTab(entry.key)}
              >
                <Icon size={17} />
                {entry.label}
              </button>
            );
          })}
        </nav>

        <div className="settings-sidebar-footer">
          <button className="settings-nav-item" onClick={onLogout}>
            <LogOut size={17} />
            Sign out
          </button>
          <span>Signed in as {user.email}</span>
          {!user.emailVerified && (
            <div className="settings-verify">
              {verifyState === 'sent' ? (
                <span className="settings-verify-sent">
                  <MailCheck size={13} /> Link sent — check your inbox.
                </span>
              ) : verifyState && verifyState !== 'sending' ? (
                <span className="settings-verify-error">{verifyState}</span>
              ) : (
                <button
                  type="button"
                  className="settings-verify-btn"
                  onClick={resendVerification}
                  disabled={verifyState === 'sending'}
                >
                  {verifyState === 'sending' ? <Loader2 size={13} className="spin" /> : <MailCheck size={13} />}
                  Confirm your email
                </button>
              )}
            </div>
          )}
        </div>
      </aside>

      <main className="settings-content">
        <header className="settings-topbar">
          <button className="icon-btn" onClick={close} title="Back to Cordia">
            <ArrowLeft size={18} />
          </button>
          <div>
            <span>Cordia</span>
            <strong>Settings</strong>
          </div>
          <button className="icon-btn" onClick={close} title="Close settings">
            <X size={18} />
          </button>
        </header>

        <div className="settings-scroll">
          {tab === 'profile' && (
            <section className="settings-section">
              <div className="settings-section-head">
                <div>
                  <h1>Profile</h1>
                  <p>How you appear in servers, conversations, and friend requests.</p>
                </div>
              </div>

              <div className="settings-profile-preview">
                <div
                  className={`settings-preview-banner ${form.bannerUrl ? 'has-image' : ''}`}
                  style={{
                    backgroundColor: form.bannerColor,
                    ...(form.bannerUrl
                      ? {
                          backgroundImage: `linear-gradient(180deg, rgba(5, 9, 20, 0.08), rgba(5, 9, 20, 0.66)), url("${assetUrl(form.bannerUrl)}")`,
                          backgroundSize: 'cover',
                          backgroundPosition: 'center'
                        }
                      : {})
                  }}
                >
                  <span>{form.bannerUrl ? 'Profile banner image' : 'Profile banner'}</span>
                </div>
                <div className="settings-preview-body">
                  <div className="settings-preview-avatar">
                    <Avatar user={previewUser} size={78} />
                  </div>
                  <div className="settings-preview-copy">
                    <strong>{form.displayName}</strong>
                    <span>@{user.username}</span>
                    <p>{form.bio || 'No bio yet.'}</p>
                  </div>
                  <div className="settings-preview-note">
                    <span className="color-dot" style={{ background: form.avatarColor }} />
                    Avatar color fills the circle.
                    <span className="color-dot" style={{ background: form.bannerColor }} />
                    Banner color fills the header.
                  </div>
                </div>
              </div>

              <div className="settings-avatar-actions">
                <label className="btn btn-ghost btn-sm">
                  {uploading ? <Loader2 size={15} className="spin" /> : <Camera size={15} />}
                  {form.avatarUrl ? 'Replace avatar' : 'Upload avatar'}
                  <input
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(event) => uploadImage(event, 'avatarUrl')}
                  />
                </label>
                {form.avatarUrl && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => update('avatarUrl', '')}
                  >
                    <Trash2 size={15} /> Remove image
                  </button>
                )}
                <span className="settings-actions-divider" aria-hidden="true" />
                <label className="btn btn-ghost btn-sm">
                  {uploading ? <Loader2 size={15} className="spin" /> : <ImageIcon size={15} />}
                  {form.bannerUrl ? 'Replace banner' : 'Upload banner'}
                  <input
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(event) => uploadImage(event, 'bannerUrl')}
                  />
                </label>
                {form.bannerUrl && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => update('bannerUrl', '')}
                  >
                    <Trash2 size={15} /> Remove banner
                  </button>
                )}
              </div>

              <div className="form-grid">
                <label className="field">
                  <span>Display name</span>
                  <input
                    value={form.displayName}
                    onChange={(event) => update('displayName', event.target.value)}
                    maxLength={32}
                  />
                </label>
                <label className="field">
                  <span>Online status</span>
                  <select
                    value={form.presence}
                    onChange={(event) => update('presence', event.target.value)}
                  >
                    <option value="online">Online</option>
                    <option value="idle">Idle</option>
                    <option value="dnd">Do not disturb</option>
                  </select>
                </label>
              </div>

              <label className="field">
                <span>Status</span>
                <input
                  value={form.statusText}
                  onChange={(event) => update('statusText', event.target.value)}
                  placeholder="What are you up to?"
                  maxLength={80}
                />
              </label>

              <div className="field settings-bio-field">
                <span className="settings-bio-head">
                  <span>Bio</span>
                  <EmoteInsertButton
                    title="Insert emoji"
                    onInsert={(snippet) => update('bio', (form.bio + snippet).slice(0, 190))}
                  />
                </span>
                <textarea
                  value={form.bio}
                  onChange={(event) => update('bio', event.target.value)}
                  rows={4}
                  maxLength={190}
                  placeholder="A short introduction. Custom emoji work here too."
                />
              </div>

              <div className="field">
                <span>Links</span>
                <p className="field-hint">
                  Up to six. Shown on your profile as chips; only http and https are accepted.
                </p>
                {form.socialLinks.map((link, index) => (
                  <div className="link-row" key={`link-${index}`}>
                    <select
                      className="input link-row-platform"
                      value={link.platform || 'website'}
                      onChange={(event) => setLink(index, { platform: event.target.value })}
                    >
                      {SOCIAL_PLATFORMS.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.label}
                        </option>
                      ))}
                    </select>
                    <input
                      className="input"
                      value={link.url || ''}
                      placeholder="https://"
                      maxLength={200}
                      onChange={(event) => setLink(index, { url: event.target.value })}
                    />
                    <button
                      type="button"
                      className="icon-btn"
                      title="Remove link"
                      onClick={() => removeLink(index)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
                {form.socialLinks.length < 6 && (
                  <button type="button" className="btn ghost small" onClick={addLink}>
                    <Plus size={14} /> Add link
                  </button>
                )}
              </div>

              <div className="field">
                <span>Games</span>
                <p className="field-hint">
                  Up to eight. Hours are optional and only ever shown as a number on your profile.
                </p>
                {form.games.map((game, index) => (
                  <div className="game-row" key={`game-${index}`}>
                    <input
                      className="input"
                      value={game.name || ''}
                      placeholder="Game"
                      maxLength={48}
                      onChange={(event) => setGame(index, { name: event.target.value })}
                    />
                    <input
                      className="input link-row-platform"
                      value={game.platform || ''}
                      placeholder="Platform"
                      maxLength={24}
                      onChange={(event) => setGame(index, { platform: event.target.value })}
                    />
                    <input
                      className="input link-row-hours"
                      type="number"
                      min="0"
                      max="100000"
                      value={game.hours || 0}
                      onChange={(event) => setGame(index, { hours: Number(event.target.value) || 0 })}
                      title="Hours"
                    />
                    <button
                      type="button"
                      className="icon-btn"
                      title="Remove game"
                      onClick={() => removeGame(index)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
                {form.games.length < 8 && (
                  <button type="button" className="btn ghost small" onClick={addGame}>
                    <Plus size={14} /> Add game
                  </button>
                )}
              </div>

              <div className="settings-color-grid">
                <div className="settings-color-block">
                  <div>
                    <span className="settings-label">Avatar color</span>
                    <p>Bright fill for the circle.</p>
                  </div>
                  <div className="swatches">
                    {AVATAR_COLORS.map((color) => (
                      <button
                        key={color}
                        className={`swatch ${form.avatarColor === color ? 'active' : ''}`}
                        style={{ background: color }}
                        onClick={() => update('avatarColor', color)}
                        aria-label={`Avatar color ${color}`}
                      />
                    ))}
                  </div>
                </div>
                <div className="settings-color-block">
                  <div>
                    <span className="settings-label">Banner color</span>
                    <p>Darker backdrop for your profile header.</p>
                  </div>
                  <div className="swatches">
                    {BANNER_COLORS.map((color) => (
                      <button
                        key={color}
                        className={`swatch ${form.bannerColor === color ? 'active' : ''}`}
                        style={{ background: color }}
                        onClick={() => update('bannerColor', color)}
                        aria-label={`Banner color ${color}`}
                      />
                    ))}
                  </div>
                </div>
              </div>

              {error && <div className="form-error">{error}</div>}
              {success && <div className="form-success">{success}</div>}

              <div className="settings-actions">
                <button className="btn btn-ghost" onClick={reset}>
                  Reset
                </button>
                <button className="btn btn-primary" onClick={save} disabled={saving}>
                  {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
                  Save changes
                </button>
              </div>
            </section>
          )}

          {tab === 'appearance' && (
            <section className="settings-section">
              <div className="settings-section-head">
                <div>
                  <h1>Appearance</h1>
                  <p>Pick an accent and a surface tone. Changes preview instantly.</p>
                </div>
              </div>

              <div className="settings-group">
                <div className="settings-group-head">
                  <h3>Accent color</h3>
                  <p>Buttons, links, focus states, and highlights.</p>
                </div>
                <div className="theme-grid">
                  {THEMES.map((theme) => (
                    <button
                      key={theme.key}
                      className={`theme-card ${form.theme === theme.key ? 'active' : ''}`}
                      onClick={() => update('theme', theme.key)}
                    >
                      <span className="theme-swatch" style={{ background: theme.color }}>
                        {form.theme === theme.key && <Check size={16} />}
                      </span>
                      <span>
                        <strong>{theme.label}</strong>
                        <small>{theme.description}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="settings-group">
                <div className="settings-group-head">
                  <h3>Surface</h3>
                  <p>The base color behind panels and messages.</p>
                </div>
                <div className="mode-grid">
                  {MODES.map((mode) => (
                    <button
                      key={mode.key}
                      className={`mode-card ${form.mode === mode.key ? 'active' : ''}`}
                      onClick={() => update('mode', mode.key)}
                    >
                      <span className="mode-preview" style={{ background: mode.color }}>
                        <span />
                        <span />
                      </span>
                      <strong>{mode.label}</strong>
                      <small>{mode.description}</small>
                    </button>
                  ))}
                </div>
              </div>

              <div className="appearance-preview">
                <div className="appearance-preview-rail">
                  <span className="appearance-server" />
                  <span className="appearance-server active" />
                </div>
                <div className="appearance-preview-sidebar">
                  <span />
                  <span />
                  <span />
                </div>
                <div className="appearance-preview-main">
                  <strong>Preview</strong>
                  <p>This is how your conversation surface will look.</p>
                  <button className="btn btn-primary btn-sm">Primary action</button>
                  <button className="btn btn-ghost btn-sm">Secondary</button>
                </div>
              </div>

              {error && <div className="form-error">{error}</div>}
              {success && <div className="form-success">{success}</div>}

              <div className="settings-actions">
                <button className="btn btn-ghost" onClick={reset}>
                  Reset
                </button>
                <button className="btn btn-primary" onClick={save} disabled={saving}>
                  {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
                  Save changes
                </button>
              </div>
            </section>
          )}

          {tab === 'audio' && <AudioVideoSettings />}

          {tab === 'updates' && <UpdatesPanel />}

          {tab === 'developers' && <DevelopersPanel />}{tab === 'storage' && <StorageSettings />}{tab === 'support' && <SupportSettings />}{tab === 'connections' && <NowPlayingSettings />}{tab === 'overlay' && <OverlaySettings />}

          {tab === 'notifications' && (
            <section className="settings-section">
              <div className="settings-section-head">
                <div>
                  <h1>Notifications</h1>
                  <p>Control alerts for new messages and incoming calls.</p>
                </div>
              </div>

              <div className="settings-group">
                <div className="settings-group-head">
                  <h3>Alerts</h3>
                  <p>Desktop alerts appear when Cordia is open and you are away.</p>
                </div>

                <div className="notification-list">
                  <div className="notification-row">
                    <span className="notification-icon">
                      <Monitor size={17} />
                    </span>
                    <div className="notification-row-copy">
                      <strong>Desktop notifications</strong>
                      <span>
                        {permission === 'granted'
                          ? 'Alerts appear when you are away or viewing another conversation.'
                          : permission === 'denied'
                            ? 'Blocked. Allow notifications in your system settings.'
                            : permission === 'unsupported'
                              ? 'This device does not support desktop notifications.'
                              : 'Enable alerts on this device.'}
                      </span>
                    </div>
                    {permission === 'granted' ? (
                      <button
                        className={`notification-switch ${notificationPrefs.desktop ? 'on' : ''}`}
                        role="switch"
                        aria-checked={notificationPrefs.desktop}
                        aria-label="Desktop notifications"
                        onClick={() =>
                          updateNotificationPref('desktop', !notificationPrefs.desktop)
                        }
                      >
                        <span />
                      </button>
                    ) : permission === 'default' ? (
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={enableDesktopNotifications}
                        disabled={requestingNotification}
                      >
                        {requestingNotification ? (
                          <Loader2 size={14} className="spin" />
                        ) : (
                          <Bell size={14} />
                        )}
                        Enable
                      </button>
                    ) : (
                      <span className="notification-status">
                        {permission === 'denied' ? 'Blocked' : 'Unavailable'}
                      </span>
                    )}
                  </div>

                  {!isNativeApp && (
                    <div className="notification-row">
                      <span className="notification-icon">
                        <Smartphone size={17} />
                      </span>
                      <div className="notification-row-copy">
                        <strong>Background notifications</strong>
                        <span>
                          {!pushState.supported
                            ? 'This browser cannot receive alerts while Cordia is closed.'
                            : pushState.enabled
                              ? 'On. Alerts arrive here even when Cordia is closed.'
                              : 'Get alerts when Cordia is closed. Requires notification permission.'}
                        </span>
                        {pushState.error && (
                          <span className="notification-error">{pushState.error}</span>
                        )}
                      </div>
                      {pushState.supported ? (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={toggleBackgroundPush}
                          disabled={pushState.busy}
                        >
                          {pushState.busy ? (
                            <Loader2 size={14} className="spin" />
                          ) : (
                            <Smartphone size={14} />
                          )}
                          {pushState.enabled ? 'Disable' : 'Enable'}
                        </button>
                      ) : (
                        <span className="notification-status">Unavailable</span>
                      )}
                    </div>
                  )}

                  <div className="notification-row">
                    <span className="notification-icon">
                      <Volume2 size={17} />
                    </span>
                    <div className="notification-row-copy">
                      <strong>Notification sounds</strong>
                      <span>Play a short chime for messages and a ringtone for calls.</span>
                    </div>
                    <button
                      className={`notification-switch ${notificationPrefs.sounds ? 'on' : ''}`}
                      role="switch"
                      aria-checked={notificationPrefs.sounds}
                      aria-label="Notification sounds"
                      onClick={() => updateNotificationPref('sounds', !notificationPrefs.sounds)}
                    >
                      <span />
                    </button>
                  </div>

                  <div className="notification-row">
                    <span className="notification-icon">
                      <BellRing size={17} />
                    </span>
                    <div className="notification-row-copy">
                      <strong>Test notification</strong>
                      <span>Check that alerts and sounds work in this browser.</span>
                    </div>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={testNotification}
                      disabled={permission !== 'granted' || !notificationPrefs.desktop}
                    >
                      Send test
                    </button>
                  </div>
                </div>
              </div>

              <div className="settings-note">
                <Bell size={17} />
                <p>
                  Message alerts skip conversations you are actively reading. Incoming calls ring
                  until you answer or decline.
                </p>
              </div>
            </section>
          )}

          {tab === 'privacy' && (
            <section className="settings-section">
              <div className="settings-section-head">
                <div>
                  <h1>Privacy</h1>
                  <p>Decide who can reach you, what they can see, and what you broadcast.</p>
                </div>
              </div>

              <div className="settings-group">
                <div className="settings-group-head">
                  <h3>Direct messages</h3>
                  <p>Existing conversations stay available. Blocking always takes priority.</p>
                </div>
                {privacyChoices('dmPrivacy')}
              </div>

              <div className="settings-group">
                <div className="settings-group-head">
                  <h3>Friend requests</h3>
                  <p>Requests already waiting for you can always be accepted.</p>
                </div>
                {privacyChoices('friendRequests')}
              </div>

              <div className="settings-group">
                <div className="settings-group-head">
                  <h3>Profile</h3>
                  <p>Your name, avatar and custom status stay visible everywhere.</p>
                </div>
                {privacyChoices('profileVisibility')}
              </div>

              <div className="settings-group">
                <div className="settings-group-head">
                  <h3>Activity</h3>
                  <p>What people can tell about you while you are online.</p>
                </div>

                <div className="privacy-toggles">
                  <div className="privacy-toggle-row">
                    <span className="privacy-icon">
                      <EyeOff size={19} />
                    </span>
                    <div className="privacy-toggle-copy">
                      <strong>Appear offline</strong>
                      <span>
                        Stay connected to calls and messages while everyone else sees you as
                        offline.
                      </span>
                    </div>
                    <button
                      className={`privacy-switch ${form.presenceVisibility === 'nobody' ? 'on' : ''}`}
                      role="switch"
                      aria-checked={form.presenceVisibility === 'nobody'}
                      aria-label="Appear offline"
                      onClick={() =>
                        update(
                          'presenceVisibility',
                          form.presenceVisibility === 'nobody' ? 'everyone' : 'nobody'
                        )
                      }
                    >
                      <span />
                    </button>
                  </div>

                  <div className="privacy-toggle-row">
                    <span className="privacy-icon">
                      <MessageSquare size={19} />
                    </span>
                    <div className="privacy-toggle-copy">
                      <strong>Typing indicators</strong>
                      <span>Show when you are typing in a channel or conversation.</span>
                    </div>
                    <button
                      className={`privacy-switch ${form.showTyping ? 'on' : ''}`}
                      role="switch"
                      aria-checked={form.showTyping}
                      aria-label="Typing indicators"
                      onClick={() => update('showTyping', !form.showTyping)}
                    >
                      <span />
                    </button>
                  </div>
                </div>
              </div>

              <div className="settings-group">
                <div className="settings-group-head">
                  <h3>Blocked people</h3>
                  <p>Blocking stops messages, calls and friend requests in both directions.</p>
                </div>

                {blocked === null ? (
                  <p className="privacy-empty">Loading blocked people…</p>
                ) : blocked.length === 0 ? (
                  <p className="privacy-empty">You haven't blocked anyone.</p>
                ) : (
                  <div className="privacy-blocked-list">
                    {blocked.map((entry) => (
                      <div className="privacy-blocked-row" key={entry.user.id}>
                        <Avatar user={entry.user} size={32} />
                        <span className="privacy-blocked-name">
                          <strong>{entry.user.displayName}</strong>
                          <small>@{entry.user.username}</small>
                        </span>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => unblockUser(entry.user.id)}
                          disabled={blockedBusy === entry.user.id}
                        >
                          {blockedBusy === entry.user.id ? (
                            <Loader2 size={14} className="spin" />
                          ) : (
                            'Unblock'
                          )}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {error && <div className="form-error">{error}</div>}
              {success && <div className="form-success">{success}</div>}

              <div className="settings-actions">
                <button className="btn btn-ghost" onClick={reset}>
                  Reset
                </button>
                <button className="btn btn-primary" onClick={save} disabled={saving}>
                  {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
                  Save changes
                </button>
              </div>
            </section>
          )}

          {tab === 'encryption' && (
            <section className="settings-section">
              <div className="settings-section-head">
                <div>
                  <h1>Encryption</h1>
                  <p>Manage end-to-end encryption for your direct messages.</p>
                </div>
              </div>

              <div className="settings-group">
                <div className="settings-group-head">
                  <h3>Encryption status</h3>
                  <p>
                    Direct messages are encrypted on your device. Server channels use transport
                    encryption and server-side moderation.
                  </p>
                </div>

                <div className="encryption-status-grid">
                  <div className="encryption-status-item">
                    <span>Direct messages</span>
                    <strong>
                      {user.e2eeReady ? (
                        <>
                          <ShieldCheck size={15} /> End-to-end encrypted
                        </>
                      ) : (
                        'Not set up'
                      )}
                    </strong>
                  </div>
                  <div className="encryption-status-item">
                    <span>This device</span>
                    <strong>
                      {encryptionUnlocked ? (
                        <>
                          <KeyRound size={15} /> Unlocked
                        </>
                      ) : (
                        <>
                          <LockKeyhole size={15} /> Locked
                        </>
                      )}
                    </strong>
                  </div>
                  <div className="encryption-status-item">
                    <span>Key version</span>
                    <strong>v{user.e2eeKeyVersion || 0}</strong>
                  </div>
                  <div className="encryption-status-item">
                    <span>Recovery code</span>
                    <strong>
                      {user.e2eeRecoveryReady
                        ? user.e2eeRecoveryResettable
                          ? 'Configured'
                          : 'Needs update'
                        : 'Not configured'}
                    </strong>
                  </div>
                </div>

                {!encryptionUnlocked && (
                  <div className="settings-note">
                    <LockKeyhole size={17} />
                    <p>
                      Your keys are locked on this device. Unlock them to read encrypted messages
                      or manage recovery.
                      <button
                        type="button"
                        className="btn btn-primary btn-sm encryption-inline-action"
                        onClick={onOpenE2eeUnlock}
                      >
                        Unlock
                      </button>
                    </p>
                  </div>
                )}
              </div>

              <div className="settings-group">
                <div className="settings-group-head">
                  <h3>Remembered device</h3>
                  <p>
                    Cordia can store your unlocked key with your operating system's secure
                    storage so you do not need to enter your password every time the app starts.
                  </p>
                </div>

                {rememberAvailable ? (
                  <>
                    <div className="settings-note">
                      <Monitor size={17} />
                      <p>
                        {deviceRemembered
                          ? 'This device is remembered. Anyone who can use your computer account can read your encrypted messages.'
                          : 'This device is not remembered. Cordia will ask for your password when it starts.'}
                      </p>
                    </div>
                    <div className="settings-actions">
                      {deviceRemembered && (
                        <button
                          type="button"
                          className="btn btn-danger"
                          onClick={forgetDevice}
                          disabled={deviceBusy}
                        >
                          {deviceBusy ? <Loader2 size={16} className="spin" /> : <Trash2 size={16} />}
                          Forget this device
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost"
                        onClick={lockDevice}
                        disabled={!encryptionUnlocked}
                      >
                        <LockKeyhole size={16} />
                        Lock now
                      </button>
                    </div>
                    {deviceError && <div className="form-error">{deviceError}</div>}
                    {deviceNotice && <div className="form-success">{deviceNotice}</div>}
                  </>
                ) : (
                  <div className="settings-note">
                    <LockKeyhole size={17} />
                    <p>Secure device storage is available in the Cordia desktop app.</p>
                  </div>
                )}
              </div>

              <div className="settings-group">
                <div className="settings-group-head">
                  <h3>Recovery code</h3>
                  <p>
                    A recovery code restores the same encryption key if you forget your password.
                    Anyone with the code and your encrypted backup can read your messages.
                  </p>
                </div>

                {user.e2eeRecoveryReady && !user.e2eeRecoveryResettable && (
                  <div className="settings-note">
                    <AlertTriangle size={17} />
                    <p>
                      This recovery code was created before password recovery was available.
                      Re-create it to enable the forgot-password flow.
                    </p>
                  </div>
                )}

                {recoveryCode && (
                  <div className="recovery-code-box">
                    <div className="recovery-code-value">
                      <code>{showRecoveryCode ? recoveryCode : '•'.repeat(43)}</code>
                      <button
                        type="button"
                        className="icon-btn"
                        title={showRecoveryCode ? 'Hide recovery code' : 'Show recovery code'}
                        onClick={() => setShowRecoveryCode((value) => !value)}
                      >
                        {showRecoveryCode ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        title="Copy recovery code"
                        onClick={copyRecovery}
                      >
                        <Copy size={16} />
                      </button>
                    </div>
                    <p>Store this code offline. It will not be shown again after you leave this page.</p>
                  </div>
                )}

                <div className="settings-actions">
                  {(!user.e2eeRecoveryReady || !user.e2eeRecoveryResettable) && (
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={createRecovery}
                      disabled={recoveryBusy || !encryptionUnlocked}
                    >
                      {recoveryBusy ? (
                        <Loader2 size={16} className="spin" />
                      ) : (
                        <KeyRound size={16} />
                      )}
                      {user.e2eeRecoveryReady ? 'Replace recovery code' : 'Create recovery code'}
                    </button>
                  )}
                  {user.e2eeRecoveryReady && (
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={removeRecovery}
                      disabled={recoveryBusy}
                    >
                      {recoveryBusy ? <Loader2 size={16} className="spin" /> : <Trash2 size={16} />}
                      Remove recovery code
                    </button>
                  )}
                </div>

                {recoveryError && <div className="form-error">{recoveryError}</div>}
                {recoveryNotice && <div className="form-success">{recoveryNotice}</div>}
              </div>

              <div className="settings-group encryption-danger">
                <div className="settings-group-head">
                  <h3>Rotate encryption key</h3>
                  <p>
                    Rotation creates a new identity key. Messages encrypted with the old key,
                    including attachments, can no longer be decrypted by anyone. Other people will
                    see a key-change warning until they verify your new safety number.
                  </p>
                </div>

                <div className="encryption-rotate-fields">
                  <label className="settings-field">
                    <span>Account password</span>
                    <input
                      type="password"
                      value={rotatePassword}
                      onChange={(event) => setRotatePassword(event.target.value)}
                      autoComplete="current-password"
                      placeholder="Confirm your password"
                    />
                  </label>
                  <label className="settings-field">
                    <span>Type ROTATE to confirm</span>
                    <input
                      type="text"
                      value={rotateConfirm}
                      onChange={(event) => setRotateConfirm(event.target.value)}
                      autoComplete="off"
                      placeholder="ROTATE"
                    />
                  </label>
                </div>

                <div className="settings-actions">
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={rotateKey}
                    disabled={rotateBusy || !encryptionUnlocked}
                  >
                    {rotateBusy ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
                    Rotate key
                  </button>
                </div>

                {rotateError && <div className="form-error">{rotateError}</div>}
              </div>
            </section>
          )}

        </div>
      </main>
    </div>
  );
}

