import { useEffect, useState } from 'react';
import { Loader2, Save, ShieldCheck } from 'lucide-react';
import api from '../api';

export default function AutomodSettings({ server, canManage }) {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .get(`/api/servers/${server.id}/automod`)
      .then((payload) => {
        if (cancelled) return;
        setSettings({
          ...payload.automod,
          blockedWordsText: (payload.automod.blockedWords || []).join('\n')
        });
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
  }, [server.id]);

  function update(patch) {
    setSettings((current) => ({ ...current, ...patch }));
    setSaved(false);
  }

  async function save() {
    if (!settings || saving || !canManage) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const payload = await api.patch(`/api/servers/${server.id}/automod`, {
        enabled: settings.enabled,
        blockedWords: settings.blockedWordsText,
        blockLinks: settings.blockLinks,
        blockInvites: settings.blockInvites,
        mentionLimit: Number(settings.mentionLimit) || 0,
        blockEveryone: settings.blockEveryone,
        blockCaps: settings.blockCaps,
        blockRepeated: settings.blockRepeated,
        emojiLimit: Number(settings.emojiLimit) || 0,
        duplicateWindow: Number(settings.duplicateWindow) || 0
      });
      setSettings({
        ...payload.automod,
        blockedWordsText: (payload.automod.blockedWords || []).join('\n')
      });
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="server-settings automod-loading">
        <Loader2 size={18} className="spin" />
        Loading automod
      </div>
    );
  }

  if (!settings) {
    return <div className="server-settings">{error || 'Automod is unavailable.'}</div>;
  }

  return (
    <div className="server-settings">
      <div className="settings-section-head">
        <div>
          <h3>Automod</h3>
          <p>Filter unwanted content before it reaches the channel.</p>
        </div>
        <ShieldCheck size={22} />
      </div>

      {error && <div className="form-error">{error}</div>}
      {saved && <div className="form-success">Automod settings saved.</div>}

      <label className="toggle-row automod-toggle">
        <input
          type="checkbox"
          checked={!!settings.enabled}
          onChange={(event) => update({ enabled: event.target.checked })}
          disabled={!canManage}
        />
        <span>
          <strong>Enable automod</strong>
          <small>Blocked content is rejected before it is posted.</small>
        </span>
      </label>

      <div className={`automod-grid ${settings.enabled ? '' : 'disabled'}`}>
        <label className="field">
          <span>Blocked words</span>
          <textarea
            value={settings.blockedWordsText}
            onChange={(event) => update({ blockedWordsText: event.target.value })}
            placeholder={'One word or phrase per line\nspoilers\nleak'}
            rows={10}
            maxLength={2500}
            disabled={!canManage}
          />
          <small>Up to 50 entries, separated by new lines or commas.</small>
        </label>

        <div className="automod-rules">
          <div className="automod-rule-group">
            <span className="automod-rule-title">Message rules</span>

            <label className="toggle-row">
              <input
                type="checkbox"
                checked={!!settings.blockLinks}
                onChange={(event) => update({ blockLinks: event.target.checked })}
                disabled={!canManage}
              />
              <span>
                <strong>Block links</strong>
                <small>Reject http and https links.</small>
              </span>
            </label>

            <label className="toggle-row">
              <input
                type="checkbox"
                checked={!!settings.blockInvites}
                onChange={(event) => update({ blockInvites: event.target.checked })}
                disabled={!canManage}
              />
              <span>
                <strong>Block invites</strong>
                <small>Reject Discord invite links.</small>
              </span>
            </label>

            <label className="toggle-row">
              <input
                type="checkbox"
                checked={!!settings.blockEveryone}
                onChange={(event) => update({ blockEveryone: event.target.checked })}
                disabled={!canManage}
              />
              <span>
                <strong>Block @everyone and @here</strong>
                <small>Reject messages that ping the whole server.</small>
              </span>
            </label>

            <label className="toggle-row">
              <input
                type="checkbox"
                checked={!!settings.blockCaps}
                onChange={(event) => update({ blockCaps: event.target.checked })}
                disabled={!canManage}
              />
              <span>
                <strong>Block excessive caps</strong>
                <small>Reject messages of 12+ letters that are mostly uppercase.</small>
              </span>
            </label>

            <label className="toggle-row">
              <input
                type="checkbox"
                checked={!!settings.blockRepeated}
                onChange={(event) => update({ blockRepeated: event.target.checked })}
                disabled={!canManage}
              />
              <span>
                <strong>Block repeated characters</strong>
                <small>Reject 10 or more identical characters in a row.</small>
              </span>
            </label>
          </div>

          <div className="automod-rule-group">
            <span className="automod-rule-title">Spam limits</span>

            <label className="field">
              <span>Mention limit</span>
              <input
                type="number"
                min={0}
                max={20}
                value={settings.mentionLimit}
                onChange={(event) => update({ mentionLimit: event.target.value })}
                disabled={!canManage}
              />
              <small>0 disables the limit. Maximum 20 mentions.</small>
            </label>

            <label className="field">
              <span>Emoji limit</span>
              <input
                type="number"
                min={0}
                max={50}
                value={settings.emojiLimit}
                onChange={(event) => update({ emojiLimit: event.target.value })}
                disabled={!canManage}
              />
              <small>0 disables the limit. Maximum 50 emoji.</small>
            </label>

            <label className="field">
              <span>Duplicate message window</span>
              <input
                type="number"
                min={0}
                max={120}
                value={settings.duplicateWindow}
                onChange={(event) => update({ duplicateWindow: event.target.value })}
                disabled={!canManage}
              />
              <small>0 disables. Seconds before the same message can repeat in a channel.</small>
            </label>
          </div>
        </div>
      </div>

      {canManage && (
        <div className="automod-actions">
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? <Loader2 size={15} className="spin" /> : <Save size={15} />}
            Save automod
          </button>
        </div>
      )}
      {!canManage && <p className="automod-readonly">Only server managers can change automod.</p>}
    </div>
  );
}
