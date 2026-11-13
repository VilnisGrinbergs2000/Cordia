# HTTP and realtime API

This is the contract the Cordia client uses. It is stable enough to build bots and integrations against, but it is not a versioned public API: routes may change between releases. Bots should prefer the gateway and the `/api/guilds` surface, which are the parts designed for third parties.

## Base URL and conventions

All HTTP routes are under `/api` on the same origin as the app:

```
https://cordia.ext.io/api
```

In development the Vite server proxies `/api`, `/uploads`, and `/socket.io` to `http://localhost:3001`. A native or third-party client can call the API origin directly.

| Convention | Detail |
| ---------- | ------ |
| Request bodies | JSON unless the route is an upload (`multipart/form-data`). The JSON limit is 1 MB. |
| Responses | JSON. Errors are `{ "error": "message" }`, sometimes with a machine-readable `code`. |
| IDs | Integers. They are `bigint` in Postgres, parsed to JavaScript numbers. |
| Timestamps | Epoch milliseconds as integers, not ISO strings. |
| Field naming | `camelCase` in responses; request bodies also use `camelCase`. |
| Authentication | Session cookie or `Authorization: Bearer` for people; `Authorization: Bot` for bots. |
| CORS | Only configured origins (`CLIENT_ORIGIN`), native origins, and same-host origins. |
| Trailing slashes | `GET`/`HEAD` paths with a trailing slash redirect to the canonical path. |

### Authentication

#### Browser sessions

`POST /api/auth/login` and `POST /api/auth/register` set an httpOnly `cordia_token` cookie. Send it with `credentials: 'include'`. The cookie is `SameSite=Lax`, and `Secure` when `NODE_ENV=production` or the request arrived over HTTPS.

The token is a 30-day HS256 JWT carrying `{ sub: userId, ver: tokenVersion }`. Changing the account's token version invalidates every existing session.

#### Native clients

Send `X-Cordia-Client: native` on login or registration. The response then includes `token` in the body. Store it and send:

```http
Authorization: Bearer <token>
```

#### Bots

Create an application in **Settings → Developers**, then use the token shown once:

```http
Authorization: Bot cordia_<random>
```

Bot tokens work on `/api` routes that explicitly accept them (the `/api/guilds/*` group and `/api/applications/@me`) and on the `/gateway` namespace. They are not interchangeable with session tokens.

### Errors

| Status | Meaning |
| ------ | ------- |
| `400` | Validation failed, or the request cannot be applied in the current state. |
| `401` | Not signed in, invalid token, or invalid credentials. |
| `403` | Signed in but not allowed (permission, ban, CORS/origin). |
| `404` | The resource does not exist or is not visible to this principal. |
| `409` | Conflict, such as a username or email already in use. |
| `413` | Upload exceeds the file-size cap or the account storage quota. |
| `429` | Rate limited. Some responses include `retryAfter` in seconds. |
| `500` | Unexpected server error. The body is intentionally generic. |

Codes you may need to branch on:

| `code` | Where | Meaning |
| ------ | ----- | ------- |
| `AUTOMOD` | Send message | Blocked by a server automod rule. `rule` names it. |
| `SAFETY_THROTTLE` | Send message | Cross-channel spam protection. Read `retryAfter`. |
| `UPLOAD_TOO_LARGE` | Upload | Over 50 MB per file. `limit` is in bytes. |
| `STORAGE_FULL` | Upload | Over the 5 GB account quota. `used` and `quota` are included. |
| `E2EE_KEY_CHANGED` | Encrypted DM | A participant rotated keys. Reload the conversation and re-encrypt. |

There is no paid upgrade and no feature gate. Free space by deleting unused files in **Settings → Storage**.

### Pagination

Message history is cursor-based and walks backwards:

```http
GET /api/channels/123/messages?limit=50&before=98765
```

- `limit` defaults to 50 and is clamped to 1–100.
- `before` is an exclusive message ID. Omit it for the newest page.
- The response is ordered oldest to newest, with `hasMore` telling you whether an older page exists.
- `catchup` is included on the newest page only.

Search returns at most 30 results and takes no cursor.

### Rate limits

Limits are fixed windows stored in Postgres, so they survive restarts. The defaults:

