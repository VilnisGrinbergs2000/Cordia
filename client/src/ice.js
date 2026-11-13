import api from './api';

const FALLBACK_ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
];

let cached = null;
let pending = null;

export function getIceConfig() {
  return { iceServers: cached?.iceServers?.length ? cached.iceServers : FALLBACK_ICE_SERVERS };
}

export function loadIceServers(force = false) {
  if (pending) return pending;
  if (!force && cached && cached.until > Date.now()) return Promise.resolve(cached.iceServers);

  pending = api
    .get('/api/voice/ice')
    .then((payload) => {
      const iceServers = Array.isArray(payload?.iceServers) ? payload.iceServers : [];
      if (!iceServers.length) throw new Error('ice unavailable');
      const until = payload?.expiresAt
        ? Math.max(Date.now() + 60_000, payload.expiresAt * 1000 - 60_000)
        : Date.now() + 10 * 60_000;
      cached = { iceServers, until };
      return iceServers;
    })
    .catch(() => {
      cached = { iceServers: FALLBACK_ICE_SERVERS, until: Date.now() + 60_000 };
      return FALLBACK_ICE_SERVERS;
    })
    .finally(() => {
      pending = null;
    });

  return pending;
}

