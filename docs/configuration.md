# Configuration

Cordia is configured with environment variables. The server reads them from the process environment first and then fills any missing values from `server/.env` (see `server/src/pg/env.js`). There is no `dotenv` dependency and no `.env` file at the repository root.

Keep one `KEY=value` per line. Whole-line `#` comments are ignored; an inline comment after a value becomes part of the value. Values may be wrapped in single or double quotes.

## Server environment

### Core

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `DATABASE_URL` | **required** | PostgreSQL connection string, for example `postgres://user:password@127.0.0.1:5432/cordia`. The server exits at startup if it is missing. |
| `PORT` | `3001` | HTTP port for the API, landing page, client, uploads, and Socket.IO. |
| `HOST` | `127.0.0.1` | Bind address. The default keeps the app reachable only through a reverse proxy; set `0.0.0.0` only when the Node process itself is the public listener. |
| `NODE_ENV` | unset | Set to `production` to mark session cookies `Secure`. Do not set it while testing over plain HTTP, or the browser will drop the cookie. |
| `PUBLIC_URL` | unset | Public origin used for absolute links, for example `https://cordia.ext.io`. Used by mail templates, unsubscribe links, the sitemap, and IndexNow. Falls back to the request origin where a request exists. |
| `CLIENT_ORIGIN` | `http://localhost:5173` | Comma-separated list of browser origins allowed by CORS and Socket.IO. Add every production origin. Native origins are always allowed. |
| `TRUST_PROXY` | unset (false) | Number of reverse-proxy hops to trust for `X-Forwarded-*`, for example `1`. Only enable this when a real proxy fronts the API; otherwise clients can spoof their IP and bypass per-IP rate limits. |

### Security and sessions

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `JWT_SECRET` | generated | HS256 secret used to sign session tokens and upload tokens. If empty, the server reads `$CORDIA_DATA_DIR/jwt.secret` or generates a 48-byte hex secret and writes it with mode `0600`. Changing it invalidates every session and every outstanding upload token. |

Sessions are 30-day JWTs carried in the `cordia_token` httpOnly cookie with `SameSite=Lax`; the cookie is `Secure` when `NODE_ENV=production` or the request is HTTPS. Native clients (`X-Cordia-Client: native`) receive the token in the response body and send it as `Authorization: Bearer`.

### Runtime files

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `CORDIA_DATA_DIR` | `server/data` | Directory for generated secrets and other runtime files. Created automatically. |
| `CORDIA_UPLOADS_DIR` | `server/uploads` | Directory for uploaded files. Created automatically. **Must be writable and must be persisted across deploys.** |

### Voice and TURN

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `STUN_URLS` | Google public STUN (`stun:stun.l.google.com:19302`, `stun:stun1.l.google.com:19302`) | Comma-separated STUN URLs returned by `GET /api/voice/ice`. |
| `TURN_URLS` | empty | Comma-separated TURN URLs. `TURN_URL` is accepted as an alias. |
| `TURN_SECRET` | empty | Shared secret for time-limited TURN credentials (the coturn `use-auth-secret` / `static-auth-secret` scheme). When set, each response carries a fresh HMAC-SHA1 credential. |
| `TURN_USERNAME` | empty | Static TURN username, used when `TURN_SECRET` is not set. |
| `TURN_CREDENTIAL` | empty | Static TURN password, used with `TURN_USERNAME`. |
| `TURN_TTL_SECONDS` | `86400` | Lifetime of generated TURN credentials. Values below 300 are raised to 300. |

If `TURN_URLS` is empty, clients receive STUN only. Calls still work on many networks but can fail behind symmetric NATs or restrictive corporate firewalls.

### Web Push (VAPID)

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `VAPID_PUBLIC_KEY` | generated | VAPID public key for Web Push. |
| `VAPID_PRIVATE_KEY` | generated | VAPID private key. Keep it secret and stable across deploys. |
| `VAPID_SUBJECT` | `mailto:admin@cordia.ext.io` | Contact URI sent to push services. Use a real mailbox you monitor. |

If `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are absent, the server reads `$CORDIA_DATA_DIR/vapid.json` or generates a pair and writes it with mode `0600`. Rotating the pair invalidates existing push subscriptions.

### Email

Cordia writes every message to the `email_outbox` table and drains it on a 15-second timer. A slow or unavailable SMTP server delays mail instead of failing the request that triggered it.

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `MAIL_ENABLED` | `true` | Set to `false` on a machine with no MTA. The outbox still records messages, which is useful for reading verification links from the database. |
| `SMTP_HOST` | `127.0.0.1` | SMTP server hostname. |
| `SMTP_PORT` | `25` | SMTP port. |
| `SMTP_SECURE` | `false` | `true` for implicit TLS (normally port 465). STARTTLS is used automatically otherwise. |
| `SMTP_USER` | empty | SMTP username, if authentication is required. |
| `SMTP_PASS` | empty | SMTP password. |
| `MAIL_FROM` | `Cordia <no-reply@cordia.ext.io>` | Envelope/header sender. Use an address on a domain with SPF, DKIM, and DMARC. |
| `MAIL_REPLY_TO` | empty | Optional `Reply-To` address. |

Delivery retries after 1 minute, 5 minutes, 30 minutes, 2 hours, and 6 hours. Messages older than 24 hours are marked failed rather than delivered late. Hard bounces are added to `email_suppressions`.

### Integrations

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `KLIPY_KEY` | empty | KLIPY app key for the GIF tab in the emoji picker. `KLIPY_API_KEY` is accepted as an alias. When empty, the tab is hidden. The key is returned only to signed-in clients, not baked into the bundle. |
| `INDEXNOW_KEY` | empty | IndexNow key used to announce marketing-page changes to Bing, Yandex, Seznam, and Naver. The server serves `/<key>.txt` for ownership proof and pings only when a landing page is newer than the last submission. Requires `PUBLIC_URL`. |

### Retention

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `CORDIA_AUDIT_RETENTION_DAYS` | `365` | Age at which `audit_logs` rows are deleted. |
| `CORDIA_REPORT_RETENTION_DAYS` | `365` | Age at which `reports` rows are deleted. |
| `CORDIA_PRUNE_HOURS` | `6` | Interval between retention passes. |

The retention pass also removes uploads that are more than 24 hours old and are not referenced by a message, avatar, server icon or banner, emote, soundboard clip, icon-history entry, or icon suggestion.

### Storage limits

Upload limits are code constants, not environment variables (`server/src/limits.js`):

| Limit | Value |
| ----- | ----- |
| Maximum size of one upload | 50 MB |
| Storage quota per account | 5 GB |
| Upload request budget | 20 per minute per user |
| Signed upload-token lifetime | 7 days |

They apply to every account equally. There is no paid tier or feature gate.

## Client build variables

Vite reads variables at build time. The client uses two:

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `VITE_API_URL` | empty (same origin) | Absolute API origin, for example `https://cordia.ext.io`. When set, the client sends credentials with `include`; when empty, it uses same-origin requests. |
| `VITE_SOCKET_URL` | `VITE_API_URL` | Absolute Socket.IO origin, if it differs from the API origin. |

