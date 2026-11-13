import React from 'react';
import { emojiUrl, splitEmoji } from '../twemoji';

// One emoji, drawn from the bundled Twemoji set. If the asset is missing (a
// sequence we do not ship) the character itself is rendered instead.
export default function Emoji({ char, size = 22, className = '', loading }) {
  const url = emojiUrl(char);
  if (!url) return <span className={className}>{char}</span>;
  return (
    <img
      className={`emoji-img ${className}`.trim()}
      src={url}
      alt={char}
      title={char}
      draggable={false}
      loading={loading}
      style={{ width: size, height: size }}
    />
  );
}

// Splits a run of text so emoji become images and everything else stays text.
export function EmojiText({ text, size = 22, className = '' }) {
  const parts = React.useMemo(() => splitEmoji(text), [text]);
  return (
    <>
      {parts.map((part, index) =>
        part.emoji ? (
          <Emoji key={`e${index}`} char={part.emoji} size={size} className={className} />
        ) : (
          <React.Fragment key={`t${index}`}>{part.text}</React.Fragment>
        )
      )}
    </>
  );
}
