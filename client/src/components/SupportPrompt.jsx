import Modal from './Modal';

// The launch-time version of the tip jar. It is a card, not an interstitial:
// one screen, one QR, and a way to say "never again" that is as easy to reach
// as the close button.
//
// The code is 300px for a reason. This QR is 81 modules across, so anything
// under about 250px puts it below 3 device pixels per module and phone cameras
// stop reading it off a screen. Size is a correctness property here.
export default function SupportPrompt({ onClose, onNever }) {
  return (
    <Modal
      className="support-prompt-modal"
      width={520}
      title="Cordia is free"
      subtitle="Funded by the people who use it"
      onClose={onClose}
      ariaLabel="Support Cordia"
      footer={
        <div className="support-prompt-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onNever}>
            Don't show this again
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Not now
          </button>
        </div>
      }
    >
      <div className="support-prompt-body">
        <img className="support-prompt-codi" src="/codi.png" alt="" aria-hidden="true" />
        <div className="support-prompt-copy">
          <strong>No plan, no ads, no catch.</strong>
          <p>
            Hosting and bandwidth are the only two bills Cordia has. If it has been useful to you,
            a one-off tip pays a little of them - and nothing changes about your account if you
            would rather not.
          </p>
        </div>
      </div>
      <div className="support-prompt-qr">
        <img src="/support-qr.png" alt="Buy Me a Coffee QR code" width={300} height={300} />
        <span>Scan with your phone camera</span>
      </div>
    </Modal>
  );
}
