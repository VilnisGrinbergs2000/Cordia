import { Download, Share, X } from 'lucide-react';
import { useState } from 'react';
import Modal from './Modal';
import { usePwaInstall } from '../pwa';

export default function PwaPrompt() {
  const { visible, ios, install, dismiss } = usePwaInstall();
  const [showIosSteps, setShowIosSteps] = useState(false);

  if (!visible) return null;

  async function handleInstall() {
    if (ios) {
      setShowIosSteps(true);
      return;
    }
    await install();
  }

  return (
    <>
      <div className="pwa-prompt" role="region" aria-label="Install Cordia">
        <span className="pwa-prompt-icon">
          <Download size={17} />
        </span>
        <div className="pwa-prompt-copy">
          <strong>Install Cordia</strong>
          <span>
            {ios
              ? 'Add Cordia to your Home Screen for a full-screen app.'
              : 'Launch Cordia like an app, with a faster offline-ready shell.'}
          </span>
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={handleInstall}>
          {ios ? 'How' : 'Install'}
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Dismiss install prompt"
          onClick={dismiss}
        >
          <X size={15} />
        </button>
      </div>

      {showIosSteps && (
        <Modal
          title="Install Cordia"
          subtitle="Safari on iPhone or iPad"
          onClose={() => setShowIosSteps(false)}
          width={420}
          footer={
            <div className="settings-footer-right">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => {
                  setShowIosSteps(false);
                  dismiss();
                }}
              >
                Got it
              </button>
            </div>
          }
        >
          <ol className="pwa-steps">
            <li>
              Tap the <Share size={14} aria-hidden="true" /> Share button in Safari.
            </li>
            <li>
              Choose <strong>Add to Home Screen</strong>.
            </li>
            <li>
              Tap <strong>Add</strong>.
            </li>
          </ol>
        </Modal>
      )}
    </>
  );
}
