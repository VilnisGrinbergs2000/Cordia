import { useEffect, useState } from 'react';
import { KeyRound, Loader2, LockKeyhole, ShieldCheck } from 'lucide-react';
import api from '../api';
import Modal from './Modal';
import {
  activateIdentity,
  createIdentity,
  installIdentity,
  isRememberDeviceAvailable,
  rememberDeviceIdentity,
  unlockIdentity
} from '../e2ee';


export default function E2eeUnlockModal({ user, onClose, onUnlocked }) {
  const setup = !user.e2eeReady;
  const [useRecovery, setUseRecovery] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [remember, setRemember] = useState(true);
  const [rememberAvailable, setRememberAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    isRememberDeviceAvailable().then((available) => {
      if (!cancelled) setRememberAvailable(available);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function rememberIfNeeded(identity) {
    if (!identity?.rememberDevice) return;
    try {
      await rememberDeviceIdentity(identity);
    } catch (err) {
      console.warn('[e2ee] could not remember this device:', err.message);
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (setup && password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (!setup && useRecovery && !recoveryCode.trim()) {
      setError('Enter your recovery code.');
      return;
    }
    setBusy(true);
    const rememberDevice = !useRecovery && rememberAvailable && remember;
    try {
      if (setup) {
        const identity = { ...(await createIdentity(user.id, password)), rememberDevice };
        try {
          const payload = await api.post('/api/e2ee/setup', {
            publicKey: identity.publicKey,
            keyBackup: identity.backup
          });
          const nextIdentity = { ...identity, keyVersion: payload.e2ee.keyVersion };
          await activateIdentity(nextIdentity);
          await rememberIfNeeded(nextIdentity);
          onUnlocked?.(payload.user);
        } catch (err) {
          if (err.status !== 409) throw err;
          const me = await api.get('/api/e2ee/me');
          if (!me.e2ee?.keyBackup) {
            throw new Error('Encryption keys already exist, but no backup was found.');
          }
          const unlocked = await unlockIdentity(
            user.id,
            password,
            me.e2ee.keyBackup,
            me.e2ee.publicKey,
            me.e2ee.keyVersion
          );
          unlocked.rememberDevice = rememberDevice;
          await activateIdentity(unlocked);
          await rememberIfNeeded(unlocked);
          onUnlocked?.(user);
        }
      } else {
        const me = await api.get('/api/e2ee/me');
        const secret = useRecovery ? recoveryCode.trim() : password;
        const backup = useRecovery ? me.e2ee?.recoveryBackup : me.e2ee?.keyBackup;
        if (!backup) {
          throw new Error(
            useRecovery
              ? 'No recovery code is configured for this account.'
              : 'Encryption key backup is missing for this account.'
          );
        }
        const unlocked = await unlockIdentity(
          user.id,
          secret,
          backup,
          me.e2ee.publicKey,
          me.e2ee.keyVersion
        );
        if (useRecovery) {
          unlocked.persistBackup = false;
          installIdentity(unlocked);
        } else {
          unlocked.rememberDevice = rememberDevice;
          await activateIdentity(unlocked);
          await rememberIfNeeded(unlocked);
        }
        onUnlocked?.(user);
      }
      onClose?.();
    } catch (err) {
      setError(err.message || 'Could not unlock encrypted messages.');
    } finally {
      setBusy(false);
    }
  }

  const title = setup
    ? 'Set up encrypted messages'
    : useRecovery
      ? 'Recover encrypted messages'
      : 'Unlock encrypted messages';
  const subtitle = setup
    ? 'Your direct messages get end-to-end encryption. Only you and the other person can read them.'
    : useRecovery
      ? 'Enter the recovery code you saved to unwrap your encryption key on this device.'
      : 'Enter your account password to unwrap your encryption key on this device.';

  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      width={460}
      footer={
        <div className="e2ee-modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Later
          </button>
          <button type="submit" form="e2ee-unlock-form" className="btn btn-primary" disabled={busy}>
            {busy ? <Loader2 size={16} className="spin" /> : <KeyRound size={16} />}
            {setup ? 'Set up' : useRecovery ? 'Recover' : 'Unlock'}
          </button>
        </div>
      }
    >
      <form id="e2ee-unlock-form" className="e2ee-form" onSubmit={submit}>
        <div className="e2ee-modal-badge">
          {setup ? <ShieldCheck size={20} /> : <LockKeyhole size={20} />}
          <div>
            <strong>
              {setup
                ? 'One-time setup'
                : useRecovery
                  ? 'Recovery code'
                  : 'Encrypted key backup'}
            </strong>
            <span>
              {setup
                ? 'Your key is wrapped with your password before it is stored.'
                : useRecovery
                  ? 'Your recovery code unwraps the same key locally. It is never sent to the server.'
                  : 'Your key is unwrapped locally. Remember this device to skip this prompt next time.'}
            </span>
          </div>
        </div>

        {!setup && user.e2eeRecoveryReady && (
          <div className="e2ee-unlock-switch">
            <button
              type="button"
              className={!useRecovery ? 'active' : ''}
              onClick={() => {
                setUseRecovery(false);
                setError('');
              }}
            >
              Account password
            </button>
            <button
              type="button"
              className={useRecovery ? 'active' : ''}
              onClick={() => {
                setUseRecovery(true);
                setError('');
              }}
            >
              Recovery code
            </button>
          </div>
        )}

        {useRecovery ? (
          <label className="field">
            <span>Recovery code</span>
            <input
              type="password"
              value={recoveryCode}
              onChange={(event) => setRecoveryCode(event.target.value)}
              autoComplete="off"
              autoFocus
              required
            />
          </label>
        ) : (
          <label className="field">
            <span>Account password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={setup ? 'new-password' : 'current-password'}
              autoFocus
              required
              minLength={8}
            />
          </label>
        )}

        {setup && (
          <label className="field">
            <span>Confirm password</span>
            <input
              type="password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              autoComplete="new-password"
              required
              minLength={8}
            />
          </label>
        )}

        {error && <div className="form-error">{error}</div>}

        {!useRecovery && rememberAvailable && (
          <label className="e2ee-confirm e2ee-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            <span>
              <strong>Remember this device</strong>
              <small>
                Store your unlocked key with your operating system's secure storage so Cordia
                can skip this prompt next time. Use “Forget this device” in Encryption settings
                to remove it.
              </small>
            </span>
          </label>
        )}

        <p className="e2ee-modal-note">
          {setup
            ? 'If you forget your password, set up a recovery code before you sign out.'
            : useRecovery
              ? 'Anyone with this code can read your encrypted messages. Store it offline.'
              : 'If you forget your password, your encrypted message history cannot be recovered without a recovery code.'}
        </p>
      </form>
    </Modal>
  );
}

