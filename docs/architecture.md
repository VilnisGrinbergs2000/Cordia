# Architecture

This document explains what Cordia is made of, what happens between a click and a database row, and where the boundaries are. It is the map to read before changing anything substantial.

## Overview

Cordia is a single Node.js service with a PostgreSQL database. The same process serves the API, the realtime gateway, the built React client, and the marketing pages.

```
┌─────────────────────────────────────────────────────────────────────┐
│ Client                                                              │
│  React SPA (browser) · Electron shell · Capacitor Android/iOS       │
│  Socket.IO client · WebRTC · Web Crypto / hash-wasm                 │
└───────────────┬─────────────────────────────────────────────────────┘
                │ HTTPS, WebSocket
                ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Node.js process                                                     │
│                                                                     │
│  Express                                                            │
│   /api/*        feature routers                                     │
│   /uploads/*    authenticated files                                 │
│   /             landing site (static HTML/CSS/JS)                   │
│   /app          built React client                                  │
│                                                                     │
│  Socket.IO                                                          │
│   /             people: presence, typing, chat, voice signalling    │
│   /gateway      bots: authenticated dispatches and interactions     │
│                                                                     │
│  Background work                                                    │
│   mail outbox · scheduled messages · reminders · retention         │
│   thread archiver · now-playing sweep · bot gateway pruner          │
└───────────────┬─────────────────────────────────────────────────────┘
                │ pg Pool + LISTEN/NOTIFY
                ▼
┌─────────────────────────────────────────────────────────────────────┐
│ PostgreSQL                                                          │
│  users, servers, channels, messages, DMs, E2EE keys, uploads,       │
│  bots, read state, reports, mail outbox, rate-limit buckets, ...    │
└─────────────────────────────────────────────────────────────────────┘
```

There is no Redis, no message broker, and no object store in the default deployment. Postgres is both the system of record and (for the few cross-process paths) the notification bus.

## Runtime topology

| Component | Entry point | Responsibility |
| --------- | ----------- | -------------- |
| API | `server/src/index.js` | Express wiring, security middleware, static mounts, startup, shutdown |
| Feature routers | `server/src/routes/*.js` | HTTP endpoints, validation, authorization, response shapes |
| Realtime | `server/src/socket.js` | Socket authentication, rooms, presence, typing, voice signalling |
| Domain helpers | `server/src/*.js` | Permissions, DMs, threads, emotes, invites, uploads, mail, push, safety |
| Postgres layer | `server/src/pg/` | Pool, transaction context, migration runner, reconciliation |
| Client | `client/src/` | React SPA, API wrapper, Socket.IO client, E2EE, voice, PWA |
| Desktop | `electron/` | Window, custom protocol, permissions, tray, overlay, updater |
| Mobile | `android/`, `ios/` | Capacitor shells |
| Marketing | `landing/` | Public pages and legal copy, served by Express |

## Startup sequence

`server/src/index.js` does the wiring before it accepts traffic:

1. **Config** (`server/src/config.js`) resolves `CORDIA_DATA_DIR` and `CORDIA_UPLOADS_DIR`, creates them if needed, and loads or generates the JWT secret. `server/src/pg/env.js` has already filled missing variables from `server/.env` when the first `pg` module was imported.
2. **HTTP app and Socket.IO server** are created. The Socket.IO CORS check accepts configured origins, native origins, and same-host origins.
3. **Middleware** is mounted: Helmet, CORS, an origin guard, cookie parsing, and a 1 MB JSON body limit.
4. **`/uploads/:name`** is mounted before the API. It accepts a scoped upload token or a valid session cookie.
5. **API routers** are mounted under `/api` (see the full list in `server/src/index.js`).
6. **Landing pages** are mounted if `landing/` exists: `/`, `/guidelines`, `/privacy`, `/terms`, `/status`, `/robots.txt`, `/sitemap.xml`, and the static assets.
7. **Client build** is mounted if `client/dist` exists: `/twemoji` with a long cache, `/app` and `/app/*` for the SPA shell, and static assets.
8. **404 and error handlers** answer unknown paths with the landing 404 page (or JSON under `/api`, `/uploads`, `/socket.io`) and turn thrown errors into `{ "error": "..." }`.
9. **`attachSocket(io)`** registers the people namespace. **`bots.attachGateway(io)`** registers the `/gateway` namespace. Both must run before `listen`.
10. **`start()`** runs migrations, then starts the scheduler, mailer, IndexNow notifier, reminder scheduler, and now-playing sweep. It reconciles message counters and upload byte totals, then binds the listener. Retention and the thread archiver start once the listener is up.
11. **Shutdown** closes Socket.IO, drains batched gateway writes, closes the HTTP server, and exits; a 5-second timer is the backstop.

