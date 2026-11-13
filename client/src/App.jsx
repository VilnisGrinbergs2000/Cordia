import { lazy, Suspense, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import api from './api';
import Logo from './components/Logo';
import Shell from './Shell';
import EasterEggLayer from './components/EasterEggLayer';
import OfflineBanner from './components/OfflineBanner';
import PwaPrompt from './components/PwaPrompt';
import { applyPreferences } from './theme';
import { setUploadToken } from './runtime';
import { SupportProvider } from './support';

const AdminPage = lazy(() => import('./AdminPage'));
const AuthPage = lazy(() => import('./components/AuthPage'));
const InvitePage = lazy(() => import('./components/InvitePage'));
const AuthorizePage = lazy(() => import('./components/AuthorizePage'));
const InsightsPage = lazy(() => import('./InsightsPage'));

function LoadingScreen() {
  return (
    <div className="splash">
      <div className="splash-orbit">
        <Logo size={64} />
      </div>
      <p>Loading Cordia</p>
    </div>
  );
}


const INVITE_CODE = (() => {
  try {
    const match = window.location.pathname.match(/^(?:\/app)?\/invite\/([^/]+)\/?$/);
    if (match) return decodeURIComponent(match[1]);
    return new URLSearchParams(window.location.search).get('invite') || '';
  } catch {
    return '';
  }
})();

const INVITE_AUTO = (() => {
  try {
    return new URLSearchParams(window.location.search).get('auto') === '1';
  } catch {
    return false;
  }
})();

// The public install link for an application: /authorize?client_id=...
// Read the same way and at the same time as the invite code.
const AUTHORIZE_CLIENT = (() => {
  try {
    if (!/^(?:\/app)?\/authorize\/?$/.test(window.location.pathname)) return '';
    return new URLSearchParams(window.location.search).get('client_id') || '';
  } catch {
    return '';
  }
})();

export default function App() {
  const [user, setUser] = useState(undefined);


  useEffect(() => {
    api
      .get('/api/auth/me')
      .then((data) => {
        setUploadToken(data.uploadToken);
        setUser(data.user);
      })
      .catch(() => setUser(null));
  }, []);

  useEffect(() => {
    if (user) applyPreferences(user);
  }, [user]);

  let content;

  if (INVITE_CODE) {
    content = (
      <Suspense fallback={<LoadingScreen />}>
        <InvitePage code={INVITE_CODE} user={user} onAuth={setUser} auto={INVITE_AUTO} />
      </Suspense>
    );
  } else if (AUTHORIZE_CLIENT) {
    content = (
      <Suspense fallback={<LoadingScreen />}>
        <AuthorizePage clientId={AUTHORIZE_CLIENT} user={user} onAuth={setUser} />
      </Suspense>
    );
  } else if (user === undefined) {
    content = <LoadingScreen />;
  } else if (!user) {
    content = (
      <Suspense fallback={<LoadingScreen />}>
        <AuthPage onAuth={setUser} />
      </Suspense>
    );
  } else {
    content = (
      <Routes>
        <Route
          path="/insights/:serverId"
          element={
            <Suspense fallback={<LoadingScreen />}>
              <InsightsPage />
            </Suspense>
          }
        />
        <Route
          path="/admin/*"
          element={
            user.role === 'admin' ? (
              <Suspense fallback={<LoadingScreen />}>
                <AdminPage user={user} setUser={setUser} />
              </Suspense>
            ) : (
              <Navigate to="/" replace />
            )
          }
        />
        <Route
          path="*"
          element={
            <SupportProvider>
              <Shell
                user={user}
                setUser={setUser}
                onLoggedOut={() => setUser(null)}
              />
            </SupportProvider>
          }
        />
      </Routes>
    );
  }

  return (
    <>
      <OfflineBanner />
      <PwaPrompt />
      <EasterEggLayer />
      {content}
    </>
  );
}
