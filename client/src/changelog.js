// Release notes shown in Settings → Updates and in the "What's new" prompt.
// Newest release first. Keep the top entry in sync with package.json "version".

export const RELEASES = [
  {
    version: '0.13.9',
    date: '2026-11-05',
    title: 'Overlay, with hands',
    items: [
      'Unlock the overlay with Ctrl + Shift + ` and it stops being a picture: mute, deafen and leave become buttons, and there is a box to type into without leaving the game.',
      'It shows the last four messages from the channel on screen, one line each, so a callout does not need a second monitor.',
      'New in Settings -> Game overlay: an opacity slider and a switch for the message preview.',
      'The overlay remembers where you dragged it instead of snapping back to its corner.',
      'Escape locks it again and hands every click straight back to the game.'
    ]
  },
  {
    version: '0.13.8',
    date: '2026-11-05',
    title: 'Look who is talking',
    items: [
      'The desktop app has a game overlay: the voice channel you are in and everyone in it, drawn over the game while you play.',
      'Turn it on in Settings -> Game overlay. Shift + ` hides and shows it without leaving the game.',
      'It sits in the corner you pick, is click-through so the game keeps every mouse click, and puts a green ring on whoever is talking.',
      'It is a separate always-on-top window rather than something injected into the game, so windowed and borderless games show it and an exclusive-fullscreen game covers it.',
      'Off by default. It reads the voice channel you are already in and nothing else.'
    ]
  },
  {
    version: '0.13.7',
    date: '2026-11-05',
    title: 'Links you can say out loud',
    items: [
      'Servers can claim a custom invite link. Instead of /invite/497BE449 you can hand out /invite/aurora-lab, and the settings card shows what it will look like before you save it.',
      'Custom links unlock once your account is 7 days old and the server is 3 days old. A brand-new account with a brand-new server is the exact shape of an invite-spam run, and memorable names are worth waiting a week for.',
      'Two servers can never share a link. The database decides, not a check-then-save, so if somebody claims the name you wanted a second earlier you get "already taken" rather than a duplicate.',
      'Old links keep working. Codes are matched case-insensitively, so everything shared before this release still opens.',
      'Reserved words like /invite/api or /invite/admin are refused, so a link can never look like part of the site.'
    ]
  },
  {
    version: '0.13.6',
    date: '2026-11-04',
    title: 'Spotify, and nothing else',
    items: [
      'Now playing reads Spotify only. The Windows media session also reports browser tabs and video players, so whatever you were watching used to appear under your name; those sessions are ignored now.',
      'Pausing Spotify still clears the card, so it only ever shows something that is actually playing.',
      'The settings card now says exactly what is read and what is not.'
    ]
  },
  {
    version: '0.13.5',
    date: '2026-11-04',
    title: 'GIFs in the picker',
    items: [
      'The emoji picker has a GIF tab. Search KLIPY or browse what is trending, and a click sends the clip as a message.',
      'Clips are sent as the mp4 rendition: the same GIF, roughly a thirtieth of the size, so a conversation does not fill up with four-megabyte reactions.',
      'A shared clip renders inside the message, capped at 320px so it cannot take over the column.',
      'The tab appears once the server has a KLIPY key configured, and stays hidden otherwise.'
    ]
  },
  {
    version: '0.13.4',
    date: '2026-11-04',
    title: 'Less to carry',
    items: [
      'Spotify linking is gone. The automatic now-playing reads whatever is playing, so the consent screen, the token table and the second card in Settings had nothing left to do. Settings -> Now playing is one switch.',
      'Encrypted conversations open instantly the second time. Every message was being decrypted again, one at a time behind the crypto lock, each time you left a server and came back; the plaintext is cached until you lock.',
      'Encrypted pictures and files are cached the same way, so reopening a conversation no longer downloads and decrypts every attachment again.',
      'The cache is cleared the moment encryption locks, so nothing readable survives a locked app.'
    ]
  },
  {
    version: '0.13.3',
    date: '2026-11-04',
    title: 'Updates that stay out of the way',
    items: [
      'Restart and install no longer brings the installer wizard back up. The update applies silently and the app comes straight back.',
      'Closing Cordia applies a downloaded update on its own, so the next time you open it you are already on the new version.',
      'When an update finishes downloading, a toast says so. Until now the only sign was the version number changing after a restart.'
    ]
  },
  {
    version: '0.13.2',
    date: '2026-11-04',
    title: 'Paste and print',
    items: [
      'Ctrl+V pastes a screenshot straight into the composer. It goes through the same size check as the attach button, so a file that is too large still says so instead of failing at send time.',
      'The "Decrypting…" placeholder showed up as broken characters: the string had been saved with the wrong encoding. Two other strings had the same problem.',
    ]
  },
  {
    version: '0.13.1',
    date: '2026-11-04',
    title: 'Whatever is playing',
    items: [
      'Settings → Connections has a second card: "Now playing". Turn it on and the desktop app reads the media session Windows already keeps, so any player shows up under your name - not just Spotify, and with no account to link.',
      'The card names the app it heard the track from, so a Liner or foobar2000 track no longer claims to be Spotify.',
      'Sharing is off until you switch it on, and switching it off deletes the track immediately. Nothing is stored: five minutes without an update and it disappears on its own.',
      'Invite links and application install links no longer land on the 404 page. They were built without the /app prefix and the server only served the app there; both now redirect.',
      'Joining a server from a browser adds it to the desktop app straight away. It used to appear only after a restart.',
      'The admin broadcast composer works again. It was comparing a numeric suspension flag to a boolean, and the failed query took the API down with it.'
    ]
  },
  {
    version: '0.12.0',
    date: '2026-11-03',
    title: 'Free, and staying free',
    items: [
      'Cordia Pro is gone. There is no paid plan, no checkout and no card on file: every feature is in every account, and 50 MB uploads with 5 GB of storage are now the standard rather than something to buy.',
      'Settings → Support is a tip jar. Scan the code with your phone to leave a one-off donation; it buys nothing and unlocks nothing, because nothing is locked.',
      'Settings → Storage has its own tab now. It shows what your uploads are using and lets you delete the ones nothing points at - it used to sit inside the paywall.',
      'The Supporter badge is granted by hand from the admin console, to anyone who chips in.',
      'An attachment that is too large now says what the limit is instead of offering an upgrade.',
      'The landing page and the terms describe donations instead of subscriptions.',
      'Cordia now asks for a tip now and then when you open it: Codi, the QR, and two buttons. At most once a fortnight, never in your first three days, and "Don\'t show this again" ends it permanently.',
      'Codi is the logo. The old geometric mark is gone from the header, the tab icon, the app icon, the splash screen and the link preview, and the notification icon is his sparkle instead of a telephone.',
      'Link Spotify from Settings and your status shows what you are playing - the track under your name, in the member list, and on your profile with album art and a progress bar. The permission is read-only, you can hide the track without unlinking, and unlinking deletes the tokens.',
      'The soundboard is two permissions now: one to play sounds, one to add and remove them. Playing was open to everyone and uploading required Manage server, so every group kept exactly what it already had.',
      'Pinning has its own permission instead of riding on Manage messages. Hover a message and press the pin, or right-click it and choose Pin message; the pinned panel lists what is pinned, opens the message when you click it, and lets you unpin from there.',
      'Forum tags have a design. Each tag is a pill in its own colour with a count, the selected one is filled, and the manager lists them with move, rename and delete.',
      'A gallery takes uploads in place: drop files anywhere on the page or press Add images, and each file becomes its own tile. When it is empty it now says what a gallery is for instead of a line of grey text in the corner.',
      'Role categories take a colour, with the same presets as roles plus a custom picker, and the category field is a real control rather than a bare input.',
      'Type @ and a name in the composer and the list appears; Tab or Enter completes it, the arrow keys move through it, and Escape puts it away.',
      'The edit history dialog is sized to its content, and the insights hover marker is a dot instead of the wide ellipse a stretched chart used to produce.',
    ]
  },
  {
    version: '0.11.1',
    date: '2026-11-03',
    title: 'The polish pass',
    items: [
      'Event creation is a role permission. A server can keep the calendar curated without taking away anyone\'s ability to talk; every existing group kept the right it already had.',
      'You can finally see and clear your storage. Settings → Storage lists every file you uploaded with its size and what is using it, and lets you delete the ones nothing points at.',
      'The status menu works while you are in a call. It used to open behind the voice panel and could not be clicked.',
      'The insights chart has a stylesheet. It was stretching to whatever the card around it did, which left the graph in a corner of an empty box.',
      'Dropdowns look like controls everywhere, not only inside a form field. The discovery category, the invite limits and the role category picker all had no frame at all.',
      'The welcome card opens with the server itself: its icon, name, member count and channel count, instead of a line of grey text.',
      'House rules: a manager writes them one per line in Server settings, and every new member sees them numbered on the welcome card, in the order they were written.',
      'The groups tab lays out in two columns again, and its category bar lines up with the list beside it.',
      'The Direct messages header is a single line again. Its title was set at 20px in a 300px sidebar with four buttons beside it, so it broke over two lines and stood taller than every other header.',
      'The presence dot in settings is a full circle; the account card was clipping it in half.',
      'The "Free forever" badges are gone. The free plan still says, in one sentence, that it stays free forever.',
      'Encrypted DMs unlock on the web build again. The Content Security Policy was blocking the WebAssembly module the key derivation runs on.',
      'Pictures open in Cordia instead of a browser window: click one in a message or in a gallery and it fills the window, with download and close in the corner. Escape closes it.',
      'Markdown works where the writing is: documents, forum guidelines, event notes, server descriptions and the welcome card all render headings, lists, quotes, code and links.',
    ]
  },
  {
    version: '0.11.0',
    date: '2026-11-03',
    title: 'Everything Discord charges for',
    items: [
      'Calendar channels: a schedule that lives in the server. Create events, mark going or interested, and set a weekly or monthly repeat.',
      'Saying yes to an event sets a reminder fifteen minutes before it starts, and backing out removes it.',
      'Docs channels: versioned pages. Every save keeps the previous body, so nothing is ever lost by editing.',
      'List channels: shared checklists with a tick box and an assignee on every row.',
      'Media channels: every picture and file posted in the channel, in one grid, with older pages on demand.',
      'Edit history: open any edited message and see what it said before, word by word, with the changes marked.',
      'Reminders: ask Cordia to remind you about a message in an hour, tonight, tomorrow, or at a time you pick. They arrive as a notification and stay listed for a week.',
      'Custom emoji everywhere: the picker is no longer only in the composer. Your bio and every server you are in share one pool of emotes.',
      '200 free emote slots and 100 sticker slots per server - four times what Discord gives away, with no boost required.',
      'Richer profiles: social links, a games list, real activity counters, and a bio per server - a different introduction for work and for play.',
      'Role categories: group your roles under headings so a server with twenty of them is still readable.',
      'Per-channel permissions: allow or deny a permission for a role or a single person on one channel. A channel nobody may view disappears from their sidebar and refuses to open.',
      'Server subscriptions: any server can sell supporter tiers, with or without a role attached. No partner programme, no follower count.',
      '1080p60 screen share, free: the bitrate cap is high enough that the encoder decides the quality, and screen content keeps its resolution instead of blurring to hold a frame rate.',
      'Voice that survives: a dropped connection rejoins by itself, and the participant list is stored in the database, so a restart or a second server process no longer empties a call.',
    ]
  },
  {
    version: '0.10.0',
    date: '2026-10-29',
    title: 'Catch up, your way',
    items: [
      'Catch-up banner: when you come back to a channel, Cordia tells you how many messages you missed, who sent them, and lets you jump straight to where you left off.',
      'Mark unread: park a conversation on purpose and it will be waiting for you exactly where you left it.',
      'Unread state is now honest — opening a channel no longer silently clears a backlog you never read.',
      'App updates: Cordia can check for, download, and install new versions without a reinstall.',
      'Privacy controls: choose who can send friend requests, who can read your bio and badges, and whether you show as online or typing.',
      'Blocked people are listed in Settings → Privacy, with an unblock button right there.',
      'Profile banners: upload an image for your profile header, or keep a colour if you prefer.',
      'Send later: schedule a message for a time that suits you and cancel it from the composer if plans change.',
      'Bookmarks: save any message privately — from a channel or a DM — and jump straight back to it.',
      'Private notes: keep a note about someone on their profile that only you can see.',
      'Spam guard: bursts of messages, the same text pasted into several channels, invite spam and mass DMs are throttled before they land.',
      "Predatory DM warnings: when a stranger's message matches a grooming or scam pattern, the person receiving it gets a plain-language warning with Block and Report. The message is never silently swallowed.",
      'Safety queue in the admin console: every signal that fires is listed with the excerpt, the patterns behind it and a review button.',
      'Applications and bots: create an app in Settings → Developers, get a bot token, install it into a server, and it appears as a member with a BOT tag.',
      'Slash commands: register commands for an app and they show up in the composer the moment someone types /. Pick one and the bot answers in the channel.',
      'A gateway for bots: connect to /gateway with your token and receive events as they happen.',
      'Buttons and dropdowns: a bot can send up to five rows of buttons or select menus, and each click comes back to the bot as its own interaction.',
      'Ephemeral replies: a bot can answer only the person who ran the command — the reply disappears on reload and is never written to history.',
      'Follow-ups: a bot can send more than one reply to the same interaction, and an interaction can only ever be answered once.',
      'Richer events: message edits and deletes, reactions being added or removed, and people joining or leaving a server all reach the gateway.',
      'Intents: choose which event families an app subscribes to in Settings → Developers, so a bot that only reads messages is never sent member traffic.',
      'Per-app rate limits: a bot that floods the API is slowed down with a Retry-After instead of taking the server with it.',
      'Install links: every application gets a shareable link that shows what the bot can read before anyone adds it, and only someone who manages a server can finish.',
      'Event replay: a bot that drops its connection can ask for what it missed and gets the backlog with its original sequence numbers, instead of a silent hole.',
      'Forms: a bot can answer a button or a command with a small form — text fields, required or optional — and the answers come back to it as their own interaction.',
      'Autocomplete: a bot can suggest values while you type a command argument. Arrow keys to move, Tab or Enter to take one, and nothing is sent until you send it.',
      'Bots survive restarts: a bot that reconnects after a deploy is still told what it missed, and its sequence numbers carry on instead of starting over.',
      'The install link remembers: servers that already have the app are marked as such and the button becomes Remove, so nobody adds the same bot twice.',
      'Removing a bot: whoever manages the server can now take a bot out, not only the person who built it. Adding one is no longer a one-way door.',
      'Command permissions: a bot can limit a command to moderators or managers. People who cannot run it never see it in the composer, and the bot is told what the person who ran one is allowed to do.',
      'Bots can look around: an app can read the server it is in — its members, channels and roles — and people can message a bot directly instead of only calling commands.',
      'Editing a command in place, including who may run it, without deleting and recreating it.',
      'An audit trail per application: installs, removals, token rotations and refused commands, with who did them.',
      'Forms gained choice fields and prefilled answers, expire after fifteen minutes, and two can be open at once without the first being lost.',
      'Suggestions are remembered for a few seconds, work for named arguments like city=, and say which argument they are for.',
      'Fixed: clicking a button on a bot message could sign you out on the next request. Interaction tokens are no longer mistaken for your session.',
      'Subcommands and groups: /admin ban instead of /admin-ban, with the composer suggesting the next word while you type it.',
      'Command descriptions can be translated, and the language follows yours — a name is never translated, because that is what people type.',
      'Verified applications carry a badge on their install link, so a link from someone you trust looks different from a link from a stranger.',
      'Install links can ask for less: add ?intents=messages and that server gets messages and nothing else, whatever the app declared.',
      'Forms can ask for a file — pick one and it uploads, so the bot receives the same attachment a person would send.',
      'Bots can pin messages wherever their role allows it, like anybody else.',
      'Bots can see calls: an app subscribed to members is told when somebody joins, mutes or leaves a voice channel.',
      'Bots are spread across processes by server, so a large deployment no longer has one process doing all the work.',
      'Open connections are now counted across the whole server rather than per process, so the limit means what it says.',
      'Edit history: click (edited) on any message to see what it said before, with the changed words marked.',
      'Remind me: right-click a message and pick a time — an hour, tonight, tomorrow morning — and Cordia brings it back to you.',
      'Bookmarks and reminders share one panel now, so everything you meant to come back to is in one place.',
      "Fixed: the 'Be careful here' warning offered Report but had no Block button."
    ]
  },
  {
    version: '0.9.0',
    date: '2026-10-14',
    title: 'Voice that holds up',
    items: [
      'Screen sharing with a source picker and per-app audio on Windows.',
      'End-to-end encrypted direct messages with device key storage and recovery codes.',
      'Message search across every server you belong to.'
    ]
  },
  {
    version: '0.8.0',
    date: '2026-09-27',
    title: 'A calmer surface',
    items: [
      'Full theme pass with light, dark, and system modes.',
      'Automod rules that reject a message at send time instead of flagging it later.',
      'Server events, polls, and a reworked member list.'
    ]
  }
];

export const LATEST_RELEASE = RELEASES[0];

export function compareVersions(a, b) {
  const parse = (value) => String(value || '').split('.').map((part) => Number(part) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}
