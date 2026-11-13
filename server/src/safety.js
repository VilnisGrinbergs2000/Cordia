'use strict';
// Global safety layer. Two jobs:
//
//   1. Spam control that is not tied to one server. A flood, the same text
//      pasted into five channels, or one invite link sprayed everywhere is
//      visible only across scopes, so the windows live here rather than in
//      server_automod.
//   2. A predatory-pattern scan for DMs from people who are not friends. It
//      never blocks a message: it attaches a notice for the recipient and files
//      an event for moderators, because the person who needs to see it is the
//      one being talked to, not a filter.
//
// Windows are in memory. That matches the rest of this process (presence, voice
// rooms, the privacy cache) and resets on restart, which is the right trade for
// short-lived spam state.
require('./pg/env');
const { query } = require('./pg/pool');

const WINDOW_MS = 10 * 60 * 1000;
const FLOOD_WINDOW_MS = 10 * 1000;
const FLOOD_LIMIT = 15;
const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
const DUPLICATE_SCOPES = 3;
const DM_WINDOW_MS = 10 * 60 * 1000;
const DM_NEW_LIMIT = 5;
const EVENT_DEDUPE_MS = 10 * 60 * 1000;

const state = new Map();

function bucket(userId) {
  const id = Number(userId);
  let entry = state.get(id);
  if (!entry) {
    entry = { messages: [], peers: [] };
    state.set(id, entry);
  }
  return entry;
}

function prune(entry, now) {
  if (entry.messages.length) entry.messages = entry.messages.filter((m) => now - m.at < WINDOW_MS);
  if (entry.peers.length) entry.peers = entry.peers.filter((p) => now - p.at < WINDOW_MS);
}

