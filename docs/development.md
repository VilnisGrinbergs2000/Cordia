# Development

This guide is for changing Cordia: where the code lives, how to run it while editing, and the conventions that keep server and client consistent.

Read [Architecture](architecture.md) first if you have not. It explains the request path and the pieces this document assumes you know.

## Repository map

```text
Cordia/
├── client/                  React 19 + Vite 8 web app
│   ├── src/
│   │   ├── components/      UI components (JSX)
│   │   ├── styles/          Plain CSS, imported through styles.css
│   │   ├── api.js           HTTP wrapper
│   │   ├── runtime.js       API/socket origins, asset URLs
│   │   ├── Shell.jsx        Main signed-in layout and socket handlers
│   │   ├── e2ee.js          Key management and encrypted DM sessions
│   │   └── voice.js         WebRTC peer connections and media
│   ├── public/              Manifest, service worker, icons
│   └── scripts/             Twemoji sync, icon generation, bundle check
├── server/
│   └── src/
│       ├── index.js         Express/Socket.IO wiring and startup
│       ├── routes/          Feature routers mounted under /api
│       ├── pg/              Pool, transactions, migrations, read model
│       ├── socket.js        People namespace: presence, typing, voice
│       ├── bots.js          Bot platform and /gateway namespace
│       ├── permissions.js   Server/channel authorization
│       ├── util.js          Serializers and shared helpers
│       └── *.js             Jobs and domain helpers
├── landing/                 Marketing and legal pages (static HTML/CSS/JS)
├── electron/                Desktop main process, preload, updater
├── android/  ios/           Capacitor native shells
├── scripts/                 Installer build
└── docs/                    These documents
```

The project is JavaScript only. The server is CommonJS (`require`); the client is ESM (`import`). There is no TypeScript build step.

## Setup loop

Follow [Getting started](getting-started.md) through the first run, then:

```bash
npm run dev
```

That runs the server with `node --watch` and Vite with hot module replacement. Server changes restart the process; client changes hot-reload the page. PostgreSQL migrations run at server startup, so a new migration is applied when the server restarts.

Useful companions:

```bash
# API only
npm --prefix server run dev

# Client only (expects an API on 3001)
npm --prefix client run dev

# Production-mode smoke test
npm run build && npm start
```

## Scripts

### Root

| Script | Does |
| ------ | ---- |
| `install:all` | Installs root, server, and client dependencies. |
| `dev` | Runs API and Vite together. |
| `build` | Builds the web client into `client/dist`. |
| `build:check` | Builds and reports bundle sizes. |
| `build:desktop` | Builds the client in desktop mode. |
| `start` | Runs the API in production mode. |
| `desktop:dev` | API + Vite + Electron pointed at the dev server. |
| `desktop:attach` | Electron against an already running Vite server. |
| `desktop:build` | Desktop client + packaged app for the current OS. |
| `desktop:installer` | Windows NSIS installer and optional update feed. |
| `desktop:pack` | Unpacked directory build, useful for debugging packaging. |
| `mobile:build` | Mobile client build + `cap sync`. |
| `mobile:sync` | Copy the web build into the native projects. |
| `mobile:android` / `mobile:ios` | Open the native IDE. |

### Client

| Script | Does |
| ------ | ---- |
| `dev` | Sync Twemoji if needed, then Vite. |
| `build` | Sync Twemoji, then production build. |
| `build:check` | Production build plus `scripts/check-bundle.mjs`. |
| `build:desktop` | `vite build --mode desktop`. |
| `build:mobile` | `vite build --mode mobile`. |
| `preview` | Serve the built app locally. |

### Server

| Script | Does |
| ------ | ---- |
| `dev` | `node --watch src/index.js`. |
| `start` | `node src/index.js`. |

## Server conventions

### Route modules

A router is a normal Express `Router` with `authRequired` on anything that needs a session. The pattern:

