import { useRef, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import Markdown from './Markdown';
import Modal from './Modal';

function ruleText(rule) {
  if (typeof rule === 'string') return rule.trim();
  if (!rule || typeof rule !== 'object') return '';
  return String(rule.text || rule.body || rule.title || rule.label || '').trim();
}

// The onboarding card a member sees the first time they open a server. The body
// goes through the same renderer as a message, which never turns text into raw
// HTML - so a manager can write headings and lists without being able to write
// markup.
export default function WelcomeScreen({ welcome, server, onDismiss }) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const rules = (welcome.rules || []).map(ruleText).filter(Boolean);
  const memberCount = server?.members?.length || 0;
  const channelCount = (server?.channels || []).filter((channel) => channel.type !== 'category').length;

  async function dismiss() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await onDismiss();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal
      className="welcome-modal"
      width={520}
      title={welcome.title || `Welcome to ${server?.name || 'the server'}`}
      subtitle={welcome.title ? server?.name : ''}
      onClose={dismiss}
      ariaLabel="Server welcome"
      footer={
        <div className="welcome-actions">
          <button className="btn btn-primary" onClick={dismiss} disabled={busy}>
            {busy ? <Loader2 size={15} className="spin" /> : <Sparkles size={15} />}
            {rules.length ? 'Got it' : "Let's go"}
          </button>
        </div>
      }
    >
      <div className="welcome-hero">
        {server?.banner ? (
          <img className="welcome-hero-banner" src={server.banner} alt="" aria-hidden="true" />
        ) : null}
        <div className="welcome-hero-row">
          <span
            className="welcome-hero-icon"
            style={{ background: server?.iconColor || 'var(--accent)' }}
          >
            {server?.iconUrl ? (
              <img src={server.iconUrl} alt="" />
            ) : (
              <span>{(server?.name || '?').slice(0, 1).toUpperCase()}</span>
            )}
          </span>
          <div className="welcome-hero-copy">
            <strong>{server?.name || 'This server'}</strong>
            <span>
              {memberCount} {memberCount === 1 ? 'member' : 'members'}
              {channelCount > 0 && ` · ${channelCount} channels`}
            </span>
          </div>
        </div>
      </div>

      {welcome.body ? (
        <div className="welcome-body">
          <Markdown className="md-prose" text={welcome.body} meUsername="" />
        </div>
      ) : (
        <p className="welcome-body welcome-body-muted">
          Take a look around - everything you need is in the sidebar.
        </p>
      )}
      {rules.length > 0 && (
        <div className="welcome-rules">
          <span className="settings-label">House rules</span>
          <ol>
            {rules.map((rule, index) => (
              <li key={`${index}-${rule}`}>{rule}</li>
            ))}
          </ol>
        </div>
      )}
    </Modal>
  );
}