The order matters. Migrations must finish before any timer queries the schema, and socket handlers must be attached before the client's first emit (a client sends `voice:join` on the connection tick).

## HTTP request pipeline

A request to `/api/...` passes through:

1. **Helmet** — cross-origin resource policy is `cross-origin`, CSP is disabled globally because the marketing page uses inline scripts.
2. **CORS** — credentials are allowed only for configured origins.
3. **Origin guard** — a request with an `Origin` header that is neither configured nor same-host is rejected with 403.
4. **Cookie parser** and **JSON parser** (1 MB limit; uploads use multer on their route).
5. **Router** — the matching feature router under `/api`.
6. **`authRequired`** — validates a bot token or a session JWT, loads the user row, rejects banned accounts.
7. **Handler** — validates input, resolves permissions, queries Postgres, emits socket events, and returns JSON.
8. **Error handler** — logs and returns `{ "error": "Something went wrong." }` with status 500, except the CORS message which is 403.

The app shell is served with a stricter CSP than the landing page: `default-src 'self'`, `script-src 'self' 'wasm-unsafe-eval'` (for `hash-wasm`), `connect-src` including KLIPY, `frame-ancestors 'none'`, and `object-src 'none'`. The shell is `no-store` and carries `X-Robots-Tag: noindex, nofollow`.

## Authentication

Cordia has two principal types: people and bots.

### People

- **Registration** hashes the password with bcrypt (cost 11) and creates a session. The first account in the database becomes `role = 'admin'`.
- **Session token** is an HS256 JWT signed with `JWT_SECRET`, valid for 30 days. The payload is `{ sub: userId, ver: tokenVersion }`.
- **Transport** is the `cordia_token` httpOnly cookie, `SameSite=Lax`, `Secure` in production or over HTTPS. Native clients send `X-Cordia-Client: native` and receive the token in the response body; they use `Authorization: Bearer`.
- **Revocation** compares `ver` with `users.token_version`. Bumping the column invalidates every existing session for that account.
- **Sockets** use `handshake.auth.token` or the same cookie. The handshake loads the user row, rejects banned accounts, and stores the row on the socket.
- **Rate limits** are fixed-window counters in the `rate_hits` table. Login failures spend budget; successful logins refund it. The limiter fails open if the database is unreachable, because taking the whole API down during a database incident is worse than skipping a limit.

### Bots

- A bot token is `cordia_` plus 32 random bytes in base64url. The database stores only its SHA-256 hash; the plaintext is shown once.
- `Authorization: Bot <token>` is checked before the session path, so a browser session can never be replayed as a bot.
- The `clientId` is the first 18 characters of the token hash, which identifies the application without being usable as a credential.
- Bots are ordinary `users` rows with `is_bot = 1` and a `server_members` row, plus an `applications` row. They have no password, friends, presence, or voice participation.
- Each application has its own request budget and gateway connection limit.

## Authorization

Authorization is resolved on the server for every route; the client mirrors the same rules to hide controls, but it is not the enforcement point.

The layers are:

1. **Global role** — `users.role = 'admin'` unlocks `/api/admin/*`.
2. **Server membership** — `server_members(server_id, user_id)` is the floor for anything inside a server.
3. **Server groups** — ranked custom groups (`server_groups`) with a permission array. Every member has the default group; assigned groups stack on top. Owners and admins have an implicit override.
4. **Channel overrides** — `channel_overrides` can allow or deny a subset of channel permissions for a member or a group. Deny wins inside one row; an empty allow/deny pair deletes the row.
5. **Resource ownership** — server owners, message authors, thread owners, application owners, and DM participants each get checks appropriate to the resource.

