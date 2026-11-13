// Classic text emoticons. Tab in the composer turns one into an emoji, and the
// send path expands anything the user did not convert themselves.
//
// Longest sequences first: `:'(` has to win over `:(`.
export const ASCII_EMOTES = [
  [":'(", '\u{1F622}'],
  [':-(', '\u{1F641}'],
  [':-)', '\u{1F642}'],
  [':-D', '\u{1F603}'],
  [':-P', '\u{1F61B}'],
  [':-O', '\u{1F62E}'],
  [':D', '\u{1F603}'],
  [':P', '\u{1F61B}'],
  [':O', '\u{1F62E}'],
  [':)', '\u{1F642}'],
  [':(', '\u{1F641}'],
  [';)', '\u{1F609}'],
  [':/', '\u{1F615}'],
  [':|', '\u{1F610}'],
  [':3', '\u{1F63A}'],
  [':*', '\u{1F618}'],
  ['<3', '\u2764\uFE0F']
];

const BEFORE = /[\s([{"']/;
const AFTER = /[\s.,!?)\]}"']/;

// Every emoticon in the text, in order, with the boundaries checked against the
// full string so a caret in the middle still sees what follows it.
export function asciiEmotesIn(text) {
  const hits = [];
  for (let i = 0; i < text.length; i += 1) {
    if (i > 0 && !BEFORE.test(text[i - 1])) continue;
    for (const [seq, char] of ASCII_EMOTES) {
      const end = i + seq.length;
      if (end > text.length) continue;
      if (text.slice(i, end).toLowerCase() !== seq.toLowerCase()) continue;
      if (end < text.length && !AFTER.test(text[end])) continue;
      hits.push({ start: i, end, char, seq });
      i = end - 1;
      break;
    }
  }
  return hits;
}

export function asciiEmoteAt(text, caret) {
  if (!caret) return null;
  return asciiEmotesIn(text).find((hit) => hit.end === caret) || null;
}

export function expandAscii(text) {
  const hits = asciiEmotesIn(text);
  if (!hits.length) return text;
  let out = '';
  let cursor = 0;
  for (const hit of hits) {
    out += text.slice(cursor, hit.start) + hit.char;
    cursor = hit.end;
  }
  return out + text.slice(cursor);
}