| Scope | Limit |
| ----- | ----- |
| Register, login, password request | 20 per minute per IP |
| Failed logins for one account | 10 per 15 minutes |
| Verification resend | 3 per 15 minutes |
| Password reset request | 5 per 15 minutes |
| Send channel or DM message | 20 per 10 seconds per user |
| Slash command | 12 per 10 seconds per user |
| Autocomplete | 120 per 10 seconds per user |
| Upload | 20 per minute per user |
| E2EE key bundle | 60 per minute per user |
| Report | 8 per minute |
| Join by invite | 10 per minute per user + IP |
| Invite preview | 60 per minute per IP |
| Emote changes | 40 per minute |
| Icon suggestions / votes | 20 / 60 per minute |
| Soundboard play | 1 per 2 seconds per user per server |
| Server tier changes | 30 per minute |

A `429` usually carries `{ "error": "..." }`. Do not retry in a tight loop; wait for the window or honour `retryAfter` when present.

## Authentication and account

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `POST` | `/auth/register` | Create an account. Body: `username`, `email`, `password`, `displayName`, `acceptGuidelines: true`. |
| `POST` | `/auth/login` | Body: `login` (username or email) and `password`. |
| `POST` | `/auth/logout` | Clear the session cookie. |
| `GET` | `/auth/me` | Current user, badges, and a fresh upload token. |
| `POST` | `/auth/verify/resend` | Resend the email verification link. |
| `POST` | `/auth/password/request` | Request a reset link. Always returns `{ ok: true }`. |
| `POST` | `/auth/recovery/verify` | Verify an E2EE recovery code and receive a short-lived reset token. |
| `POST` | `/auth/recovery/complete` | Set a new password and replace the encrypted key backup. |
| `GET` | `/badges` | Catalog of all badges. Public. |

Register and login return:

```json
{
  "user": { "id": 1, "username": "aria", "displayName": "Aria", "role": "admin" },
  "badges": [],
  "uploadToken": "1.1760000000000.<hmac>"
}
```

Registration succeeds even when SMTP is unavailable; the address simply stays unverified. The first account created in an empty database becomes `role: "admin"` and receives the `founder` badge.

`GET /api/auth/me` is the bootstrap check the client runs on load. A `401` means show the sign-in page.

## Bootstrap, servers, and channels

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/bootstrap` | Everything the shell needs: `servers`, `dms`, `users`, `readState`. |
| `GET` | `/server-templates` | Built-in templates for the create-server dialog. |
| `POST` | `/servers` | Create a server. Body: `name`, optional `templateId`, optional `iconUrl`. |
| `GET` | `/servers/:id` | One server with channels, groups, members, and emotes. |
| `PATCH` | `/servers/:id` | Update name, icon, banner, description, or other server settings. |
| `DELETE` | `/servers/:id` | Delete a server (owner only). |
| `POST` | `/servers/:id/leave` | Leave a server. |
| `POST` | `/servers/:id/transfer` | Transfer ownership. |
| `GET` | `/servers/:id/export` | Export server structure and content as JSON. |
| `POST` | `/servers/:id/import/preview` | Validate an import without applying it. |
| `POST` | `/servers/:id/import` | Apply a previously previewed import. |
| `GET` | `/servers/:id/insights` | Server analytics for people with permission. |
| `GET` | `/discover` | Public server directory. |
| `POST` | `/discover/:id/join` | Join a discoverable server. |

`GET /api/bootstrap` is the only call needed after sign-in:

```json
{
  "servers": [ { "id": 1, "name": "Cordia", "channels": [], "groups": [], "members": [] } ],
  "dms": [ { "id": 4, "otherUser": { "id": 2, "username": "kai" }, "lastMessage": null } ],
  "users": [ { "id": 2, "username": "kai", "displayName": "Kai" } ],
  "readState": { "channels": {}, "dms": {} }
}
```

### Channels and categories

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `POST` | `/servers/:id/channels` | Create a text, voice, forum, announcement, or stage channel. |
| `PUT` | `/servers/:id/channels/order` | Reorder channels. Body: an ordered list of IDs. |
| `PATCH` | `/channels/:id` | Rename, retopic, change slowmode, or move a channel. |
| `DELETE` | `/channels/:id` | Delete a channel. |
| `POST` | `/servers/:id/categories` | Create a category. |
| `PATCH` | `/servers/:id/categories/:categoryId` | Rename or reposition a category. |
| `PUT` | `/servers/:id/categories/order` | Reorder categories. |
| `DELETE` | `/servers/:id/categories/:categoryId` | Delete a category. |
| `GET` | `/channels/:id` | Channel metadata and the caller's permissions. |
| `GET` | `/channels/:id/overrides` | Per-channel permission overrides. |
| `PUT` | `/channels/:id/overrides/:targetType/:targetId` | Set an override for `member` or `group`. |
| `DELETE` | `/channels/:id/overrides/:targetType/:targetId` | Remove an override. |

### Groups, members, and invites

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/servers/:id/groups` | Ranked permission groups. |
| `POST` | `/servers/:id/groups` | Create a group. |
| `PATCH` | `/servers/:id/groups/:groupId` | Update name, color, permissions, or position. |
| `PUT` | `/servers/:id/groups/order` | Reorder groups. |
| `DELETE` | `/servers/:id/groups/:groupId` | Delete a group. |
| `GET` | `/servers/:id/group-categories` | Group headings used in the member list. |
| `POST` | `/servers/:id/group-categories` | Create a heading. |
| `PATCH` | `/servers/:id/group-categories/:categoryId` | Rename or reorder a heading. |
| `DELETE` | `/servers/:id/group-categories/:categoryId` | Delete a heading. |
| `PUT` | `/servers/:id/members/:userId/groups` | Replace a member's groups. |
| `PATCH` | `/servers/:id/members/me/bio` | Set your own server bio. |
| `PATCH` | `/servers/:id/members/:userId` | Change a member's nickname, role, or timeout. |
| `DELETE` | `/servers/:id/members/:userId` | Kick a member. |
| `GET` | `/servers/:id/invites` | List invites. |
| `POST` | `/servers/:id/invites` | Create an invite. Body: optional `maxUses` (0–100), `expiresInMinutes` (0–129600). |
| `DELETE` | `/invites/:inviteId` | Revoke an invite. |
| `GET` | `/invites/:code` | Preview an invite. No authentication required. |
| `POST` | `/servers/join` | Join with `{ code }`. |
| `PUT` | `/servers/:id/invite/code` | Set the vanity invite code. |
| `POST` | `/servers/:id/invite/regenerate` | Rotate the vanity code. |