The server permission catalog (`server/src/permissionCatalog.js`) contains:

`manageServer`, `viewServerSettings`, `manageChannels`, `manageGroups`, `manageMessages`, `pinMessages`, `kickMembers`, `sendMessages`, `startThreads`, `attachFiles`, `addReactions`, `connectVoice`, `speak`, `useSoundboard`, `manageSoundboard`, `createEvents`.

Channel overrides can name `viewChannel`, `sendMessages`, `attachFiles`, `addReactions`, `startThreads`, `manageMessages`, `connectVoice`, and `speak`. `viewChannel` has no server-level switch; a channel is visible unless something explicitly hides it.

The resolvers live in `server/src/permissions.js`. Every write path calls the same resolver the payload uses, so the buttons the client hides are the routes the server refuses.

## Database

- **PostgreSQL only.** The schema lives in `server/src/pg/migrations/` as numbered, forward-only SQL files. There is no ORM.
- **Migrations** are applied at boot. The runner takes a Postgres advisory lock, creates `schema_migrations`, and applies each pending file inside its own transaction. A failed migration rolls back and stops startup. Never edit a migration that has been applied; add a new file.
- **Connection pool** is `pg.Pool` with a maximum of 10 connections (`server/src/pg/pool.js`). `int8` values are parsed into JavaScript numbers, because the schema uses `bigint` for every ID and counter.
- **Transactions** use `withTransaction()`, which stores the checked-out client in `AsyncLocalStorage`. A nested call joins the open transaction instead of taking a second connection; this is what lets helpers such as `ensureDefaultGroups` participate in server creation.
- **Timestamps** are `bigint` epoch milliseconds, not `timestamptz`. Ordering and retention are arithmetic on those numbers.
- **IDs** are `bigint` identity columns. JavaScript can represent them safely up to 2^53; that is far beyond the current scale but worth remembering if you import data.

### Data model at a glance

| Area | Tables |
| ---- | ------ |
| Identity | `users`, `friendships`, `user_badges`, `password_resets`, `push_subscriptions`, `uploads` |
| Communities | `servers`, `server_members`, `server_groups`, `server_member_groups`, `group_categories`, `channel_categories`, `channels`, `channel_overrides`, `server_invites`, `invite_joins` |
| Server features | `server_emotes`, `emote_role_access`, `soundboard_sounds`, `server_tiers`, `server_subscriptions`, `server_icon_history`, `server_icon_suggestions`, `server_icon_suggestion_votes`, `server_onboarding`, `server_automod`, `server_events`, `event_rsvps` |
| Messaging | `messages`, `reactions`, `mentions`, `read_states`, `message_edits`, `polls`, `poll_options`, `poll_votes`, `saved_messages`, `scheduled_messages`, `reminders` |
| Threads and docs | `thread_members`, `forum_tags`, `thread_tags`, `docs`, `doc_versions`, `lists`, `list_items` |
| Direct messages | `dm_channels`, `e2ee_key_events`, `e2ee_one_time_prekeys`, `user_notes` |
| Bots | `applications`, `application_commands`, `application_installs`, `application_audit`, `interactions`, `gateway_streams`, `gateway_events`, `gateway_sessions`, `gateway_live` |
| Safety and operations | `audit_logs`, `reports`, `safety_events`, `rate_hits`, `email_tokens`, `email_outbox`, `email_suppressions`, `seo_state`, `voice_participants` |

`server_tiers` and `server_subscriptions` are per-server supporter tiers, not an account-level paid plan. There is no account subscription or billing table in the current schema; migration `039_drop_billing.sql` removed the retired billing table.

## Realtime layer

Socket.IO is attached to the same HTTP server. The people namespace is `/`; bots use `/gateway`.

### Rooms

| Room | Joined when | Used for |
| ---- | ----------- | -------- |
| `user:{id}` | On connect | Direct events: DMs, badges, reminders, interactions, force-mute, scheduled-message results |
| `server:{id}` | On connect, for every membership | Channel messages, typing, presence, server changes, thread list changes |
| `thread:{id}` | On connect, for every thread membership; on thread join | Private thread typing and messages |
| `voice:{channelId}` | On `voice:join` | Peer join/leave/state and local WebRTC signalling |

