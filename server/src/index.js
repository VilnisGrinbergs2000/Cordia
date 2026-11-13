const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const { port, uploadsDir } = require('./config');
const { attachSocket } = require('./socket');
const { startScheduler } = require('./scheduler');
const asyncHandler = require('./pg/asyncHandler');
const { extractToken, userFromTokenAsync } = require('./auth');
const { verifyUploadToken } = require('./uploads');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const serverRoutes = require('./routes/servers');
const messageRoutes = require('./routes/messages');
const dmRoutes = require('./routes/dms');
const friendRoutes = require('./routes/friends');
const searchRoutes = require('./routes/search');
const uploadRoutes = require('./routes/upload');
const adminRoutes = require('./routes/admin');
const voiceRoutes = require('./routes/voice');
const readRoutes = require('./routes/read');
const pushRoutes = require('./routes/push');
const featureRoutes = require('./routes/features');
const e2eeRoutes = require('./routes/e2ee');
const reportRoutes = require('./routes/reports');
const emoteRoutes = require('./routes/emotes');
const threadRoutes = require('./routes/threads');
const forumTagRoutes = require('./routes/forumTags');
const soundboardRoutes = require('./routes/soundboard');
const discoverRoutes = require('./routes/discover');
const savedRoutes = require('./routes/saved');
const reminderRoutes = require('./routes/reminders');
const docRoutes = require('./routes/docs');
const listRoutes = require('./routes/lists');
const serverBillingRoutes = require('./routes/serverBilling');
const applicationRoutes = require('./routes/applications').router;
const interactionRoutes = require('./routes/interactions');
const guildRoutes = require('./routes/guilds');
const supportRoutes = require('./routes/support');
const presenceRoutes = require('./routes/presence');
const integrationRoutes = require('./routes/integrations');
const { router: emailLinkRoutes } = require('./routes/email');
const { startMailer } = require('./mail');
const { startRetention } = require('./retention');
const { archiveIdleThreads } = require('./threads');
const { migrate } = require('./pg/migrate');
const { reconcileCounters, reconcileUploadBytes } = require('./pg/reconcile');

const app = express();
const server = http.createServer(app);
const configuredOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const nativeOrigins = [
  'cordia://app',
  'http://localhost',
  'https://localhost',
  'capacitor://localhost'
];
const allowedOrigins = [...new Set([...configuredOrigins, ...nativeOrigins])];

function sameHost(origin, host) {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true
  },
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    if (!origin) return callback(null, true);
    return callback(null, allowedOrigins.includes(origin) || sameHost(origin, req.headers.host));
  },
  maxHttpBufferSize: 1e6
});

app.set('io', io);
// Trusting a proxy makes req.ip whatever X-Forwarded-For claims, which lets a
// client sidestep the per-IP rate limiters. Only opt in when a real proxy fronts
// the API (TRUST_PROXY=1 or the number of hops).
app.set('trust proxy', process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : false);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  })
);
app.use(
  cors({
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)),
    credentials: true,
    exposedHeaders: ['Content-Disposition']
  })
);
app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (!origin || allowedOrigins.includes(origin) || sameHost(origin, req.get('host'))) return next();
  return res.status(403).json({ error: 'Not allowed by CORS' });
});
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
// /uploads is no longer a public static mount. Media elements cannot send an
// Authorization header, so the client appends a scoped upload token (see
// src/uploads.js) to every asset URL, and a same-origin session cookie is
// accepted as well. Either way the reader has to be signed in.
app.get(
  '/uploads/:name',
  asyncHandler(async (req, res) => {
    const signed = verifyUploadToken(req.query.t);
    if (!signed && !(await userFromTokenAsync(extractToken(req)))) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    const name = String(req.params.name || '');
    // The :name param cannot contain a slash, but a leading dot would expose
    // dotfiles, so the shape is checked before the path is resolved.
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.includes('..')) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // File names are content-addressed UUIDs, so a hit never goes stale.
    res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
    res.sendFile(name, { root: uploadsDir, dotfiles: 'deny' }, (error) => {
      if (!error || res.headersSent) return;
      res.status(error.code === 'ENOENT' ? 404 : 500).json({
        error: error.code === 'ENOENT' ? 'Not found' : 'Could not read that file.'
      });
    });
  })
);

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'cordia', time: Date.now() }));

// IndexNow proves domain ownership by fetching this file, so it has to be a real
// 200 at the exact path the submission names - no redirect, no auth. The key is
// hex only, which is why it can be pasted straight into a route path.
const indexNowKey = String(process.env.INDEXNOW_KEY || '').trim();
if (indexNowKey) {
  app.get(`/${indexNowKey}.txt`, (req, res) => {
    res.type('text/plain').setHeader('Cache-Control', 'public, max-age=3600').send(indexNowKey);
  });
}