```js
'use strict';
const express = require('express');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query, withTransaction } = require('../pg/pool');
const { authRequired } = require('../auth');
const { trim, getMembership } = require('../util');

const router = express.Router();

router.post('/things', authRequired, asyncHandler(async (req, res) => {
  const name = trim(req.body.name);
  if (!name) return res.status(400).json({ error: 'Name is required.' });

  const row = await withTransaction(async () => {
    const inserted = await query(
      'INSERT INTO things (user_id, name, created_at) VALUES ($1, $2, $3) RETURNING id',
      [req.user.id, name, Date.now()]
    );
    return inserted.rows[0];
  });

  req.app.get('io').to(`user:${req.user.id}`).emit('thing:created', { id: Number(row.id) });
  res.status(201).json({ thing: { id: Number(row.id), name } });
}));

module.exports = router;
```

Rules that matter:

- **Always use `asyncHandler`.** Express 5 forwards rejected promises from async handlers, but the wrapper keeps every route on the same explicit error path and makes the intent clear during review.
- **Always parameterize SQL.** `query('... WHERE id = $1', [id])`, never string interpolation.
- **Use `withTransaction` for multi-write operations.** It stores the client in `AsyncLocalStorage`, so helpers called inside it join the same transaction instead of checking out a second connection.
- **Check authorization on the server.** Use `assertChannelAccess`, `hasServerPermission`, `getMembership`, or the resource owner check. The client mirrors the rules only to hide controls.
- **Return the serializer, not the row.** `serializeMessage`, `buildServer`, `publicUser`, and friends keep the client contract stable and avoid leaking columns such as password hashes.
- **Emit after commit.** A socket event sent inside an uncommitted transaction can describe a row that later rolls back.
- **IDs are `bigint`.** Convert with `Number(row.id)` before putting them in JSON; the pool parses `int8` to numbers, but explicit conversion keeps arithmetic predictable.
- **Timestamps are epoch milliseconds.** Use `Date.now()`, and store them in `bigint` columns.

Mount the router in `server/src/index.js` under `/api`. Order rarely matters because route paths are distinct, but keep public link handlers (such as `/api/email/*`) ahead of the SPA catch-all.

### Errors and logging

- Validation failures: `400` with a sentence a person can act on.
- Missing or invisible resources: `404`, not `403`, when existence itself is private.
- Permission failures: `403`.
- Rate limits: `429`. Include `retryAfter` when you know it.
- Unexpected errors: throw. The app-level handler logs and returns `500 { "error": "Something went wrong." }`.

Do not log message content, tokens, passwords, or key material. Log identifiers and error messages.

### Authorization

The resolvers live in `server/src/permissions.js`. If you add a permission:

1. Add it to `server/src/permissionCatalog.js` with a label and description.
2. Decide whether it is server-level, channel-overrideable, or both.
3. Enforce it in every route that performs the action, not only in the UI.
4. Mirror it in `client/src/permissions.js` so the control is hidden or disabled.
5. Add it to the group editor if it should be assignable.

Owners and admins bypass group permissions; do not special-case them in a route.

### Migrations

Migrations are numbered SQL files in `server/src/pg/migrations/`:

```text
049_add_something.sql
```

- The runner matches `^\d+_[A-Za-z0-9_]+\.sql$`, sorts by number, and applies each pending file in its own transaction under a Postgres advisory lock.
- **Never edit an applied migration.** The runner records only the version; an edited file is not re-run, and another environment may have the old shape. Add a new file.
- Use the next free number. Check the directory before choosing.
- Write idempotent SQL where practical (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) so a retry after a partial manual fix is safe, but do not rely on it to repair a failed transaction.
- Use `bigint` for IDs, counters, and epoch-millisecond timestamps.
- Add indexes for every foreign key and every sort/filter the query uses.
- Backfill large tables in batches rather than one long `UPDATE`.
- Do not drop a column in the same release that stops writing it; deploy the code change first, then drop it.

Apply migrations by restarting the server, or run the runner directly:

```bash
node -e "require('./server/src/pg/migrate').migrate().then(r=>console.log(r)).finally(()=>process.exit())"
```

There is no down migration. Roll back by restoring a backup.

### Background jobs