### Client → server events

| Event | Purpose |
| ----- | ------- |
| `typing` | `{ scopeType: 'channel'|'dm', scopeId }`. Re-checks privacy, membership, thread privacy, and `sendMessages`. |
| `voice:join` | `{ channelId }`. Checks channel type, membership, and `connectVoice`; creates/updates the voice occupancy row. |
| `voice:leave` | Leaves the current voice channel and records voice seconds. |
| `voice:state` | `{ muted, video, sharing }`. `speak` is enforced here too. |
| `webrtc:signal` | `{ to, data }`. Relayed to a peer socket, locally or through Postgres `NOTIFY`. |

### Server → client events

The client registers these in `Shell.jsx` and `voice.js`:

`presence:list`, `presence:update`, `activity:update`, `user:new`, `user:updated`, `user:deleted`, `message:new`, `message:updated`, `message:deleted`, `message:reactions`, `message:poll`, `message:pinned`, `message:unpinned`, `typing`, `server:updated`, `server:threads-changed`, `server:joined`, `server:member-joined`, `server:member-left`, `server:deleted`, `channel:created`, `channel:deleted`, `dm:new`, `friends:changed`, `badge:awarded`, `badges:updated`, `reminder:due`, `interaction:modal`, `voice:occupancy`, `voice:occupancy:init`, `voice:participants`, `voice:peer-joined`, `voice:peer-left`, `voice:peer-state`, `voice:force-mute`, `voice:error`, `voice:closed`.

Presence is process-local by design: `server/src/presence.js` keeps a socket count and an “appear offline” set in memory. “Connected” and “visible” are separate answers, so a person who chose to appear offline is still reachable for calls and push but is reported offline in lists.

## Voice, video, and screen share

- Media is **peer-to-peer WebRTC mesh**. There is no SFU in the default stack. Each participant creates a peer connection to every other participant, so bandwidth and CPU grow with call size.
- **ICE configuration** comes from `GET /api/voice/ice`. STUN is always returned; TURN is added when configured. A shared `TURN_SECRET` produces time-limited HMAC credentials.
- **Signalling** travels over Socket.IO (`webrtc:signal`). If the peer is in the local process, the offer never leaves it. Otherwise `voiceBridge.js` publishes it through `pg_notify('cordia_voice_signal', ...)` and every process relays it to its local sockets.
- **Occupancy** is stored in `voice_participants`, not just in an in-memory map. The table makes the participant list survive restarts and lets another process see the same channel. Rows older than 90 seconds are treated as stale (three missed transport heartbeats).
- **Heartbeat:** the engine.io transport emits `heartbeat` about every 25 seconds; the server refreshes the participant row. Rust's socketioxide has no equivalent hook, which is why the Rust port uses a timer instead.
- **Voice seconds** are accumulated on leave and can award the `voice_veteran` badge after an hour.
- **Screen share** is a WebRTC track replacement. The client offers quality and FPS controls; the server only relays signalling.

## End-to-end encrypted DMs

E2EE is implemented in the client (`client/src/e2ee.js`, `client/src/ratchet.js`) and validated, but not decrypted, by the server.

- **Identity** is an ECDH P-256 key pair generated on the client. The public key, signing key, signed prekey, and key version are published to the server. The private material is wrapped with a password-derived key (PBKDF2 or Argon2id via `hash-wasm`) and backed up encrypted.
- **Session setup** uses an X3DH-style bundle: identity key, signed prekey, one-time prekey, and signatures. One-time prekeys are handed out exactly once.
- **Message encryption** uses a double ratchet with P-256 and AES-256-GCM. A v2 envelope carries the ratchet header (`dh`, `pn`, `n`), IV, ciphertext, and optional X3DH material. A v1 envelope is still accepted for older clients.
- **Server validation** (`server/src/routes/dms.js`) checks the conversation, sender, recipient, key versions, IV/ciphertext bounds, and header shape. A stale key version returns `E2EE_KEY_CHANGED` instead of storing an unreadable message. The server never sees plaintext.
- **Attachments** are encrypted client-side before upload; the message envelope carries the key material needed by the recipient.
- **Key history** is a SHA-256 hash chain in `e2ee_key_events`. Each row hashes `previous|userId|version|publicKey|type|createdAt`. A rotation appends; a tampered history is detectable. `headHash` is the newest row's hash, which is why history is read newest-first and then reversed.
- **Recovery** uses a verifier and an encrypted backup, with a short-lived, hashed reset token. The server cannot recover plaintext without the user's secret.