app.use('/api', authRoutes);
app.use('/api', userRoutes);
app.use('/api', serverRoutes);
app.use('/api', messageRoutes);
app.use('/api', dmRoutes);
app.use('/api', friendRoutes);
app.use('/api', searchRoutes);
app.use('/api', uploadRoutes);
app.use('/api', adminRoutes);
app.use('/api', voiceRoutes);
app.use('/api', readRoutes);
app.use('/api', pushRoutes);
app.use('/api', featureRoutes);
app.use('/api', e2eeRoutes);
app.use('/api', reportRoutes);
app.use('/api', emoteRoutes);
app.use('/api', threadRoutes);
app.use('/api', forumTagRoutes);
app.use('/api', soundboardRoutes);
app.use('/api', discoverRoutes);
app.use('/api', savedRoutes);
app.use('/api', reminderRoutes);
app.use('/api', docRoutes);
app.use('/api', listRoutes);
app.use('/api', serverBillingRoutes);
app.use('/api', applicationRoutes);
app.use('/api', interactionRoutes);
app.use('/api', guildRoutes);
app.use('/api', supportRoutes);
app.use('/api', presenceRoutes);
app.use('/api', integrationRoutes);
// Clicked links from mail: verification, password reset, unsubscribe. Mounted
// with the API because the links point at /api/email/*, and ahead of the SPA
// catch-all so a browser gets a page instead of the app shell.
app.use('/api', emailLinkRoutes);

// Express matches a route with or without a trailing slash, so /guidelines/ and
// /guidelines both answer 200 with the same bytes - two URLs for one page. Send
// the slashed form to the canonical one. GET and HEAD only: a 301 on a POST
// turns it into a GET and drops the body.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const pathname = req.path;
  if (pathname.length > 1 && pathname.endsWith('/')) {
    const query = req.originalUrl.slice(pathname.length);
    return res.redirect(301, pathname.replace(/\/+$/, '') + query);
  }
  next();
});

// Marketing site. Mounted after every /api router so it can never shadow the
// API, /uploads or /socket.io, and before the client bundle so "/" and
// "/pricing" land on the pitch instead of the app shell.
const landingDir = path.join(__dirname, '..', '..', 'landing');
if (fs.existsSync(landingDir)) {
  const landingIndex = path.join(landingDir, 'index.html');
  app.get('/', (req, res) => res.sendFile(landingIndex));
  // Nothing links here and the page it served was the home page under a second
  // URL. A permanent redirect folds whatever ranking it earned into "/".
  app.get('/pricing', (req, res) => res.redirect(301, '/'));
  // The long-form pages are authored as standalone HTML, but a URL ending in
  // ".html" reads like a file rather than a page. Serve them at the clean path
  // and send the old address there permanently, before the static mount claims
  // the .html request.
  const DOC_PAGES = {
    '/guidelines': 'guidelines.html',
    '/privacy': 'privacy.html',
    '/terms': 'terms.html',
    '/status': 'status.html'
  };
  for (const [route, file] of Object.entries(DOC_PAGES)) {
    app.get(route, (req, res) => res.sendFile(path.join(landingDir, file)));
    // Two spellings of the same page are two pages to a crawler. Both the file
    // extension and the trailing slash go to the one canonical address.
    app.get(route + '.html', (req, res) => res.redirect(301, route));
    app.get(route + '/', (req, res) => res.redirect(301, route));
  }
  // The Spotify setup guide was aimed at whoever runs the server, not at the
  // people using it. It is gone, and the catch-all below would otherwise answer
  // for it with a 200 and the app shell - a soft 404 that search engines index.
  app.get(['/spotify', '/spotify.html'], (req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });
  // Assets on this site are not content-hashed, so a long max-age would strand
  // visitors on an old stylesheet after a deploy. Fonts and images essentially
  // never change and get a week; everything else revalidates.
  app.use(
    express.static(landingDir, {
      index: 'index.html',
      setHeaders: (res, filePath) => {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.woff2' || ext === '.png' || ext === '.jpg' || ext === '.svg') {
          res.setHeader('Cache-Control', 'public, max-age=604800');
        } else if (ext === '.css' || ext === '.js') {
          res.setHeader('Cache-Control', 'public, max-age=3600');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=300');
        }
      }
    })
  );

  // A missing installer must not fall through to the app shell: the browser
  // would save a 1.6 KB HTML page under a .exe name and the visitor would think
  // the download worked. Anything under /downloads that the static mount above
  // did not answer is genuinely absent.
  app.use('/downloads', (req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });

  // Crawlers read these two before anything else. Built from PUBLIC_URL when it
  // is set, so a deployment does not ship a sitemap full of localhost.
  const siteOrigin = (req) => {
    const configured = String(process.env.PUBLIC_URL || '').replace(/\/$/, '');
    if (configured) return configured;
    return `${req.protocol}://${req.get('host')}`;
  };

  app.get('/robots.txt', (req, res) => {
    const lines = [
      'User-agent: *',
      'Allow: /',
      'Disallow: /app',
      'Disallow: /api',
      'Disallow: /uploads',
      '',
      `Sitemap: ${siteOrigin(req)}/sitemap.xml`,
      ''
    ];
    res.type('text/plain').send(lines.join('\n'));
  });

  // lastmod comes from the file's mtime, not from the clock. A sitemap that
  // says every page changed today, every day, is a signal crawlers learn to
  // ignore - and it hides the one page that actually did change.
  const SITEMAP_PAGES = [
    { route: '/', file: 'index.html', priority: '1.0', changefreq: 'weekly' },
    { route: '/guidelines', file: 'guidelines.html', priority: '0.5', changefreq: 'yearly' },
    { route: '/privacy', file: 'privacy.html', priority: '0.4', changefreq: 'yearly' },
    { route: '/terms', file: 'terms.html', priority: '0.4', changefreq: 'yearly' },
    { route: '/status', file: 'status.html', priority: '0.6', changefreq: 'daily' }
  ];

  app.get('/sitemap.xml', (req, res) => {
    const origin = siteOrigin(req);
    const urls = SITEMAP_PAGES.map((page) => {
      let lastmod = '';
      try {
        lastmod = fs.statSync(path.join(landingDir, page.file)).mtime.toISOString().slice(0, 10);
      } catch (error) {
        lastmod = new Date().toISOString().slice(0, 10);
      }
      return [
        '  <url>',
        `    <loc>${origin}${page.route}</loc>`,
        `    <lastmod>${lastmod}</lastmod>`,
        `    <changefreq>${page.changefreq}</changefreq>`,
        `    <priority>${page.priority}</priority>`,
        '  </url>'
      ].join('\n');
    }).join('\n');
    res
      .type('application/xml')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
      );
  });
}

