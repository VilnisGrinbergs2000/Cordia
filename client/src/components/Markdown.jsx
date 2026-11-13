import React, { useMemo } from 'react';
import Emoji from './Emoji';
import { splitEmoji } from '../twemoji';
import { assetUrl } from '../runtime';

// Turns a plain-text run into text nodes with Twemoji images for every emoji.
function emojiNodes(value, keyPrefix, size) {
  const parts = splitEmoji(value);
  if (!parts.some((part) => part.emoji)) return [value];
  return parts.map((part, index) =>
    part.emoji ? (
      <Emoji key={`${keyPrefix}-emoji-${index}`} char={part.emoji} size={size} />
    ) : (
      <React.Fragment key={`${keyPrefix}-run-${index}`}>{part.text}</React.Fragment>
    )
  );
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch {}
  return null;
}

// A shared GIF is a URL in the message body. KLIPY's media host is rendered as
// the clip itself; the host check keeps an arbitrary link from turning into an
// image that loads for everyone who scrolls past.
const KLIPY_MEDIA = /\.(mp4|webm|gif|webp)$/i;

function klipyKind(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return '';
    if (parsed.hostname !== 'static.klipy.com') return '';
    const path = parsed.pathname.toLowerCase();
    if (!KLIPY_MEDIA.test(path)) return '';
    return /\.(mp4|webm)$/.test(path) ? 'video' : 'image';
  } catch {
    return '';
  }
}

function splitTrailing(value) {
  let url = value;
  let trailing = '';
  while (/[.,!?;:]$/.test(url)) {
    trailing = url.slice(-1) + trailing;
    url = url.slice(0, -1);
  }
  let opens = (url.match(/\(/g) || []).length;
  let closes = (url.match(/\)/g) || []).length;
  while (closes > opens && url.endsWith(')')) {
    trailing = `)${trailing}`;
    url = url.slice(0, -1);
    closes -= 1;
  }
  return [url, trailing];
}

function inline(text, ctx, keyPrefix) {
  const source = String(text || '');
  const username = String(ctx?.meUsername || '').toLowerCase();
  const emotes = ctx?.emotes || null;
  const pattern =
    /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s<]+|@[a-zA-Z0-9._-]{3,24}|:[a-zA-Z0-9_]{2,32}:)/g;
  const nodes = [];
  let lastIndex = 0;
  let match;
  let index = 0;

  while ((match = pattern.exec(source))) {
    if (match.index > lastIndex) {
      nodes.push(
        <React.Fragment key={`${keyPrefix}-text-${index}`}>
          {emojiNodes(source.slice(lastIndex, match.index), `${keyPrefix}-text-${index}`, ctx?.emojiSize)}
        </React.Fragment>
      );
    }
    const token = match[0];
    const key = `${keyPrefix}-token-${index}`;
    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(
        <code className="md-code" key={key}>
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(<strong key={key}>{inline(token.slice(2, -2), ctx, key)}</strong>);
    } else if (token.startsWith('__') && token.endsWith('__')) {
      nodes.push(<strong key={key}>{inline(token.slice(2, -2), ctx, key)}</strong>);
    } else if (token.startsWith('~~') && token.endsWith('~~')) {
      nodes.push(<del key={key}>{inline(token.slice(2, -2), ctx, key)}</del>);
    } else if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push(<em key={key}>{inline(token.slice(1, -1), ctx, key)}</em>);
    } else if (token.startsWith('_') && token.endsWith('_')) {
      nodes.push(<em key={key}>{inline(token.slice(1, -1), ctx, key)}</em>);
    } else if (token.startsWith('[')) {
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      const href = link ? safeUrl(link[2]) : null;
      nodes.push(
        href ? (
          <a key={key} href={href} target="_blank" rel="noreferrer noopener">
            {inline(link[1], ctx, key)}
          </a>
        ) : (
          <React.Fragment key={key}>{token}</React.Fragment>
        )
      );
    } else if (/^https?:\/\//.test(token)) {
      const [url, trailing] = splitTrailing(token);
      const media = klipyKind(url);
      const href = safeUrl(url);
      nodes.push(
        media ? (
          <React.Fragment key={key}>
            {media === 'video' ? (
              <video className="md-gif" src={url} autoPlay loop muted playsInline preload="metadata" />
            ) : (
              <img className="md-gif" src={url} alt="GIF" loading="lazy" draggable={false} />
            )}
            {trailing}
          </React.Fragment>
        ) : href ? (
          <React.Fragment key={key}>
            <a href={href} target="_blank" rel="noreferrer noopener">
              {url}
            </a>
            {trailing}
          </React.Fragment>
        ) : (
          <React.Fragment key={key}>{token}</React.Fragment>
        )
      );
    } else if (/^@[a-zA-Z0-9._-]{3,24}$/.test(token)) {
      const mentioned = username && token.slice(1).toLowerCase() === username;
      nodes.push(
        mentioned ? (
          <span className="message-mention" key={key}>
            {token}
          </span>
        ) : (
          <React.Fragment key={key}>{token}</React.Fragment>
        )
      );
    } else if (/^:[a-zA-Z0-9_]{2,32}:$/.test(token)) {
      const emote = emotes ? emotes[token.slice(1, -1).toLowerCase()] : null;
      nodes.push(
        emote ? (
          <img
            key={key}
            className={ctx?.jumbo ? 'md-emote jumbo' : 'md-emote'}
            src={assetUrl(emote.url)}
            alt={token}
            title={token}
            draggable={false}
            loading="lazy"
          />
        ) : (
          <React.Fragment key={key}>{token}</React.Fragment>
        )
      );
    } else {
      nodes.push(<React.Fragment key={key}>{token}</React.Fragment>);
    }
    lastIndex = match.index + token.length;
    index += 1;
  }

  if (lastIndex < source.length) {
    nodes.push(
      <React.Fragment key={`${keyPrefix}-text-${index}`}>
        {emojiNodes(source.slice(lastIndex), `${keyPrefix}-text-${index}`, ctx?.emojiSize)}
      </React.Fragment>
    );
  }
  return nodes;
}

