import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Briefcase,
  Camera,
  Check,
  Compass,
  Gamepad2,
  GraduationCap,
  Hash,
  Loader2,
  Palette,
  Plus,
  Sparkles,
  Trash2,
  Users,
  Volume2
} from 'lucide-react';
import api from '../api';
import Modal from './Modal';
import ServerIcon from './ServerIcon';
import ServerIconCropModal from './ServerIconCropModal';

const TEMPLATE_ICONS = {
  users: Users,
  gamepad: Gamepad2,
  graduation: GraduationCap,
  briefcase: Briefcase,
  palette: Palette,
  sparkles: Sparkles
};

const MAX_ICON_BYTES = 8 * 1024 * 1024;

function templateChannelCounts(template) {
  const channels = template?.categories?.flatMap((category) => category.channels) || [];
  return {
    text: channels.filter((channel) => channel.type === 'text').length,
    voice: channels.filter((channel) => channel.type === 'voice').length
  };
}

export default function AddServerModal({ onClose, onCreate, onJoin }) {
  const [mode, setMode] = useState('create');
  const [name, setName] = useState('');
  const [invite, setInvite] = useState('');
  const [templates, setTemplates] = useState([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templateId, setTemplateId] = useState('');
  const [iconUrl, setIconUrl] = useState('');
  const [cropFile, setCropFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .get('/api/server-templates')
      .then((payload) => {
        if (cancelled) return;
        const nextTemplates = Array.isArray(payload?.templates) ? payload.templates : [];
        setTemplates(nextTemplates);
        setTemplateId((current) =>
          nextTemplates.some((template) => template.id === current)
            ? current
            : nextTemplates[0]?.id || ''
        );
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setTemplatesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === templateId) || null,
    [templates, templateId]
  );
  const selectedChannels = useMemo(
    () => selectedTemplate?.categories?.flatMap((category) => category.channels) || [],
    [selectedTemplate]
  );

  function chooseIcon(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Choose an image file for the server icon.');
      return;
    }
    if (file.size > MAX_ICON_BYTES) {
      setError('Server images must be 8 MB or smaller.');
      return;
    }
    setError('');
    setCropFile(file);
  }

  async function applyCrop(blob) {
    setUploading(true);
    setError('');
    try {
      const extension = blob.type === 'image/jpeg' ? 'jpg' : 'webp';
      const file = new File([blob], `server-icon.${extension}`, {
        type: blob.type || 'image/webp'
      });
      const data = await api.upload(file);
      setIconUrl(data.attachment.url);
      setCropFile(null);
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setUploading(false);
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (mode === 'create' && !selectedTemplate) {
      setError('Choose a server template.');
      return;
    }
    if (uploading) return;
    setBusy(true);
    setError('');
    try {
      if (mode === 'create') {
        // The shell takes over after creation: it swaps this modal for the
        // invite sheet, so closing here would undo that.
        await onCreate({
          name: name.trim(),
          templateId: selectedTemplate.id,
          iconUrl
        });
      } else {
        await onJoin(invite.trim());
        onClose();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const createDisabled =
    busy ||
    uploading ||
    templatesLoading ||
    !selectedTemplate;

  return (
    <>
      <Modal
        title={mode === 'create' ? 'Create a server' : 'Join a server'}
        subtitle={
          mode === 'create'
            ? 'Pick a template, then make it yours.'
            : 'Paste an invite link to join an existing server.'
        }
        onClose={onClose}
        width={mode === 'create' ? 700 : 460}
      >
        <div className="segmented">
          <button
            type="button"
            className={mode === 'create' ? 'active' : ''}
            onClick={() => {
              setMode('create');
              setError('');
            }}
          >
            <Plus size={15} /> Create
          </button>
          <button
            type="button"
            className={mode === 'join' ? 'active' : ''}
            onClick={() => {
              setMode('join');
              setError('');
            }}
          >
            <Compass size={15} /> Join
          </button>
        </div>

        <form className="auth-form add-server-form" onSubmit={submit}>
          {mode === 'create' ? (
            <>
              <div className="server-template-head">
                <span className="settings-label">Start from a template</span>
                <span className="field-hint">Everything can be changed later.</span>
              </div>

              {templatesLoading ? (
                <div className="server-template-loading">
                  <Loader2 size={16} className="spin" />
                  Loading templates...
                </div>
              ) : templates.length > 0 ? (
                <div
                  className="server-template-grid"
                  role="radiogroup"
                  aria-label="Server template"
                >
                  {templates.map((template) => {
                    const Icon = TEMPLATE_ICONS[template.icon] || Sparkles;
                    const counts = templateChannelCounts(template);
                    const selected = template.id === templateId;
                    return (
                      <button
                        key={template.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={`server-template-card ${selected ? 'active' : ''}`}
                        onClick={() => {
                          setTemplateId(template.id);
                          setError('');
                        }}
                      >
                        <span className="server-template-card-top">
                          <span
                            className="server-template-icon"
                            style={{ '--template-color': template.color }}
                          >
                            <Icon size={18} />
                          </span>
                          {selected && <Check size={15} className="server-template-check" />}
                        </span>
                        <strong>{template.name}</strong>
                        <span className="server-template-description">
                          {template.description}
                        </span>
                        <span className="server-template-count">
                          {counts.text} text · {counts.voice} voice
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {selectedTemplate && (
                <div className="server-template-includes">
                  <span className="settings-label">Included channels</span>
                  <div className="server-template-channels">
                    {selectedChannels.map((channel) => (
                      <span
                        key={`${channel.type}-${channel.name}`}
                        className={`server-template-channel ${channel.type}`}
                      >
                        {channel.type === 'voice' ? (
                          <Volume2 size={12} />
                        ) : (
                          <Hash size={12} />
                        )}
                        {channel.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="server-create-identity">
                <ServerIcon
                  server={{
                    name: name.trim() || 'New server',
                    iconUrl,
                    iconColor: selectedTemplate?.color || '#6d5efc'
                  }}
                  className="server-create-icon"
                />
                <div className="server-create-fields">
                  <label className="field">
                    <span>Server name</span>
                    <input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Project Studio"
                      maxLength={48}
                      autoFocus
                      required
                    />
                  </label>
                  <div className="server-create-icon-actions">
                    <label className={`btn btn-ghost btn-sm ${uploading ? 'is-busy' : ''}`}>
                      {uploading ? (
                        <Loader2 size={15} className="spin" />
                      ) : (
                        <Camera size={15} />
                      )}
                      {iconUrl ? 'Replace image' : 'Add server image'}
                      <input
                        type="file"
                        accept="image/*"
                        hidden
                        onChange={chooseIcon}
                        disabled={uploading}
                      />
                    </label>
                    {iconUrl && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          setIconUrl('');
                          setError('');
                        }}
                        disabled={uploading}
                      >
                        <Trash2 size={15} /> Remove
                      </button>
                    )}
                  </div>
                  <small className="field-hint">
                    Square crop, 512 x 512. PNG, JPG, WebP, GIF, or AVIF up to 8 MB.
                  </small>
                </div>
              </div>
            </>
          ) : (
            <label className="field">
              <span>Invite link</span>
              <input
                value={invite}
                onChange={(event) => setInvite(event.target.value)}
                placeholder="Paste an invite link"
                autoFocus
                required
              />
              <small className="field-hint">
                Links look like https://your-cordia-host/invite/CODE.
              </small>
            </label>
          )}

          {error && <div className="form-error">{error}</div>}

          <button
            className="btn btn-primary"
            disabled={mode === 'create' ? createDisabled : busy}
          >
            {busy ? (
              <Loader2 size={17} className="spin" />
            ) : mode === 'create' ? (
              <Sparkles size={17} />
            ) : (
              <ArrowRight size={17} />
            )}
            {mode === 'create' ? 'Create server' : 'Join server'}
          </button>
        </form>
      </Modal>

      {cropFile && (
        <ServerIconCropModal
          file={cropFile}
          onClose={() => !uploading && setCropFile(null)}
          onApply={applyCrop}
        />
      )}
    </>
  );
}
