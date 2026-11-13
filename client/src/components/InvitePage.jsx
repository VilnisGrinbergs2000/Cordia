import { useEffect, useRef, useState } from 'react';
import { Loader2, UserPlus, X } from 'lucide-react';
import api from '../api';
import { isNativeApp } from '../runtime';
import { appInviteLink } from '../utils';
import AuthPage from './AuthPage';
import Logo from './Logo';
import Markdown from './Markdown';
import ServerIcon from './ServerIcon';

export default function InvitePage({ code, user, onAuth, auto = false }) {
  const [invite, setInvite] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [openingApp, setOpeningApp] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const autoAccepted = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api
      .get(`/api/invites/${encodeURIComponent(code)}`)
      .then((payload) => {
        if (!cancelled) setInvite(payload.invite);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [code, user]);

  useEffect(() => {
    if (!auto || autoAccepted.current || !invite || !user) return;
    autoAccepted.current = true;
    accept();
  }, [auto, invite, user]);

  function launchApp(inviteCode) {
    return new Promise((resolve) => {
      let settled = false;
      let frame = null;
      const finish = (opened) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', onVisibility);
        frame?.remove();
        resolve(opened);
      };
      const onVisibility = () => {
        if (document.hidden) finish(true);
      };
      const timer = setTimeout(() => finish(false), 1500);
      document.addEventListener('visibilitychange', onVisibility);
      try {
        frame = document.createElement('iframe');
        frame.style.display = 'none';
        frame.src = appInviteLink(inviteCode);
        document.body.appendChild(frame);
      } catch {
        finish(false);
      }
    });
  }

  if (authOpen) {
    return (
      <AuthPage
        onAuth={(nextUser) => {
          onAuth(nextUser);
          setAuthOpen(false);
        }}
      />
    );
  }

  async function accept() {
    if (!invite) return;
    if (!isNativeApp) {
      setOpeningApp(true);
      const opened = await launchApp(invite.code || code);
      setOpeningApp(false);
      if (opened) return;
    }
    if (!user) {
      setAuthOpen(true);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.post('/api/servers/join', { inviteCode: invite.code || code });
      window.location.assign('/app');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  function cancel() {
    window.location.assign(user ? '/app' : '/');
  }

  return (
    <div className="auth-page" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      <section className="auth-panel">
        <div className="auth-card" style={{ maxWidth: 480 }}>
          <div className="auth-brand">
            <Logo size={40} withText />
          </div>

          {loading ? (
            <div className="server-template-loading">
              <Loader2 size={17} className="spin" />
              Checking invite...
            </div>
          ) : !invite ? (
            <>
              <div className="auth-card-head">
                <div>
                  <h2>Invite unavailable</h2>
                  <p>{error || 'This invite link is invalid or expired.'}</p>
                </div>
              </div>
              <button className="btn btn-ghost invite-copy" onClick={cancel}>
                <X size={16} /> Cancel
              </button>
            </>
          ) : (
            <>
              <div className="invite-visual">
                <ServerIcon
                  server={invite.server}
                  className="server-icon-preview"
                />
                <div>
                  <span className="settings-label">You're invited to</span>
                  <strong style={{ display: 'block', fontSize: 20, lineHeight: 1.25 }}>
                    {invite.server.name}
                  </strong>
                  <span className="field-hint">
                    {invite.memberCount} {invite.memberCount === 1 ? 'member' : 'members'}
                    {invite.alreadyMember ? ' · already joined' : ''}
                  </span>
                </div>
              </div>

              {invite.server.description && (
                <div className="invite-description" style={{ marginTop: 14 }}>
                  <Markdown className="md-prose" text={invite.server.description} meUsername="" />
                </div>
              )}

              {error && <div className="form-error">{error}</div>}

              <button
                className="btn btn-primary invite-copy"
                onClick={accept}
                disabled={busy || openingApp || user === undefined}
              >
                {busy || openingApp || user === undefined ? (
                  <Loader2 size={16} className="spin" />
                ) : (
                  <UserPlus size={16} />
                )}
                {openingApp
                  ? 'Opening Cordia...'
                  : busy
                    ? 'Joining...'
                    : user === undefined
                      ? 'Checking account...'
                      : !user
                        ? 'Sign in to accept'
                        : invite.alreadyMember
                          ? 'Open server'
                          : 'Accept invite'}
              </button>
              <button
                className="btn btn-ghost"
                style={{ width: '100%', marginTop: 8 }}
                onClick={cancel}
                disabled={busy}
              >
                <X size={16} /> Cancel
              </button>
              <p className="invite-note">
                Invite links can be reset by server admins at any time.
              </p>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
