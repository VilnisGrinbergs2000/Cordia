import { useState } from 'react';
import { Check, Copy, Link2 } from 'lucide-react';
import { inviteLink } from '../utils';
import Markdown from './Markdown';
import Modal from './Modal';

export default function InviteModal({ server, onClose }) {
  const [copied, setCopied] = useState(false);
  const link = inviteLink(server.inviteCode);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Modal
      title={`Invite people to ${server.name}`}
      subtitle="Share this link with friends. Anyone with it can join."
      onClose={onClose}
      width={480}
    >
      {server.description && (
        <div className="invite-description">
          <Markdown className="md-prose" text={server.description} meUsername="" />
        </div>
      )}
      <div className="invite-visual">
        <div className="invite-orbit" aria-hidden="true">
          <Link2 size={30} />
        </div>
        <div style={{ minWidth: 0 }}>
          <span className="settings-label">Invite link</span>
          <div
            className="invite-code-large"
            style={{ fontSize: 14, letterSpacing: 0, overflowWrap: 'anywhere' }}
          >
            {link}
          </div>
        </div>
      </div>
      <button className="btn btn-primary invite-copy" onClick={copy}>
        {copied ? <Check size={16} /> : <Copy size={16} />}
        {copied ? 'Copied to clipboard' : 'Copy invite link'}
      </button>
      <p className="invite-note">
        Server admins can reset the link anytime from server settings.
      </p>
    </Modal>
  );
}