// The marketing page ships an inline <script>, so the policy is attached to the
// app shell responses instead of every response. Without it a reflected or
// stored injection anywhere in the app owns the whole origin.
// 'wasm-unsafe-eval' is not a synonym for 'unsafe-eval': it allows
// WebAssembly.compile and nothing else, which is exactly what the E2EE key
// derivation needs. hash-wasm compiles its argon2id module on demand, and
// without this keyword every DM unlock dies with a CSP violation. Browsers that
// do not know the keyword ignore it and keep 'self'.
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  // KLIPY is called straight from the browser, so its origin has to be
  // reachable from the app shell and nowhere else.
  "connect-src 'self' ws: wss: https://api.klipy.com",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'"
].join('; ');

// A document that carries a security policy must not be reused from a cache.
// The policy travels in the response headers, so a shell cached before the
// policy changed keeps enforcing the old one - which is exactly how a fixed
// WebAssembly rule can appear to still be broken after a server restart.
const APP_SHELL_CACHE = 'no-store, must-revalidate';

function sendAppShell(res, file) {
  res.setHeader('Content-Security-Policy', APP_CSP);
  res.setHeader('Cache-Control', APP_SHELL_CACHE);
  // The app is a signed-in surface with nothing to rank; a header reaches the
  // paths robots.txt cannot (query strings, deep links) and does it without
  // relying on the crawler reading the markup.
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(file);
}

const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  // Emoji artwork never changes; cache it hard so the picker is instant on a
  // second visit instead of re-fetching hundreds of svgs.
  app.use(
    '/twemoji',
    express.static(path.join(clientDist, 'twemoji'), {
      maxAge: '30d',
      immutable: true,
      fallthrough: true
    })
  );

  // The app gets a real mount point. Without it the only URL for the bundle was
  // "/", which the landing page already owns, so every "Create an account"
  // click bounced back to the marketing page. The landing
  // static mount above never contains an "app" entry, so /app is not shadowed.
  const appIndex = path.join(clientDist, 'index.html');
  // redirect:false keeps "/app" a 200 instead of a 301 to "/app/" (serve-static
  // redirects directories whose URL lacks a trailing slash).
  app.use(
    '/app',
    express.static(clientDist, {
      redirect: false,
      setHeaders: (res, filePath) => {
        if (!filePath.endsWith('.html')) return;
        res.setHeader('Content-Security-Policy', APP_CSP);
        res.setHeader('Cache-Control', APP_SHELL_CACHE);
      }
    })
  );
  app.get('/app', (req, res) => sendAppShell(res, appIndex));
  // Deep links (/app/admin/users) and the trailing slash both fall here and the
  // client router takes over from the served shell.
  app.get('/app/*splat', (req, res) => sendAppShell(res, appIndex));

  // Two links the app hands out are pasted into chat clients, e-mail and forum
  // posts, so they arrive without the /app prefix: an invite (built by
  // inviteLink) and an application install link (DevelopersPanel). Both used to
  // fall through to the 404 page - a shared invite looked like a dead server.
  // The client router reads the code from either spelling, so a permanent
  // redirect is enough; the query string carries ?auto=1 for the join flow.
  app.get('/invite/:code', (req, res) => {
    res.redirect(301, '/app' + req.path + req.url.slice(req.path.length));
  });
  app.get('/authorize', (req, res) => {
    res.redirect(301, '/app' + req.path + req.url.slice(req.path.length));
  });

  app.use(express.static(clientDist));
}

