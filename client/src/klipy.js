import api from './api';

const BASE = 'https://api.klipy.com/api/v1';
const PAGE_SIZE = 24;

// The key is fetched once and cached for the life of the tab. KLIPY wants the
// request to come from the user's own client, so this module talks to their
// API directly and never through our server.
let keyPromise = null;

function loadKey() {
  if (!keyPromise) {
    keyPromise = api
      .get('/api/integrations')
      .then((data) => String(data?.klipy?.key || '').trim())
      .catch(() => '');
  }
  return keyPromise;
}

export function klipyConfigured() {
  return loadKey().then((key) => !!key);
}

// Every result carries each rendition, so the grid takes the smallest animated
// still and a sent message takes the mp4: the same clip is 4 MB as a gif and
// 120 KB as an mp4, and a chat does not need the former.
function pick(file, size, format) {
  const entry = file?.[size]?.[format];
  return entry && entry.url ? entry : null;
}

function normalize(item) {
  const file = item?.file || {};
  const preview =
    pick(file, 'sm', 'webp') || pick(file, 'sm', 'jpg') || pick(file, 'sm', 'gif') || pick(file, 'md', 'webp');
  const share =
    pick(file, 'hd', 'mp4') ||
    pick(file, 'md', 'mp4') ||
    pick(file, 'hd', 'gif') ||
    pick(file, 'md', 'gif') ||
    pick(file, 'hd', 'webp') ||
    pick(file, 'md', 'webp');
  if (!preview?.url || !share?.url) return null;
  return {
    id: String(item.id ?? item.slug ?? share.url),
    title: String(item.title || ''),
    preview: preview.url,
    url: share.url,
    width: Number(share.width) || 0,
    height: Number(share.height) || 0
  };
}

export async function klipySearch({ query = '', page = 1 } = {}) {
  const key = await loadKey();
  if (!key) return { items: [], hasMore: false, configured: false };
  const term = String(query || '').trim();
  const endpoint = term ? 'search' : 'trending';
  const params = new URLSearchParams({ page: String(page), per_page: String(PAGE_SIZE) });
  if (term) params.set('q', term);
  const response = await fetch(`${BASE}/${encodeURIComponent(key)}/gifs/${endpoint}?${params}`, {
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) throw new Error('GIF search is not available right now.');
  const payload = await response.json().catch(() => null);
  if (!payload || payload.result === false) {
    const detail = payload?.errors?.message;
    throw new Error(Array.isArray(detail) ? detail[0] : 'GIF search is not available right now.');
  }
  const body = payload.data || {};
  return {
    items: (Array.isArray(body.data) ? body.data : []).map(normalize).filter(Boolean),
    hasMore: !!body.has_next,
    configured: true
  };
}
