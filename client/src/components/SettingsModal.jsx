import { useState } from 'react';
import { Camera, Loader2, LogOut, Save, Trash2 } from 'lucide-react';
import Modal from './Modal';
import Avatar from './Avatar';
import api from '../api';
import { AVATAR_COLORS, BANNER_COLORS } from '../utils';

export default function SettingsModal({ user, onClose, onSave, onLogout }) {
  const [form, setForm] = useState({
    displayName: user.displayName,
    statusText: user.statusText || '',
    bio: user.bio || '',
    presence: user.presence || 'online',
    avatarColor: user.avatarColor || AVATAR_COLORS[0],
    bannerColor: user.bannerColor || BANNER_COLORS[0],
    avatarUrl: user.avatarUrl || ''
  });
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  function update(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function uploadAvatar(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploading(true);
    setError('');
    try {
      const data = await api.upload(file);
      update('avatarUrl', data.attachment.url);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      await onSave(form);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const previewUser = { ...user, ...form };

  return (
    <Modal
      title="Profile settings"
      subtitle="Shape how you appear across Cordia."
      onClose={onClose}
      width={560}
      footer={
        <div className="settings-footer">
          <button className="btn btn-ghost btn-sm" onClick={onLogout}>
            <LogOut size={15} /> Sign out
          </button>
          <div className="settings-footer-right">
            <button className="btn btn-ghost btn-sm" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
              {saving ? <Loader2 size={15} className="spin" /> : <Save size={15} />} Save changes
            </button>
          </div>
        </div>
      }
    >
      <div className="settings-profile">
        <div
          className="settings-banner"
          style={{
            background: `linear-gradient(135deg, ${form.bannerColor}, ${form.avatarColor})`
          }}
        />
        <div className="settings-avatar-row">
          <Avatar user={previewUser} size={76} />
          <div className="settings-avatar-actions">
            <label className="btn btn-ghost btn-sm">
              {uploading ? <Loader2 size={15} className="spin" /> : <Camera size={15} />}
              Upload avatar
              <input type="file" accept="image/*" hidden onChange={uploadAvatar} />
            </label>
            {form.avatarUrl && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => update('avatarUrl', '')}
                title="Remove avatar"
              >
                <Trash2 size={15} /> Remove
              </button>
            )}
          </div>
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
            <span>Presence</span>
            <select value={form.presence} onChange={(event) => update('presence', event.target.value)}>
              <option value="online">Online</option>
              <option value="idle">Idle</option>
              <option value="dnd">Do not disturb</option>
            </select>
          </label>
        </div>

        <label className="field">
          <span>Custom status</span>
          <input
            value={form.statusText}
            onChange={(event) => update('statusText', event.target.value)}
            placeholder="What are you orbiting around?"
            maxLength={80}
          />
        </label>

        <label className="field">
          <span>Bio</span>
          <textarea
            value={form.bio}
            onChange={(event) => update('bio', event.target.value)}
            rows={3}
            maxLength={190}
            placeholder="A little about you…"
          />
        </label>

        <div className="settings-colors">
          <div>
            <span className="settings-label">Avatar color</span>
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
          <div>
            <span className="settings-label">Banner color</span>
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

        <div className="settings-account">
          <span>Signed in as</span>
          <strong>{user.email}</strong>
        </div>

        {error && <div className="form-error">{error}</div>}
      </div>
    </Modal>
  );
}
