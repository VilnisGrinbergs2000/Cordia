export const THEMES = [
  { key: 'iris', label: 'Iris', color: '#6d5efc', description: 'Cool violet' },
  { key: 'ocean', label: 'Ocean', color: '#2f7df6', description: 'Clear blue' },
  { key: 'fern', label: 'Fern', color: '#2f9e6f', description: 'Quiet green' },
  { key: 'ember', label: 'Ember', color: '#e5673b', description: 'Warm orange' },
  { key: 'rose', label: 'Rose', color: '#d9538a', description: 'Soft magenta' },
  { key: 'graphite', label: 'Graphite', color: '#6f7d91', description: 'Neutral slate' }
];

export const MODES = [
  { key: 'ink', label: 'Ink', description: 'Deep neutral', color: '#0a0d12' },
  { key: 'slate', label: 'Slate', description: 'Soft charcoal', color: '#161c26' },
  { key: 'dusk', label: 'Dusk', description: 'Warm brown-black', color: '#171310' }
];

export function applyPreferences(preferences = {}) {
  const theme = THEMES.some((entry) => entry.key === preferences.theme) ? preferences.theme : 'iris';
  const mode = MODES.some((entry) => entry.key === preferences.mode) ? preferences.mode : 'ink';
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.mode = mode;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', MODES.find((entry) => entry.key === mode)?.color || '#0a0d12');
  try {
    localStorage.setItem('cordia:prefs', JSON.stringify({ theme, mode }));
  } catch {
    // Storage can be unavailable.
  }
}

export function cachedPreferences() {
  try {
    const raw = localStorage.getItem('cordia:prefs');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
