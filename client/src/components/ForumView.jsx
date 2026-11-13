import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Info,
  Loader2,
  MessagesSquare,
  Pencil,
  Pin,
  Plus,
  Settings2,
  Tag,
  Trash2
} from 'lucide-react';
import Avatar from './Avatar';
import Markdown from './Markdown';
import Modal from './Modal';
import api from '../api';
import { formatDay } from '../utils';

// Tags carry a colour, but the colour is an accent rather than the whole pill:
// the stylesheet tints the background and border from this variable and keeps
// the label in body colour, so a pale yellow tag is still readable.
function tagStyle(tag) {
  return { '--tag-color': tag.color };
}

// A forum is a channel whose "messages" are threads. The list below is just the
// thread channels whose parent is this channel, so there is no second store.
export default function ForumView({
  channel,
  server,
  me,
  posts,
  canPost,
  canManage,
  onOpenPost,
  onCreatePost,
  onTogglePin,
  onSaveGuidelines,
  onTagsChanged,
  onBackToList
}) {
  const [composing, setComposing] = useState(false);
  const [editingRules, setEditingRules] = useState(false);
  const [rules, setRules] = useState(channel.guidelines || '');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [tags, setTags] = useState([]);
  const [tagFilter, setTagFilter] = useState(null);
  const [selectedTagIds, setSelectedTagIds] = useState([]);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [tagDraftName, setTagDraftName] = useState('');
  const [tagDraftColor, setTagDraftColor] = useState('#6d5efc');
  const [tagBusy, setTagBusy] = useState('');
  const [tagError, setTagError] = useState('');
  const [tagEditorPost, setTagEditorPost] = useState(null);
  const [tagEditorIds, setTagEditorIds] = useState([]);
  const [tagEditorError, setTagEditorError] = useState('');
  const [tagSaving, setTagSaving] = useState(false);

  useEffect(() => {
    setRules(channel.guidelines || '');
  }, [channel.id, channel.guidelines]);

  useEffect(() => {
    let cancelled = false;
    setTags([]);
    setTagFilter(null);
    setSelectedTagIds([]);
    setTagManagerOpen(false);
    setTagError('');
    setTagEditorPost(null);
    setTagEditorIds([]);
    setTagEditorError('');
    api
      .get(`/api/channels/${channel.id}/tags`)
      .then((payload) => {
        if (!cancelled) setTags(payload?.tags || []);
      })
      .catch(() => {
        if (!cancelled) setTags([]);
      });
    return () => {
      cancelled = true;
    };
  }, [channel.id]);

  const authors = useMemo(() => {
    const map = {};
    for (const member of server?.members || []) map[member.id] = member;
    return map;
  }, [server]);

  const tagCounts = useMemo(() => {
    const counts = new Map();
    for (const post of posts) {
      for (const tag of post.tags || []) counts.set(tag.id, (counts.get(tag.id) || 0) + 1);
    }
    return counts;
  }, [posts]);

  // Pinned posts stay on top, everything else sorts by activity.
  const { pinned, rest, count } = useMemo(() => {
    const byActivity = (a, b) =>
      (b.lastMessageAt || b.createdAt) - (a.lastMessageAt || a.createdAt);
    const filtered = tagFilter
      ? posts.filter((post) => (post.tags || []).some((tag) => tag.id === tagFilter))
      : posts;
    const all = [...filtered].sort(byActivity);
    return {
      pinned: all.filter((post) => post.pinned),
      rest: all.filter((post) => !post.pinned),
      count: all.length
    };
  }, [posts, tagFilter]);

  function openCompose() {
    setSelectedTagIds([]);
    setError('');
    setComposing(true);
  }

  function close() {
    if (saving) return;
    setComposing(false);
    setSelectedTagIds([]);
    setError('');
  }

  function toggleSelectedTag(tagId) {
    setSelectedTagIds((current) => {
      if (current.includes(tagId)) return current.filter((id) => id !== tagId);
      if (current.length >= 5) {
        setError('Pick up to 5 tags.');
        return current;
      }
      setError('');
      return [...current, tagId];
    });
  }

  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    if (!title.trim()) return setError('Give the post a title.');
    if (!body.trim()) return setError('Write something in the post.');
    setSaving(true);
    setError('');
    try {
      await onCreatePost({ title: title.trim(), content: body.trim(), tagIds: selectedTagIds });
      setComposing(false);
      setTitle('');
      setBody('');
      setSelectedTagIds([]);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function saveRules(event) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      await onSaveGuidelines(rules.trim());
      setEditingRules(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function closeTagManager() {
    if (tagBusy) return;
    setTagManagerOpen(false);
    setTagError('');
  }

  async function createTag(event) {
    event.preventDefault();
    if (tagBusy) return;
    const name = tagDraftName.trim();
    if (!name) return setTagError('Give the tag a name.');
    setTagBusy('create');
    setTagError('');
    try {
      const payload = await api.post(`/api/channels/${channel.id}/tags`, {
        name,
        color: tagDraftColor
      });
      setTags((current) => [...current, payload.tag]);
      setTagDraftName('');
      onTagsChanged?.();
    } catch (err) {
      setTagError(err.message);
    } finally {
      setTagBusy('');
    }
  }

  async function renameTag(tag) {
    if (tagBusy) return;
    const next = window.prompt(`Rename "${tag.name}"`, tag.name);
    if (next === null) return;
    const name = next.trim();
    if (!name || name === tag.name) return;
    setTagBusy(`rename-${tag.id}`);
    setTagError('');
    try {
      const payload = await api.patch(`/api/tags/${tag.id}`, { name });
      setTags((current) => current.map((item) => (item.id === tag.id ? payload.tag : item)));
      onTagsChanged?.();
    } catch (err) {
      setTagError(err.message);
    } finally {
      setTagBusy('');
    }
  }

  // The whole order goes up in one request, so the optimistic swap is also the
  // payload. A failure restores the snapshot rather than leaving the bar and the
  // database disagreeing.
  async function moveTag(tag, delta) {
    if (tagBusy) return;
    const index = tags.findIndex((item) => item.id === tag.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= tags.length) return;
    const previous = tags;
    const ordered = [...tags];
    [ordered[index], ordered[target]] = [ordered[target], ordered[index]];
    setTags(ordered);
    setTagBusy(`move-${tag.id}`);
    setTagError('');
    try {
      const payload = await api.post(`/api/channels/${channel.id}/tags/reorder`, {
        ids: ordered.map((item) => item.id)
      });
      setTags(payload.tags);
      onTagsChanged?.();
    } catch (err) {
      setTags(previous);
      setTagError(err.message);
    } finally {
      setTagBusy('');
    }
  }

  async function deleteTag(tag) {
    if (tagBusy) return;
    if (!window.confirm(`Delete the "${tag.name}" tag? Posts will keep their other tags.`)) {
      return;
    }
    setTagBusy(`delete-${tag.id}`);
    setTagError('');
    try {
      await api.del(`/api/tags/${tag.id}`);
      setTags((current) => current.filter((item) => item.id !== tag.id));
      setSelectedTagIds((current) => current.filter((id) => id !== tag.id));
      if (tagFilter === tag.id) setTagFilter(null);
      onTagsChanged?.();
    } catch (err) {
      setTagError(err.message);
    } finally {
      setTagBusy('');
    }
  }

  function openTagEditor(post) {
    setTagEditorPost(post);
    setTagEditorIds((post.tags || []).map((tag) => tag.id));
    setTagEditorError('');
  }

  function closeTagEditor() {
    if (tagSaving) return;
    setTagEditorPost(null);
    setTagEditorIds([]);
    setTagEditorError('');
  }

  function toggleEditorTag(tagId) {
    setTagEditorIds((current) => {
      if (current.includes(tagId)) return current.filter((id) => id !== tagId);
      if (current.length >= 5) {
        setTagEditorError('Pick up to 5 tags.');
        return current;
      }
      setTagEditorError('');
      return [...current, tagId];
    });
  }

  async function savePostTags(event) {
    event.preventDefault();
    if (tagSaving || !tagEditorPost) return;
    setTagSaving(true);
    setTagEditorError('');
    try {
      await api.patch(`/api/threads/${tagEditorPost.id}`, { tagIds: tagEditorIds });
      setTagEditorPost(null);
      setTagEditorIds([]);
      onTagsChanged?.();
    } catch (err) {
      setTagEditorError(err.message);
    } finally {
      setTagSaving(false);
    }
  }

  const canPin = (post) => !!onTogglePin && (canManage || post.ownerId === me?.id);
  const canEditTags = (post) =>
    tags.length > 0 && (canManage || post.ownerId === me?.id);

  function renderPost(post) {
    const author = authors[post.ownerId];
    return (
      <div className={`forum-post${post.pinned ? ' pinned' : ''}`} key={post.id}>
        <button className="forum-post-main" onClick={() => onOpenPost(post)}>
          <Avatar user={author || { displayName: 'Unknown' }} size={34} />
          <span className="forum-post-text">
            <strong>{post.name}</strong>
            <span className="forum-post-meta">
              <span>{author?.displayName || 'Unknown'}</span>
              <span className="forum-dot" />
              <span>
                {post.messageCount} {post.messageCount === 1 ? 'message' : 'messages'}
              </span>
              <span className="forum-dot" />
              <span>{formatDay(post.lastMessageAt || post.createdAt)}</span>
            </span>
            {post.tags?.length > 0 && (
              <span className="forum-post-tags">
                {post.tags.map((tag) => (
                  <span className="forum-post-tag" key={tag.id} style={tagStyle(tag)}>
                    {tag.name}
                  </span>
                ))}
              </span>
            )}
          </span>
        </button>
        {canEditTags(post) && (
          <button
            className="icon-btn forum-post-pin"
            title="Edit tags"
            aria-label="Edit tags"
            onClick={() => openTagEditor(post)}
          >
            <Tag size={14} />
          </button>
        )}
        {canPin(post) && (
          <button
            className={`icon-btn forum-post-pin${post.pinned ? ' active' : ''}`}
            title={post.pinned ? 'Unpin post' : 'Pin post'}
            aria-label={post.pinned ? 'Unpin post' : 'Pin post'}
            onClick={() => onTogglePin(post)}
          >
            <Pin size={14} />
          </button>
        )}
      </div>
    );
  }

  return (
    <section className="chat-view forum-view">
      <header className="chat-header">
        <button
          className="icon-btn chat-back"
          onClick={onBackToList}
          title="Back to channels"
          aria-label="Back to channels"
        >
          <ArrowLeft size={18} />
        </button>
        <div className="chat-title">
          <span className="chat-title-icon">
            <MessagesSquare size={19} />
          </span>
          <span className="chat-title-text">
            <strong>{channel.name}</strong>
            <small>
              Forum · {count} {count === 1 ? 'post' : 'posts'}
              {tagFilter ? ` of ${posts.length}` : ''}
            </small>
          </span>
        </div>
        <div className="chat-header-actions">
          {canManage && (
            <button
              className="icon-btn"
              onClick={() => {
                setRules(channel.guidelines || '');
                setEditingRules(true);
              }}
              title="Edit guidelines"
              aria-label="Edit guidelines"
            >
              <Settings2 size={17} />
            </button>
          )}
          {canPost && (
            <button className="btn btn-primary btn-sm" onClick={openCompose}>
              <Plus size={15} /> New post
            </button>
          )}
        </div>
      </header>

      <div className="forum-body">
        <div className="forum-inner">
          {channel.guidelines ? (
            <div className="forum-guidelines">
              <Info size={15} />
              <Markdown className="md-prose" text={channel.guidelines} meUsername="" />
            </div>
          ) : null}

          {(tags.length > 0 || canManage) && (
            <div className="forum-tag-bar" aria-label="Forum tags">
              <button
                className={`forum-tag-chip forum-tag-all${tagFilter === null ? ' active' : ''}`}
                onClick={() => setTagFilter(null)}
              >
                All
              </button>
              {tags.map((tag) => (
                <button
                  key={tag.id}
                  className={`forum-tag-chip${tagFilter === tag.id ? ' active' : ''}`}
                  style={tagStyle(tag)}
                  onClick={() => setTagFilter(tagFilter === tag.id ? null : tag.id)}
                >
                  {tag.name}
                  {tagCounts.get(tag.id) ? (
                    <span className="forum-tag-count">{tagCounts.get(tag.id)}</span>
                  ) : null}
                </button>
              ))}
              {canManage && (
                <button
                  className="forum-tag-manage"
                  onClick={() => {
                    setTagError('');
                    setTagManagerOpen(true);
                  }}
                >
                  <Tag size={13} /> {tags.length ? 'Manage' : 'Add tags'}
                </button>
              )}
            </div>
          )}

          {count === 0 ? (
            <div className="forum-empty">
              {posts.length === 0 ? <MessagesSquare size={30} /> : <Tag size={30} />}
              <h3>{posts.length === 0 ? 'No posts yet' : 'No posts with this tag'}</h3>
              <p>
                {posts.length === 0
                  ? `Start the first conversation in ${channel.name}.`
                  : 'Try another tag or show every post.'}
              </p>
              {posts.length === 0 && canPost ? (
                <button className="btn btn-primary btn-sm" onClick={openCompose}>
                  <Plus size={15} /> New post
                </button>
              ) : tagFilter !== null ? (
                <button className="btn btn-ghost btn-sm" onClick={() => setTagFilter(null)}>
                  Show all posts
                </button>
              ) : null}
            </div>
          ) : (
            <>
              {pinned.length > 0 && (
                <section className="forum-group">
                  <div className="forum-group-label">
                    <Pin size={11} /> Pinned
                  </div>
                  {pinned.map(renderPost)}
                </section>
              )}
              <section className="forum-group">
                {pinned.length > 0 && <div className="forum-group-label">All posts</div>}
                {rest.map(renderPost)}
              </section>
            </>
          )}
        </div>
      </div>

      {composing && (
        <Modal
          title="New post"
          subtitle={`Posting in #${channel.name}`}
          onClose={close}
          width={560}
        >
          <form className="auth-form" onSubmit={submit}>
            <label className="field">
              <span>Title</span>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="What is this about?"
                maxLength={80}
                autoFocus
              />
            </label>
            <label className="field">
              <span>Body</span>
              <textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder="Say more"
                rows={6}
                maxLength={4000}
              />
            </label>
            {tags.length > 0 && (
              <div className="field">
                <span>
                  Tags <small className="field-hint">Up to 5</small>
                </span>
                <div className="forum-tag-picker">
                  {tags.map((tag) => (
                    <button
                      type="button"
                      key={tag.id}
                      className={`forum-tag-chip${selectedTagIds.includes(tag.id) ? ' active' : ''}`}
                      style={tagStyle(tag)}
                      onClick={() => toggleSelectedTag(tag.id)}
                      disabled={saving}
                    >
                      {tag.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {error && <div className="form-error">{error}</div>}
            <div className="forum-modal-actions">
              <button type="button" className="btn btn-ghost" onClick={close} disabled={saving}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={saving}>
                {saving ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
                Post
              </button>
            </div>
          </form>
        </Modal>
      )}

      {editingRules && (
        <Modal
          title="Forum guidelines"
          subtitle={`Shown above every post in #${channel.name}`}
          onClose={() => setEditingRules(false)}
          width={520}
        >
          <form className="auth-form" onSubmit={saveRules}>
            <label className="field">
              <span>Guidelines</span>
              <textarea
                value={rules}
                onChange={(event) => setRules(event.target.value)}
                placeholder="Keep it on topic, no spoilers, credit the artist..."
                rows={6}
                maxLength={500}
                autoFocus
              />
              <small className="field-hint">{rules.length}/500</small>
            </label>
            {error && <div className="form-error">{error}</div>}
            <div className="forum-modal-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setEditingRules(false)}
                disabled={saving}
              >
                Cancel
              </button>
              <button className="btn btn-primary" disabled={saving}>
                {saving ? <Loader2 size={16} className="spin" /> : null}
                Save guidelines
              </button>
            </div>
          </form>
        </Modal>
      )}

      {tagManagerOpen && (
        <Modal
          title="Forum tags"
          subtitle={`Organize posts in #${channel.name}`}
          onClose={closeTagManager}
          width={480}
        >
          <div className="forum-tag-manager">
            {tags.length === 0 ? (
              <p className="field-hint">No tags yet. Add one below.</p>
            ) : (
              <div className="forum-tag-manager-list">
                {tags.map((tag) => (
                  <div className="forum-tag-manager-row" key={tag.id}>
                    <span className="forum-post-tag" style={tagStyle(tag)}>
                      {tag.name}
                    </span>
                    <span className="forum-tag-manager-actions">
                      <button
                        className="icon-btn"
                        title={`Move ${tag.name} up`}
                        aria-label={`Move ${tag.name} up`}
                        onClick={() => moveTag(tag, -1)}
                        disabled={!!tagBusy || tags[0]?.id === tag.id}
                      >
                        <ChevronUp size={14} />
                      </button>
                      <button
                        className="icon-btn"
                        title={`Move ${tag.name} down`}
                        aria-label={`Move ${tag.name} down`}
                        onClick={() => moveTag(tag, 1)}
                        disabled={!!tagBusy || tags[tags.length - 1]?.id === tag.id}
                      >
                        <ChevronDown size={14} />
                      </button>
                      <button
                        className="icon-btn"
                        title={`Rename ${tag.name}`}
                        aria-label={`Rename ${tag.name}`}
                        onClick={() => renameTag(tag)}
                        disabled={!!tagBusy}
                      >
                        {tagBusy === `rename-${tag.id}` ? (
                          <Loader2 size={14} className="spin" />
                        ) : (
                          <Pencil size={14} />
                        )}
                      </button>
                      <button
                        className="icon-btn danger-hover"
                        title={`Delete ${tag.name}`}
                        aria-label={`Delete ${tag.name}`}
                        onClick={() => deleteTag(tag)}
                        disabled={!!tagBusy}
                      >
                        {tagBusy === `delete-${tag.id}` ? (
                          <Loader2 size={14} className="spin" />
                        ) : (
                          <Trash2 size={14} />
                        )}
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            )}
            <form className="forum-tag-form" onSubmit={createTag}>
              <input
                className="forum-tag-name-input"
                value={tagDraftName}
                onChange={(event) => setTagDraftName(event.target.value)}
                placeholder="New tag name"
                maxLength={24}
                disabled={!!tagBusy}
              />
              <input
                className="forum-tag-color-input"
                type="color"
                value={tagDraftColor}
                onChange={(event) => setTagDraftColor(event.target.value)}
                aria-label="New tag color"
                disabled={!!tagBusy}
              />
              <button
                className="btn btn-primary btn-sm"
                disabled={!!tagBusy || !tagDraftName.trim()}
              >
                {tagBusy === 'create' ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <Plus size={14} />
                )}
                Add
              </button>
            </form>
            {tagError && <div className="form-error">{tagError}</div>}
          </div>
        </Modal>
      )}

      {tagEditorPost && (
        <Modal
          title="Post tags"
          subtitle={tagEditorPost.name}
          onClose={closeTagEditor}
          width={460}
        >
          <form className="auth-form" onSubmit={savePostTags}>
            <div className="field">
              <span>
                Tags <small className="field-hint">Up to 5</small>
              </span>
              <div className="forum-tag-picker">
                {tags.map((tag) => (
                  <button
                    type="button"
                    key={tag.id}
                    className={`forum-tag-chip${tagEditorIds.includes(tag.id) ? ' active' : ''}`}
                    style={tagStyle(tag)}
                    onClick={() => toggleEditorTag(tag.id)}
                    disabled={tagSaving}
                  >
                    {tag.name}
                  </button>
                ))}
              </div>
            </div>
            {tagEditorError && <div className="form-error">{tagEditorError}</div>}
            <div className="forum-modal-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={closeTagEditor}
                disabled={tagSaving}
              >
                Cancel
              </button>
              <button className="btn btn-primary" disabled={tagSaving}>
                {tagSaving ? <Loader2 size={16} className="spin" /> : <Tag size={16} />}
                Save tags
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