Jobs are plain modules started from `start()` in `server/src/index.js` after `migrate()`. If a job can run on more than one process, claim rows atomically (`UPDATE ... WHERE ... RETURNING`) or use a `pg_notify` bridge. See the existing scheduler, mailer, and reminder scheduler for patterns.

Timers should call `.unref()` so they do not keep the process alive during shutdown, and their first tick should be safe on an empty database.

### Socket.IO

The people namespace lives in `server/src/socket.js`. To add an event:

1. Authenticate is already done in the connection middleware; use `socket.data.user`.
2. Validate the payload and re-check authorization. Do not trust the room the socket is in.
3. Broadcast to the narrowest room that should see it (`user:`, `server:`, `thread:`, `voice:`).
4. Document the event in [API](api.md).
5. Add the client handler in `Shell.jsx` (or the relevant module) and clean it up on unmount.

The bot gateway is separate: `server/src/bots.js`, namespace `/gateway`, event name `dispatch`, and a payload of `{ t, d, seq }`. Every dispatch is recorded in `gateway_events` for replay. If you add one, give it an intent and record it through `record()`.

### Configuration

Read configuration from `process.env` at module load, with a sensible default. Do not add a config framework. Document the variable in [Configuration](configuration.md) and in `server/.env.example` in the same change.

Never commit real secrets. Generated files belong in `server/data/`, which is gitignored.

## Client conventions

- **JavaScript and JSX**, not TypeScript. Keep components functional and hooks-based.
- **One API wrapper.** Use `client/src/api.js` so bearer tokens, credentials, error shapes, and upload tokens stay consistent. Do not call `fetch` directly from a component unless there is a specific reason.
- **Runtime URLs.** Use `client/src/runtime.js` for API/socket origins and asset URLs. Do not hardcode `localhost`, and do not assume the app is mounted at `/` (it is at `/app` in production).
- **Styles.** Add rules to the matching file under `client/src/styles/` and import it through `styles.css`. Class names are plain global CSS names; prefix new ones to avoid collisions.
- **State.** `Shell.jsx` owns the socket connection, current server/channel, presence, typing, and call state. Prefer passing down what a component needs over opening a second socket.
- **Permissions.** `client/src/permissions.js` mirrors the server catalog. Hide or disable controls, but never treat that as enforcement.
- **Accessibility.** Buttons need labels; dialogs need focus handling and Escape; images need alt text. The existing `Modal.jsx` and form components are the reference.
- **E2EE.** Do not log plaintext, keys, or ratchet state. Any change to `e2ee.js`, `ratchet.js`, or `deviceUnlock.js` needs a manual two-account test, including a key rotation and a reload.
- **Voice.** Changes to `voice.js` need a real two-browser test with microphone, camera, and screen share. Check mute, deafen, device switching, and a peer reconnect.

### Adding a view

1. Create the component under `client/src/components/` or `client/src/` for a top-level page.
2. Add the route in `App.jsx` (public/auth/admin gates) or the relevant switch in `Shell.jsx`.
3. Fetch data through `api.js`, show a loading state, and handle `401` by returning to sign-in.
4. Add cleanup for timers, observers, and socket listeners.
5. Check the mobile breakpoints in `client/src/styles/responsive.css`.

## Desktop and mobile

### Desktop

```bash
npm run desktop:dev      # live reload with Electron
npm run desktop:pack     # unpacked build in release/
npm run desktop:build    # installer for the current OS
```

The Electron main process is `electron/main.cjs`; the renderer bridge is `electron/preload.cjs`. The packaged app loads the built client over the privileged `cordia://app` scheme. `electron/updater.cjs` reads a generic feed configured by `CORDIA_UPDATE_URL`.

When changing the packaging config, test `npm run desktop:pack` before `desktop:build`; it is much faster and catches missing files.

### Mobile

```bash
npm run mobile:build
npm run mobile:android   # opens Android Studio
npm run mobile:ios       # opens Xcode (macOS only)
```

`capacitor.config.json` points at `client/dist`, uses the `https` Android scheme, and configures local notifications. The mobile build reads `client/.env.mobile`; the Android emulator reaches the host at `http://10.0.2.2:3001`, while a physical device needs your machine's LAN address or a hosted API.

