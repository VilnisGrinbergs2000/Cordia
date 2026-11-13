import { Heart } from 'lucide-react';

// Cordia is free and funded by donations, so this tab is not a paywall: it is
// the one place that says how to help pay for the servers. The QR is a static
// asset, so opening the tab costs one cached image and nothing else.
export default function SupportSettings() {
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <div>
          <h1>Support Cordia</h1>
          <p>
            Cordia is free, and it stays free - every feature, every account, no ads and no
            trial. If you want to help with the hosting bill, this is how.
          </p>
        </div>
      </div>

      <div className="settings-group support-card">
        <div className="support-qr">
          <img src="/support-qr.png" alt="Buy Me a Coffee QR code" width={184} height={184} />
        </div>
        <div className="support-copy">
          <span className="settings-label">
            <Heart size={13} /> Buy me a coffee
          </span>
          <h3>Scan it with your phone</h3>
          <p>
            The code opens a page where you can leave a one-off tip of whatever size you like.
            Nothing about your account changes: no plan, no card on file, nothing to cancel.
          </p>
          <p className="support-fine-print">
            Everyone who chips in gets the Supporter badge on their profile. Badges are handed
            out by hand, so it can take a day or two.
          </p>
        </div>
      </div>
    </section>
  );
}
