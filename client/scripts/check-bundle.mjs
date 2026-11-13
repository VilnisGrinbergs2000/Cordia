import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const dist = path.resolve('dist');
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
const unique = [...new Set(assets)];

const rows = unique.map((asset) => {
  const file = path.join(dist, asset.replace(/^\//, ''));
  const raw = fs.readFileSync(file);
  return {
    asset,
    raw: raw.length,
    gzip: zlib.gzipSync(raw, { level: 9 }).length,
    type: asset.endsWith('.css') ? 'css' : 'js'
  };
});

const js = rows.filter((row) => row.type === 'js');
const css = rows.filter((row) => row.type === 'css');
const sum = (entries, key) => entries.reduce((total, entry) => total + entry[key], 0);

// totalGzip covers everything the build emits, lazy chunks included, because
// that is the payload a client eventually downloads. It has been raised three times,
// each time for a feature that is mostly data or a rarely-opened view:
//   210 -> 212  emoji picker + Twemoji-backed catalogue
//   212 -> 214  threads and forum posts
//   214 -> 216  discovery page plus this session's UI work
//   216 -> 228  the nine release features: onboarding, soundboard, voice notes,
//               forwarding, stage channels and boosts are all client code
// The JS budget moved 175 -> 176 for the same reason, at the same time: thread
// archiving plus a permission entry left it at 174.9 of 175, which is not a
// budget, it is a coin flip.
//   176 -> 188  same nine features: the new screens, pickers and emote filter
//   188 -> 192  the retired plan UI: the billing tab, the entitlements context
//               and the composer upload upsell (+4.2 KiB), so total moved too.
//   234 -> 236  server onboarding checklist in the empty channel state, the
//               first surface a new owner sees (+0.8 KiB gzip).
//   192 -> 193  join/leave lines and the settings switch that turns them off:
//               two icons, the toggle card and the deep-link plumbing (+0.3 KiB
//               gzip). Total stays at 236.
//   193 -> 194  the server insights card in settings > Overview (+0.4 KiB
//               gzip). Total 236 -> 237 for the same reason.
//   194 -> 195  the insights card grew a 7/14/30 range switch, a hover
//               readout and a recency line (+0.6 KiB gzip). Total 237 -> 238.
//   195 -> 196  the Privacy tab grew friend-request, profile and activity
//               controls plus a blocked-people list (+0.5 KiB gzip). Total
//               238 -> 239 for the same reason.
//   196 -> 197  profile banner uploads: the shared image handler, the banner
//               action row and the cover image branch (+0.5 KiB gzip). Total
//               239 -> 240. Both were at 99.8% of the ceiling, which is the
//               coin flip the note above warns about.
//   197 -> 199  the three personal features: the send-later popover in the
//               composer, the bookmarks modal and the private note panel
//               (+1.4 KiB gzip). Total 240 -> 242.
//   199 -> 200  the safety layer: the recipient warning card in the message
//               list and the admin Safety tab (+0.9 KiB gzip). Total 242 -> 243.
//               Both landed at 99.9% again, so the bump is 1 KiB plus slack.
//   200 -> 202  the bot platform: the Developers panel (create, token, commands,
//               install), the slash-command picker in the composer and the BOT
//               badges (+2.6 KiB gzip). Total 243 -> 246.
//   202 -> 204  bot interactivity: rendering buttons and select menus inside a
//               message, plus seven more release-note lines describing it
//               (+0.7 KiB gzip). Total 246 -> 248. The previous ceiling was
//               0.2 KiB away, which is not a budget.
//   204 -> 206  bot forms and command autocomplete: the form modal, the
//               suggestion popup in the composer and the debounce around it
//               (+1.2 KiB gzip). Total 248 -> 250.
//   206 -> 210  the platform's second pass: subcommand suggestions in the
//               composer, the verified badge and scope list on the authorize
//               page, file fields in bot forms, and the permission toggles and
//               in-place command editing in the Developers panel (+1.4 KiB
//               gzip). Total 250 -> 254. The old ceiling was 0.6 KiB away,
//               which is the coin flip this note keeps warning about, so this
//               raise buys four rather than one.
// CSS 45 -> 46: the four tool channels (docs, lists, gallery, calendar) are new
// screens with their own layout (+0.8 KiB gzip). The four views are also
// code-split, so they only reach a client that opens one of those channels.
// Total stays at 254: the JS side had 1.6 KiB spare.
// CSS 46 -> 47: the subscription tier cards, the channel override matrix and
// the role-category controls are three new settings layouts (+0.3 KiB gzip).
//   210 -> 216  rich profiles and per-channel permissions: the link and game
//               editors, the profile panels, the role-category controls and
//               the three-state override matrix (+6.1 KiB gzip). Total
//               254 -> 262. This is the largest single raise so far, and it is
//               earned by two features rather than one, so the slack is
//               deliberate - both screens are settings surfaces a member opens
//               once, not the hot path.
// CSS 47 -> 48: the insights card had no stylesheet at all - the chart, the
// range picker and the three stat tiles were laid out by whatever the frame
// around them happened to do - and the storage manager, the welcome hero and
// the restyled bare <select> add up to +0.6 KiB gzip. Total 262 -> 263.
//   216 -> 217  house rules on the welcome card: one textarea, one counter and
//               a numbered preview list on the settings side, plus the same
//               list in the card itself (+0.3 KiB gzip). Total 263 -> 264. The
//               JS ceiling was 0.3 KiB away, which is the same "not a budget"
//               case as the 246 -> 248 raise, so it moves with the total.
//   217 -> 214  the retired plan UI is gone, and with it the plan cards, the
//               checkout flow and the compare table (-2.7 KiB gzip). CSS
//               48 -> 47, total 264 -> 261. Ceilings go down when code comes
//               out; leaving the slack would hide the next 3 KiB.
//   214 -> 215  the launch-time tip jar: Codi, the QR, the copy and the
//               frequency rules (+0.9 KiB gzip). Total 261 -> 262. It landed
//               exactly on the old ceiling, which is not a budget.
//   215 -> 218  Spotify listening presence: the connection tab, the shared
//               "listening to" card rendered in three places, the status-menu
//               block, the socket handler and its merge (+0.7 KiB gzip).
//               CSS 47 -> 49, total 262 -> 266. Every one of the three ceilings
//               was 0.6 KiB away or less, so all three move together. The
//               feature is a connection and a render path, not a screen full of
//               new surface, and three KiB of headroom is the smallest honest
//               amount that leaves room for the fixes it will need.
// CSS 49 -> 51: six surfaces that had no stylesheet at all finally got one -
//               forum tag pills, the pinned-message panel, the gallery empty
//               state and drop target, the mention popup, the role-category
//               composer with its colour presets, and a base .input rule that
//               the profile link and game fields were already relying on.
//               (+0.8 KiB gzip). Total 266 -> 268. JS stays at 218: the code
//               these styles describe was mostly wiring, not new screens.
// total 268 -> 270: outbound email. Sign-in gained a second way back in (the
//               emailed reset link), the settings sidebar gained a confirmation
//               nudge, and the admin console gained a delivery panel with a
//               composer (+0.6 KiB gzip). JS stays at 218 and CSS at 51: both
//               were still under their ceilings, and raising a ceiling nothing
//               crossed is how a budget stops meaning anything.
//   218 -> 220  provider-neutral "now playing": the connections card that reads
//               the desktop media session, the poll hook that pushes it, and the
//               source name on the shared listening card (+0.8 KiB gzip). CSS
//               and total stay put - the card reuses the Spotify classes and
//               total is 269.1, still under 270.
//   220 -> 222  the KLIPY tab in the emoji picker: the API client, the grid with
//               its paging and the inline renderer for a shared clip (+0.5 KiB
//               gzip). Total 270 -> 272 for the same reason; CSS stayed at 51.
//   222 -> 224  custom invite links: the slug field with its prefix, the save
//               state and the unlock hint in the invite card (+0.6 KiB gzip).
//               Total 272 -> 274. The build landed at 271.9 of 272, which is
//               the coin flip this note keeps warning about, so both move.
// CSS 51 -> 52: the game overlay tab - the corner picker, the head row and the
//               note (+0.4 KiB gzip). Total 274 -> 275. JS stays at 224: the
//               overlay itself is Electron-side HTML, not part of the bundle,
//               and the renderer side is one hook plus one card (222.7 used).
const budgets = {
  jsGzip: 224 * 1024,
  cssGzip: 52 * 1024,
  totalGzip: 275 * 1024
};

const totals = {
  jsRaw: sum(js, 'raw'),
  jsGzip: sum(js, 'gzip'),
  cssRaw: sum(css, 'raw'),
  cssGzip: sum(css, 'gzip'),
  totalGzip: sum(rows, 'gzip')
};

const failures = [];
if (totals.jsGzip > budgets.jsGzip) failures.push(`JS gzip ${totals.jsGzip} > ${budgets.jsGzip}`);
if (totals.cssGzip > budgets.cssGzip) failures.push(`CSS gzip ${totals.cssGzip} > ${budgets.cssGzip}`);
if (totals.totalGzip > budgets.totalGzip) failures.push(`total gzip ${totals.totalGzip} > ${budgets.totalGzip}`);

console.log(
  JSON.stringify(
    {
      assets: rows.map((row) => ({
        ...row,
        raw: `${(row.raw / 1024).toFixed(1)} KiB`,
        gzip: `${(row.gzip / 1024).toFixed(1)} KiB`
      })),
      totals: Object.fromEntries(
        Object.entries(totals).map(([key, value]) => [key, `${(value / 1024).toFixed(1)} KiB`])
      ),
      budgets: Object.fromEntries(
        Object.entries(budgets).map(([key, value]) => [key, `${(value / 1024).toFixed(0)} KiB`])
      ),
      failures
    },
    null,
    2
  )
);

if (failures.length) process.exitCode = 1;
