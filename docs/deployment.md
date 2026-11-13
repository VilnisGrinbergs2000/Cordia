# Deployment

This guide deploys Cordia to a single Linux server with PostgreSQL, a reverse proxy, and TLS. It is the setup the hosted demo uses in spirit: one Node.js process, one database, and a proxy in front.

If you only want to try Cordia locally, use [Getting started](getting-started.md) instead.

## Supported topology

```
Internet
   │ HTTPS / WSS
   ▼
Caddy or nginx  (TLS, compression, request limits)
   │ http://127.0.0.1:3001
   ▼
Node.js — Cordia (API, Socket.IO, app, landing page)
   │ postgres://127.0.0.1:5432/cordia
   ▼
PostgreSQL
```

The supported production topology is **one Cordia process**. Ordinary chat, typing, and presence broadcasts use in-process Socket.IO rooms with no shared adapter, and scheduled-message delivery does not claim rows. Running two API processes behind a load balancer will drop events and can double-post scheduled messages. See [Scaling and multi-process behaviour](architecture.md#scaling-and-multi-process-behaviour) before attempting it.

PostgreSQL, the Node process, and the proxy can share a small VPS. Voice and video are peer-to-peer, so they do not consume server bandwidth beyond signalling — but they do require a TURN server for restrictive networks.

## Sizing

| Resource | Minimum | Comfortable |
| -------- | ------- | ----------- |
| CPU | 1 vCPU | 2 vCPU |
| RAM | 1 GB | 2 GB |
| Disk | 10 GB | 50 GB+ (uploads count against this) |
| Node.js | 22 | 24 LTS |
| PostgreSQL | 14 | 16/17/18 |

Uploads are the disk driver. The 5 GB per-account quota is enforced in the app, but nothing limits the number of accounts; monitor the volume.

## 1. Prepare the host

The examples assume Debian or Ubuntu and a dedicated `cordia` user. Adjust paths for your distribution.

```bash
sudo adduser --system --group --home /opt/cordia cordia
sudo mkdir -p /opt/cordia
sudo chown cordia:cordia /opt/cordia
```

Install Node.js 22+ (NodeSource, nvm, or your distribution's package), PostgreSQL, and a reverse proxy:

```bash
# NodeSource example for Node 24
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs postgresql caddy
node --version
```

Git is needed to deploy from source:

```bash
sudo apt-get install -y git
```

## 2. Create the database

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE cordia LOGIN PASSWORD 'replace-with-a-long-random-password';
CREATE DATABASE cordia OWNER cordia;
SQL
```

The server creates its own schema. It does not need superuser rights; ownership of the database is enough.

Verify the connection string works:

```bash
psql "postgres://cordia:replace-with-a-long-random-password@127.0.0.1:5432/cordia" -c "select 1;"
```

URL-encode any character in the password that is special in a URL (`@`, `:`, `/`, `#`, `%`).

## 3. Install the code

```bash
sudo -u cordia git clone https://github.com/VilnisGrinbergs2000/Cordia.git /opt/cordia
cd /opt/cordia
sudo -u cordia npm run install:all
```

`install:all` installs the root tooling (Electron, Capacitor, electron-builder), the server, and the client. On a headless server you do not need Electron; skip its binary download to save time and disk:

```bash
sudo -u cordia env ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install
sudo -u cordia npm install --prefix server
sudo -u cordia npm install --prefix client
```

The web app and API are unaffected by the missing Electron binary. If you later build the desktop installer, install the root dependencies without that variable.

## 4. Configure

```bash
sudo -u cordia cp server/.env.example server/.env
sudo -u cordia nano server/.env
```

A production file looks like this:

```dotenv
DATABASE_URL=postgres://cordia:replace-with-a-long-random-password@127.0.0.1:5432/cordia
PORT=3001
HOST=127.0.0.1
NODE_ENV=production
PUBLIC_URL=https://cordia.example.com
CLIENT_ORIGIN=https://cordia.example.com
TRUST_PROXY=1
JWT_SECRET=replace-with-48-bytes-of-hex
```

Notes:

- Keep `HOST=127.0.0.1` so the only way in is the proxy. Set `0.0.0.0` only if the Node process itself terminates TLS or sits behind a network-level firewall you control.
- `CLIENT_ORIGIN` must match the browser origin exactly, including scheme and any port. Multiple origins are comma-separated. Native origins are always allowed.
- `TRUST_PROXY=1` tells Express to trust one proxy hop. Without it, every request appears to come from the proxy and per-IP rate limits become global. With it set incorrectly (no proxy, or too many hops), clients can spoof `X-Forwarded-For`.
- `NODE_ENV=production` marks the session cookie `Secure`. The site must be served over HTTPS or sign-in will appear to succeed and then immediately fail.
- Generate `JWT_SECRET` with `openssl rand -hex 48`. If you leave it empty, the server generates and persists `server/data/jwt.secret`; that is fine for a single host, but an explicit value survives a host rebuild.
- Generate VAPID keys explicitly if you want push subscriptions to survive moving `server/data/`. See [Web Push](#web-push).

Every variable is documented in [Configuration](configuration.md).

Protect the file:

```bash
sudo chown cordia:cordia /opt/cordia/server/.env
sudo chmod 600 /opt/cordia/server/.env
```

## 5. Build the client

```bash
cd /opt/cordia
sudo -u cordia npm run build
```

This produces `client/dist`. The server serves it at `/app` and serves `landing/` at `/`.

The build also copies Twemoji SVGs into `client/public/twemoji` and then into `dist`. That is a few thousand small files; it takes a moment but is a one-time cost per deploy.

If the bundle grows unexpectedly, run:

```bash
sudo -u cordia npm run build:check
```

It builds and reports the largest chunks.

## 6. Run it under systemd

Create `/etc/systemd/system/cordia.service`:

```ini
[Unit]
Description=Cordia
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=cordia
Group=cordia
WorkingDirectory=/opt/cordia
ExecStart=/usr/bin/node server/src/index.js
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=15
Environment=NODE_ENV=production
# Optional: systemd can load the same file. Cordia also reads server/.env itself.
# EnvironmentFile=/opt/cordia/server/.env
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/opt/cordia/server/data /opt/cordia/server/uploads

[Install]
WantedBy=multi-user.target
```

Check the Node path with `command -v node` and adjust `ExecStart` if needed (nvm installs outside `/usr/bin`).

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cordia
sudo systemctl status cordia
curl -fsS http://127.0.0.1:3001/api/health
```

Expected: `{"ok":true,"service":"cordia","time":...}`.

Logs:

```bash
sudo journalctl -u cordia -f
```

On startup the server applies pending migrations, reconciles counters, starts the mailer and schedulers, and then binds the listener. A migration failure stops startup; the log names the file.

Use a **single worker**. Do not put `cluster`, PM2 cluster mode, or multiple `cordia.service` instances in front of the same database.

## 7. Put a proxy and TLS in front

### Caddy

Caddy obtains and renews certificates automatically once DNS points at the host. `/etc/caddy/Caddyfile`:

```caddyfile
cordia.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3001
}
```

```bash
sudo systemctl reload caddy
```

Caddy handles WebSocket upgrades and `X-Forwarded-*` headers automatically. Do not add a separate `client_max_body_size`; Caddy streams request bodies.

### nginx

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name cordia.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name cordia.example.com;

    ssl_certificate     /etc/letsencrypt/live/cordia.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cordia.example.com/privkey.pem;

    # One upload is capped at 50 MB by the app; leave headroom for multipart
    # framing. Without this, nginx answers 413 before Cordia can explain why.
    client_max_body_size 55m;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # Socket.IO long-polling and WebSocket connections must outlive a
        # normal request. 90s is longer than the engine.io heartbeat.
        proxy_read_timeout 90s;
        proxy_send_timeout 90s;
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

If you terminate TLS somewhere else and forward plain HTTP, still send `X-Forwarded-Proto: https` and set `TRUST_PROXY` to the number of hops. Otherwise cookies are marked `Secure` and redirects/absolute URLs use `http`.

### Verify

```bash
curl -I https://cordia.example.com/
curl -fsS https://cordia.example.com/api/health
```

Then open the site in a browser, register the first account, and confirm the WebSocket connects (the presence indicator and typing events are the quickest check).

## 8. First administrator

The first account registered against an empty database becomes `role = 'admin'` and receives the Founder badge. Register it immediately after the deploy, before the host is announced. On a public host, an unattended fresh instance is an unattended admin signup.

If you need to promote an account later:

```bash
psql "$DATABASE_URL" -c "UPDATE users SET role = 'admin' WHERE username = 'yourname';"
```

Then sign out and back in. Sessions carry a token version, not the role, but the client refetches `/api/auth/me`; a reload is enough.

## 9. The marketing page and download link

`landing/` is served by the same process. The page's primary download button points at a static file:

```text
landing/downloads/Cordia-Setup-0.13.6.exe
```

`landing/downloads/` is gitignored, so a fresh deployment returns 404 for that URL until you either build and copy the installer or change the link. The repository currently points at 0.13.6 while the client version in `client/package.json` is different; check both before publishing.

To build the Windows installer:

```bash
cd /opt/cordia
sudo -u cordia npm run desktop:installer
# release/Cordia-Setup-<version>.exe
```

Copy it into the web root and make the link match:

```bash
sudo -u cordia mkdir -p landing/downloads
sudo -u cordia cp release/Cordia-Setup-<version>.exe landing/downloads/
```

Then update the `href` in `landing/index.html` to the same file name. The server deliberately answers a missing `/downloads/*` with a real 404 rather than the app shell, so a browser never saves an HTML page under an `.exe` name.

Builds for macOS and Linux are produced by `electron-builder` on those platforms (`npm run desktop:build`); they are not cross-compiled from Linux in the default configuration.

If you do not ship a desktop build, replace the button with a link to `/app` or to your GitHub releases page. Leaving a dead installer link is worse than not offering a download.

## 10. Email

Cordia queues mail in `email_outbox` and drains it every 15 seconds. A request never waits on SMTP.

```dotenv
MAIL_ENABLED=true
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=cordia
SMTP_PASS=...
MAIL_FROM=Cordia <no-reply@cordia.example.com>
MAIL_REPLY_TO=admin@cordia.example.com
PUBLIC_URL=https://cordia.example.com
```

Requirements:

- `MAIL_FROM` must be on a domain you control and that has SPF, DKIM, and DMARC configured. Otherwise verification and reset mail lands in spam or is rejected.
- Port 587 uses STARTTLS automatically. Use `SMTP_SECURE=true` for implicit TLS on 465.
- Set `PUBLIC_URL`; otherwise links are built from the incoming request host, which can be wrong behind a proxy or in a queued message sent after the request ended.
- Hard bounces are recorded in `email_suppressions` and skipped on later sends.

If you deliberately run without mail:

```dotenv
MAIL_ENABLED=false
```

The outbox still records the message, so you can read a verification or reset link during setup:

```bash
psql "$DATABASE_URL" -c "select id, to_email, kind, subject, created_at from email_outbox order by id desc limit 5;"
```

## 11. Web Push

Browsers require HTTPS for Web Push (`localhost` is exempt). Keys are generated into `server/data/vapid.json` on first use, or supplied explicitly:

```dotenv
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:admin@cordia.example.com
```

Generate a pair once and keep it stable:

```bash
cd /opt/cordia
node -e "const w=require('web-push');const k=w.generateVAPIDKeys();console.log(k.publicKey);console.log(k.privateKey)"
```

Rotating the pair invalidates every existing subscription; users must re-enable notifications. Back up `server/data/vapid.json` if you rely on generated keys.

## 12. TURN for voice and video

Calls use STUN by default and work on many home networks. Symmetric NATs, corporate firewalls, and some mobile networks need TURN. Without it, users see "connected" but hear nothing.

Install coturn:

```bash
sudo apt-get install -y coturn
```

`/etc/turnserver.conf`:

```conf
listening-port=3478
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=replace-with-the-same-secret-as-TURN_SECRET
realm=cordia.example.com
# Restrict to your server's addresses and the relay range you open.
min-port=49152
max-port=65535
no-multicast-peers
no-cli
```

Enable the service and open the ports:

```bash
sudo sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
sudo systemctl enable --now coturn
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 49152:65535/udp
```

Cordia:

```dotenv
TURN_URLS=turn:cordia.example.com:3478?transport=udp,turn:cordia.example.com:3478?transport=tcp
TURN_SECRET=replace-with-the-same-secret-as-static-auth-secret
TURN_TTL_SECONDS=86400
```

`TURN_SECRET` must match `static-auth-secret`; Cordia returns HMAC credentials valid for the TTL. Alternatively use static `TURN_USERNAME`/`TURN_CREDENTIAL`, which is simpler but cannot expire per user.

Test from a network outside your own with two browsers. A TURN failure is visible in the browser's `chrome://webrtc-internals` as ICE candidates that never pair.

## 13. GIFs and search-engine notifications

Both are optional.

```dotenv
KLIPY_KEY=...
INDEXNOW_KEY=...
```

- `KLIPY_KEY` enables the GIF tab. The key is handed to signed-in clients at runtime; it is an app identifier, not a user secret. When absent, the tab is hidden.
- `INDEXNOW_KEY` must be a hex string. Cordia serves `/<key>.txt` for ownership proof and submits `sitemap.xml` changes when a landing page's mtime is newer than the last submission. `PUBLIC_URL` is required.

## 14. Backups

Back up three things together:

| What | Why |
| ---- | --- |
| PostgreSQL database | All messages, accounts, servers, keys, and metadata. |
| `server/data/` | JWT secret and VAPID keys. Losing it signs everyone out and breaks push. |
| `server/uploads/` | Attachments, avatars, icons, emotes, and soundboard clips. |

A simple nightly backup:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /opt/cordia
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p /var/backups/cordia
pg_dump --format=custom --file="/var/backups/cordia/db-$stamp.dump" "$DATABASE_URL"
tar -C /opt/cordia -czf "/var/backups/cordia/files-$stamp.tgz" server/data server/uploads
find /var/backups/cordia -type f -mtime +14 -delete
```

Run it as the `cordia` user, from a unit timer or cron, with `DATABASE_URL` exported (or read from `server/.env`). Keep copies off the host.

For a fully consistent snapshot, briefly stop the service:

```bash
sudo systemctl stop cordia
# pg_dump + tar
sudo systemctl start cordia
```

Without stopping, a file can be written a few milliseconds before its database row. The retention pass treats an unreferenced file as an orphan after 24 hours; a restore can therefore contain a handful of harmless extra files or a row whose file was not yet flushed. Stopping is the clean approach for a large or important instance.

### Restore

```bash
sudo systemctl stop cordia
sudo -u postgres dropdb --if-exists cordia
sudo -u postgres createdb --owner=cordia cordia
pg_restore --dbname="postgres://cordia:...@127.0.0.1:5432/cordia" --clean --if-exists /var/backups/cordia/db-....dump
sudo -u cordia tar -C /opt/cordia -xzf /var/backups/cordia/files-....tgz
sudo chown -R cordia:cordia /opt/cordia/server/data /opt/cordia/server/uploads
sudo systemctl start cordia
```

Test a restore on a scratch host at least once. A backup that has never been restored is a hypothesis.

## 15. Upgrades

```bash
cd /opt/cordia
sudo systemctl stop cordia
sudo -u cordia git pull --ff-only
sudo -u cordia npm run install:all
sudo -u cordia npm run build
sudo systemctl start cordia
sudo journalctl -u cordia -n 50 --no-pager
```

Migrations are forward-only and run at boot inside transactions under a Postgres advisory lock. A failed migration rolls back and stops startup. There is no down migration; restoring the database backup is the rollback path. Take a backup before every upgrade that includes a new migration.

Never edit a migration that has already been applied. Add a new numbered file in `server/src/pg/migrations/` instead.

## 16. Operations

| Task | Command |
| ---- | ------- |
| Health | `curl -fsS http://127.0.0.1:3001/api/health` |
| Service status | `systemctl status cordia` |
| Logs | `journalctl -u cordia -f` |
| Database size | `psql "$DATABASE_URL" -c "select pg_size_pretty(pg_database_size(current_database()));"` |
| Uploads size | `du -sh server/uploads` |
| Outbox backlog | `psql "$DATABASE_URL" -c "select count(*) from email_outbox where sent_at is null and failed_at is null;"` |
| Stale rate hits | Automated; rows are fixed-window counters. |

Watch disk space, especially `server/uploads`. The app caps each account at 5 GB and removes unreferenced uploads after 24 hours, but it does not cap the number of accounts.

The retention job runs every 6 hours and deletes audit logs and reports past their configured windows plus orphaned uploads. Tune with `CORDIA_AUDIT_RETENTION_DAYS`, `CORDIA_REPORT_RETENTION_DAYS`, and `CORDIA_PRUNE_HOURS`.

Back up `server/data/` even if you set explicit secrets; it costs little and covers generated values.

## 17. Security checklist

- [ ] TLS terminates at the proxy; HTTP redirects to HTTPS.
- [ ] `HOST=127.0.0.1` unless you have a specific reason.
- [ ] `NODE_ENV=production` and `TRUST_PROXY` match the proxy topology.
- [ ] `server/.env` is mode `600` and owned by the service user.
- [ ] `JWT_SECRET` is long, random, and backed up.
- [ ] PostgreSQL listens on loopback or a private network, not the public internet.
- [ ] Firewall allows only 22, 80, 443, and the TURN ports you need.
- [ ] Uploads and `server/data` are on a persistent volume, included in backups.
- [ ] The first admin account is registered before the host is announced.
- [ ] `CLIENT_ORIGIN` lists only real origins.
- [ ] Mail has SPF, DKIM, and DMARC; `VAPID_SUBJECT` is a monitored mailbox.
- [ ] You have restored a backup successfully at least once.

## Troubleshooting

| Symptom | Likely cause |
| ------- | ------------ |
| Sign-in works, then immediately signs out | `NODE_ENV=production` on plain HTTP, or `TRUST_PROXY` / `X-Forwarded-Proto` wrong. |
| API returns 403 "Not allowed by CORS" | The browser origin is not in `CLIENT_ORIGIN` and is not same-host. |
| WebSocket fails, app falls back to polling and feels slow | Proxy is not forwarding `Upgrade`/`Connection` (nginx) or is stripping them. |
| Uploads fail at 413 with an nginx error page | `client_max_body_size` is below 50 MB. |
| Everything is rate-limited at once | Missing `TRUST_PROXY=1`, so all clients share the proxy's IP. |
| `EADDRINUSE` | Another Cordia or unrelated process owns `PORT`. Run one instance. |
| Migration error at boot | The database user lacks rights, or an applied migration was edited. Restore and add a new file. |
| Mail sits in `email_outbox` | `MAIL_ENABLED=false`, SMTP unreachable, or credentials rejected. |
| Push works for one deploy then stops | VAPID keys were regenerated; persist `server/data/vapid.json` or set keys explicitly. |
| Voice connects but no audio across networks | No TURN server, or the TURN secret/ports are wrong. |
| Installer link 404s | `landing/downloads/` is gitignored and empty; build and copy the installer or change the link. |
| High memory after weeks | Check for a growing number of sockets or a large in-memory cache; restart is a mitigation, not a fix. Report it. |

## Related documentation

- [Configuration](configuration.md) — every environment variable and its effect.
- [Architecture](architecture.md) — what the process does and where its limits are.
- [Getting started](getting-started.md) — local setup and first-run problems.
- [Development](development.md) — building desktop and mobile artifacts.