### Server extras

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/servers/:id/onboarding` | Onboarding checklist and state. |
| `POST` | `/servers/:id/onboarding/dismiss` | Dismiss onboarding. |
| `GET` | `/servers/:id/welcome` | Welcome screen configuration. |
| `POST` | `/servers/:id/welcome/dismiss` | Dismiss the welcome screen. |
| `GET` | `/servers/:id/icon-history` | Previous server icons. |
| `GET` | `/servers/:id/icon-suggestions` | Icon suggestions and vote counts. |
| `POST` | `/servers/:id/icon-suggestions` | Suggest an icon. |
| `POST` | `/servers/:id/boost` | Boost the server. |
| `PATCH` | `/servers/:id/boost` | Change your boost state. |
| `GET` | `/servers/:id/boost/me` | Your boost state. |
| `GET` | `/servers/:id/automod` | Automod rules. |
| `PATCH` | `/servers/:id/automod` | Replace automod rules. |
| `GET` | `/servers/:id/events` | Scheduled server events. |
| `POST` | `/servers/:id/events` | Create an event. |
| `PATCH` | `/servers/:id/events/:eventId` | Update an event. |
| `DELETE` | `/servers/:id/events/:eventId` | Delete an event. |
| `POST` | `/servers/:id/events/:eventId/rsvp` | RSVP to an event. |

### Per-server supporter tiers

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/servers/:id/tiers` | List a server's supporter tiers. |
| `GET` | `/servers/:id/tiers/summary` | Subscriber counts and revenue summary. |
| `POST` | `/servers/:id/tiers` | Create a tier. |
| `PATCH` | `/servers/:id/tiers/:tierId` | Update a tier. |
| `DELETE` | `/servers/:id/tiers/:tierId` | Delete a tier. |
| `POST` | `/servers/:id/tiers/:tierId/subscribe` | Subscribe. |
| `DELETE` | `/servers/:id/tiers/:tierId/subscribe` | Cancel. |

These are optional per-server supporter tiers. They grant the tier's group and lapse at the period end. No payment provider is wired up in this codebase: the subscription is a local record, not a charge. They are unrelated to account access, and no feature is gated by them.

