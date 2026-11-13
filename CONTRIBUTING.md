# Contributing to Cordia

Thanks for taking the time to help. Cordia is a self-hostable chat platform, and contributions of every size are welcome: bug reports, documentation fixes, accessibility improvements, translations, and code.

By participating, you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md). Please read it before opening an issue or pull request.

## Ways to contribute

- **Report a bug.** Use the bug report template. Include the version or commit, what you expected, what happened, and the smallest set of steps that reproduces it.
- **Request a feature.** Use the feature request template. Explain the problem before the solution.
- **Improve documentation.** The docs live in [`docs/`](docs/). Corrections and clearer examples are genuinely useful.
- **Fix something.** Comment on an issue before starting significant work so two people do not build the same thing.
- **Report a vulnerability.** Do **not** open a public issue. Follow [SECURITY.md](SECURITY.md).

## Before you start

For anything beyond a typo or a one-line fix, open an issue or comment on an existing one first. It saves you from finishing a change that does not fit the project's direction.

Small, focused pull requests are much easier to review than large ones. If a change touches the server, client, database, and deployment docs, consider splitting it.

## Development setup

The full walkthrough is in [Getting started](docs/getting-started.md). The short version:

```bash
git clone https://github.com/VilnisGrinbergs2000/Cordia.git
cd Cordia
npm run install:all
createdb cordia
cp server/.env.example server/.env   # set DATABASE_URL
npm run dev
```

Open <http://localhost:5173>. The first registered account becomes the administrator.

Requirements:

- Node.js 22 or newer (24 LTS recommended).
- PostgreSQL 14 or newer.
- A modern browser with WebRTC for voice work.

You do not need Docker, Redis, or an object store.

## Coding expectations

### General

- Match the style of the surrounding code. The project is JavaScript, not TypeScript.
- Keep the server in CommonJS and the client in ESM.
- Prefer a small, readable change over a clever abstraction.
- Do not reformat unrelated files in the same pull request.
- Do not commit generated output, secrets, uploads, logs, or local notes.

### Server

- Wrap async route handlers in `asyncHandler`.
- Parameterize every SQL query.
- Use `withTransaction` for multi-write operations.
- Enforce authorization on the server; hiding a button is not enforcement.
- Emit socket events after a transaction commits.
- Add a migration rather than editing an applied one. See [Development](docs/development.md#migrations).
- Document any new environment variable in `server/.env.example` and [Configuration](docs/configuration.md).

### Client

- Use the `api.js` wrapper and `runtime.js` URL helpers.
- Handle loading, empty, error, and unauthorized states.
- Clean up timers, listeners, and socket handlers on unmount.
- Add styles to the matching file in `client/src/styles/`; keep class names prefixed.
- Check keyboard navigation and mobile breakpoints for UI changes.

### Commits

Write a short imperative subject, then explain the why in the body if it is not obvious:

```text
Fix upload token refresh after a session reload

The client cached the token for seven days but never refreshed it after
sign-in, so images returned 401 until a full reload. Fetch it from /auth/me
when the shell mounts and replace the cached value.
```

There is no strict commit-message format. Do not include secrets, tokens, or personal data in a commit message. If you accidentally commit a secret, tell a maintainer; rewriting history is easier before a push.

## Testing

There is no automated test suite yet. CI checks that the server parses and the client builds. For behaviour changes, include a manual test plan in the pull request:

- What you ran (browser, Node version, OS).
- What you clicked or called.
- What you expected and what happened.
- Screenshots or a short recording for visible UI changes.

At minimum, run:

```bash
node --check server/src/index.js        # and every other changed server file
npm --prefix client run build
```

For changes touching messages, permissions, DMs, voice, or uploads, read the relevant manual passes in [Development](docs/development.md#testing-and-qa) and say which ones you completed.

## Pull request process

1. Fork the repository and create a branch from `main`.
2. Make the change, including documentation and any migration.
3. Run the checks above and the manual tests that apply.
4. Open a pull request using the template. Link the issue it closes, if any.
5. Keep the branch up to date if `main` moves and the conflict is meaningful.
6. Respond to review. Maintainers may ask for a smaller change or a different approach.

A pull request is ready to merge when:

- It does what the linked issue describes, and nothing unrelated.
- The build and syntax checks pass.
- Documentation is updated where behaviour or configuration changed.
- A maintainer has approved it.

Maintainers may close a pull request that has been inactive for a long time without response, or one that does not fit the project's scope. That is not a judgment on the work.

## Licensing

Cordia is licensed under the **GNU Affero General Public License, version 3.0 only** (`AGPL-3.0-only`). By submitting a contribution, you agree that it is licensed under the same terms. You retain copyright in your contribution.

Do not copy code, artwork, or fonts into the repository unless you have the right to license them under AGPL-3.0. If you add a dependency or bundled asset, add it to [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) with its license and source.

## Trademarks

The Cordia name, the Codi mascot, and the Cordia logo are project trademarks and are not licensed under the AGPL. You may fork and run the code; please do not present a fork as the official Cordia service. See the trademark notice in the [README](README.md#license).

## Questions

Open a discussion or an issue with the `question` label. For security matters, use the private channel in [SECURITY.md](SECURITY.md) instead.
