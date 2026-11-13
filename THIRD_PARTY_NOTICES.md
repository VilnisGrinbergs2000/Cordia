# Third-party notices

Cordia itself is licensed under the **GNU Affero General Public License, version 3.0 only** (`AGPL-3.0-only`). See [LICENSE](LICENSE).

This file lists third-party work that is bundled with or required by Cordia, and the licenses under which it is used. It is not a complete dependency lockfile; the authoritative versions are in `package-lock.json` and each package's own `LICENSE` file.

## Bundled assets

### Twemoji

The emoji artwork served at `/twemoji` is from **Twemoji** (<https://github.com/jdecked/twemoji>), installed through the `@twemoji/svg` package.

- Graphics: **CC-BY 4.0** — Copyright 2020 Twitter, Inc and other contributors.
- The package metadata declares MIT for the package itself; the SVG artwork is CC-BY 4.0.

The SVGs are copied into `client/public/twemoji` at build time by `client/scripts/sync-twemoji.mjs` and are not committed to this repository. Attribution is provided here and on the project page.

### Fonts

Both fonts are self-hosted so the site makes no third-party font requests.

| Font | License | Source |
| ---- | ------- | ------ |
| Inter | SIL Open Font License 1.1 | <https://github.com/rsms/inter> |
| Space Grotesk | SIL Open Font License 1.1 | <https://github.com/floriankarsten/space-grotesk> |

Files: `landing/assets/fonts/inter-var.woff2`, `landing/assets/fonts/space-grotesk-var.woff2`.

### Cordia artwork

The Cordia name, the Codi mascot, the Cordia logo, the app icons, and the badge artwork are project trademarks and are **not** licensed under the AGPL. See the trademark notice in the [README](README.md#license). The files under `images/`, `landing/assets/`, `landing/*.png`, and `client/public/` are included so a deployment looks like Cordia; a fork may replace them.

### QR code

`landing/qr-code.png` is generated for the project and contains no third-party artwork.

## Runtime dependencies

### Server

| Package | License | Project |
| ------- | ------- | ------- |
| `express` | MIT | <https://expressjs.com> |
| `socket.io` | MIT | <https://socket.io> |
| `pg` | MIT | <https://github.com/brianc/node-postgres> |
| `bcryptjs` | BSD-3-Clause | <https://github.com/dcodeIO/bcrypt.js> |
| `jsonwebtoken` | MIT | <https://github.com/auth0/node-jsonwebtoken> |
| `multer` | MIT | <https://github.com/expressjs/multer> |
| `nodemailer` | MIT-0 | <https://nodemailer.com> |
| `helmet` | MIT | <https://helmetjs.github.io> |
| `cors` | MIT | <https://github.com/expressjs/cors> |
| `cookie-parser` | MIT | <https://github.com/expressjs/cookie-parser> |
| `web-push` | MPL-2.0 | <https://github.com/web-push-libs/web-push> |

`web-push` is MPL-2.0. It is used as an unmodified dependency; its source is available from the project link above. MPL-2.0 is compatible with AGPL-3.0 for this use, but if you modify `web-push` itself, the MPL's file-level copyleft applies to those files.

### Client

| Package | License | Project |
| ------- | ------- | ------- |
| `react`, `react-dom` | MIT | <https://react.dev> |
| `react-router-dom` | MIT | <https://reactrouter.com> |
| `socket.io-client` | MIT | <https://socket.io> |
| `lucide-react` | ISC | <https://lucide.dev> |
| `hash-wasm` | MIT | <https://github.com/Daninet/hash-wasm> |

### Desktop and mobile

| Package | License | Project |
| ------- | ------- | ------- |
| `electron` | MIT | <https://www.electronjs.org> |
| `electron-builder` | MIT | <https://www.electron.build> |
| `electron-updater` | MIT | <https://www.electron.build/auto-update> |
| `@capacitor/core`, `@capacitor/cli` | MIT | <https://capacitorjs.com> |
| `@capacitor/android`, `@capacitor/ios` | MIT | <https://capacitorjs.com> |
| `@capacitor/app` | MIT | <https://capacitorjs.com> |
| `@capacitor/local-notifications` | MIT | <https://capacitorjs.com> |

## Build and development dependencies

| Package | License | Project |
| ------- | ------- | ------- |
| `vite` | MIT | <https://vite.dev> |
| `@vitejs/plugin-react` | MIT | <https://github.com/vitejs/vite-plugin-react> |
| `@twemoji/svg` | MIT (package), CC-BY 4.0 (artwork) | <https://github.com/jdecked/twemoji> |
| `concurrently` | MIT | <https://github.com/open-cli-tools/concurrently> |
| `cross-env` | MIT | <https://github.com/kentcdodds/cross-env> |
| `wait-on` | MIT | <https://github.com/jeffbski/wait-on> |

## Optional external services

Cordia can talk to services that are not distributed with it. Using them is subject to their own terms and privacy policies:

- **KLIPY** for GIF search (<https://klipy.com>), only when `KLIPY_KEY` is set.
- **Google STUN** (`stun.l.google.com`) for WebRTC, by default.
- **Your SMTP provider** for mail.
- **Browser push services** (FCM, Mozilla autopush, Apple push) for Web Push.
- **IndexNow** participants (Bing, Yandex, Seznam, Naver) for search-engine notifications, only when `INDEXNOW_KEY` is set.

No user content is sent to KLIPY unless a user opens the GIF tab and searches. Message content, uploads, and E2EE key material are not sent to any of these services by the server.

## Reporting an omission

If you believe a bundled asset or dependency is missing from this file, or is listed under the wrong license, please open an issue or a pull request. Include the file or package, its source, and the license you believe applies.
