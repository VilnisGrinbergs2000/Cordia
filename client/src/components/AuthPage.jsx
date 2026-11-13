import { useState } from 'react';
import { ArrowRight, Eye, EyeOff, KeyRound, Loader2, MailCheck, Radio, ShieldCheck, Users } from 'lucide-react';
import api from '../api';
import {
  activateIdentity,
  createIdentity,
  createPasswordBackup,
  createRecoveryBackup,
  forgetRememberedDevice,
  generateRecoveryCode,
  hashRecoveryCode,
  normalizeRecoveryCode,
  unlockIdentity
} from '../e2ee';

import Logo from './Logo';
import RecoveryCodeModal from './RecoveryCodeModal';

const FEATURES = [
  {
    icon: Users,
    title: 'Servers for your people',
    text: 'Channels, direct messages, and friends in one calm place.'
  },
  {
    icon: Radio,
    title: 'Voice when you need it',
    text: 'Voice, video, and screen sharing with a single click.'
  },
  {
    icon: ShieldCheck,
    title: 'Clear privacy controls',
    text: 'Decide who can message you, and manage every server you join.'
  }
];

async function ensureEncryption(user, password) {
  const me = await api.get('/api/e2ee/me');
  if (me.e2ee?.keyBackup) {
    const identity = await unlockIdentity(
      user.id,
      password,
      me.e2ee.keyBackup,
      me.e2ee.publicKey,
      me.e2ee.keyVersion
    );
    await activateIdentity(identity);
    return { user, identity };
  }
  const identity = await createIdentity(user.id, password);
  const payload = await api.post('/api/e2ee/setup', {
    publicKey: identity.publicKey,
    keyBackup: identity.backup
  });
  const nextIdentity = { ...identity, keyVersion: payload.e2ee.keyVersion };
  await activateIdentity(nextIdentity);
  return { user: payload.user || user, identity: nextIdentity };
}

async function buildRecovery(identity, user) {
  const code = generateRecoveryCode();
  const keyBackup = await createRecoveryBackup(identity, user.id, code);
  const recoveryVerifier = await hashRecoveryCode(code);
  return { code, keyBackup, recoveryVerifier };
}

