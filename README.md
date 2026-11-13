<div align="center">

<img src="images/codi_mascot.png" alt="Codi, the Cordia mascot" width="132" />

# Cordia

**A self-hosted realtime community platform: servers, channels, threads, forums, direct messages with end-to-end encryption, voice and video, bots, and an admin console.**

[Live demo](https://cordia.ext.io) · [Documentation](docs/README.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

[![CI](https://github.com/VilnisGrinbergs2000/Cordia/actions/workflows/ci.yml/badge.svg)](https://github.com/VilnisGrinbergs2000/Cordia/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/node-22%2B-339933.svg)](https://nodejs.org/)
[![PostgreSQL 14+](https://img.shields.io/badge/postgresql-14%2B-4169E1.svg)](https://www.postgresql.org/)

</div>

Cordia is a complete, self-hostable chat application. One Node.js process serves the HTTP API, the Socket.IO gateway, the React client, and the marketing site; PostgreSQL is the only data store.

There is no paid tier, no checkout, and no feature gating. Every feature is available to every account: no limits on messages, history, search, servers, channels, threads, or DMs. The only ceilings are technical storage limits — 50 MB per upload and 5 GB per account — and they apply equally to everyone.

The public instance at **<https://cordia.ext.io>** runs this code.

## Contents

- [Features](#features)
- [Stack](#stack)
- [Quick start](#quick-start)
- [Documentation](#documentation)
- [How it fits together](#how-it-fits-together)
- [Project layout](#project-layout)
- [Deploying](#deploying)
- [Project status and limitations](#project-status-and-limitations)
- [Contributing](#contributing)
- [License](#license)

## Features

- **Communities** — create servers with categories, text, voice, and stage channels, custom invite codes, descriptions, icons, banners, and a public discovery directory.
- **Roles and permissions** — ranked custom groups with colors, member-list sections, a 16-permission server matrix, and per-channel overrides. Permissions are resolved on the server, so the buttons the client hides are the routes the API refuses.
- **Realtime chat** — Socket.IO messaging, typing indicators, replies, edits, edit history, deletion, reactions, polls, pins, attachments, voice notes, forwarding, infinite scroll, drafts, jump-to-present, unread state, and search.
- **Threads and forums** — private threads that archive after an idle window, forum channels with tags, per-thread membership, and pinned posts.
- **Direct messages and friends** — one-to-one DMs, friend requests, blocking, presence, calls, and per-conversation privacy.
- **End-to-end encrypted DMs** — X3DH-style session setup, a double ratchet, P-256 keys, AES-256-GCM, one-time prekeys, key-history hash chains, encrypted attachments, and password-derived encrypted backups. The server stores envelopes, never plaintext.
- **Voice, video, and screen share** — peer-to-peer WebRTC with mute/deafen, device selection, input/output processing, camera preview, screenshare quality controls, a floating voice dock, and a participant grid.
- **Attention and inbox** — server-backed read state, mentions, a catch-up summary, mute per conversation, and unread counts in the page title.
- **PWA, desktop, and mobile** — installable PWA with Web Push, an Electron desktop shell with tray notifications, game overlay, and auto-updates, and Capacitor Android/iOS shells with native local notifications.
- **Applications and bots** — create an application, mint a bot token, install it into servers, connect to the `/gateway` socket, register slash commands, send buttons and selects, open modals, handle autocomplete, and receive message, reaction, and member events by intent.
- **Moderation and safety** — automod rules, spam and mass-DM throttling, a predatory-DM warning flow, member reports, an admin review queue, audit logs, suspensions, and account deletion.
- **Admin console** — workspace analytics, activation and retention cohorts, user and server management, badge grants, safety reports, mail and broadcast tools, and an audit trail.
- **Personal tools** — saved messages, reminders, shared lists, versioned channel docs, server events and RSVPs, soundboards, custom emotes, and per-server profiles.

## Stack

| Layer | Technology |
| ----- | ---------- |
| Client | React 18, Vite 6, React Router 6, Socket.IO client, `lucide-react`, `hash-wasm` |
| API | Node.js 22+, Express 4, Socket.IO 4, PostgreSQL (`pg`), JWT, bcryptjs, multer, nodemailer, `web-push`, Helmet |
| Realtime | Socket.IO rooms for chat and signalling, WebRTC for media |
| Data | PostgreSQL 14+; forward-only SQL migrations applied on boot |
| Desktop | Electron 45, electron-builder, `electron-updater`, custom `cordia://app` protocol |
| Mobile | Capacitor 8 (Android/iOS), `@capacitor/local-notifications` |
| Marketing | Static HTML, CSS, and vanilla JavaScript served by the same Express process |

## Quick start

**Requirements:** Node.js 22+ (24 LTS recommended), PostgreSQL 14+, and a modern browser for WebRTC.

```bash
git clone https://github.com/VilnisGrinbergs2000/Cordia.git
cd Cordia

# 1. Install root, server, and client dependencies
npm run install:all

# 2. Create a database (or use an existing PostgreSQL server)
createdb cordia

# 3. Configure the API
cp server/.env.example server/.env
#    Edit DATABASE_URL in server/.env if your database is not localhost/cordia

# 4. Run the API and Vite dev server together
npm run dev
```

Open **http://localhost:5173**. The API listens on **http://localhost:3001**; Vite proxies `/api`, `/uploads`, and `/socket.io` to it.

The **first account that registers becomes the workspace administrator** and receives the Founder badge. Every later account is a regular member. The admin console is at `/admin` or via the shield icon in the server rail.

For production:

```bash
npm run build   # builds client/dist
npm start       # serves the API, landing page, and app on PORT (default 3001)
```

The marketing page is at `/`; the application is at `/app`. See [Getting started](docs/getting-started.md) for database setup, environment details, and troubleshooting, and [Deployment](docs/deployment.md) for a production checklist.

## Documentation

| Document | What it covers |
| -------- | -------------- |
| [Getting started](docs/getting-started.md) | Prerequisites, database setup, environment, running in development and production, first-run checklist, troubleshooting |
| [Configuration](docs/configuration.md) | Every environment variable, defaults, generated secrets, client build variables, and data locations |
| [Architecture](docs/architecture.md) | How the API, database, realtime layer, voice, E2EE, uploads, jobs, bots, and clients fit together |
| [HTTP and realtime API](docs/api.md) | API conventions, authentication, error shapes, route groups, Socket.IO events, and the bot gateway |
| [Deployment](docs/deployment.md) | Production builds, reverse proxies, systemd, TLS, backups, mail, push, TURN, and upgrades |
| [Development](docs/development.md) | Repository map, scripts, conventions, migrations, desktop/mobile builds, and release steps |
| [Contributing](CONTRIBUTING.md) | How to propose changes, coding expectations, and the review process |
| [Security policy](SECURITY.md) | How to report a vulnerability and what is in scope |
| [Code of conduct](CODE_OF_CONDUCT.md) | Community expectations and enforcement |
| [Third-party notices](THIRD_PARTY_NOTICES.md) | Artwork, fonts, and dependency licenses |

## How it fits together

```
Browser / Electron / Capacitor
          │
          │  HTTPS + WebSocket
          ▼
┌────────────────────────────────────────────┐
│ Node.js process                            │
│  Express: /api, /uploads, /app, landing    │
│  Socket.IO: / (people), /gateway (bots)    │
│  Background: mail, reminders, retention    │
└──────────────────┬─────────────────────────┘
                   │ SQL + LISTEN/NOTIFY
                   ▼
             PostgreSQL
```

- **One data store.** PostgreSQL holds users, servers, channels, messages, read state, keys, uploads, bots, and the mail outbox. There is no second database and no ORM.
- **One process for the web app.** Express mounts the API first, then the marketing site, then the built client under `/app`, and finally a real 404 handler.
- **Realtime is rooms, not polling.** Every socket joins `user:{id}` and each `server:{id}` and `thread:{id}` it can see. Voice uses `voice:{channelId}`. Postgres `NOTIFY` bridges voice signalling, bot dispatches, and reminders across processes; ordinary chat rooms are process-local, so the supported deployment is one API process.
- **Encryption stays on the client.** DM keys are generated and stored in the browser (or encrypted at rest with a device/account secret). The server validates and relays envelopes.
- **Media is peer-to-peer.** Voice, video, and screen share use WebRTC mesh connections; Socket.IO carries offers, answers, and ICE candidates. TURN is optional but recommended for restrictive networks.
- **Migrations are the schema.** `server/src/pg/migrations/*.sql` are applied in order on boot under a Postgres advisory lock.

## Project layout

```
client/                 React SPA (Vite)
  src/                  pages, components, hooks, styles, E2EE and voice logic
  public/               icons, manifest, service worker assets
server/                 Node.js API
  src/index.js          Express wiring, static mounts, startup and shutdown
  src/routes/           one router per feature area
  src/pg/migrations/    forward-only SQL schema
  src/socket.js         presence, typing, voice signalling
  src/bots.js           bot tokens and the /gateway namespace
landing/                marketing site, legal pages, status page
electron/               desktop shell, preload bridge, updater, overlay
android/ ios/           Capacitor native projects
scripts/                installer and release helpers
docs/                   documentation
images/                 logo, mascot, badges
```

## Deploying

The short version:

1. Build the client with `npm run build`.
2. Set `DATABASE_URL`, `JWT_SECRET`, `CLIENT_ORIGIN`, `PUBLIC_URL`, and `NODE_ENV=production`.
3. Run `npm start` behind a TLS reverse proxy.
4. Persist `server/data/`, `server/uploads/`, and PostgreSQL backups.

The full checklist, including Caddy and nginx examples, systemd, VAPID keys, SMTP, TURN, and upgrade notes, is in [Deployment](docs/deployment.md).

## Project status and limitations

Cordia is under active development. The hosted demo and the repository move together, but interfaces may still change between releases.

Known limitations:

- **No automated test suite is included.** CI builds the client and syntax-checks the server. Manual QA checklists live in [Development](docs/development.md). Contributions that add tests are especially welcome.
- **Background jobs assume one API process.** Scheduled-message delivery, the thread archiver, and the retention sweeper are not coordinated across processes. Socket.IO, voice signalling, bot gateway events, mail delivery, and reminders do have Postgres bridges or row claims and can span processes. See [Architecture](docs/architecture.md#scaling-and-multi-process-behaviour).
- **Voice and video are mesh, not SFU.** Each participant connects to every other participant. Calls stay comfortable for small groups; very large calls need an SFU or media server, which is not included.
- **Desktop builds are not code-signed by default.** Windows SmartScreen and macOS Gatekeeper will warn until you provide your own signing credentials.
- **Mobile background delivery** while the app is fully closed needs FCM/APNs configuration; the included Capacitor shell uses native local notifications while the app is running.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [code of conduct](CODE_OF_CONDUCT.md), then open an issue or a pull request. Security issues should go through [SECURITY.md](SECURITY.md), not the public issue tracker.

By contributing, you agree that your contributions are licensed under the GNU Affero General Public License v3.0.

## License

Cordia is licensed under the **GNU Affero General Public License, version 3.0 only** (`AGPL-3.0-only`). See [LICENSE](LICENSE) for the full text.

Copyright © 2026 Cordia contributors.

If you run a modified version as a network service, the AGPL requires you to offer its users the corresponding source code. The hosted instance at <https://cordia.ext.io> is one deployment of this repository; self-hosting is supported.

The Cordia name, the Codi mascot, and the Cordia logo are trademarks of the project and are **not** licensed under the AGPL. You may fork the code and run it, but please do not present a fork as the official Cordia service. Third-party artwork and fonts are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