## Messages

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/channels/:id/messages` | Page through history. Query: `limit`, `before`. |
| `POST` | `/channels/:id/messages` | Send a message. |
| `PATCH` | `/messages/:id` | Edit your message. |
| `DELETE` | `/messages/:id` | Delete a message you wrote or moderate. |
| `GET` | `/messages/:id/edits` | Edit history. |
| `POST` | `/messages/:id/forward` | Forward to another channel or DM. |
| `GET` | `/channels/:id/pins` | Pinned messages. |
| `POST` | `/messages/:id/pin` | Pin. |
| `DELETE` | `/messages/:id/pin` | Unpin. |
| `POST` | `/messages/:id/reactions` | Toggle a reaction. Body: `{ emoji }`. |
| `POST` | `/channels/:id/polls` | Create a poll message. |
| `POST` | `/polls/:id/vote` | Vote. Body: `{ optionId }` or indices. |
| `POST` | `/polls/:id/close` | Close a poll. |
| `POST` | `/channels/:id/scheduled` | Schedule a message. |
| `GET` | `/scheduled` | Your pending scheduled messages. |
| `DELETE` | `/scheduled/:id` | Cancel a scheduled message. |

Send-message body:

```json
{
  "content": "hello",
  "replyToId": null,
  "attachment": {
    "url": "/uploads/0f0c...png",
    "name": "screenshot.png",
    "type": "image/png"
  },
  "voiceDurationMs": null
}
```

`content` may be empty only when `attachment` is present. Bots may also send `components` (buttons and select menus); people cannot. The response is `201 { "message": { ... } }`.

Message objects carry `id`, `channelId`, `author`, `content`, `createdAt`, `editedAt`, `attachment`, `replyTo`, `reactions`, `pinned`, `poll`, `components`, and mention metadata as applicable. Encrypted DMs use a separate envelope shape described below.

### Mentions, read state, and catch-up

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `POST` | `/read/:scopeType/:scopeId` | Mark a channel or DM read. `scopeType` is `channel` or `dm`. |
| `PATCH` | `/read/:scopeType/:scopeId/mute` | Mute or unmute. Body: `{ muted }`. |
| `POST` | `/read/:scopeType/:scopeId/unread` | Mark unread from `{ messageId }`. |
| `POST` | `/read/all` | Mark every unmuted text channel read. |
| `GET` | `/catchup/summary` | Counts of unread messages and mentions. |
| `GET` | `/mentions` | Recent mentions. |
| `GET` | `/search` | Message search. Query: `q` (2–100 chars), optional `serverId`, `channelId`. |

## Direct messages and E2EE

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `POST` | `/dms` | Open a DM. Body: `{ userId }`. |
| `GET` | `/dms/:id/messages` | History. Same `limit`/`before` pagination as channels. |
| `POST` | `/dms/:id/messages` | Send plaintext or an encrypted envelope. |
| `GET` | `/dms/:id/pins` | Pinned messages. |
| `POST` | `/dms/:id/close` | Close the conversation. |
| `GET` | `/e2ee/me` | Your published keys and key version. |
| `GET` | `/e2ee/prekeys` | Your remaining one-time prekeys. |
| `POST` | `/e2ee/prekeys` | Upload more one-time prekeys. |
| `GET` | `/e2ee/users/:id/bundle` | Fetch a recipient's X3DH bundle. |
| `GET` | `/e2ee/users/:id/key` | Public identity key. |
| `GET` | `/e2ee/users/:id/key-history` | Hash-chained key history. |
| `POST` | `/e2ee/setup` | Publish identity, signed prekey, and backup. |
| `PUT` | `/e2ee/backup` | Replace the encrypted key backup. |
| `POST` | `/e2ee/rotate` | Rotate keys and append to the hash chain. |
| `POST` | `/e2ee/recovery` | Store a recovery verifier and encrypted backup. |
| `DELETE` | `/e2ee/recovery` | Remove recovery material. |

An encrypted DM is posted as:

```json
{
  "encrypted": {
    "v": 2,
    "alg": "X3DH-DOUBLE-RATCHET-P256-AES-256-GCM",
    "dmId": 4,
    "senderId": 1,
    "recipientId": 2,
    "senderKeyVersion": 3,
    "recipientKeyVersion": 5,
    "iv": "base64",
    "ct": "base64",
    "header": { "dh": "base64", "pn": 0, "n": 7 },
    "x3dh": { "identityKey": "...", "signedPrekey": "...", "oneTimePrekeyId": 12 }
  }
}
```

The server validates the conversation, participants, key versions, header shape, and ciphertext bounds, then stores the envelope without decrypting it. A key-version mismatch returns `409` with `code: "E2EE_KEY_CHANGED"`. Attachments in encrypted DMs are encrypted by the client before upload.

## Friends, notes, saved items, and reminders

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/friends` | Friends, incoming requests, outgoing requests, and blocked users. |
| `POST` | `/friends/requests` | Send a request. Body: `{ username }` or `{ userId }`. |
| `POST` | `/friends/requests/:id/accept` | Accept. |
| `DELETE` | `/friends/requests/:id` | Decline or cancel. |
| `DELETE` | `/friends/:userId` | Remove a friend. |
| `POST` | `/friends/block` | Block a user. |
| `DELETE` | `/friends/block/:userId` | Unblock. |
| `GET` | `/users/:id/note` | Your private note about a user. |
| `PUT` | `/users/:id/note` | Set the note. |
| `POST` | `/messages/:id/save` | Save a message. |
| `DELETE` | `/messages/:id/save` | Remove it from saved items. |
| `GET` | `/saved` | Saved messages. |
| `POST` | `/messages/:id/remind` | Create a reminder. Body: `{ remindAt }` (epoch ms). |
| `GET` | `/reminders` | Pending reminders. |
| `DELETE` | `/reminders/:id` | Cancel a reminder. |