export default function AuthPage({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [recoverySetup, setRecoverySetup] = useState(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryError, setRecoveryError] = useState('');
  // The emailed link is the only way back in for someone who lost the recovery
  // code, so it gets its own small form rather than hiding behind the one that
  // requires the code they no longer have.
  const [emailSent, setEmailSent] = useState(false);
  const [form, setForm] = useState({
    login: '',
    username: '',
    email: '',
    displayName: '',
    password: '',
    confirmPassword: '',
    recoveryCode: ''
  });

  function update(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function switchMode(nextMode) {
    setMode(nextMode);
    setError('');
    setRecoveryError('');
    setEmailSent(false);
  }

  async function requestResetLink() {
    const login = form.login.trim();
    if (!login) {
      setError('Enter your username or email first.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      // The server answers the same way whether or not the account exists, so
      // there is nothing to branch on here - and nothing to leak either.
      await api.post('/api/auth/password/request', { login });
      setEmailSent(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function resetPassword() {
    if (form.password !== form.confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    const code = normalizeRecoveryCode(form.recoveryCode);
    if (!code) {
      setError('Enter your recovery code.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const verifier = await hashRecoveryCode(code);
      const verified = await api.post('/api/auth/recovery/verify', {
        login: form.login,
        verifier
      });
      const identity = await unlockIdentity(
        verified.user.id,
        code,
        verified.recoveryBackup,
        verified.user.e2eePublicKey,
        verified.user.e2eeKeyVersion
      );
      const passwordBackup = await createPasswordBackup(identity, verified.user.id, form.password);
      const nextRecovery = await buildRecovery(identity, verified.user);
      const payload = await api.post('/api/auth/recovery/complete', {
        resetToken: verified.resetToken,
        password: form.password,
        keyBackup: passwordBackup.backup,
        recoveryBackup: nextRecovery.keyBackup,
        recoveryVerifier: nextRecovery.recoveryVerifier
      });
      await forgetRememberedDevice(verified.user.id).catch(() => {});
      await activateIdentity({
        ...identity,
        backup: passwordBackup.backup,
        wrappingKey: passwordBackup.wrappingKey,
        wrappingKeyRaw: passwordBackup.wrappingKeyRaw,
        backupParams: passwordBackup.params,
        backupSalt: passwordBackup.params.salt,
        needsBackupUpload: false,
        needsPrekeyUpload: false,
        persistBackup: true
      });
      setRecoverySetup({
        code: nextRecovery.code,
        user: payload.user,
        mode: 'reset'
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (mode === 'email') {
      await requestResetLink();
      return;
    }
    if (mode === 'reset') {
      await resetPassword();
      return;
    }
    if (mode === 'register' && !accepted) {
      setError('Accept the Community Guidelines to create an account.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const isRegister = mode === 'register';
      const data = isRegister
        ? await api.post('/api/auth/register', {
            username: form.username,
            email: form.email,
            displayName: form.displayName || form.username,
            password: form.password,
            acceptGuidelines: true
          })
        : await api.post('/api/auth/login', {
            login: form.login,
            password: form.password
          });
      let setup;
      try {
        setup = await ensureEncryption(data.user, form.password);
      } catch (err) {
        if (isRegister) {
          setMode('login');
          setForm((prev) => ({ ...prev, login: prev.username }));
          setError(
            `Your account was created, but encrypted messaging setup failed: ${err.message} Sign in to retry.`
          );
        } else {
          setError(`Could not unlock encrypted messages: ${err.message}`);
        }
        return;
      }
      if (isRegister && !setup.user.e2eeRecoveryReady) {
        const recovery = await buildRecovery(setup.identity, setup.user);
        setRecoverySetup({ ...recovery, user: setup.user, mode: 'register' });
        return;
      }
      onAuth(setup.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function confirmRecoverySetup() {
    if (!recoverySetup) return;
    setRecoveryBusy(true);
    setRecoveryError('');
    try {
      if (recoverySetup.mode === 'register') {
        const payload = await api.post('/api/e2ee/recovery', {
          keyBackup: recoverySetup.keyBackup,
          recoveryVerifier: recoverySetup.recoveryVerifier
        });
        const nextUser = payload.user || {
          ...recoverySetup.user,
          e2eeRecoveryReady: true,
          e2eeRecoveryResettable: true
        };
        setRecoverySetup(null);
        onAuth(nextUser);
      } else {
        const nextUser = recoverySetup.user;
        setRecoverySetup(null);
        onAuth(nextUser);
      }
    } catch (err) {
      setRecoveryError(err.message);
    } finally {
      setRecoveryBusy(false);
    }
  }

  const isRegister = mode === 'register';
  const isReset = mode === 'reset';
  const isEmailReset = mode === 'email';
  const title = isEmailReset
    ? 'Reset by email'
    : isReset
      ? 'Reset your password'
      : isRegister
        ? 'Create your account'
        : 'Welcome back';
  const subtitle = isEmailReset
    ? 'We will send a link that lets you choose a new password.'
    : isReset
      ? 'Use the recovery code you saved to restore your encrypted messages.'
      : isRegister
        ? 'Create an account to join your first server.'
        : 'Sign in to pick up where you left off.';

  return (
    <div className="auth-page">
      <section className="auth-story">
        <div className="auth-brand">
          <Logo size={44} withText />
        </div>
        <div className="auth-headline">
          <span className="eyebrow">Messages, voice, and community</span>
          <h1>
            A calmer place
            <br />
            to talk.
          </h1>
          <p>
            Cordia keeps your servers, conversations, and friends together without the noise.
          </p>
        </div>
        <div className="auth-features">
          {FEATURES.map((feature) => {
            const Icon = feature.icon;
            return (
              <div className="auth-feature" key={feature.title}>
                <span className="auth-feature-icon">
                  <Icon size={18} />
                </span>
                <div>
                  <strong>{feature.title}</strong>
                  <p>{feature.text}</p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <div className="auth-card-head">
            <Logo size={34} />
            <div>
              <h2>{title}</h2>
              <p>{subtitle}</p>
            </div>
          </div>

          {isReset || isEmailReset ? (
            <button type="button" className="auth-link" onClick={() => switchMode('login')}>
              Back to sign in
            </button>
          ) : (
            <div className="segmented">
              <button
                type="button"
                className={mode === 'login' ? 'active' : ''}
                onClick={() => switchMode('login')}
              >
                Sign in
              </button>
              <button
                type="button"
                className={mode === 'register' ? 'active' : ''}
                onClick={() => switchMode('register')}
              >
                Register
              </button>
            </div>
          )}

          {isEmailReset ? (
            emailSent ? (
              <div className="auth-sent">
                <MailCheck size={22} />
                <strong>Check your inbox</strong>
                <p>
                  If that account exists, the link is on its way. It expires in an hour and works
                  once.
                </p>
                <button type="button" className="auth-link" onClick={() => switchMode('login')}>
                  Back to sign in
                </button>
              </div>
            ) : (
              <form onSubmit={submit} className="auth-form">
                <label className="field">
                  <span>Username or email</span>
                  <input
                    value={form.login}
                    onChange={(event) => update('login', event.target.value)}
                    placeholder="aria"
                    autoComplete="username"
                    autoFocus
                    required
                  />
                </label>
                {error && <div className="form-error">{error}</div>}
                <button className="btn btn-primary auth-submit" disabled={loading}>
                  {loading ? <Loader2 size={18} className="spin" /> : <MailCheck size={18} />}
                  Send reset link
                </button>
              </form>
            )
          ) : (
          <form onSubmit={submit} className="auth-form">
            {isRegister && (
              <>
                <label className="field">
                  <span>Display name</span>
                  <input
                    value={form.displayName}
                    onChange={(event) => update('displayName', event.target.value)}
                    placeholder="Aria Vale"
                    maxLength={32}
                    autoComplete="name"
                  />
                </label>
                <label className="field">
                  <span>Username</span>
                  <input
                    value={form.username}
                    onChange={(event) => update('username', event.target.value)}
                    placeholder="aria"
                    autoComplete="username"
                    required
                  />
                </label>
                <label className="field">
                  <span>Email</span>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(event) => update('email', event.target.value)}
                    placeholder="aria@example.com"
                    autoComplete="email"
                    required
                  />
                </label>
              </>
            )}

            {(mode === 'login' || isReset) && (
              <label className="field">
                <span>Username or email</span>
                <input
                  value={form.login}
                  onChange={(event) => update('login', event.target.value)}
                  placeholder="aria"
                  autoComplete="username"
                  required
                />
              </label>
            )}

            {isReset && (
              <label className="field">
                <span>Recovery code</span>
                <input
                  value={form.recoveryCode}
                  onChange={(event) => update('recoveryCode', event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </label>
            )}

            <label className="field">
              <span>{isReset ? 'New password' : 'Password'}</span>
              <div className="password-wrap">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  onChange={(event) => update('password', event.target.value)}
                  placeholder="••••••••"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  minLength={8}
                  required
                />
                <button
                  type="button"
                  className="password-toggle"
                  onClick={() => setShowPassword((value) => !value)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </label>

            {isReset && (
              <label className="field">
                <span>Confirm new password</span>
                <input
                  type="password"
                  value={form.confirmPassword}
                  onChange={(event) => update('confirmPassword', event.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </label>
            )}

            {error && <div className="form-error">{error}</div>}

            {isRegister && (
              <label className="auth-consent">
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={(event) => setAccepted(event.target.checked)}
                />
                <span>
                  I agree to the{' '}
                  <a href="/guidelines" target="_blank" rel="noreferrer">
                    Community Guidelines
                  </a>
                  .
                </span>
              </label>
            )}

            <button className="btn btn-primary auth-submit" disabled={loading}>
              {loading ? (
                <Loader2 size={18} className="spin" />
              ) : isReset ? (
                <KeyRound size={18} />
              ) : (
                <ArrowRight size={18} />
              )}
              {isReset ? 'Reset password' : isRegister ? 'Create account' : 'Sign in'}
            </button>
          </form>
          )}

          {mode === 'login' && (
            <div className="auth-forgot">
              <button type="button" className="auth-link" onClick={() => switchMode('reset')}>
                I have my recovery code
              </button>
              <button type="button" className="auth-link" onClick={() => switchMode('email')}>
                Email me a reset link
              </button>
            </div>
          )}

          {isRegister && (
            <p className="auth-hint">
              <ShieldCheck size={14} /> Encrypted DMs are set up automatically. You will save a
              recovery code next.
            </p>
          )}
          <p className="auth-legal">
            Passwords are hashed with bcrypt. Sessions live in httpOnly cookies. Encryption keys
            never leave your device unencrypted.
          </p>
        </div>
      </section>

      {recoverySetup && (
        <RecoveryCodeModal
          code={recoverySetup.code}
          title={recoverySetup.mode === 'reset' ? 'Save your new recovery code' : 'Save your recovery code'}
          subtitle={
            recoverySetup.mode === 'reset'
              ? 'Your old code no longer works. Save this replacement before continuing.'
              : 'This is the only time this code will be shown.'
          }
          confirmLabel={recoverySetup.mode === 'reset' ? 'Continue' : 'I saved my code'}
          onConfirm={confirmRecoverySetup}
          onClose={() => {}}
          busy={recoveryBusy}
          error={recoveryError}
        />
      )}
    </div>
  );
}
