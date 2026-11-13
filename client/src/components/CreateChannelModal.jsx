import { useState } from 'react';
import {
  CalendarDays,
  FileText,
  FolderPlus,
  Hash,
  Image,
  ListChecks,
  Loader2,
  MessagesSquare,
  Plus,
  Radio,
  Volume2
} from 'lucide-react';
import Modal from './Modal';

export default function CreateChannelModal({
  onClose,
  onCreate,
  categories = [],
  defaultCategoryId = null
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState('text');
  const [categoryId, setCategoryId] = useState(
    defaultCategoryId ? String(defaultCategoryId) : ''
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isCategory = type === 'category';

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onCreate(name.trim(), type, isCategory || !categoryId ? null : Number(categoryId));
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={isCategory ? 'Create a category' : 'Create a channel'}
      subtitle={
        isCategory
          ? 'Group channels into a space that fits your server.'
          : 'Text for ideas. Voice for presence.'
      }
      onClose={onClose}
      width={480}
    >
      <form className="auth-form" onSubmit={submit}>
        <div className="channel-type-picker">
          <button
            type="button"
            className={`channel-type ${type === 'text' ? 'active' : ''}`}
            onClick={() => setType('text')}
          >
            <Hash size={20} />
            <span>
              <strong>Text</strong>
              <small>Messages & files</small>
            </span>
          </button>
          <button
            type="button"
            className={`channel-type ${type === 'voice' ? 'active' : ''}`}
            onClick={() => setType('voice')}
          >
            <Volume2 size={20} />
            <span>
              <strong>Voice</strong>
              <small>Talk & screenshare</small>
            </span>
          </button>
          <button
            type="button"
            className={`channel-type ${type === 'stage' ? 'active' : ''}`}
            onClick={() => setType('stage')}
          >
            <Radio size={20} />
            <span>
              <strong>Stage</strong>
              <small>Voice channel where only speakers talk</small>
            </span>
          </button>
          <button
            type="button"
            className={`channel-type ${type === 'forum' ? 'active' : ''}`}
            onClick={() => setType('forum')}
          >
            <MessagesSquare size={20} />
            <span>
              <strong>Forum</strong>
              <small>Organised posts</small>
            </span>
          </button>
          <button
            type="button"
            className={`channel-type ${type === 'media' ? 'active' : ''}`}
            onClick={() => setType('media')}
          >
            <Image size={20} />
            <span>
              <strong>Gallery</strong>
              <small>Only the pictures and files</small>
            </span>
          </button>
          <button
            type="button"
            className={`channel-type ${type === 'docs' ? 'active' : ''}`}
            onClick={() => setType('docs')}
          >
            <FileText size={20} />
            <span>
              <strong>Docs</strong>
              <small>Pages you write together</small>
            </span>
          </button>
          <button
            type="button"
            className={`channel-type ${type === 'list' ? 'active' : ''}`}
            onClick={() => setType('list')}
          >
            <ListChecks size={20} />
            <span>
              <strong>Lists</strong>
              <small>Shared checklists</small>
            </span>
          </button>
          <button
            type="button"
            className={`channel-type ${type === 'calendar' ? 'active' : ''}`}
            onClick={() => setType('calendar')}
          >
            <CalendarDays size={20} />
            <span>
              <strong>Calendar</strong>
              <small>Events people can join</small>
            </span>
          </button>
          <button
            type="button"
            className={`channel-type ${isCategory ? 'active' : ''}`}
            onClick={() => setType('category')}
          >
            <FolderPlus size={20} />
            <span>
              <strong>Category</strong>
              <small>Group channels</small>
            </span>
          </button>
        </div>

        <label className="field">
          <span>{isCategory ? 'Category name' : 'Channel name'}</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={
              isCategory
                ? 'Project space'
                : type === 'text'
                  ? 'deep-space'
                  : type === 'forum'
                    ? 'show-and-tell'
                    : type === 'stage'
                      ? 'main-stage'
                      : 'the-observatory'
            }
            autoFocus
            maxLength={isCategory ? 48 : 32}
            required
          />
        </label>

        {!isCategory && (
          <label className="field">
            <span>Category</span>
            <select
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
            >
              <option value="">No category</option>
              {categories.map((category) => (
                <option value={category.id} key={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {error && <div className="form-error">{error}</div>}

        <button className="btn btn-primary" disabled={busy}>
          {busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
          {isCategory ? 'Create category' : 'Create channel'}
        </button>
      </form>
    </Modal>
  );
}
