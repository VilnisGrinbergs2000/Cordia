import { useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Folder,
  FolderPlus,
  Hash,
  Loader2,
  Lock,
  Pencil,
  Plus,
  Radio,
  Save,
  Trash2,
  Volume2,
  X
} from 'lucide-react';
import api from '../api';
import ChannelPermissionsModal from './ChannelPermissionsModal';

export default function ChannelManager({ server, canManage, onUpdated }) {
  const [permChannel, setPermChannel] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const categories = server.categories || [];
  const channels = server.channels || [];

  function startCreate() {
    setCreating(true);
    setEditingId(null);
    setNewName('');
    setError('');
  }

  function startRename(category) {
    setCreating(false);
    setEditingId(category.id);
    setEditName(category.name);
    setError('');
  }

  async function createCategory(event) {
    event.preventDefault();
    if (!canManage) return;
    setBusy('category-create');
    setError('');
    try {
      const data = await api.post(`/api/servers/${server.id}/categories`, {
        name: newName.trim()
      });
      onUpdated(data.server);
      setCreating(false);
      setNewName('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function renameCategory(event, category) {
    event.preventDefault();
    if (!canManage) return;
    setBusy(`category-${category.id}`);
    setError('');
    try {
      const data = await api.patch(`/api/servers/${server.id}/categories/${category.id}`, {
        name: editName.trim()
      });
      onUpdated(data.server);
      setEditingId(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function deleteCategory(category) {
    if (!canManage) return;
    if (
      !window.confirm(
        `Delete "${category.name}"? Its channels will move to the uncategorized section.`
      )
    ) {
      return;
    }
    setBusy(`category-${category.id}`);
    setError('');
    try {
      const data = await api.del(
        `/api/servers/${server.id}/categories/${category.id}`
      );
      onUpdated(data.server);
      if (editingId === category.id) setEditingId(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function moveCategory(category, direction) {
    if (!canManage) return;
    const index = categories.findIndex((entry) => entry.id === category.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= categories.length) return;
    const next = [...categories];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    setBusy('category-order');
    setError('');
    try {
      const data = await api.put(`/api/servers/${server.id}/categories/order`, {
        categoryIds: next.map((entry) => entry.id)
      });
      onUpdated(data.server);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function moveChannel(channel, value) {
    if (!canManage) return;
    setBusy(`channel-${channel.id}`);
    setError('');
    try {
      const data = await api.patch(`/api/channels/${channel.id}`, {
        categoryId: value ? Number(value) : null
      });
      onUpdated(data.server);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="channel-manager">
      <div className="settings-section-head">
        <div>
          <h3>Channels and categories</h3>
          <p>Group channels into your own spaces. Events stay above every category.</p>
        </div>
        {canManage && (
          <button className="btn btn-primary btn-sm" onClick={startCreate}>
            <FolderPlus size={15} /> New category
          </button>
        )}
      </div>

      {error && <div className="form-error">{error}</div>}

      {creating && (
        <form className="channel-category-form" onSubmit={createCategory}>
          <input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="Category name"
            maxLength={48}
            autoFocus
            required
          />
          <button className="btn btn-primary btn-sm" disabled={busy === 'category-create'}>
            {busy === 'category-create' ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <Plus size={15} />
            )}
            Create
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setCreating(false)}
          >
            Cancel
          </button>
        </form>
      )}

      <div className="channel-manager-section">
        <span className="settings-label">Categories</span>
        <div className="channel-manager-categories">
          {categories.map((category, index) => {
            const count = channels.filter((channel) => channel.categoryId === category.id).length;
            const editing = editingId === category.id;
            return (
              <div className="channel-category-admin" key={category.id}>
                {editing ? (
                  <form
                    className="channel-category-form channel-category-form--inline"
                    onSubmit={(event) => renameCategory(event, category)}
                  >
                    <input
                      value={editName}
                      onChange={(event) => setEditName(event.target.value)}
                      maxLength={48}
                      autoFocus
                      required
                    />
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={busy === `category-${category.id}`}
                    >
                      {busy === `category-${category.id}` ? (
                        <Loader2 size={15} className="spin" />
                      ) : (
                        <Save size={15} />
                      )}
                      Save
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => setEditingId(null)}
                      title="Cancel"
                    >
                      <X size={15} />
                    </button>
                  </form>
                ) : (
                  <>
                    <div className="channel-category-admin-copy">
                      <Folder size={16} />
                      <div>
                        <strong>{category.name}</strong>
                        <small>
                          {count} channel{count === 1 ? '' : 's'}
                        </small>
                      </div>
                    </div>
                    <div className="channel-category-admin-actions">
                      <button
                        className="icon-btn"
                        onClick={() => moveCategory(category, -1)}
                        disabled={busy === 'category-order' || index === 0}
                        title="Move category up"
                      >
                        <ChevronUp size={15} />
                      </button>
                      <button
                        className="icon-btn"
                        onClick={() => moveCategory(category, 1)}
                        disabled={busy === 'category-order' || index === categories.length - 1}
                        title="Move category down"
                      >
                        <ChevronDown size={15} />
                      </button>
                      <button
                        className="icon-btn"
                        onClick={() => startRename(category)}
                        title="Rename category"
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        className="icon-btn danger-hover"
                        onClick={() => deleteCategory(category)}
                        disabled={busy === `category-${category.id}`}
                        title="Delete category"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
          {categories.length === 0 && (
            <p className="channel-empty">
              No categories yet. Create one to group channels together.
            </p>
          )}
        </div>
      </div>

      <div className="channel-manager-section">
        <span className="settings-label">Channel placement</span>
        <div className="channel-manager-channels">
          {channels.map((channel) => (
            <div className="channel-manager-row" key={channel.id}>
              <span className="channel-manager-icon">
                {channel.type === 'voice' ? (
                  <Volume2 size={16} />
                ) : channel.type === 'stage' ? (
                  <Radio size={16} />
                ) : (
                  <Hash size={16} />
                )}
              </span>
              <div className="channel-manager-copy">
                <strong>{channel.name}</strong>
                <small>
                  {channel.type === 'voice'
                    ? 'Voice channel'
                    : channel.type === 'stage'
                      ? 'Stage channel'
                      : 'Text channel'}
                </small>
              </div>
              <select
                value={channel.categoryId || ''}
                onChange={(event) => moveChannel(channel, event.target.value)}
                disabled={!canManage || busy === `channel-${channel.id}`}
                aria-label={`Category for ${channel.name}`}
              >
                <option value="">No category</option>
                {categories.map((category) => (
                  <option value={category.id} key={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="icon-btn"
                title={`Permissions for ${channel.name}`}
                aria-label={`Permissions for ${channel.name}`}
                onClick={() => setPermChannel(channel)}
              >
                <Lock size={15} />
              </button>
            </div>
          ))}
          {channels.length === 0 && <p className="channel-empty">No channels yet.</p>}
        </div>
      </div>
      {permChannel && (
        <ChannelPermissionsModal
          channel={permChannel}
          server={server}
          onClose={() => setPermChannel(null)}
        />
      )}
    </div>
  );
}