function isBlockStart(line) {
  return (
    /^```/.test(line.trim()) ||
    /^#{1,3}\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*(?:[-*+]|\d+\.)\s+/.test(line)
  );
}

function renderBlocks(text, ctx) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (/^```/.test(line.trim())) {
      const language = line.trim().slice(3).trim();
      const code = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index].trim())) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <pre key={`block-${key}`}>
          <code className={language ? `language-${language}` : undefined}>{code.join('\n')}</code>
        </pre>
      );
      key += 1;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const Tag = `h${heading[1].length}`;
      blocks.push(<Tag key={`block-${key}`}>{inline(heading[2], ctx, `h-${key}`)}</Tag>);
      key += 1;
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push(
        <blockquote key={`block-${key}`}>
          {quote.map((entry, quoteIndex) => (
            <p key={`quote-${key}-${quoteIndex}`}>
              {inline(entry, ctx, `q-${key}-${quoteIndex}`)}
            </p>
          ))}
        </blockquote>
      );
      key += 1;
      continue;
    }

    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*(?:[-*+]|\d+\.)\s+(.*)$/);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      const ListTag = ordered ? 'ol' : 'ul';
      blocks.push(
        <ListTag key={`block-${key}`}>
          {items.map((item, itemIndex) => (
            <li key={`li-${key}-${itemIndex}`}>
              {inline(item, ctx, `li-${key}-${itemIndex}`)}
            </li>
          ))}
        </ListTag>
      );
      key += 1;
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(
      <p key={`block-${key}`}>
        {paragraph.map((entry, lineIndex) => (
          <React.Fragment key={`p-${key}-${lineIndex}`}>
            {lineIndex > 0 && <br />}
            {inline(entry, ctx, `p-${key}-${lineIndex}`)}
          </React.Fragment>
        ))}
      </p>
    );
    key += 1;
  }

  return blocks;
}

function buildEmoteMap(emotes) {
  if (!emotes) return null;
  const list = Array.isArray(emotes) ? emotes : Object.values(emotes);
  if (!list.length) return null;
  const map = {};
  for (const emote of list) {
    if (emote && emote.name) map[String(emote.name).toLowerCase()] = emote;
  }
  return map;
}

export default function Markdown({ text, meUsername, emotes, className = '' }) {
  const emoteMap = useMemo(() => buildEmoteMap(emotes), [emotes]);
  if (!text) return null;

  const stickerMatch = /^:([a-zA-Z0-9_]{2,32}):$/.exec(String(text).trim());
  const sticker = stickerMatch ? emoteMap?.[stickerMatch[1].toLowerCase()] : null;
  if (sticker && sticker.kind === 'sticker') {
    return (
      <div className={`markdown-body ${className}`.trim()}>
        <img
          className="md-sticker"
          src={assetUrl(sticker.url)}
          alt={text.trim()}
          title={text.trim()}
          draggable={false}
        />
      </div>
    );
  }

  // Discord calls a message that is nothing but one to three emoji "jumbo".
  const jumbo = useMemo(() => {
    const trimmed = String(text || '').trim();
    if (!trimmed) return false;
    let count = 0;
    let rest = '';
    for (const part of splitEmoji(trimmed)) {
      if (part.emoji) count += 1;
      else rest += part.text;
    }
    rest = rest
      .replace(/:[a-zA-Z0-9_]{2,32}:/g, (token) => {
        if (!emoteMap?.[token.slice(1, -1).toLowerCase()]) return token;
        count += 1;
        return '';
      })
      .trim();
    return count > 0 && count <= 3 && !rest;
  }, [text, emoteMap]);

  const ctx = {
    meUsername,
    emotes: emoteMap,
    jumbo,
    emojiSize: jumbo ? 48 : 22
  };
  const rootClass = ['markdown-body', jumbo ? 'jumbo' : '', className]
    .filter(Boolean)
    .join(' ');
  return <div className={rootClass}>{renderBlocks(text, ctx)}</div>;
}