Channels are **not** end-to-end encrypted. A database administrator can read channel messages, uploads, profiles, and server content. Say so plainly in your own deployment's privacy policy.

## Uploads and storage

1. The client posts a file to `POST /api/upload` with the session cookie or native bearer token.
2. `multer` writes it to `CORDIA_UPLOADS_DIR` with a random UUID name and an extension derived from the MIME type. The MIME allowlist is images, MP4/WebM video, MP3/OGG/WAV/WebM audio, PDF, ZIP, and plain text.
3. The account gets 50 MB per file and 5 GB total. The quota check locks the user row, sums `uploads.bytes`, and rejects over-quota writes with `413 STORAGE_FULL`. There is no paid upgrade and no higher tier.
4. The row is recorded in `uploads` so the retention sweeper can find files that were never attached to a message, avatar, icon, banner, emote, sound, or suggestion.
5. `<img>`, `<video>`, and `<audio>` cannot send an Authorization header, so the client appends a scoped token to `/uploads/...` URLs. The token is `userId.expires.HMAC-SHA256("uploads:userId:expires")`, valid for 7 days. A valid session cookie is accepted as an alternative.
6. `GET /uploads/:name` checks the token or session, rejects unsafe names and dotfiles, sets `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`, and serves with a private, immutable one-week cache.
7. The retention pass removes orphaned uploads older than 24 hours, including the file and its row.

Uploads are access-controlled, but not encrypted at rest. If you need that, put the uploads directory on an encrypted volume or add server-side encryption.

## Background jobs

| Job | Interval | What it does |
| --- | -------- | ------------ |
| Scheduled messages (`scheduler.js`) | 15 s | Delivers `scheduled_messages` whose time has come. Re-checks channel, membership, `sendMessages`, and automod; drops the row with a reason if anything changed. |
| Mail outbox (`mail.js`) | 15 s | Claims due rows with an attempts compare-and-set, sends through nodemailer, retries with backoff, suppresses hard bounces, and expires messages older than 24 h. |
| Reminders (`reminderScheduler.js`) | 30 s | Claims due reminders with `UPDATE ... RETURNING`, then publishes `reminder:due` through `pg_notify('cordia_reminder_due', ...)` so the process holding the socket can deliver it. |
| Retention (`retention.js`) | 6 h | Deletes audit logs and reports past their retention window and orphaned uploads older than 24 h. |
| Thread archiver (`index.js` + `threads.js`) | 5 min | Archives idle threads and emits `server:threads-changed`. |
| Now playing (`now_playing.rs` equivalent: `nowPlaying.js`) | In-memory sweep | Expires “listening to” activity after a few minutes. Memory only, per process; a crash cannot leave a track frozen on a profile. |
| Bot gateway pruner (`bots.js`) | Periodic | Removes replay events, expired sessions, and stale live sockets. |
| Counter reconciliation (`pg/reconcile.js`) | At boot | Recomputes message counters and upload byte totals so historical drift is corrected once per start. |

## Bot platform

An application is created in **Settings → Developers**. It gets:

- A bot `users` row with `is_bot = 1`, no password, and a bot tag in the client.
- A token shown once, stored as SHA-256.
- A `clientId` derived from the token hash.
- Commands with descriptions, options, permissions, and translations.
- An install row per server it is added to.

Bots use two surfaces:

1. **REST** under `/api`, authenticated with `Authorization: Bot <token>`. `GET /api/guilds`, `/guilds/{id}`, `/members`, `/channels`, and `/roles` expose the installed server. `GET /api/applications/@me` identifies the bot.
2. **Gateway** at the Socket.IO namespace `/gateway`, authenticated with the bot token. Events are gated by the `messages`, `reactions`, and `members` intents. Each dispatch has a sequence number and is replayable from `gateway_events`; `gateway_sessions` and `gateway_live` track resumability and concurrency. The Postgres `cordia_gateway` bridge lets a dispatch reach the process that owns the bot socket.

