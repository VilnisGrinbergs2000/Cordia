import { useEffect, useState } from 'react';
import { Eye, FileText, Loader2, Pencil, Plus, Save, Trash2 } from 'lucide-react';
import api from '../api';
import Markdown from './Markdown';
import { formatDate } from '../utils';

// A channel of documents: a list on the left, an editor on the right. Saving
// keeps the previous version, the same rule messages follow.
export default function DocsView({ channel, canWrite, onBackToList }) {
  const [docs, setDocs] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  // Documents are read far more often than they are written, so an opened page
  // shows the rendered text and Write is the deliberate step.
  const [mode, setMode] = useState('read');

  useEffect(() => {
    let cancelled = false;
    api
      .get('/api/channels/' + channel.id + '/docs')
      .then((data) => {
        if (cancelled) return;
        setDocs(data.docs || []);
        if ((data.docs || []).length) {
          setActiveId(data.docs[0].id);
          setTitle(data.docs[0].title);
          setBody(data.docs[0].body);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message);
          setDocs([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [channel.id]);

  function open(doc) {
    setActiveId(doc.id);
    setTitle(doc.title);
    setBody(doc.body);
    setDirty(false);
    setError('');
    setMode('read');
  }

  async function create() {
    setBusy(true);
    setError('');
    try {
      const data = await api.post('/api/channels/' + channel.id + '/docs', {
        title: 'Untitled document',
        body: ''
      });
      const doc = data.doc;
      setDocs((list) => [doc, ...(list || [])]);
      open(doc);
      setDirty(true);
      setMode('write');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!activeId) return;
    setBusy(true);
    setError('');
    try {
      const data = await api.patch('/api/docs/' + activeId, { title, body });
      setDocs((list) => (list || []).map((doc) => (doc.id === activeId ? data.doc : doc)));
      setDirty(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!activeId) return;
    setBusy(true);
    try {
      await api.del('/api/docs/' + activeId);
      const next = (docs || []).filter((doc) => doc.id !== activeId);
      setDocs(next);
      if (next.length) open(next[0]);
      else {
        setActiveId(null);
        setTitle('');
        setBody('');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tool-view docs-view">
      <div className="tool-head">
        <div>
          <span className="eyebrow-mini">Documents</span>
          <h2>#{channel.name}</h2>
        </div>
        <div className="tool-head-actions">
          {canWrite && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={create} disabled={busy}>
              <Plus size={14} /> New document
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm mobile-only" onClick={onBackToList}>
            Back
          </button>
        </div>
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className="docs-layout">
        <div className="docs-list">
          {docs === null ? (
            <div className="tool-empty"><Loader2 size={16} className="spin" /> Loading…</div>
          ) : docs.length === 0 ? (
            <div className="tool-empty"><FileText size={18} /> No documents yet.</div>
          ) : (
            docs.map((doc) => (
              <button
                type="button"
                key={doc.id}
                className={'docs-row' + (doc.id === activeId ? ' active' : '')}
                onClick={() => open(doc)}
              >
                <FileText size={14} />
                <span>{doc.title}</span>
                <small>{formatDate(doc.updatedAt)}</small>
              </button>
            ))
          )}
        </div>

        <div className="docs-editor">
          {activeId ? (
            <>
              <div className="docs-title-row">
                <input
                  className="docs-title"
                  value={title}
                  maxLength={120}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    setDirty(true);
                  }}
                />
                <div className="docs-mode" role="group" aria-label="Document view">
                  <button
                    type="button"
                    className={mode === 'read' ? 'active' : ''}
                    onClick={() => setMode('read')}
                    aria-pressed={mode === 'read'}
                  >
                    <Eye size={13} /> Read
                  </button>
                  <button
                    type="button"
                    className={mode === 'write' ? 'active' : ''}
                    onClick={() => setMode('write')}
                    aria-pressed={mode === 'write'}
                  >
                    <Pencil size={13} /> Write
                  </button>
                </div>
              </div>
              {mode === 'write' ? (
                <textarea
                  className="docs-body"
                  value={body}
                  onChange={(event) => {
                    setBody(event.target.value);
                    setDirty(true);
                  }}
                  placeholder="Write the page. Markdown works: headings, bold, lists, code fences, quotes and links."
                />
              ) : body.trim() ? (
                <div className="docs-preview">
                  <Markdown className="md-prose" text={body} meUsername="" />
                </div>
              ) : (
                <div className="docs-preview docs-preview-empty">
                  This page is empty.
                  {canWrite && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMode('write')}>
                      <Pencil size={13} /> Start writing
                    </button>
                  )}
                </div>
              )}
              <div className="docs-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={save}
                  disabled={busy || !dirty}
                >
                  {busy ? <Loader2 size={14} className="spin" /> : <Save size={14} />} Save
                </button>
                <button type="button" className="icon-btn" onClick={remove} title="Delete document">
                  <Trash2 size={14} />
                </button>
                {dirty && <span className="docs-dirty">Unsaved changes</span>}
              </div>
            </>
          ) : (
            <div className="tool-empty"><FileText size={22} /> Pick a document, or make one.</div>
          )}
        </div>
      </div>
    </div>
  );
}
