import { useEffect } from 'react';
import api from './api';

// Opt-in, stored where the other preferences live so it survives a reload and
// needs no server round trip to read. Off by default: what is playing on your
// machine is not something a chat app should publish on its own.
const KEY = 'cordia:now-playing';
const EVENT = 'cordia:now-playing-changed';
const POLL_MS = 7000;

export function nowPlayingShared() {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

export function setNowPlayingShared(value) {
  try {
    localStorage.setItem(KEY, value ? 'on' : 'off');
  } catch {
    // Storage can be unavailable; the toggle still works for this session.
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { value: Boolean(value) } }));
}

// The media session reports the executable that owns the stream, not a brand.
// The bridge only ever forwards Spotify, so the label is fixed; the fallback
// keeps the card honest if that filter is ever widened.
function sourceLabel(app) {
  const raw = String(app || '').trim();
  if (/spotify/i.test(raw)) return 'Spotify';
  if (!raw) return 'Desktop';
  return raw.replace(/\.exe$/i, '').slice(0, 40) || 'Desktop';
}

/**
 * Pushes Spotify's media session to the server while the person has sharing
 * switched on. Only the desktop build has a bridge, and that bridge filters
 * everything except Spotify; in a browser this is inert, which is why the
 * settings card explains that.
 */
export default function useNowPlaying() {
  useEffect(() => {
    const bridge = window.cordiaDesktop && window.cordiaDesktop.mediaSession;
    if (!bridge) return undefined;

    let stopped = false;
    let timer = null;
    let last = '';

    async function push(info) {
      const track = info && !info.none ? String(info.title || '').trim() : '';
      const playing = Boolean(info && info.playing);
      const key = track ? `${info.app}|${track}|${info.artist}|${playing}` : '';
      if (key === last) return;
      last = key;
      try {
        if (!track || !playing) {
          await api.del('/api/presence/now-playing');
          return;
        }
        await api.post('/api/presence/now-playing', {
          track,
          artist: info.artist || '',
          album: info.album || '',
          durationMs: Number(info.duration) || 0,
          progressMs: Number(info.position) || 0,
          playing: true,
          source: sourceLabel(info.app)
        });
      } catch {
        // A failed push is not worth a toast: the next tick tries again.
      }
    }

    async function tick() {
      const info = await bridge().catch(() => null);
      if (stopped) return;
      await push(info);
    }

    function stopPolling() {
      if (timer) clearInterval(timer);
      timer = null;
      if (last) {
        last = '';
        api.del('/api/presence/now-playing').catch(() => {});
      }
    }

    function startPolling() {
      if (timer) return;
      last = '';
      tick();
      timer = setInterval(tick, POLL_MS);
    }

    function sync() {
      if (nowPlayingShared()) startPolling();
      else stopPolling();
    }

    sync();
    window.addEventListener(EVENT, sync);
    return () => {
      stopped = true;
      window.removeEventListener(EVENT, sync);
      stopPolling();
    };
  }, []);
}
