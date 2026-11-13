# Getting started

This guide takes a fresh clone to a running Cordia instance on your machine. For a production deployment, continue with [Deployment](deployment.md).

## What you need

| Requirement | Notes |
| ----------- | ----- |
| **Node.js 22 or newer** | Node 24 LTS is recommended. `node --version` must report `v22.x` or higher. |
| **PostgreSQL 14 or newer** | The server creates its own tables and indexes on first boot; you only need an empty database and a role that can use it. |
| **A modern browser** | Chrome, Edge, Firefox, or Safari. Voice and video need WebRTC; microphone and camera access require `localhost` or HTTPS. |
| **Git** | To clone the repository. |

Optional, only for the features that use them:

- A local or remote SMTP server for verification and password-reset mail. Without one, mail is queued and you can read the link from the database.
- A TURN server for calls across restrictive NATs or firewalls.
- A [KLIPY](https://partner.klipy.com) app key for the GIF tab.
- Android Studio or Xcode for the native mobile shells.

## 1. Clone the repository

```bash
git clone https://github.com/VilnisGrinbergs2000/Cordia.git
cd Cordia
```

## 2. Install dependencies

Cordia is a small monorepo with three `package.json` files: the root (Electron, Capacitor, and dev tooling), `server/` (the API), and `client/` (the React app).

```bash
npm run install:all
```

That runs `npm install` at the root and then in `server/` and `client/`.

> **Web-only development:** the root install downloads Electron. If you do not plan to run the desktop app, you can set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` before installing on Linux/macOS, or `$env:ELECTRON_SKIP_BINARY_DOWNLOAD="1"` in PowerShell. The web app does not need Electron.

## 3. Create the database

Cordia connects with a single PostgreSQL connection string. The example below creates a dedicated role and database; use whatever names and password you prefer.

### macOS / Linux

```bash
# Run as a PostgreSQL superuser (often your own account with Homebrew)
createuser --login --pwprompt cordia
createdb --owner=cordia cordia
```

Or with `psql`:

```bash
psql -U postgres -c "CREATE ROLE cordia LOGIN PASSWORD 'choose-a-password';"
psql -U postgres -c "CREATE DATABASE cordia OWNER cordia;"
```

### Windows

If `createdb` is not on `PATH`, use the full path to the PostgreSQL `bin` directory, for example:

```powershell
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "CREATE ROLE cordia LOGIN PASSWORD 'choose-a-password';"
& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -c "CREATE DATABASE cordia OWNER cordia;"
```

The PostgreSQL Windows installer normally registers a service named `postgresql-x64-<version>`. Check it with `Get-Service postgresql*`.

### Verify the connection

```bash
psql "postgres://cordia:choose-a-password@127.0.0.1:5432/cordia" -c "select 1;"
```

If that returns `1`, the server will be able to connect. If your password contains characters such as `@`, `:`, `/`, or `#`, percent-encode them in the URL.

## 4. Configure the server

```bash
cp server/.env.example server/.env
```

Open `server/.env` and set at least:

```dotenv
DATABASE_URL=postgres://cordia:choose-a-password@127.0.0.1:5432/cordia
```

Useful defaults and what you can leave alone:

- `PORT=3001` — the API port.
- `HOST=127.0.0.1` — binds to loopback. A reverse proxy should be the only way in; set `0.0.0.0` only when the app itself is the public listener.
- `CLIENT_ORIGIN=http://localhost:5173` — the Vite dev origin allowed by CORS and Socket.IO. Add your production origin before deploying.
- `JWT_SECRET` — leave empty in development. The server generates `server/data/jwt.secret` on first boot and reuses it.
- `NODE_ENV` — leave unset for local HTTP development. `production` marks the session cookie `Secure`, so it will not persist over plain HTTP.

> The server does **not** use `dotenv`. `server/src/pg/env.js` reads `server/.env` itself and only fills variables that are not already set. Real environment variables always win. Keep one `KEY=value` per line; inline comments after a value are treated as part of the value.

Every variable is documented in [Configuration](configuration.md).

## 5. Run it in development

```bash
npm run dev
```

This starts two processes:

- **API** — `node --watch server/src/index.js` on <http://localhost:3001>.
- **Vite** — the React app on <http://localhost:5173>, proxying `/api`, `/uploads`, and `/socket.io` to port 3001.

Open **<http://localhost:5173>**. On first boot the server applies all migrations in `server/src/pg/migrations/` under a Postgres advisory lock, then starts the HTTP listener.

Check the API directly:

```bash
curl http://localhost:3001/api/health
# {"ok":true,"service":"cordia","time":...}
```

## 6. Create the first account

Register in the app. The **first account becomes the workspace administrator** and receives the Founder badge. Every later account is a regular member.

The admin console is available at `/admin` or from the shield icon in the server rail.

Recommended first steps:

1. Create a server from the rail. It is created with `Members`, `Moderator`, and `Admin` groups and the default categories/channels.
2. Invite a second account from **Server settings → Invites**.
3. Join a voice channel in two browsers to verify WebRTC.
4. Open **Settings → Notifications** and enable browser notifications if you want to test Web Push.

## 7. Run it the production way (locally)

```bash
npm run build
npm start
```

`npm run build` produces `client/dist`. `npm start` runs the API on `PORT` and serves:

| Path | Content |
| ---- | ------- |
| `/` | Marketing site from `landing/` |
| `/app` | The React application |
| `/api` | JSON API |
| `/uploads/<name>` | Authenticated user uploads |
| `/socket.io` | Socket.IO (HTTP long-polling and WebSocket) |

If you set `NODE_ENV=production` while browsing over `http://localhost:3001`, the session cookie is marked `Secure` and the browser will not send it back over plain HTTP. Either use HTTPS (recommended) or leave `NODE_ENV` unset for local production-mode testing.

## 8. Optional integrations

### Email

Verification and password-reset links are written to `email_outbox` and drained by a timer. With no SMTP server, set:

```dotenv
MAIL_ENABLED=false
```

The queue still records the message, so you can read the link from the database during development:

```bash
psql "$DATABASE_URL" -c "select id, to_email, kind, subject, text from email_outbox order by id desc limit 5;"
```

For a real SMTP server, see [Configuration](configuration.md#email).

### Voice and TURN

Calls use Google's public STUN servers by default. If participants cannot connect on restrictive networks, configure `TURN_URLS` plus either `TURN_SECRET` (time-limited HMAC credentials) or `TURN_USERNAME`/`TURN_CREDENTIAL`. Details are in [Deployment](deployment.md#turn).

### GIFs

Set `KLIPY_KEY` to the app key from [partner.klipy.com](https://partner.klipy.com). The GIF tab stays hidden when the key is not configured; the key is handed to signed-in clients at runtime rather than baked into the bundle.

### Web Push

VAPID keys are generated into `server/data/vapid.json` on first use if `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` are absent. Web Push requires HTTPS in production (`localhost` is treated as secure by browsers). For a stable deployment, set the keys explicitly and keep them across restarts.

## Where Cordia keeps data

| Data | Default location | Override |
| ---- | ---------------- | -------- |
| PostgreSQL database | The database in `DATABASE_URL` | `DATABASE_URL` |
| JWT signing secret | `server/data/jwt.secret` | `JWT_SECRET` |
| VAPID key pair | `server/data/vapid.json` | `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` |
| Uploaded files | `server/uploads/` | `CORDIA_UPLOADS_DIR` |
| Other runtime files | `server/data/` | `CORDIA_DATA_DIR` |

`server/data/` and `server/uploads/` are gitignored. Back up the database, `server/data/`, and `server/uploads/` together; a restore that omits the JWT secret signs everyone out, and one that omits uploads leaves broken attachments.

## Resetting a development instance

> **This deletes all data.** Do it only on a machine where that is acceptable.

```bash
# 1. Recreate the database
dropdb cordia
createdb --owner=cordia cordia

# 2. Remove runtime secrets and uploads
rm -rf server/data server/uploads
```

The next `npm run dev` applies every migration from a clean schema, generates a new JWT secret and VAPID pair, and makes the next registered account the administrator again.

On PowerShell, use `Remove-Item -Recurse -Force server\data, server\uploads` and the `dropdb`/`createdb` equivalents from the PostgreSQL `bin` directory.

## Troubleshooting

| Symptom | Cause and fix |
| ------- | ------------- |
| `pg/pool: DATABASE_URL is not set` | `server/.env` is missing or has no `DATABASE_URL`. Copy `server/.env.example` and set it. |
| `ECONNREFUSED 127.0.0.1:5432` | PostgreSQL is not running, is on another port, or is only listening on a Unix socket. Start the service and confirm the host/port in `DATABASE_URL`. |
| `password authentication failed for user "cordia"` | The role, password, or URL encoding is wrong. Test with `psql "$DATABASE_URL" -c "select 1;"`. |
| `database "cordia" does not exist` | Create it with `createdb --owner=cordia cordia`. |
| `EADDRINUSE :3001` or `:5173` | Another process owns the port. Stop it, or set `PORT` (and update the Vite proxy if you change 3001). |
| Login succeeds but the session disappears in production | `NODE_ENV=production` makes the cookie `Secure`. Terminate TLS at a proxy and browse over HTTPS, or leave `NODE_ENV` unset for HTTP-only local testing. |
| The app loads but API calls fail with 403 / CORS | Add the exact browser origin to `CLIENT_ORIGIN` (scheme, host, port). Native origins (`cordia://app`, `capacitor://localhost`, `http://localhost`) are always allowed. |
| Uploaded images return 401 | `/uploads` requires a signed-in session or the scoped `?t=` token. Reload the app after signing in; the client refreshes the token from `/api/auth/me`. |
| Camera/microphone is blocked | Browsers require a secure context. Use `http://localhost` or HTTPS; a LAN IP over plain HTTP is not enough. |
| Voice connects but there is no audio | Check the selected input/output devices in **Settings → Voice & Video**. Across NATs, configure TURN. |
| `migration 0xx_... failed` | The database user lacks privileges, or an earlier migration was edited after being applied. Migrations are forward-only; add a new file instead of changing an old one. |
| Mail never arrives | `MAIL_ENABLED` is false, SMTP is unreachable, or the message is still in `email_outbox`. Check the table and the server log. |
| `npm run dev` cannot find `concurrently` | Run `npm run install:all` from the repository root, not inside `client/` or `server/`. |
| Node reports unsupported syntax or a crypto error | Use Node 22+. Node 24 LTS is recommended. |

## Next steps

- Read [Configuration](configuration.md) for every environment variable.
- Read [Architecture](architecture.md) to understand what happens after a request arrives.
- Read [Development](development.md) before changing server routes, migrations, or the desktop/mobile shells.