// A wrong address must answer 404, not 200 with the app shell. The old
// catch-all answered every unknown path with a 200 and 1.6 KB of HTML, which is
// a soft 404: crawlers index the junk URL, and a mistyped link looks like it
// worked. The SPA only ever lives under /app, and that mount is above this.
app.use((req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/uploads') || req.path.startsWith('/socket.io')) {
    return res.status(404).json({ error: 'Not found' });
  }
  const notFoundPage = path.join(landingDir, '404.html');
  if (fs.existsSync(notFoundPage)) {
    res.status(404).setHeader('Cache-Control', 'no-store');
    return res.sendFile(notFoundPage);
  }
  res.status(404).type('text/plain').send('Not found');
});

app.use((error, req, res, next) => {
  console.error('[server]', error);
  if (res.headersSent) return next(error);
  const status = error.message === 'Not allowed by CORS' ? 403 : 500;
  res.status(status).json({ error: status === 500 ? 'Something went wrong.' : error.message });
});

attachSocket(io);
// Bots live in their own namespace: separate auth, separate rooms, no presence
// and no voice. attachGateway has to run before listen, like attachSocket.
require('./bots').attachGateway(io);
// The housekeeping timers are started inside start(), after migrate(): their
// first tick runs immediately, and on a fresh database that tick used to fire
// before the tables existed, logging three failures that looked like bugs.

// Threads archive themselves once the server's window has passed with no
// activity. Five minutes is fine: the window is measured in hours, and the
// clients only need a nudge to refetch their thread list.
function startThreadArchiver() {
  const run = async () => {
    try {
      for (const serverId of await archiveIdleThreads()) {
        io.to(`server:${serverId}`).emit('server:threads-changed', { serverId });
      }
    } catch (error) {
      console.error('[threads] archive sweep failed', error);
    }
  };
  run();
  const timer = setInterval(run, 5 * 60_000);
  timer.unref();
  return timer;
}

// Postgres is the only store now: apply pending migrations before accepting
// traffic so a stale schema fails at boot instead of mid-request.
async function start() {
  await migrate();
  // Now that the schema exists, the sweeps can safely run their first tick.
  startScheduler(io);
  // The outbox lives in Postgres, so the drainer can only start once the table
  // is there. It flushes anything queued before the last restart on its first
  // pass instead of waiting for the interval.
  startMailer();
  // Announce the marketing pages to IndexNow when they actually changed. This
  // runs after migrate() because it reads seo_state, and it does nothing when
  // the newest page mtime is not newer than the last submission - a restart is
  // not a content change.
  const seoOrigin = String(process.env.PUBLIC_URL || '').replace(/\/$/, '');
  if (seoOrigin) {
    require('./indexnow')
      .notifyIfChanged({ origin: seoOrigin, landingDir })
      .then((result) => {
        if (!result.skipped) {
          console.log('[seo] indexnow', result.ok ? 'accepted' : result.detail);
        }
      })
      .catch((error) => console.error('[seo] indexnow failed', error.message));
  }
  require('./reminderScheduler').startReminderScheduler(io);
  // Purely in memory: the socket is all it needs, so it can start before the
  // database work above.
  require('./nowPlaying').start(io);
  await reconcileCounters();
  const backfilled = await reconcileUploadBytes();
  if (backfilled) console.log(`[storage] backfilled bytes for ${backfilled} upload(s)`);
  // Behind a reverse proxy the app has no reason to accept connections from
  // the network: the proxy reaches it on loopback, and anything else is either
  // a bypass of TLS or an accident. HOST is opt-in for the direct-exposure case.
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => {
    console.log(`Cordia API listening on http://${host}:${port}`);
    startRetention();
    startThreadArchiver();
  });
}

start().catch((error) => {
  console.error('[server] startup failed', error);
  process.exit(1);
});

function shutdown() {
  io.close();
  // Gateway events are written in batches; drain the queue so a clean stop does
  // not lose the last quarter second of bot history.
  const drained = require('./bots').flushGatewayWrites();
  server.close(() => {
    Promise.resolve(drained).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
