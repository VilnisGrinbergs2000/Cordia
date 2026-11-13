import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { applyPreferences, cachedPreferences } from './theme';
import { registerServiceWorker, syncPushSubscription } from './push';
import { listenForInviteLinks } from './native';
import './styles.css';

applyPreferences(cachedPreferences() || {});

listenForInviteLinks();
registerServiceWorker().then(() => syncPushSubscription());

// The bundle is served from /app on the hosted build (the landing page owns
// "/"), so the router's own paths are relative to that prefix. Without this,
// /app/admin/users would fall through to the catch-all instead of the admin
// route. In dev the app is at the root, so basename stays "/".
const basename = /^\/app(\/|$)/.test(window.location.pathname) ? '/app' : '/';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