Native sessions use a bearer token in `localStorage` under `cordia:native-token`, sent with `X-Cordia-Client: native`.

## Testing and QA

There is **no automated test suite** in this repository. CI checks that the server parses and the client builds; it does not exercise behaviour. Treat the following manual passes as required for any non-trivial change.

### Smoke test

1. Register a fresh account on a clean database.
2. Create a server and a channel.
3. Send, edit, delete, pin, react, and reply to a message.
4. Reload the page and confirm the state survives.
5. Open a second browser profile, join by invite, and exchange messages.
6. Open a DM and send a message in both directions.
7. Upload an image and a PDF; confirm both render or download.
8. Create a thread and reply in it.
9. Join a voice channel in both browsers and confirm audio; toggle mute, deafen, video, and screen share.
10. Check the admin console as the first account.

### E2EE pass

1. Enable E2EE in a DM between two accounts.
2. Send messages in both directions, including one while the other side is offline.
3. Reload both sides and confirm history decrypts.
4. Rotate keys on one side.
5. Send again: the stale side should be told keys changed, then recover after reload.
6. Test recovery with the recovery code on a third browser.

### Permission pass

1. Create a group that denies `sendMessages` in one channel.
2. Assign it to a member and confirm the composer is disabled and the API refuses a direct post.
3. Add a channel override for a single member and confirm it wins.
4. Confirm an owner can still post.

### API checks

```bash
node --check server/src/index.js   # repeat for every changed server file
curl -fsS http://localhost:3001/api/health
```

CI runs `node --check` across `server/src/**/*.js`, installs both workspaces, and builds the client.

## Debugging

| Problem | Where to look |
| ------- | ------------- |
| Server exits at startup | Log line names the migration or missing `DATABASE_URL`. |
| Route returns 500 | Server log has the stack; the client only sees the generic message. |
| Socket events missing | Check the room membership in `socket.js`, the origin allowlist, and the browser's WebSocket frame log. |
| Uploads 401 | Session cookie missing, or the `?t=` token expired. Reload to refresh it. |
| Slow queries | `psql` with `EXPLAIN ANALYZE`; check that the filter columns are indexed. |
| Client blank page in production | Check `/app` is mounted, the built `client/dist` exists, and the console for CSP violations. |
| Login loops | `NODE_ENV=production` over HTTP, or `CLIENT_ORIGIN` mismatch. |

Useful SQL:

```sql
-- recent migrations
select version, to_timestamp(applied_at / 1000) from schema_migrations order by version desc limit 5;

-- stuck mail
select id, to_email, kind, attempts, last_error from email_outbox where sent_at is null order by id desc limit 10;

-- upload usage
select user_id, count(*), pg_size_pretty(sum(bytes)) from uploads group by user_id order by sum(bytes) desc limit 10;

-- open reports
select id, reason, status, created_at from reports where status = 'open' order by id desc;
```

## Release checklist

1. `git status` is clean except intended changes; no `.env`, `server/data`, uploads, logs, or screenshots.
2. Every new environment variable is in `server/.env.example` and [Configuration](configuration.md).
3. New routes and events are in [API](api.md).
4. New migrations are numbered, forward-only, and tested on a copy of a real database.
5. `npm run install:all`, `npm run build`, and `npm run build:check` pass.
6. The manual smoke/E2EE/permission passes above are done for the affected areas.
7. Version numbers are consistent where they are shown to users (`client/package.json`, `landing/index.html` download link, `electron-builder.yml` artifact naming).
8. The desktop installer, if published, is built and copied to `landing/downloads/` under the exact name the page links to.
9. `LICENSE`, `THIRD_PARTY_NOTICES.md`, and `SECURITY.md` still describe reality.
10. Take a database and files backup before deploying a migration.

## Related documentation

- [Architecture](architecture.md) — the system this code implements.
- [API](api.md) — route and event contracts.
- [Configuration](configuration.md) — environment variables.
- [Deployment](deployment.md) — running it for real.
- [Contributing](../CONTRIBUTING.md) — how to propose and submit changes.
