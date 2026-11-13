## What this changes

<!-- One or two sentences. Link the issue this closes, if any: "Closes #123". -->

## Why

<!-- The problem, not the implementation. What breaks or is missing today? -->

## How

<!-- The approach, and anything a reviewer should look at first. Note trade-offs. -->

## Areas touched

- [ ] Server routes, helpers, or jobs
- [ ] Database schema or migration
- [ ] Socket.IO or bot gateway
- [ ] Client UI or state
- [ ] E2EE or voice
- [ ] Desktop or mobile shell
- [ ] Landing page or documentation
- [ ] Build, CI, or deployment

## Testing

<!-- What did you run? Include browser, OS, Node and PostgreSQL versions where relevant. -->

- [ ] `node --check` passes for every changed server file
- [ ] `npm --prefix client run build` passes
- [ ] The manual smoke test in `docs/development.md#smoke-test` passes for the affected areas
- [ ] E2EE pass, if keys, DMs, or the ratchet changed
- [ ] Permission pass, if authorization changed
- [ ] Voice pass in two browsers, if media or signalling changed

## Screenshots or recordings

<!-- For visible UI changes. Before/after is ideal. -->

## Checklist

- [ ] No secrets, `.env` files, uploads, logs, or personal data are included.
- [ ] New configuration is documented in `server/.env.example` and `docs/configuration.md`.
- [ ] New routes and events are documented in `docs/api.md`.
- [ ] Migrations are new files, not edits to applied migrations.
- [ ] The change is licensed under AGPL-3.0-only, and any new third-party asset is listed in `THIRD_PARTY_NOTICES.md`.
- [ ] Unrelated files were not reformatted.