Vite loads `.env`, `.env.local`, and mode-specific files. The repository ships:

- `client/.env.example` — comments showing the available variables.
- `client/.env.desktop.example` — the packaged desktop build.
- `client/.env.mobile.example` — the Android emulator and device/hosted API.

Copy the one you need to `.env.desktop` or `.env.mobile` (both gitignored), or export the variables in your shell before building.

Modes are selected by the scripts:

| Script | Mode | Output |
| ------ | ---- | ------ |
| `npm --prefix client run dev` | development | Vite dev server on 5173 |
| `npm --prefix client run build` | production | `client/dist` for the web |
| `npm --prefix client run build:desktop` | desktop | `client/dist` with desktop defaults |
| `npm --prefix client run build:mobile` | mobile | `client/dist` with mobile defaults |

## Desktop runtime variables

The Electron shell reads these from its own environment:

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `CORDIA_DEV_URL` | `http://localhost:3001/app` | URL loaded when the app is not packaged. `npm run desktop:dev` sets it to `http://localhost:5173`. |
| `CORDIA_API_URL` | empty | API origin exposed to the renderer through `window.cordiaDesktop.apiUrl`. Set it at runtime or bake it with `VITE_API_URL` in `client/.env.desktop`. |
| `CORDIA_UPDATE_URL` | empty | Generic update feed. When set, `npm run desktop:installer` generates `latest.yml` for `electron-updater`. |

## Installer build variables

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `CORDIA_OUTPUT_DIR` | `release` | Output directory for `scripts/build-installer.mjs`. |
| `CORDIA_UPDATE_URL` | empty | Publish feed written into `latest.yml`. |

## Example configurations

### Minimal development

```dotenv
DATABASE_URL=postgres://cordia:password@127.0.0.1:5432/cordia
PORT=3001
CLIENT_ORIGIN=http://localhost:5173
```

Leave `JWT_SECRET` empty; it is generated into `server/data/jwt.secret`. Leave `NODE_ENV` unset so cookies work over plain HTTP.

### Production behind a proxy

```dotenv
DATABASE_URL=postgres://cordia:strong-password@127.0.0.1:5432/cordia
PORT=3001
HOST=127.0.0.1
NODE_ENV=production
PUBLIC_URL=https://cordia.ext.io
CLIENT_ORIGIN=https://cordia.ext.io
TRUST_PROXY=1
JWT_SECRET=<long random secret>
```

The proxy should terminate TLS and forward `X-Forwarded-Proto: https`. See [Deployment](deployment.md).

### SMTP

```dotenv
MAIL_ENABLED=true
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=cordia
SMTP_PASS=<smtp password>
MAIL_FROM=Cordia <no-reply@cordia.ext.io>
MAIL_REPLY_TO=admin@cordia.ext.io
PUBLIC_URL=https://cordia.ext.io
```

### TURN with time-limited credentials

```dotenv
TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
TURN_SECRET=<same static-auth-secret as coturn>
TURN_TTL_SECONDS=86400
```

## Secrets checklist

Keep these out of git:

- `server/.env` (especially `DATABASE_URL`, `SMTP_PASS`, `TURN_SECRET`, `JWT_SECRET`, `KLIPY_KEY`).
- `server/data/jwt.secret`.
- `server/data/vapid.json`.
- Any TLS private keys or proxy credentials.

The repository's `.gitignore` already excludes `.env`, `.env.*` (except the example files), `server/data/`, and `server/uploads/`. Before publishing a fork or a backup archive, confirm none of those files are included.

Rotating a secret has consequences:

| Secret | Effect of rotation |
| ------ | ------------------ |
| `JWT_SECRET` | Every session and upload token becomes invalid; everyone signs in again. |
| `VAPID_*` | Existing push subscriptions stop working; clients must resubscribe. |
| `TURN_SECRET` | Existing TURN credentials expire at their TTL; new ones use the new secret. |
| `DATABASE_URL` password | Restart the server after changing the database role password. |

## Related documentation

- [Getting started](getting-started.md) — first run and troubleshooting.
- [Deployment](deployment.md) — TLS, reverse proxies, systemd, backups, mail, push, and TURN.
- [Architecture](architecture.md) — what reads each setting and when.
