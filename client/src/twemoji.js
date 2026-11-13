// Twemoji asset names are the lowercase hex codepoints joined by dashes with
// the variation selector removed: ❤️ -> 2764.svg, 🏳️‍🌈 -> 1f3f3-200d-1f308.svg.
// The files are copied into public/twemoji by scripts/sync-twemoji.mjs.
export function emojiFileName(char) {
  const value = String(char || '');
  // Twemoji only drops the variation selector on single-codepoint emoji; inside
  // a zero-width-joiner sequence it is part of the filename (1f3f3-fe0f-200d-1f308).
  const keepSelector = value.includes('\u200D');
  const points = [];
  for (const symbol of value) {
    const code = symbol.codePointAt(0);
    if (code === 0xfe0f && !keepSelector) continue;
    points.push(code.toString(16));
  }
  return points.length ? `${points.join('-')}.svg` : '';
}

export function emojiUrl(char) {
  const file = emojiFileName(char);
  return file ? `/twemoji/${file}` : '';
}

// Extended_Pictographic covers the pictographs; the tail picks up variation
// selectors, skin tones and zero-width-joiner sequences.
const EMOJI_RE =
  /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\uFE0F|\u200D(?:\p{Extended_Pictographic}|\p{Regional_Indicator})|[\u{1F3FB}-\u{1F3FF}])*/gu;

export function splitEmoji(text) {
  const source = String(text || '');
  if (!source) return [];
  const parts = [];
  let last = 0;
  EMOJI_RE.lastIndex = 0;
  let match;
  while ((match = EMOJI_RE.exec(source))) {
    if (match.index > last) parts.push({ text: source.slice(last, match.index) });
    parts.push({ emoji: match[0] });
    last = match.index + match[0].length;
  }
  if (last < source.length) parts.push({ text: source.slice(last) });
  return parts;
}