Interactions are single-use tokens stored in `interactions`:

- `INTERACTION_CREATE` is dispatched to the application.
- The bot answers at `POST /api/interactions/{id}/callback` with its bot token and the interaction token.
- Components, modals, autocomplete, follow-ups, and ephemeral replies all go through the same claim (`responded_at IS NULL`), so two concurrent answers cannot both post.
- An ephemeral reply is emitted only to `user:{id}` with a negative message ID; it never touches the `messages` table.
- A modal is stored with a 15-minute expiry and its `{user}`, `{channel}`, `{server}` placeholders are filled from the person who opened it, not from the bot.

## Frontend

The client is React 18 with Vite 6 and React Router 6. It is JavaScript and JSX, not TypeScript.

- **Bootstrap** — `App.jsx` calls `/api/auth/me`, applies theme preferences, and decides between the auth page, the invite page, the application authorize page, the admin console, the insights page, and the main `Shell`.
- **API wrapper** — `client/src/api.js` attaches the native bearer token, sends credentials appropriately, converts non-2xx responses into `Error` objects with `status` and optional `code`, stores the native session token, and keeps the upload token fresh.
- **Runtime** — `client/src/runtime.js` resolves `API_BASE` and `SOCKET_URL` from the Electron bridge or Vite variables, and builds asset URLs with the upload token.
- **Shell** — `Shell.jsx` owns the single Socket.IO connection, server/channel/DM state, presence, typing, unread state, call state, and most of the event handlers.
- **E2EE** — `e2ee.js` manages identity, unlock/lock, prekey replenishment, session setup, encryption/decryption queues, and caches. `ratchet.js` contains the cryptographic primitives. `deviceUnlock.js` handles remembered device identity.
- **Voice** — `voice.js` owns `RTCPeerConnection`s, local media, device selection, mute/deafen, screen share, analysers, and signalling.
- **Styling** — plain CSS files in `client/src/styles/` (`base`, `layout`, `chat`, `views`, `voice`, `theme`, `admin`, `overlay`, `responsive`, `support`, and a few feature sheets), imported through `client/src/styles.css`. There is no CSS framework.
- **PWA** — `client/public/manifest.webmanifest`, `sw.js`, and the push registration path provide installability and background notifications.
- **Native** — `native.js` wraps Capacitor local notifications; `electron/preload.cjs` exposes `window.cordiaDesktop` for API URL, version, updates, overlay, and window controls.

## Desktop and mobile

### Electron

- `electron/main.cjs` creates the window, registers the privileged `cordia://app` scheme, grants microphone/camera/screen-capture/notification permissions only to trusted origins, and manages the tray, global shortcuts, notifications, and the always-on-top game overlay.
- The packaged app loads the built client from `client/dist` over `cordia://app`; the preload bridge exposes a narrow API.
- `electron/updater.cjs` uses `electron-updater` against a generic feed. `CORDIA_UPDATE_URL` produces `latest.yml` during the installer build.

### Capacitor

- `capacitor.config.json` points at `client/dist`, uses the `https` Android scheme, and configures local notifications.
- Native sessions use the bearer token stored in `localStorage` under `cordia:native-token`; the client sends `X-Cordia-Client: native`.
- The mobile build reads `client/.env.mobile`; the Android emulator reaches the host at `http://10.0.2.2:3001`.

## Marketing site and routing

The landing pages are plain HTML, CSS, and JavaScript in `landing/`. Express serves them before the client bundle so `/` is the marketing page and `/app` is the application. Notable routes:

| Route | Response |
| ----- | -------- |
| `/` | `landing/index.html` |
| `/pricing` | 301 to `/` (there is no separate pricing page) |
| `/guidelines`, `/privacy`, `/terms`, `/status` | Long-form pages; `.html` and trailing-slash variants redirect to the clean path |
| `/downloads/*` | Static files if present, otherwise a real 404 (never the app shell) |
| `/app`, `/app/*` | SPA shell with the app CSP |
| `/invite/:code`, `/authorize` | 301 to the same path under `/app` |
| `/twemoji/*` | Emoji artwork from the client build, cached for 30 days |
| `/robots.txt`, `/sitemap.xml` | Generated from `PUBLIC_URL` and the page mtimes |
| unknown | `landing/404.html` (JSON under API paths) |

