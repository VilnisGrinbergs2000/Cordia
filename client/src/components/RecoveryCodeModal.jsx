import { useState } from 'react';
import { Check, Copy, Download, KeyRound, Loader2, ShieldAlert } from 'lucide-react';
import Modal from './Modal';

export default function RecoveryCodeModal({
  code,
  title = 'Save your recovery code',
  subtitle = 'This is the only time this code will be shown.',
  confirmLabel = 'I saved my code',
  cancelLabel = 'Later',
  onConfirm,
  onClose,
  canCancel = false,
  busy = false,
  error = ''
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');

  async function copyCode() {
    setCopyError('');
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = code;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      } catch {
        setCopyError('Could not copy the code. Select it and copy it manually.');
      }
    }
  }

  function downloadCode() {
    const contents = [
      'Cordia recovery code',
      '',
      'Keep this code offline. It can restore your encrypted messages if you forget your password.',
      'Anyone with this code and access to your account can read your encrypted messages.',
      '',
      code,
      ''
    ].join('\n');
    const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'cordia-recovery-code.txt';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      hideClose={!canCancel}
      width={540}
      footer={
        <div className="e2ee-modal-actions">
          {canCancel && (
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
              {cancelLabel}
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            onClick={onConfirm}
            disabled={!saved || busy}
          >
            {busy ? <Loader2 size={16} className="spin" /> : <KeyRound size={16} />}
            {confirmLabel}
          </button>
        </div>
      }
    >
      <div className="recovery-setup">
        <div className="e2ee-modal-badge">
          <ShieldAlert size={20} />
          <div>
            <strong>Password recovery is now available</strong>
            <span>
              This code unwraps your encryption key locally. The server only stores an encrypted
              backup.
            </span>
          </div>
        </div>

        <div className="recovery-code-box">
          <div className="recovery-code-value">
            <code>{code}</code>
            <button
              type="button"
              className="icon-btn"
              title={copied ? 'Copied' : 'Copy recovery code'}
              onClick={copyCode}
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
            <button
              type="button"
              className="icon-btn"
              title="Download recovery code"
              onClick={downloadCode}
            >
              <Download size={16} />
            </button>
          </div>
          <p>Store this code offline. It will not be shown again after you continue.</p>
        </div>

        <label className="recovery-save-check">
          <input
            type="checkbox"
            checked={saved}
            onChange={(event) => setSaved(event.target.checked)}
          />
          <span>I saved this recovery code somewhere safe.</span>
        </label>

        <p className="e2ee-modal-note">
          If you lose both your password and this code, your encrypted message history cannot be
          recovered.
        </p>

        {copyError && <div className="form-error">{copyError}</div>}
        {error && <div className="form-error">{error}</div>}
      </div>
    </Modal>
  );
}
