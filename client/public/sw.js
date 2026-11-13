// Bumped whenever the shell or the policy around it changes: activate() drops
// every cache whose name does not match, which is how a client that installed
// an older shell stops serving it.
const VERSION = 'v5';
const SHELL_CACHE = `cordia-shell-${VERSION}`;
const ASSET_CACHE = `cordia-assets-${VERSION}`;
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png'
];

const OFFLINE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#0F1117" />
    <title>Cordia is offline</title>
    <style>
      html, body { height: 100%; margin: 0; }
      body {
        display: grid;
        place-items: center;
        padding: 24px;
        background: #05070f;
        color: #e9eeff;
        font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main { max-width: 360px; text-align: center; }
      h1 { font-size: 22px; margin: 0 0 8px; }
      p { color: #8d97b5; line-height: 1.5; margin: 0 0 20px; }
      a {
        display: inline-flex;
        padding: 10px 16px;
        border-radius: 12px;
        color: #fff;
        text-decoration: none;
        background: linear-gradient(135deg, #7c6bff, #5b8cff);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Cordia is offline</h1>
      <p>Reconnect to the internet, then try again. Your cached app shell is ready when the server is reachable.</p>
      <a href="/">Try again</a>
    </main>
  </body>
</html>`;

function offlineResponse() {
  return new Response(OFFLINE_HTML, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== ASSET_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/socket.io/') ||
    url.pathname.startsWith('/uploads/')
  ) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches
              .open(SHELL_CACHE)
              .then((cache) => cache.put('/', copy))
              .catch(() => undefined);
          }
          return response;
        })
        .catch(async () => (await caches.match('/')) || offlineResponse())
    );
    return;
  }

  const assetPath =
    url.pathname.startsWith('/assets/') || url.pathname.startsWith('/twemoji/');
  const shellPath = SHELL.includes(url.pathname);
  if (!assetPath && !shellPath) return;

  const cacheName = assetPath ? ASSET_CACHE : SHELL_CACHE;
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches
            .open(cacheName)
            .then((cache) => cache.put(request, copy))
            .catch(() => undefined);
        }
        return response;
      });
    })
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data?.json() || {};
  } catch {
    data = {};
  }
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const focused = windows.find((client) => client.visibilityState === 'visible' && client.focused);
      if (focused) {
        focused.postMessage({ type: 'cordia:push', payload: data });
        return;
      }
      await self.registration.showNotification(data.title || 'Cordia', {
        body: data.body || '',
        tag: data.tag || 'cordia',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { url: data.url || '/', scopeType: data.scopeType, scopeId: data.scopeId },
        renotify: true
      });
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if ('focus' in client) {
          await client.focus();
          if ('navigate' in client) {
            try {
              await client.navigate(url);
            } catch {
              // focus is enough if navigation is blocked
            }
          }
          return;
        }
      }
      await self.clients.openWindow(url);
    })()
  );
});