## Profiles and presence

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/users/me` | Your full profile and settings. |
| `PATCH` | `/users/me` | Update profile, status, theme, notification preferences, or password. |
| `GET` | `/users/:id/profile` | Another user's public profile and mutual servers. |
| `POST` | `/presence/now-playing` | Publish "listening to" activity. |
| `DELETE` | `/presence/now-playing` | Clear it. |

## Uploads and storage

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `POST` | `/upload` | Upload one file as `multipart/form-data` with field `file`. |
| `GET` | `/support/me` | Account limits and storage usage. |
| `GET` | `/support/me/storage` | Per-file storage usage and where each file is referenced. |
| `DELETE` | `/support/me/storage/:name` | Delete an unused file. |

The upload response:

```json
{
  "attachment": {
    "url": "/uploads/0f0c9d2e-....png",
    "name": "screenshot.png",
    "type": "image/png",
    "bytes": 183402
  }
}
```

Allowed types: PNG, JPEG, GIF, WebP, AVIF, MP4, WebM, MP3, OGG, WAV, WebM audio, PDF, ZIP, and plain text. The server generates the stored file name from a UUID and the MIME type; the original name is kept only as metadata.

`/uploads/:name` requires a session cookie or the scoped `?t=` token. The client receives an upload token from `/api/auth/me` and appends it to media URLs. Without either credential the response is `401`.

The per-file ceiling is 50 MB and the per-account quota is 5 GB. Both are technical limits applied to every account; there is no paid plan that raises them.

## Notifications

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/push/public-key` | VAPID public key. |
| `POST` | `/push/subscribe` | Store a browser push subscription. |
| `POST` | `/push/unsubscribe` | Remove it. |
| `POST` | `/push/test` | Send yourself a test notification. |
| `GET` | `/integrations` | Runtime integration keys the client may use, currently `{ klipy: { key } }` or `null`. |

