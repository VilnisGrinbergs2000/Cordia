const EGG_EVENT = 'cordia:easter-egg';
const STORAGE_KEY = 'cordia.easterEggs.v1';
export const EGG_TOTAL = 15;

let uid = 0;

const PARTY = '\u{1F389}';
const PARTY_ALT = '\u{1F38A}';
const BOOM = '\u{1F4A5}';
const SNOW = '\u2744\uFE0F';
const HEART = '\u2764\uFE0F';

const MESSAGE_TRIGGERS = new Map([
  ['party time', ['party', 'Party mode engaged.']],
  ["let's party", ['party', 'Party mode engaged.']],
  ['lets party', ['party', 'Party mode engaged.']],
  [PARTY, ['party', 'Party mode engaged.']],
  [PARTY_ALT, ['party', 'Party mode engaged.']],
  ['kaboom', ['boom', `${BOOM} boom.`]],
  ['boom', ['boom', `${BOOM} boom.`]],
  [BOOM, ['boom', `${BOOM} boom.`]],
  ['vibe check', ['vibe', 'Vibe check: passed.']],
  ['matrix', ['matrix', 'Wake up, Neo.']],
  ['let it snow', ['snow', 'Let it snow.']],
  [SNOW, ['snow', 'Let it snow.']],
  ['i love you', ['hearts', 'Aww.']],
  [HEART, ['hearts', 'Aww.']],
  ['hello there', ['toast', 'General Kenobi.']],
  ['i am inevitable', ['toast', 'And I am Cordia.']],
  ['there is no spoon', ['toast', "Then you'll see that it is not the spoon that bends."]],
  ['sudo make me a sandwich', ['toast', 'Okay.']],
  ['42', ['toast', 'The answer to everything.']]
]);

function normalizeMessage(content) {
  return String(content || '')
    .trim()
    .toLowerCase()
    .replace(/[!.]+$/, '');
}

export function nextEggId() {
  uid += 1;
  return `${Date.now()}-${uid}`;
}

function readFound() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return new Set(Array.isArray(value) ? value : []);
  } catch {
    return new Set();
  }
}

function discover(id) {
  const found = readFound();
  if (found.has(id)) return { isNew: false, count: found.size, complete: false };
  found.add(id);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...found]));
  } catch {}
  return { isNew: true, count: found.size, complete: found.size >= EGG_TOTAL };
}

export function fireEasterEgg(type, detail = {}) {
  if (typeof window === 'undefined') return;
  let message = detail.message || '';
  let mega = false;
  if (detail.egg) {
    const result = discover(detail.egg);
    if (result.isNew) {
      message = `${detail.message || 'Secret found'} · ${result.count}/${EGG_TOTAL}`;
      mega = result.complete;
    } else {
      message = '';
    }
  }
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  window.dispatchEvent(
    new CustomEvent(EGG_EVENT, {
      detail: { ...detail, type, message, mega, reduced }
    })
  );
}

export function celebrate(options = {}) {
  fireEasterEgg('confetti', options);
}

export function celebrateAt(x, y, options = {}) {
  fireEasterEgg('confetti', {
    ...options,
    x,
    y,
    count: options.count ?? 34
  });
}

export function shakeScreen(options = {}) {
  fireEasterEgg('shake', options);
}

export function messageFlair(content) {
  const entry = MESSAGE_TRIGGERS.get(normalizeMessage(content));
  if (!entry || entry[0] === 'toast') return '';
  return entry[0];
}

export function triggerMessageEasterEgg(content) {
  const text = normalizeMessage(content);
  if (!text) return;
  const entry = MESSAGE_TRIGGERS.get(text);
  if (!entry) return;
  const [type, message] = entry;
  fireEasterEgg(type, { egg: type === 'toast' ? `phrase-${text}` : type, message });
}

export function triggerReactionEasterEgg(emoji, x, y) {
  if (emoji === PARTY || emoji === PARTY_ALT) {
    celebrateAt(x, y, { count: 40, egg: 'reaction', message: 'Confetti!' });
  }
  if (emoji === BOOM) {
    fireEasterEgg('boom', { x, y, egg: 'boom-reaction', message: BOOM });
  }
}

export { EGG_EVENT };
