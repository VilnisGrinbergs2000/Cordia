# Cordia documentation

This directory explains how to run Cordia, how it is put together, and how to change it safely.

If you are new here, read **[Getting started](getting-started.md)** first. It takes you from a fresh clone to a working local instance in a few minutes.

| Document | Read it when you want to… |
| -------- | ------------------------- |
| [Getting started](getting-started.md) | Install dependencies, create the database, run the app, and fix the usual first-run problems. |
| [Configuration](configuration.md) | Look up an environment variable, understand generated secrets, or point the client at a different API. |
| [Architecture](architecture.md) | Understand the request path, realtime layer, permissions, E2EE, voice, uploads, jobs, bots, and data model. |
| [HTTP and realtime API](api.md) | Call the API, authenticate a request, use the Socket.IO events, or connect a bot. |
| [Deployment](deployment.md) | Put Cordia behind TLS on a server, back it up, configure mail/push/TURN, and upgrade it. |
| [Development](development.md) | Find your way around the code, add a route or migration, build the desktop/mobile apps, and cut a release. |
| [Contributing](../CONTRIBUTING.md) | Propose a change, follow the coding expectations, and open a pull request. |
| [Security policy](../SECURITY.md) | Report a vulnerability privately. |
| [Code of conduct](../CODE_OF_CONDUCT.md) | Understand the community rules. |
| [Third-party notices](../THIRD_PARTY_NOTICES.md) | Check the licenses of bundled artwork, fonts, and dependencies. |

## The short version

```bash
npm run install:all
createdb cordia
cp server/.env.example server/.env   # set DATABASE_URL
npm run dev
```

Open <http://localhost:5173>. The first account to register becomes the administrator.

For a production deployment:

```bash
npm run build
NODE_ENV=production npm start
```

The landing page is served at `/`, the app at `/app`, and the API at `/api`. PostgreSQL is the only service Cordia needs; mail, push, TURN, and KLIPY are optional integrations.
