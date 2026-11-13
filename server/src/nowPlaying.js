'use strict';

// "Now playing" presence, filled by whichever client is running.
//
// Nothing here knows about a music service. A client pushes what is playing -
// the desktop build reads the operating system's media session, so any player
// works, including one with no API at all - and the server keeps it in memory
// long enough to show it in the member list and on a profile.
//
// Nothing is persisted. An activity that stops being pushed goes stale and
// disappears, so a client that crashes mid-track cannot leave it frozen on a
// profile for a week.

const STALE_MS = 5 * 60_000;
const SWEEP_MS = 60_000;
const MAX_TRACK = 200;
const MAX_TEXT = 160;
const MAX_SOURCE = 40;
const MAX_DURATION = 24 * 3_600_000;

const activities = new Map();

let socket = null;
let timer = null;

function text(value, max) {
  return String(value == null ? '' : value)
    .trim()
    .slice(0, max);
}

function millis(value) {
  const number = Math.trunc(Number(value) || 0);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(number, MAX_DURATION);
}

// Artwork and links come from another process and are rendered by every other
// client, so only the two schemes that cannot execute anything are accepted.
function webUrl(value) {
  const raw = text(value, 500);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function shape(input) {
  const track = text(input && input.track, MAX_TRACK);
  if (!track) return null;
  const artist = text(input.artist, MAX_TRACK);
  const source = text(input.source, MAX_SOURCE) || 'Desktop';
  return {
    // Stable while the same track keeps playing: it is what decides whether a
    // push is worth broadcasting.
    id: `np:${source}:${track}:${artist}`,
    track,
    artist,
    album: text(input.album, MAX_TEXT),
    albumArt: webUrl(input.albumArt),
    url: webUrl(input.url),
    durationMs: millis(input.durationMs),
    progressMs: millis(input.progressMs),
    playing: input.playing !== false,
    source,
    sampledAt: Date.now()
  };
}

function emit(userId, activity) {
  if (socket) socket.emit('activity:update', { userId, activity: activity || null });
}

/**
 * Records what a client says it is playing. The progress moves on every push,
 * so a repeat of the same track only refreshes sampledAt - clients count
 * forward from there instead of receiving a broadcast every few seconds.
 */
function set(userId, input) {
  const id = Number(userId);
  const activity = shape(input);
  if (!activity || !activity.playing) {
    clear(id);
    return null;
  }
  const previous = activities.get(id) || null;
  activities.set(id, activity);
  if (!previous || previous.id !== activity.id) emit(id, activity);
  return activity;
}

function clear(userId) {
  const id = Number(userId);
  if (!activities.delete(id)) return;
  emit(id, null);
}

function get(userId) {
  const id = Number(userId);
  const entry = activities.get(id);
  if (!entry) return null;
  if (Date.now() - entry.sampledAt > STALE_MS) {
    activities.delete(id);
    return null;
  }
  return entry;
}

function start(io) {
  socket = io;
  if (timer) return;
  timer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of activities) {
      if (now - entry.sampledAt <= STALE_MS) continue;
      activities.delete(id);
      emit(id, null);
    }
  }, SWEEP_MS);
  if (timer.unref) timer.unref();
}

module.exports = { set, clear, get, start };