Web Push needs HTTPS (or `localhost`) and a VAPID key pair. See [Configuration](configuration.md#web-push-vapid).

## Voice

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/voice/ice` | Returns `{ iceServers: [...], expiresAt }`. `iceServers` is ready to pass to `RTCPeerConnection`; `expiresAt` is a Unix timestamp when time-limited TURN credentials expire, or `null`. |

Media itself is peer-to-peer. Joining, leaving, state changes, and signalling happen over Socket.IO, not HTTP.

## Threads, forums, docs, and lists

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `POST` | `/channels/:channelId/threads` | Create a thread. |
| `POST` | `/channels/:channelId/posts` | Create a forum post (a thread with tags). |
| `GET` | `/servers/:serverId/threads` | Active and archived threads in a server. |
| `POST` | `/threads/:threadId/join` | Join a private thread. |
| `GET` | `/threads/:threadId/members` | Thread members. |
| `PATCH` | `/threads/:threadId` | Rename, archive, lock, or change slowmode. |
| `DELETE` | `/threads/:threadId` | Delete a thread. |
| `GET` | `/channels/:channelId/tags` | Forum tags. |
| `POST` | `/channels/:channelId/tags` | Create a tag. |
| `POST` | `/channels/:channelId/tags/reorder` | Reorder tags. |
| `PATCH` | `/tags/:tagId` | Update a tag. |
| `DELETE` | `/tags/:tagId` | Delete a tag. |
| `GET` | `/channels/:id/docs` | Channel documents. |
| `POST` | `/channels/:id/docs` | Create a document. |
| `GET` | `/docs/:id` | Read a document. |
| `PATCH` | `/docs/:id` | Save a revision. |
| `GET` | `/docs/:id/versions` | Revision history. |
| `DELETE` | `/docs/:id` | Delete a document. |
| `GET` | `/channels/:id/lists` | Channel lists. |
| `POST` | `/channels/:id/lists` | Create a list. |
| `POST` | `/lists/:id/items` | Add an item. |
| `PATCH` | `/list-items/:id` | Update an item (text, checked state, position). |
| `DELETE` | `/list-items/:id` | Remove an item. |
| `DELETE` | `/lists/:id` | Delete a list. |

## Emotes, soundboard, and discovery

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/emotes/mine` | Emotes available to you across servers. |
| `GET` | `/servers/:id/emotes` | A server's emotes. |
| `POST` | `/servers/:id/emotes` | Add an emote. |
| `PATCH` | `/servers/:id/emotes/:emoteId` | Rename or change access. |
| `DELETE` | `/servers/:id/emotes/:emoteId` | Delete an emote. |
| `GET` | `/servers/:id/soundboard` | Soundboard clips. |
| `POST` | `/servers/:id/soundboard` | Add a clip. |
| `DELETE` | `/soundboard/:id` | Delete a clip. |
| `POST` | `/soundboard/:id/play` | Play a clip in your current voice channel. |
| `GET` | `/discover` | Discoverable servers. |
| `POST` | `/discover/:id/join` | Join one. |

## Applications, bots, and interactions

### Management (people)

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/applications` | Your applications. |
| `POST` | `/applications` | Create one. |
| `PATCH` | `/applications/:id` | Update name, description, intents, or redirect URIs. |
| `POST` | `/applications/:id/token` | Rotate the bot token. The new token is shown once. |
| `POST` | `/applications/:id/sessions/revoke` | Disconnect every gateway session. |
| `DELETE` | `/applications/:id` | Delete the application. |
| `GET` | `/applications/:id/audit` | Application audit log. |
| `GET` | `/applications/:id/commands` | List commands. |
| `POST` | `/applications/:id/commands` | Create a slash command. |
| `PATCH` | `/applications/:id/commands/:commandId` | Update a command. |
| `DELETE` | `/applications/:id/commands/:commandId` | Delete a command. |
| `GET` | `/applications/servers` | Servers you can install into. |
| `GET` | `/applications/:id/installs` | Installations. |
| `POST` | `/applications/:id/install` | Install into a server. |
| `DELETE` | `/applications/:id/install/:serverId` | Uninstall. |
| `GET` | `/applications/installed` | Applications installed in your servers. |
| `GET` | `/applications/public/:clientId` | Public application metadata for the authorize screen. |
| `POST` | `/applications/authorize` | Authorize a user-install application. |

### Bot REST

These require `Authorization: Bot <token>`:

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/applications/@me` | The bot's application and user. |
| `GET` | `/guilds` | Servers the bot is installed in. |
| `GET` | `/guilds/:id` | Guild metadata. |
| `GET` | `/guilds/:id/members` | Guild members. |
| `GET` | `/guilds/:id/channels` | Guild channels. |
| `GET` | `/guilds/:id/roles` | Guild groups/roles. |

Bot-created messages go through the normal message route with the bot token; bots can include `components`.

### Interactions

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/channels/:id/commands` | Commands available in a channel. |
| `POST` | `/channels/:id/interactions` | Invoke a slash command. |
| `POST` | `/channels/:id/components` | Click a button or use a select menu. |
| `POST` | `/channels/:id/autocomplete` | Request autocomplete choices. |
| `POST` | `/autocomplete/:token` | Fulfil a pending autocomplete request from a bot. |
| `POST` | `/interactions/:id/callback` | Bot's first response. |
| `POST` | `/interactions/:id/followup` | Bot's follow-up response. |
| `POST` | `/interactions/:id/modal-submit` | Submit a modal. |

Interaction tokens are single-use for the first response; a second callback returns `409`. Follow-ups are allowed while the token is valid.

## Administration and safety

All `/api/admin/*` routes require `users.role = 'admin'`.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/admin/overview` | Instance health and counts. |
| `GET` | `/admin/activation` | Registration and activity funnel. |
| `GET` | `/admin/users` | Search and list users. |
| `PATCH` | `/admin/users/:id` | Change role, ban, or reset profile fields. |
| `DELETE` | `/admin/users/:id` | Delete an account and release its uploads. |
| `POST` | `/admin/users/:id/badges` | Grant a badge. |
| `DELETE` | `/admin/users/:id/badges/:badge` | Revoke a badge. |
| `GET` | `/admin/servers` | List servers. |
| `DELETE` | `/admin/servers/:id` | Delete a server. |
| `GET` | `/admin/audit` | Audit log. |
| `GET` | `/admin/applications` | Applications. |
| `POST` | `/admin/applications/:id/verify` | Verify an application. |
| `GET` | `/admin/safety` | Safety events. |
| `POST` | `/admin/safety/:id/review` | Mark a safety event reviewed. |
| `GET` | `/admin/mail` | Mail outbox and suppressions. |
| `POST` | `/admin/broadcast/preview` | Preview a broadcast mail. |
| `POST` | `/admin/broadcast` | Send a broadcast. |
| `POST` | `/admin/seo/indexnow` | Submit marketing pages to IndexNow. |

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `POST` | `/reports` | Report a user or message. |
| `GET` | `/admin/reports` | List reports. |
| `PATCH` | `/admin/reports/:id` | Resolve or dismiss a report. |
| `GET` | `/support/me` | Account limits and storage. |
| `GET` | `/support/me/storage` | Storage breakdown. |

## Socket.IO

The people namespace is `/` on the same origin. It uses the same session cookie as HTTP, or `handshake.auth.token` for native and non-cookie clients.

```js
import { io } from 'socket.io-client';

const socket = io('https://cordia.ext.io', {
  withCredentials: true,
  transports: ['websocket', 'polling']
});
```

Native:

```js
const socket = io('https://cordia.ext.io', {
  auth: { token: bearerToken }
});
```

### Client → server

| Event | Payload | Notes |
| ----- | ------- | ----- |
| `typing` | `{ scopeType: 'channel' \| 'dm', scopeId }` | Re-checks membership, privacy, and `sendMessages`. The server emits `typing` to the room with the user. |
| `voice:join` | `{ channelId }` | Checks channel type, membership, and `connectVoice`. Occupies the channel. |
| `voice:leave` | none | Leaves and records voice seconds. |
| `voice:state` | `{ muted, video, sharing }` | Enforces `speak`. |
| `webrtc:signal` | `{ to, data }` | Relayed to the peer socket, locally or through Postgres. |
| `call:start` | `{ userId }` | Start a direct call. Enforces block checks and call rate limits. |
| `call:accept` | `{ callId }` | Accept an incoming call. |
| `call:decline` | `{ callId }` | Decline it. |
| `call:end` | `{ callId }` | End it. |
| `call:signal` | `{ callId, data }` | WebRTC signalling for a direct call. |

### Server → client

| Group | Events |
| ----- | ------ |
| Presence | `presence:list`, `presence:update`, `activity:update` |
| Users | `user:new`, `user:updated`, `user:deleted`, `badge:awarded`, `badges:updated` |
| Messages | `message:new`, `message:updated`, `message:deleted`, `message:reactions`, `message:poll`, `message:pinned`, `message:unpinned` |
| Conversations | `dm:new`, `friends:changed`, `typing` |
| Servers | `server:updated`, `server:threads-changed`, `server:joined`, `server:member-joined`, `server:member-left`, `server:deleted`, `channel:created`, `channel:deleted` |
| Reminders and bots | `reminder:due`, `interaction:modal` |
| Calls | `call:incoming`, `call:ringing`, `call:accepted`, `call:signal`, `call:ended`, `call:handled`, `call:unavailable` |
| Voice | `voice:occupancy`, `voice:occupancy:init`, `voice:participants`, `voice:peer-joined`, `voice:peer-left`, `voice:peer-state`, `voice:force-mute`, `voice:error`, `voice:closed` |

Event payloads mirror the HTTP objects. For example, `message:new` carries the same serialized message as `POST /api/channels/:id/messages`, and `server:updated` carries the same object as `GET /api/servers/:id`.

Presence is per process. `presence:update` reports a user's chosen status, not merely whether a socket exists. A user who chose to appear offline is still reachable for calls and push.

## Bot gateway

The gateway is a separate Socket.IO namespace at `/gateway`, authenticated with the bot token:

```js
const gateway = io('https://cordia.ext.io/gateway', {
  auth: { token: process.env.BOT_TOKEN }
});
```

Everything the server sends is a `dispatch` event:

```json
{ "t": "MESSAGE_CREATE", "d": { "...": "..." }, "seq": 42 }
```

### Lifecycle

| Event | Direction | Meaning |
| ----- | --------- | ------- |
| `READY` | server → bot | Sent once after connect. Contains `application`, `user`, `servers`, `guilds`, `commands`, `sessionId`, `seq`, `shard`, `sessionLimit`, `replayLimit`. |
| `RESUMED` | server → bot | The requested replay was delivered. |
| `RESUME_FAILED` | server → bot | The session or sequence is too old. Reconnect for a fresh `READY`. |
| `SESSION_LIMIT` | server → bot | Too many concurrent gateway sessions; the socket is closed. |
| `PING` / `PONG` | both | App-level heartbeat. Send `ping`; the server answers `PONG` and touches the session. |
| `resume` | bot → server | `{ sessionId, seq }` to replay missed dispatches. |
| `resume` ack | server → bot | Missed dispatches are replayed from `gateway_events`. |

### Dispatches

| Event | Intent | Payload |
| ----- | ------ | ------- |
| `MESSAGE_CREATE` | `messages` | A channel or DM message. |
| `MESSAGE_UPDATE` | `messages` | Edited message. |
| `MESSAGE_DELETE` | `messages` | `{ id, channelId, serverId }`. |
| `REACTION_ADD` | `reactions` | `{ messageId, userId, emoji }`. |
| `REACTION_REMOVE` | `reactions` | Same shape. |
| `MEMBER_JOIN` | `members` | Member and guild IDs. |
| `MEMBER_LEAVE` | `members` | Member and guild IDs. |
| `VOICE_STATE_UPDATE` | `members` | Voice join/leave/state. |
| `INTERACTION_CREATE` | always | A slash command, button, select, or modal submission. |

Intents are declared per application as a comma-separated list of `messages`, `reactions`, and `members`. No declaration means all three. DM events are delivered to the bot in the conversation regardless of guild intents.

Replying to an interaction:

```http
POST /api/interactions/123/callback
Authorization: Bot <token>
Content-Type: application/json

{ "type": "message", "content": "pong" }
```

The first callback claims the interaction. A second one is rejected, and follow-ups use `/followup`.

The gateway is shard-aware (`CORDIA_SHARD_ID`, `CORDIA_SHARD_COUNT`) and replayable. Gateway sessions are capped per application (5 by default) and dispatches are retained for 24 hours or 1,000 events, whichever is smaller.

## Examples

### Register and send a message

```bash
# Register; the cookie jar keeps the session
curl -s -c jar.txt -X POST https://cordia.ext.io/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"aria","email":"aria@example.com","password":"correct horse battery staple","displayName":"Aria","acceptGuidelines":true}'

# Bootstrap
curl -s -b jar.txt https://cordia.ext.io/api/bootstrap

# Post to channel 1
curl -s -b jar.txt -X POST https://cordia.ext.io/api/channels/1/messages \
  -H 'Content-Type: application/json' \
  -d '{"content":"hello from curl"}'
```

### Read history

```bash
curl -s -b jar.txt 'https://cordia.ext.io/api/channels/1/messages?limit=100'
curl -s -b jar.txt 'https://cordia.ext.io/api/channels/1/messages?limit=100&before=98765'
```

### Upload

```bash
curl -s -b jar.txt -X POST https://cordia.ext.io/api/upload \
  -F 'file=@screenshot.png'
```

Use the returned `attachment` object as the `attachment` field of a message.

### Bot connect and reply

```js
import { io } from 'socket.io-client';

const gateway = io('https://cordia.ext.io/gateway', {
  auth: { token: process.env.BOT_TOKEN }
});

gateway.on('dispatch', async (event) => {
  if (event.t === 'INTERACTION_CREATE') {
    await fetch(`https://cordia.ext.io/api/interactions/${event.d.id}/callback`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${process.env.BOT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ type: 'message', content: 'pong' })
    });
  }
});
```

## Related documentation

- [Architecture](architecture.md) — why routes look the way they do.
- [Configuration](configuration.md) — origins, secrets, TURN, push, and mail.
- [Development](development.md) — adding a route or event.
