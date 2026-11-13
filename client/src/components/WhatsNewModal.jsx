import { Sparkles } from 'lucide-react';
import Modal from './Modal';
import { LATEST_RELEASE } from '../changelog';

export default function WhatsNewModal({ version, onClose, onSeeAll }) {
  const release = LATEST_RELEASE;
  return (
    <Modal
      title="What's new"
      subtitle={`Version ${version || release.version} · ${release.date}`}
      onClose={onClose}
      width={520}
      className="whats-new-modal"
      footer={
        <div className="whats-new-actions">
          {onSeeAll ? (
            <button className="btn btn-ghost" onClick={onSeeAll}>
              All release notes
            </button>
          ) : (
            <span />
          )}
          <button className="btn btn-primary" onClick={onClose}>
            Got it
          </button>
        </div>
      }
    >
      <div className="whats-new-head">
        <span className="whats-new-icon">
          <Sparkles size={18} />
        </span>
        <strong>{release.title}</strong>
      </div>
      <ul className="whats-new-list">
        {release.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </Modal>
  );
}