## Security model

- **Passwords:** bcrypt cost 11.
- **Sessions:** httpOnly, SameSite=Lax, Secure in production, 30-day expiry, versioned for revocation.
- **CSRF:** no separate token; state-changing API requests rely on SameSite cookies, the Origin guard, CORS, and JSON content types. If you add form-encoded state-changing routes, add explicit CSRF protection.
- **Uploads:** MIME allowlist, size caps, server-generated names, path checks, scoped capability tokens, and an authenticated read route.
- **E2EE:** server stores public keys and envelopes only; private keys and plaintext stay on the client.
- **Bot tokens:** SHA-256 at rest, separate authentication path, per-application budgets.
- **Rate limits:** database-backed fixed windows for auth, uploads, messages, bot requests, bundles, reports, and other expensive routes. `TRUST_PROXY` must be correct or per-IP limits can be spoofed.
- **Headers:** Helmet on all responses; app shell CSP; `nosniff` and `no-referrer` on uploads; `frame-ancestors 'none'`.
- **Secrets:** generated secrets are written with mode `0600`; `.env`, `server/data/`, and `server/uploads/` are gitignored.
- **Admin actions:** role-gated, audited in `audit_logs`, and account deletion releases counters and removes uploads after the transaction commits.

## Scaling and multi-process behaviour

The supported default is **one Node.js process**. It is enough for a self-hosted community and avoids coordination that has not been built.

What already spans processes through Postgres `LISTEN/NOTIFY` or row claims:

- Voice signalling and peer join/leave/state (`cordia_voice_signal`, `cordia_voice_peer`).
- Bot gateway dispatches (`cordia_gateway`).
- Reminders (`cordia_reminder_due`).
- Mail delivery (rows are claimed with an attempts compare-and-set).
- Reminder claims (`UPDATE ... RETURNING`).

What does **not** span processes yet:

- Ordinary chat, typing, and presence broadcasts use Socket.IO rooms without a shared adapter. A second process would not deliver `message:new` to sockets connected to the first. A Redis adapter (or another Socket.IO adapter) would be needed.
- Scheduled-message delivery selects due rows without a claim, so two processes could post the same scheduled message.
- The thread archiver and retention sweeper are safe to run repeatedly but are not coordinated.

If you need horizontal scaling, add a Socket.IO adapter and a single-owner job runner first. Do not run multiple API processes behind a load balancer with the current defaults.

## Where to start reading

| If you want to understand… | Read |
| -------------------------- | ---- |
| Server wiring and route order | `server/src/index.js` |
| Auth, cookies, rate limiting | `server/src/auth.js` |
| Permission resolution | `server/src/permissions.js`, `server/src/permissionCatalog.js` |
| Message serialization and shared helpers | `server/src/util.js` |
| Socket rooms, presence, typing, voice | `server/src/socket.js`, `server/src/presence.js`, `server/src/voicePresence.js` |
| DMs and E2EE validation | `server/src/routes/dms.js`, `server/src/routes/e2ee.js`, `server/src/e2eeKeys.js` |
| Uploads | `server/src/routes/upload.js`, `server/src/uploads.js`, `server/src/retention.js` |
| Bots and the gateway | `server/src/bots.js`, `server/src/botToken.js`, `server/src/routes/applications.js`, `server/src/routes/interactions.js` |
| Client bootstrap and state | `client/src/App.jsx`, `client/src/Shell.jsx`, `client/src/api.js` |
| E2EE client | `client/src/e2ee.js`, `client/src/ratchet.js`, `client/src/deviceUnlock.js` |
| Voice client | `client/src/voice.js`, `client/src/call.js` |
| Desktop shell | `electron/main.cjs`, `electron/preload.cjs`, `electron/updater.cjs` |
| Schema | `server/src/pg/migrations/` |

## Related documentation

- [Configuration](configuration.md) — every setting referenced above.
- [HTTP and realtime API](api.md) — endpoint and event contracts.
- [Deployment](deployment.md) — turning this architecture into a running service.
- [Development](development.md) — conventions and workflows.
