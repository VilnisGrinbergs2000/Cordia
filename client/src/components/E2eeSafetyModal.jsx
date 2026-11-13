import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, Loader2, ShieldCheck } from 'lucide-react';
import api from '../api';
import Modal from './Modal';
import {
  checkE2eePin,
  fingerprintPublicKey,
  formatFingerprint,
  safetyNumber,
  setE2eePin,
  verifyKeyHistory
} from '../e2ee';

export default function E2eeSafetyModal({ me, peer, onClose, onVerified }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [safety, setSafety] = useState('');
  const [myFingerprint, setMyFingerprint] = useState('');
  const [peerFingerprint, setPeerFingerprint] = useState('');
  const [history, setHistory] = useState(null);
  const [chainOk, setChainOk] = useState(true);
  const [keyMismatch, setKeyMismatch] = useState(false);
  const [pinStatus, setPinStatus] = useState('unverified');
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!me?.e2eePublicKey || !peer?.e2eePublicKey) {
        setError('Both people need to set up encrypted messages before you can verify keys.');
        setLoading(false);
        return;
      }
      try {
        const data = await api.get(`/api/e2ee/users/${peer.id}/key-history`);
        const events = data.events || [];
        const latest = events[events.length - 1];
        const historyKey = data.publicKey || '';
        const historyVersion = Number(data.keyVersion) || 0;
        if (!historyKey) throw new Error('This contact has not published an encryption key.');
        const [mine, theirs, number] = await Promise.all([
          fingerprintPublicKey(me.e2eePublicKey),
          fingerprintPublicKey(historyKey),
          safetyNumber(me.id, me.e2eePublicKey, peer.id, historyKey)
        ]);
        if (cancelled) return;
        const validChain =
          events.length > 0 &&
          (await verifyKeyHistory(peer.id, events)) &&
          latest?.publicKey === historyKey &&
          Number(latest?.keyVersion) === historyVersion &&
          data.headHash === latest?.eventHash;
        const mismatch =
          historyKey !== peer.e2eePublicKey ||
          historyVersion !== Number(peer.e2eeKeyVersion);
        const status = checkE2eePin(me.id, peer.id, historyKey, historyVersion);
        if (status.pin?.headHash && data.headHash && status.pin.headHash !== data.headHash) {
          status.status = 'changed';
        }
        setMyFingerprint(mine);
        setPeerFingerprint(theirs);
        setSafety(number);
        setHistory({ ...data, publicKey: historyKey, keyVersion: historyVersion });
        setChainOk(validChain);
        setKeyMismatch(mismatch);
        setPinStatus(status.status);
      } catch (err) {
        if (!cancelled) setError(err.message || 'Could not load encryption keys.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [me?.id, me?.e2eePublicKey, peer?.id, peer?.e2eePublicKey, peer?.e2eeKeyVersion]);

  async function copyNumber() {
    try {
      await navigator.clipboard.writeText(safety);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError('Could not copy the safety number.');
    }
  }

  function verify() {
    if (!history || !confirmed || keyMismatch || !chainOk) return;
    setE2eePin(me.id, peer.id, {
      publicKey: history.publicKey,
      keyVersion: history.keyVersion,
      headHash: history.headHash
    });
    setPinStatus('verified');
    setConfirmed(false);
    onVerified?.();
  }

  return (
    <Modal
      title="Verify encryption"
      subtitle={`Compare this safety number with ${peer.displayName} over a call, in person, or another trusted channel.`}
      onClose={onClose}
      width={560}
      footer={
        <div className="e2ee-modal-actions">
          <button type="button" className="btn btn-ghost" onClick={copyNumber} disabled={!safety}>
            {copied ? <Check size={16} /> : <Copy size={16} />}
            {copied ? 'Copied' : 'Copy number'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={verify}
            disabled={!history || !confirmed || !chainOk || keyMismatch || pinStatus === 'verified'}
          >
            <ShieldCheck size={16} />
            {pinStatus === 'verified' ? 'Verified' : 'Mark as verified'}
          </button>
        </div>
      }
    >
      {loading ? (
        <div className="e2ee-safety-loading">
          <Loader2 size={20} className="spin" />
          <span>Loading key fingerprints...</span>
        </div>
      ) : error ? (
        <div className="form-error">{error}</div>
      ) : (
        <div className="e2ee-safety">
          <div className="e2ee-modal-badge">
            <ShieldCheck size={20} />
            <div>
              <strong>Safety number</strong>
              <span>
                If this matches on both devices, the server has not substituted either key.
              </span>
            </div>
          </div>

          {pinStatus === 'changed' && (
            <div className="e2ee-key-alert">
              <AlertTriangle size={18} />
              <div>
                <strong>Encryption key changed</strong>
                <span>
                  {peer.displayName} has a different key than the one you verified before. Verify
                  the new number before sending anything sensitive.
                </span>
              </div>
            </div>
          )}

          {!chainOk && (
            <div className="e2ee-key-alert">
              <AlertTriangle size={18} />
              <div>
                <strong>Key history failed verification</strong>
                <span>
                  The server returned an inconsistent key history. Treat this contact as
                  unverified until you confirm the key out of band.
                </span>
              </div>
            </div>
          )}

          {keyMismatch && (
            <div className="e2ee-key-alert">
              <AlertTriangle size={18} />
              <div>
                <strong>Key data does not match</strong>
                <span>
                  The published key history does not match the key this conversation is using.
                  Refresh the conversation and verify again before sending anything sensitive.
                </span>
              </div>
            </div>
          )}

          <div className="e2ee-safety-number" aria-label="Safety number">
            {safety.split(' ').map((group, index) => (
              <span key={`${group}-${index}`}>{group}</span>
            ))}
          </div>

          <div className="e2ee-fingerprints">
            <div>
              <span>Your fingerprint</span>
              <code>{formatFingerprint(myFingerprint)}</code>
            </div>
            <div>
              <span>{peer.displayName}&apos;s fingerprint</span>
              <code>{formatFingerprint(peerFingerprint)}</code>
            </div>
          </div>

          <label className="e2ee-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              I compared this safety number with {peer.displayName} over another trusted channel.
            </span>
          </label>

          <div className="e2ee-key-history">
            <div className="e2ee-key-history-head">
              <strong>Key history</strong>
              <span>{history?.events?.length || 0} event(s)</span>
            </div>
            {(history?.events || [])
              .slice()
              .reverse()
              .map((event) => (
                <div className="e2ee-key-event" key={event.id}>
                  <span className="e2ee-key-version">v{event.keyVersion}</span>
                  <div>
                    <strong>{event.eventType === 'rotate' ? 'Rotated' : 'Created'}</strong>
                    <span>{new Date(event.createdAt).toLocaleString()}</span>
                  </div>
                  <code title={event.eventHash}>{event.eventHash.slice(0, 16)}</code>
                </div>
              ))}
            {!history?.events?.length && (
              <p className="e2ee-key-history-empty">No key events recorded yet.</p>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
