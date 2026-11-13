import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Crown,
  Download,
  FileJson,
  Loader2,
  ShieldCheck,
  Upload
} from 'lucide-react';
import api from '../api';
import Avatar from './Avatar';
import Modal from './Modal';
import Toast from './Toast';

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function countLabel(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export default function ServerDataSettings({ server, me, canExport, canImport, onUpdated }) {
  const [includeMessages, setIncludeMessages] = useState(true);
  const [files, setFiles] = useState([]);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // Fallback only: the panel hands us the signed-in user, so this lookup runs
  // just when a caller forgets the prop.
  const [meFallback, setMeFallback] = useState(null);
  const [meError, setMeError] = useState('');
  const [meAttempt, setMeAttempt] = useState(0);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferMembers, setTransferMembers] = useState(null);
  const [transferTarget, setTransferTarget] = useState(null);
  const [transferConfirm, setTransferConfirm] = useState('');
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferError, setTransferError] = useState('');
  const [toast, setToast] = useState(null);
  const inputRef = useRef(null);
  const viewer = me || meFallback;
  const isOwner = !!viewer && server.ownerId === viewer.id;

  useEffect(() => {
    if (me) return undefined;
    let cancelled = false;
    setMeError('');
    api
      .get('/api/users/me')
      .then((data) => {
        if (!cancelled) setMeFallback(data.user);
      })
      .catch((err) => {
        // Swallowing this used to leave the real owner with a disabled button
        // and the not-owner copy. Surface it so the card can offer a retry.
        if (!cancelled) setMeError(err?.message || 'Could not confirm your account.');
      });
    return () => {
      cancelled = true;
    };
  }, [me, meAttempt]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(timer);
  }, [toast]);

  async function openTransfer() {
    setTransferOpen(true);
    setTransferMembers(null);
    setTransferTarget(null);
    setTransferConfirm('');
    setTransferError('');
    try {
      // Fresh member list, straight from the server: the picker must never
      // offer someone who has left since this panel was opened.
      const data = await api.get(`/api/servers/${server.id}`);
      setTransferMembers(
        (data.server.members || []).filter((member) => member.id !== viewer?.id)
      );
    } catch (err) {
      setTransferOpen(false);
      setToast({ type: 'error', title: 'Could not load members', message: err.message });
    }
  }

  async function submitTransfer() {
    if (!transferTarget) return;
    setTransferBusy(true);
    setTransferError('');
    try {
      const data = await api.post(`/api/servers/${server.id}/transfer`, {
        userId: transferTarget.id
      });
      setTransferOpen(false);
      onUpdated(data.server);
      setToast({
        type: 'success',
        title: 'Ownership transferred',
        message: `${transferTarget.displayName} now owns ${server.name}.`
      });
    } catch (err) {
      setTransferError(err.message);
      setToast({
        type: 'error',
        title: err.status === 403 ? 'Transfer blocked' : 'Could not transfer',
        message: err.message
      });
    } finally {
      setTransferBusy(false);
    }
  }

  function chooseFiles(event) {
    const next = Array.from(event.target.files || []);
    event.target.value = '';
    setFiles(next);
    setPreview(null);
    setError('');
    setSuccess('');
  }

  function clearFiles() {
    setFiles([]);
    setPreview(null);
    setError('');
    setSuccess('');
    if (inputRef.current) inputRef.current.value = '';
  }

  async function exportData() {
    if (!canExport) return;
    setBusy('export');
    setError('');
    setSuccess('');
    try {
      const { blob, filename } = await api.download(
        `/api/servers/${server.id}/export?messages=${includeMessages ? '1' : '0'}`
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setSuccess('Server export downloaded.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function previewImport() {
    if (!canImport) return;
    if (!files.length) {
      setError('Choose at least one JSON export file.');
      return;
    }
    setBusy('preview');
    setError('');
    setSuccess('');
    try {
      const data = await api.uploadFiles(`/api/servers/${server.id}/import/preview`, files);
      setPreview(data.plan);
    } catch (err) {
      setPreview(null);
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function applyImport() {
    if (!canImport) return;
    if (!files.length) {
      setError('Choose at least one JSON export file.');
      return;
    }
    setBusy('import');
    setError('');
    setSuccess('');
    try {
      const data = await api.uploadFiles(`/api/servers/${server.id}/import`, files);
      setPreview(null);
      onUpdated(data.server);
      setFiles([]);
      if (inputRef.current) inputRef.current.value = '';
      const imported = data.imported;
      setSuccess(
        `Imported ${countLabel(imported.categories, 'category', 'categories')}, ${countLabel(
          imported.channels,
          'channel',
          'channels'
        )}, ${countLabel(imported.groups, 'group', 'groups')}, ${countLabel(
          imported.emotes,
          'emote',
          'emotes'
        )}, and ${countLabel(imported.messages, 'message', 'messages')}.`
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="server-data-settings">
      <div className="settings-section-head">
        <div>
          <h3>Import and export</h3>
          <p>Move a community into Cordia or take a portable copy with you.</p>
        </div>
        <ShieldCheck size={20} className="server-data-shield" />
      </div>

      {error && <div className="form-error">{error}</div>}
      {success && <div className="form-success">{success}</div>}

      <div className="server-data-grid">
        <section className="server-data-card">
          <div className="server-data-card-head">
            <span className="server-data-icon">
              <Download size={18} />
            </span>
            <div>
              <h4>Export server</h4>
              <p>Download categories, channels, groups, and messages as a Cordia JSON file.</p>
            </div>
          </div>

          <label className="server-data-option">
            <input
              type="checkbox"
              checked={includeMessages}
              onChange={(event) => setIncludeMessages(event.target.checked)}
              disabled={!canExport || busy === 'export'}
            />
            <span>
              <strong>Include message history</strong>
              <small>Message content, timestamps, and Cordia-hosted attachments.</small>
            </span>
          </label>

          <div className="server-data-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={exportData}
              disabled={!canExport || busy === 'export'}
            >
              {busy === 'export' ? <Loader2 size={15} className="spin" /> : <Download size={15} />}
              Export JSON
            </button>
            {!canExport && <small className="field-hint">Requires Manage server.</small>}
          </div>
        </section>

        <section className="server-data-card">
          <div className="server-data-card-head">
            <span className="server-data-icon">
              <Upload size={18} />
            </span>
            <div>
              <h4>Import server data</h4>
              <p>
                Bring in a Cordia export, or Discord guild.json, channels.json, and roles.json.
              </p>
            </div>
          </div>

          <label className={`server-data-drop ${!canImport ? 'disabled' : ''}`}>
            <FileJson size={20} />
            <span>
              <strong>{files.length ? 'Choose different files' : 'Choose JSON files'}</strong>
              <small>Up to 8 files, 20 MB each. Existing names are skipped.</small>
            </span>
            <input
              ref={inputRef}
              type="file"
              accept=".json,application/json"
              multiple
              onChange={chooseFiles}
              disabled={!canImport || busy === 'preview' || busy === 'import'}
            />
          </label>

          {files.length > 0 && (
            <div className="server-data-files">
              {files.map((file) => (
                <span className="server-data-file" key={`${file.name}-${file.size}`}>
                  <FileJson size={13} />
                  <span>{file.name}</span>
                  <small>{formatBytes(file.size)}</small>
                </span>
              ))}
              <button type="button" className="server-data-clear" onClick={clearFiles}>
                Clear
              </button>
            </div>
          )}

          <div className="server-data-actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={previewImport}
              disabled={!canImport || !files.length || busy === 'preview' || busy === 'import'}
            >
              {busy === 'preview' ? <Loader2 size={15} className="spin" /> : <FileJson size={15} />}
              Preview
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={applyImport}
              disabled={
                !canImport || !files.length || !preview?.hasChanges || busy === 'preview' || busy === 'import'
              }
            >
              {busy === 'import' ? <Loader2 size={15} className="spin" /> : <Upload size={15} />}
              Import
            </button>
          </div>
          {!canImport && (
            <small className="field-hint">Only server owners and admins can import data.</small>
          )}
        </section>
      </div>

      {preview && (
        <section className="server-data-plan">
          <div className="server-data-plan-head">
            <div>
              <h4>Import preview</h4>
              <p>
                From {preview.source === 'discord' ? 'Discord' : 'Cordia'}
                {preview.sourceName ? `: ${preview.sourceName}` : ''}
              </p>
            </div>
            <span className={`server-data-status ${preview.hasChanges ? 'ready' : 'empty'}`}>
              {preview.hasChanges ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
              {preview.hasChanges ? 'Ready to import' : 'Nothing new to import'}
            </span>
          </div>

          <div className="server-data-counts">
            <span>
              <strong>{preview.counts.categories.create}</strong>
              categories
              <small>{preview.counts.categories.skip} skipped</small>
            </span>
            <span>
              <strong>{preview.counts.channels.create}</strong>
              channels
              <small>{preview.counts.channels.skip} skipped</small>
            </span>
            <span>
              <strong>{preview.counts.groups.create}</strong>
              groups
              <small>{preview.counts.groups.skip} skipped</small>
            </span>
            <span>
              <strong>{preview.counts.emotes.create}</strong>
              emotes
              <small>{preview.counts.emotes.skip} skipped</small>
            </span>
            <span>
              <strong>{preview.counts.messages.create}</strong>
              messages
              <small>{preview.counts.messages.skip} skipped</small>
            </span>
          </div>

          {preview.warnings.length > 0 && (
            <div className="server-data-warnings">
              <div className="server-data-warnings-head">
                <AlertTriangle size={14} />
                {preview.warningsTotal > preview.warnings.length
                  ? `Showing ${preview.warnings.length} of ${preview.warningsTotal} notes`
                  : 'Import notes'}
              </div>
              <ul>
                {preview.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
      <div className="danger-zone">
        <div>
          <h4>Transfer ownership</h4>
          <p>
            {isOwner ? (
              'Hand this server to another member. They get full control and you stay behind as an admin.'
            ) : viewer ? (
              'Only the current owner can transfer this server.'
            ) : meError ? (
              <>
                Could not confirm your account, so transfer is unavailable.{' '}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setMeAttempt((attempt) => attempt + 1)}
                >
                  Retry
                </button>
              </>
            ) : (
              'Checking your role…'
            )}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-danger btn-sm"
          onClick={openTransfer}
          disabled={!isOwner}
        >
          <Crown size={15} /> Transfer ownership
        </button>
      </div>

      {transferOpen && (
        <Modal
          title="Transfer ownership"
          subtitle={'Choose a member of ' + server.name + '. They must already be in the server.'}
          width={440}
          onClose={() => !transferBusy && setTransferOpen(false)}
          footer={
            <>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setTransferOpen(false)}
                disabled={transferBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={submitTransfer}
                disabled={transferBusy || !transferTarget || transferConfirm.trim() !== server.name}
              >
                {transferBusy ? <Loader2 size={15} className="spin" /> : <Crown size={15} />}
                Transfer
              </button>
            </>
          }
        >
          {transferError && <div className="form-error">{transferError}</div>}
          {!transferMembers ? (
            <p className="field-hint">
              <Loader2 size={14} className="spin" /> Loading members...
            </p>
          ) : transferMembers.length === 0 ? (
            <p className="field-hint">This server has no other members yet. Invite someone first.</p>
          ) : (
            <div className="server-members-admin">
              {transferMembers.map((member) => (
                <label className="member-admin-row" key={member.id}>
                  <input
                    type="radio"
                    name="transfer-target"
                    checked={transferTarget?.id === member.id}
                    onChange={() => {
                      setTransferTarget(member);
                      setTransferConfirm('');
                    }}
                  />
                  <Avatar user={member} size={28} />
                  <span className="member-admin-meta">
                    <strong>{member.displayName}</strong>
                    <small>@{member.username}</small>
                  </span>
                </label>
              ))}
            </div>
          )}
          {transferTarget && (
            <label className="field">
              <span>Type {server.name} to confirm</span>
              <input
                value={transferConfirm}
                onChange={(event) => setTransferConfirm(event.target.value)}
                placeholder={server.name}
              />
            </label>
          )}
        </Modal>
      )}
      <Toast toast={toast} />
    </div>
  );
}