function normalize(content) {
  return String(content || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

// Cheap stable hash: the exact text matters, not cryptographic strength.
function digest(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return String(hash);
}

const INVITE_RE = /(?:discord\.gg|cordia\.gg)\/[a-z0-9-]+|\/invite\/[a-z0-9-]+/i;

function verdictFor(flags) {
  if (!flags.length) return { blocked: false, retryAfter: 0, flags };
  const copy = {
    flood: "You're sending messages very quickly. Wait a few seconds and try again.",
    duplicate: 'That message just went to several places. Post it once, then wait.',
    invites: 'That invite has already been posted in several places.'
  };
  const first = flags[0];
  return {
    blocked: true,
    retryAfter: flags.includes('flood') ? 15000 : 60000,
    flags,
    error: copy[first] || 'Slow down for a moment.'
  };
}

// Called before a channel or DM message is written.
function checkMessage(userId, { scopeType, scopeId, content }) {
  const now = Date.now();
  const entry = bucket(userId);
  prune(entry, now);

  const scopeKey = `${scopeType}:${scopeId}`;
  const text = normalize(content);
  const hash = digest(text);
  const invite = text.match(INVITE_RE);
  const inviteKey = invite ? invite[0].toLowerCase() : null;
  const flags = [];

  const recent = entry.messages.filter((m) => now - m.at < FLOOD_WINDOW_MS);
  if (recent.length >= FLOOD_LIMIT) flags.push('flood');

  if (text.length > 12) {
    const scopes = new Set(
      entry.messages
        .filter((m) => now - m.at < DUPLICATE_WINDOW_MS && m.hash === hash)
        .map((m) => m.scope)
    );
    scopes.add(scopeKey);
    if (scopes.size >= DUPLICATE_SCOPES) flags.push('duplicate');
  }

  if (inviteKey) {
    const scopes = new Set(
      entry.messages
        .filter((m) => now - m.at < DUPLICATE_WINDOW_MS && m.invite === inviteKey)
        .map((m) => m.scope)
    );
    scopes.add(scopeKey);
    if (scopes.size >= DUPLICATE_SCOPES) flags.push('invites');
  }

  entry.messages.push({ at: now, scope: scopeKey, hash, invite: inviteKey });
  return verdictFor(flags);
}

// Called when a new DM conversation is opened. People messaging five new
// strangers inside ten minutes are running a list, not a conversation.
function checkNewDm(userId, peerId) {
  const now = Date.now();
  const entry = bucket(userId);
  prune(entry, now);
  const peer = Number(peerId);
  const known = entry.peers.filter((p) => now - p.at < DM_WINDOW_MS);
  if (known.some((p) => p.peer === peer)) return { blocked: false, retryAfter: 0, flags: [] };
  if (known.length >= DM_NEW_LIMIT) {
    return {
      blocked: true,
      retryAfter: 10 * 60 * 1000,
      flags: ['mass_dm'],
      error: 'You have started a lot of new conversations. Take a break and try again later.'
    };
  }
  entry.peers.push({ at: now, peer });
  return { blocked: false, retryAfter: 0, flags: [] };
}

// ── Predatory patterns ──────────────────────────────────────────────────────
// Scored, not blocked. The weights encode how strong each signal is on its own:
// "add me on snapchat" is weak, "don't tell your parents" is not.
const SIGNALS = [
  {
    key: 'secrecy',
    weight: 5,
    patterns: [
      /don'?t tell (your )?(parents|mom|mum|dad|anyone|anybody)/i,
      /keep (this|it) (between us|secret|quiet)/i,
      /delete (this|these) (message|messages|chat|conversation)/i
    ]
  },
  {
    key: 'off_platform',
    weight: 3,
    patterns: [
      /\b(add|message|dm|text|find|hit) me (on|at)\b/i,
      /\b(snapchat|snap ?chat|kik|telegram|whatsapp|signal|instagram|insta)\b/i
    ]
  },
  {
    key: 'money',
    weight: 5,
    patterns: [
      /\bgift ?cards?\b/i,
      /\b(steam|itunes|google play|amazon) (card|code)\b/i,
      /\b(bitcoin|btc|ethereum|crypto|usdt)\b/i,
      /\b(cash ?app|venmo|zelle|paypal)\b/i
    ]
  },
  {
    key: 'age_probe',
    weight: 3,
    patterns: [
      /\bhow old are you\b/i,
      /\bwhat grade (are you )?in\b/i,
      /\bare you (a )?(minor|under ?18|in (middle|high) school)\b/i,
      /\basl\b/i
    ]
  },
  {
    key: 'personal_info',
    weight: 3,
    patterns: [
      /\bwhere do you live\b/i,
      /\bwhat school do you\b/i,
      /\byour (home )?address\b/i,
      /\bsend (me )?(a )?(pic|photo|selfie)\b/i
    ]
  }
];

function scanText(content) {
  const text = String(content || '');
  if (!text) return { score: 0, categories: [] };
  const categories = [];
  let score = 0;
  for (const signal of SIGNALS) {
    if (signal.patterns.some((pattern) => pattern.test(text))) {
      categories.push(signal.key);
      score += signal.weight;
    }
  }
  return { score, categories };
}

function safetyLevel(categories, score) {
  if (!categories.length) return null;
  if (score >= 8) return 'high';
  if (score >= 5) return 'medium';
  return 'low';
}

// One event per user per kind per ten minutes: a spammer firing twenty messages
// should produce one queue entry, not twenty.
async function recordEvent({
  kind,
  severity = 'medium',
  userId,
  targetId = null,
  scopeType = null,
  scopeId = null,
  messageId = null,
  detail = {}
}) {
  const now = Date.now();
  await query(
    `INSERT INTO safety_events
       (kind, severity, user_id, target_id, scope_type, scope_id, message_id, detail, created_at)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9
     WHERE NOT EXISTS (
       SELECT 1 FROM safety_events
       WHERE user_id = $3 AND kind = $1 AND created_at > $10
     )`,
    [
      kind,
      severity,
      Number(userId),
      targetId ? Number(targetId) : null,
      scopeType,
      scopeId ? Number(scopeId) : null,
      messageId ? Number(messageId) : null,
      JSON.stringify(detail),
      now,
      now - EVENT_DEDUPE_MS
    ]
  );
}

module.exports = { checkMessage, checkNewDm, scanText, safetyLevel, recordEvent };
