import { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, CalendarClock, ImagePlus, Loader2, Mic, Reply, Send, Smile, Terminal, X } from 'lucide-react';
import EmojiPicker from './EmojiPicker';
import { asciiEmoteAt, asciiEmotesIn, expandAscii } from '../asciiEmotes';
import Emoji from './Emoji';
import { assetUrl } from '../runtime';
import api from '../api';
import { useSupport } from '../support';

const DRAFT_PREFIX = 'cordia:draft:';
const VOICE_MAX_MS = 600000;

function clock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function toast(detail) {
  window.dispatchEvent(new CustomEvent('cordia:toast', { detail }));
}

function readDraft(key) {
  if (!key) return '';
  try {
    return localStorage.getItem(`${DRAFT_PREFIX}${key}`) || '';
  } catch {
    return '';
  }
}

function writeDraft(key, text) {
  if (!key) return;
  try {
    if (text) localStorage.setItem(`${DRAFT_PREFIX}${key}`, text);
    else localStorage.removeItem(`${DRAFT_PREFIX}${key}`);
  } catch {}
}

function fileSize(bytes) {
  const size = Number(bytes) || 0;
  if (size >= 1024 ** 2) {
    const mb = size / 1024 ** 2;
    return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
  }
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function voiceFile(blob, type) {
  const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
  return new File([blob], `voice-${Date.now()}.${ext}`, { type });
}

// A "/name args" line only becomes an interaction when the channel actually has
// that command installed; otherwise it is just a message that starts with a
// slash, which people do type.
// "/admin ban user" is one command with a subcommand. The words after the
// command name are resolved against the declaration before anything is treated
// as an argument, because the first word is a name, not a value.
function resolveSubcommand(found, words) {
  const nested = (found.options || []).filter(
    (entry) => entry.type === 'subcommand' || entry.type === 'subcommand_group'
  );
  if (!nested.length) return { options: found.options || [], rest: words };

  const first = (words[0] || '').toLowerCase();
  const group = nested.find((entry) => entry.type === 'subcommand_group' && entry.name === first);
  if (group) {
    const second = (words[1] || '').toLowerCase();
    const sub = (group.options || []).find((entry) => entry.name === second);
    if (!sub) return { options: [], rest: words, subcommandGroup: group.name };
    return {
      options: sub.options || [],
      rest: words.slice(2),
      subcommand: sub.name,
      subcommandGroup: group.name
    };
  }

  const sub = nested.find((entry) => entry.type === 'subcommand' && entry.name === first);
  if (!sub) return { options: [], rest: words };
  return { options: sub.options || [], rest: words.slice(1), subcommand: sub.name };
}

function parseCommandInvocation(text, commands) {
  const match = /^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i.exec(String(text).trim());
  if (!match) return null;
  const found = commands.find((command) => command.name === match[1].toLowerCase());
  if (!found) return null;
  const rest = (match[2] || '').trim();
  const words = rest ? rest.split(/\s+/) : [];
  const resolved = resolveSubcommand(found, words);
  const options = {};
  if (rest) {
    if (rest.includes('=')) {
      for (const part of rest.split(/\s+/)) {
        const [key, ...value] = part.split('=');
        if (key && value.length) options[key.toLowerCase()] = value.join('=');
      }
    } else {
      (resolved.options || []).forEach((option, index) => {
        if (resolved.rest[index] !== undefined) options[option.name] = resolved.rest[index];
      });
    }
  }
  return {
    applicationId: found.applicationId,
    command: found.name,
    ...(resolved.subcommand ? { subcommand: resolved.subcommand } : {}),
    ...(resolved.subcommandGroup ? { subcommandGroup: resolved.subcommandGroup } : {}),
    options
  };
}

// Suggestions only make sense for the option being typed right now, so the
// target is resolved positionally: "/weather " asks about the first option and
// "/weather co " asks about the second.
// Typing "/admin " should offer "ban" and "kick" the way an option offers its
// suggestions — the names are already in the composer, so no round trip.
function subcommandSuggestions(text, commands) {
  const match = /^\/([a-z0-9_-]+)\s+([a-z0-9_-]*)$/i.exec(String(text));
  if (!match) return null;
  const command = commands.find((entry) => entry.name === match[1].toLowerCase());
  if (!command) return null;
  const nested = (command.options || []).filter(
    (entry) => entry.type === 'subcommand' || entry.type === 'subcommand_group'
  );
  if (!nested.length) return null;
  const typed = match[2].toLowerCase();
  const items = nested
    // An exact match means the word is finished; offering it again would put
    // the same name back under the cursor.
    .filter((entry) => entry.name.startsWith(typed) && entry.name !== typed)
    .map((entry) => ({ name: entry.name, value: entry.name, hint: entry.description }));
  return items.length ? { label: command.name, items } : null;
}
function autocompleteTarget(text, commands) {
  const match = /^\/([a-z0-9_-]+)\s+([\s\S]*)$/i.exec(String(text));
  if (!match) return null;
  const command = commands.find((entry) => entry.name === match[1].toLowerCase());
  if (!command) return null;
  const words = match[2].split(/\s+/);
  // With a subcommand the arguments belong to it, not to the command, so the
  // position is counted from the end of the subcommand's name.
  const resolved = resolveSubcommand(command, words);
  const options = resolved.options || [];
  const rest = resolved.rest || words;
  const last = rest[rest.length - 1] || '';

  // "city=os" names the option; "os" means whichever option sits in that
  // position. Named is unambiguous, and it is the only way to suggest for an
  // option that comes after a skipped optional one.
  const named = /^([a-z0-9_-]+)=(.*)$/i.exec(last);
  if (named) {
    const option = options.find((entry) => entry.name === named[1].toLowerCase());
    if (!option || !option.autocomplete) return null;
    return {
      applicationId: command.applicationId,
      command: command.name,
      option: option.name,
      label: option.description || option.name,
      query: named[2] || ''
    };
  }

  const option = options[rest.length - 1];
  if (!option || !option.autocomplete) return null;
  return {
    applicationId: command.applicationId,
    command: command.name,
    option: option.name,
    label: option.description || option.name,
    query: last
  };
}

// A take that was interrupted by leaving the scope is kept here, keyed by the
// draft it was recorded for, so the composer can offer it back on return.
const pendingTakes = new Map();

export default function MessageInput({
  draftKey,
  placeholder,
  onSend,
  onTyping,
  replyTo,
  onCancelReply,
  disabled,
  canAttach = true,
  canPoll = false,
  onCreatePoll,
  scheduleChannelId = null,
  emotes = [],
  mentionables = []
}) {
  const { limits } = useSupport();
  // The ceiling is a constant the provider falls back to on its own, so the
  // composer can enforce it before the first request answers.
  const uploadLimit = limits.maxUploadBytes;
  const [text, setText] = useState(() => readDraft(draftKey));
  const [attachment, setAttachment] = useState(null);
  const [sending, setSending] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [error, setError] = useState('');
  const [upsell, setUpsell] = useState(null);
  const [caret, setCaret] = useState(0);
  const [activeEmote, setActiveEmote] = useState(0);
  const [dismissedToken, setDismissedToken] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState('');
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [pending, setPending] = useState([]);
  const [commands, setCommands] = useState([]);
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandSuggestions, setCommandSuggestions] = useState([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionLabel, setSuggestionLabel] = useState('');
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  // The @word somebody escaped out of, so Escape does not reopen the same list
  // on the next keystroke. Typing another character changes the query and the
  // list comes back, which is what you want.
  const [mentionDismissed, setMentionDismissed] = useState(null);
  // Set to the text a suggestion produced, so accepting one does not immediately
  // ask for suggestions for the value it just inserted.
  const acceptedSuggestion = useRef('');
  // "/ro" narrows the list; a space ends the command name and closes the popup.
  const commandQuery = text.startsWith('/') && !/\s/.test(text) ? text.slice(1).toLowerCase() : null;
  const commandMatches =
    commandQuery === null
      ? []
      : commands.filter((command) => command.name.startsWith(commandQuery)).slice(0, 6);

  // A mention is live only while the caret sits at the end of the @word. The
  // lookbehind is written as a group so it also matches the start of the box.
  const mentionToken = (() => {
    const before = text.slice(0, caret);
    const match = before.match(/(?:^|[\s(])@([a-zA-Z0-9._-]{0,24})$/);
    if (!match) return null;
    return { start: before.length - match[1].length - 1, query: match[1].toLowerCase() };
  })();
  const mentionMatches =
    mentionToken && mentionToken.query !== mentionDismissed
      ? mentionables
          .filter(
            (member) =>
              (member.username || '').toLowerCase().startsWith(mentionToken.query) ||
              (member.displayName || '').toLowerCase().startsWith(mentionToken.query)
          )
          .slice(0, 8)
      : [];
  const scheduleRef = useRef(null);
  // The composer asks once per channel: commands are installed per server, so
  // this list doubles as the "is this app installed here" check.
  useEffect(() => {
    if (!scheduleChannelId) {
      setCommands([]);
      return undefined;
    }
    let cancelled = false;
    api
      // The language the browser is set to. Descriptions follow it; command
      // names never do.
      .get(
        `/api/channels/${scheduleChannelId}/commands?locale=${encodeURIComponent(
          navigator.language || 'en'
        )}`
      )
      .then((data) => {
        if (!cancelled) setCommands(data.commands || []);
      })
      .catch(() => {
        if (!cancelled) setCommands([]);
      });
    return () => {
      cancelled = true;
    };
  }, [scheduleChannelId]);

  // Suggestions are debounced and the last answer wins: typing fast must not
  // make an older list appear under a newer word.
  useEffect(() => {
    const local = subcommandSuggestions(text, commands);
    if (local) {
      setSuggestionLabel(local.label);
      setSuggestionsLoading(false);
      setCommandSuggestions(local.items);
      setSuggestionIndex(0);
      return undefined;
    }

    const target = autocompleteTarget(text, commands);
    if (!target || !scheduleChannelId || text === acceptedSuggestion.current) {
      setCommandSuggestions([]);
      return undefined;
    }
    let cancelled = false;
    setSuggestionLabel(target.label);
    const timer = setTimeout(() => {
      // The request can take up to the server's deadline, so the popup says it
      // is waiting instead of simply appearing late.
      setSuggestionsLoading(true);
      api
        .post(`/api/channels/${scheduleChannelId}/autocomplete`, {
          applicationId: target.applicationId,
          command: target.command,
          option: target.option,
          query: target.query
        })
        .then((data) => {
          if (cancelled) return;
          setCommandSuggestions(data.choices || []);
          setSuggestionIndex(0);
          setSuggestionsLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setCommandSuggestions([]);
          setSuggestionsLoading(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      setSuggestionsLoading(false);
      clearTimeout(timer);
    };
  }, [text, commands, scheduleChannelId]);
  const textareaRef = useRef(null);
  const fileRef = useRef(null);
  const emojiRef = useRef(null);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const startedRef = useRef(0);
  const cancelledRef = useRef(false);
  const mountedRef = useRef(true);
  const startingRef = useRef(false);

  // ":nam" typed at a word boundary opens an inline picker; Enter/Tab completes it.
  const emoteToken = useMemo(() => {
    const before = text.slice(0, caret);
    const match = /(?:^|[\s([{]):([a-zA-Z0-9_]{0,32})$/.exec(before);
    return match ? match[1] : null;
  }, [text, caret]);

  const emoteMap = useMemo(() => {
    const map = {};
    for (const emote of emotes) {
      if (emote?.name) map[String(emote.name).toLowerCase()] = emote;
    }
    return map;
  }, [emotes]);

  // The emoji catalogue is a lazy chunk. The first `:` token pulls it in so
  // shortcodes can be completed and previewed without opening the picker.
  useEffect(() => {
    if (catalog || emoteToken === null) return undefined;
    let cancelled = false;
    import('../emojiData')
      .then((module) => {
        if (!cancelled) setCatalog(module);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [catalog, emoteToken]);

  const emoteMatches = useMemo(() => {
    if (emoteToken === null || !emotes.length) return [];
    const query = emoteToken.toLowerCase();
    const starts = [];
    const contains = [];
    for (const emote of emotes) {
      if (!emote?.name) continue;
      const name = String(emote.name).toLowerCase();
      if (name.startsWith(query)) starts.push(emote);
      else if (query && name.includes(query)) contains.push(emote);
    }
    return [...starts, ...contains].slice(0, 8);
  }, [emoteToken, emotes]);

  // Server emotes first (they are the ones that cannot be typed as emoji), then
  // the catalogue's own shortcodes.
  const suggestions = useMemo(() => {
    if (emoteToken === null) return [];
    const list = emoteMatches.map((emote) => ({ key: `e${emote.id}`, emote }));
    if (catalog) {
      for (const emoji of catalog.searchEmojiByName(emoteToken, 6)) {
        list.push({ key: `m${emoji.char}`, emoji });
      }
    }
    return list.slice(0, 10);
  }, [emoteToken, emoteMatches, catalog]);

  const suggestOpen = suggestions.length > 0 && dismissedToken !== emoteToken;

  // What the draft will look like: server emotes as images, everything else as
  // the emoji it will become on send.
  const previewItems = useMemo(() => {
    const items = [];
    const seen = new Set();
    const tokenRe = /:([a-zA-Z0-9_]{2,32}):/g;
    let match;
    while ((match = tokenRe.exec(text))) {
      const name = match[1].toLowerCase();
      const emote = emoteMap[name];
      const emoji = emote ? null : catalog?.findEmojiByName(name);
      const key = emote ? `e${emote.id}` : emoji ? `m${emoji.char}` : '';
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push(
        emote
          ? { key, emote, label: `:${emote.name}:` }
          : { key, emoji, label: `:${emoji.name}:` }
      );
    }
    for (const hit of asciiEmotesIn(text)) {
      const key = `m${hit.char}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ key, emoji: { char: hit.char }, label: hit.seq });
    }
    return items.slice(0, 8);
  }, [text, emoteMap, catalog]);

  useEffect(() => {
    setActiveEmote(0);
  }, [emoteToken]);

  useEffect(() => {
    if (dismissedToken !== null && dismissedToken !== emoteToken) setDismissedToken(null);
  }, [emoteToken, dismissedToken]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);

  useEffect(() => {
    writeDraft(draftKey, text);
  }, [draftKey, text]);

  useEffect(() => {
    if (!emojiOpen) return undefined;
    function onDown(event) {
      if (emojiRef.current && !emojiRef.current.contains(event.target)) setEmojiOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [emojiOpen]);

  useEffect(
    () => () => {
      if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    },
    [attachment]
  );

  // Leaving the scope mid-recording must not leave the microphone hot. The take
  // is kept instead of dropped, so coming back offers it again.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (recorderRef.current && chunksRef.current.length) {
        const type = String(recorderRef.current.mimeType || 'audio/webm').split(';')[0];
        const blob = new Blob(chunksRef.current, { type });
        if (blob.size >= 512) {
          const file = voiceFile(blob, type);
          file.voiceDurationMs = Math.min(
            VOICE_MAX_MS,
            Math.round(Date.now() - startedRef.current)
          );
          pendingTakes.set(draftKey, file);
        }
      }
      cancelledRef.current = true;
      stopTimer();
      const recorder = recorderRef.current;
      try {
        if (recorder && recorder.state !== 'inactive') recorder.stop();
      } catch {
        // already stopped
      }
      recorderRef.current = null;
      stopTracks();
    };
  }, []);

  // A kept take is offered as a pending attachment rather than sent silently:
  // the composer already knows how to send one.
  useEffect(() => {
    const kept = pendingTakes.get(draftKey);
    if (!kept) return;
    pendingTakes.delete(draftKey);
    setAttachment({ file: kept, name: kept.name, type: kept.type, previewUrl: '' });
    toast({
      title: 'Recording kept',
      message: 'Your voice message is ready - press Send to post it.'
    });
  }, [draftKey]);

  const canRecord =
    canAttach &&
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia;

  // One attachment at a time, whichever way it arrives. Keeping the size check
  // here is what makes the picker, a paste and the upsell agree.
  function acceptFile(file) {
    if (!file) return;
    setError('');
    if (uploadLimit && file.size > uploadLimit) {
      setAttachment(null);
      setUpsell({ size: file.size, limit: uploadLimit });
      return;
    }
    setUpsell(null);
    setAttachment({
      file,
      // A screenshot on the clipboard has no name worth keeping; the upload
      // route needs something, so give it a plausible one.
      name: file.name || 'pasted-image.png',
      type: file.type || 'application/octet-stream',
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : ''
    });
  }

  function pickFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    acceptFile(file);
  }

  // Ctrl+V with a screenshot on the clipboard. Text paste is left alone: the
  // handler only steps in when the clipboard carries an image file, so copying
  // a word still inserts the word.
  function handlePaste(event) {
    if (!canAttach) return;
    const items = Array.from(event.clipboardData?.items || []);
    const image = items.find((item) => item.kind === 'file' && item.type.startsWith('image/'));
    if (!image) return;
    const file = image.getAsFile();
    if (!file) return;
    event.preventDefault();
    acceptFile(file);
  }

  function stopTracks() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  function stopTimer() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  // Runs from MediaRecorder.onstop, so the strip is already gone when the
  // upload starts; the composer falls back to its normal send spinner.
  async function finishRecording(mimeType) {
    stopTimer();
    stopTracks();
    const chunks = chunksRef.current;
    chunksRef.current = [];
    const duration = Math.min(VOICE_MAX_MS, Date.now() - startedRef.current);
    const cancelled = cancelledRef.current;
    cancelledRef.current = false;
    recorderRef.current = null;
    if (!mountedRef.current) return;
    setRecording(false);
    setElapsed(0);
    if (cancelled) return;
    const type = String(mimeType || 'audio/webm').split(';')[0];
    const blob = new Blob(chunks, { type });
    // A permission prompt that returns a dead track, or a tap-and-release,
    // leaves a header-only blob; posting it would make a silent message.
    if (!chunks.length || blob.size < 512 || duration < 300) {
      toast({ type: 'error', title: 'Recording too short', message: 'Hold on a little longer before sending.' });
      return;
    }
    const file = voiceFile(blob, type);
    // Carried on the File because onSend's signature is shared with attachments.
    file.voiceDurationMs = Math.round(duration);
    setSending(true);
    setError('');
    try {
      await onSend('', file);
      textareaRef.current?.focus();
    } catch (err) {
      setError(err.message);
    } finally {
      if (mountedRef.current) setSending(false);
    }
  }

  function stopRecording(cancel) {
    cancelledRef.current = cancel;
    const recorder = recorderRef.current;
    // Cleared before stop() so a double click cannot finish the same take twice.
    recorderRef.current = null;
    if (!recorder) {
      stopTimer();
      stopTracks();
      setRecording(false);
      setElapsed(0);
      return;
    }
    if (recorder.state === 'inactive') finishRecording(recorder.mimeType);
    else recorder.stop();
  }

  async function startRecording() {
    if (recording || sending || disabled || startingRef.current) return;
    startingRef.current = true;
    setError('');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      startingRef.current = false;
      toast({
        type: 'error',
        title: 'Microphone unavailable',
        message:
          err?.name === 'NotAllowedError' || err?.name === 'SecurityError'
            ? 'Allow microphone access to record a voice message.'
            : 'Could not start recording on this device.'
      });
      return;
    }
    startingRef.current = false;
    if (!mountedRef.current) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find(
      (type) => MediaRecorder.isTypeSupported?.(type)
    );
    let recorder;
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch {
      startingRef.current = false;
      stream.getTracks().forEach((track) => track.stop());
      toast({ type: 'error', title: 'Recording unavailable', message: 'This browser cannot record audio.' });
      return;
    }
    streamRef.current = stream;
    recorderRef.current = recorder;
    chunksRef.current = [];
    cancelledRef.current = false;
    startedRef.current = Date.now();
    setElapsed(0);
    setRecording(true);
    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => finishRecording(recorder.mimeType);
    recorder.start(250);
    timerRef.current = setInterval(() => {
      const ms = Date.now() - startedRef.current;
      setElapsed(ms);
      if (ms >= VOICE_MAX_MS) stopRecording(false);
    }, 200);
  }

  // `:joy:` and `:D` become real emoji on send. Server emotes keep their token
  // (the renderer swaps in the image) and code spans are left untouched.
  function expandEmoji(raw) {
    if (!raw) return raw;
    return raw
      .split('`')
      .map((segment, index) => {
        if (index % 2 === 1) return segment;
        const withShortcodes = segment.replace(
          /:([a-zA-Z0-9_]{2,32}):/g,
          (token) => {
            const name = token.slice(1, -1);
            if (emoteMap[name.toLowerCase()]) return token;
            const emoji = catalog?.findEmojiByName(name);
            return emoji ? emoji.char : token;
          }
        );
        return expandAscii(withShortcodes);
      })
      .join('`');
  }

  // "Send later" lives here rather than in Shell: the queue is per channel and
  // the draft being scheduled is the one in this textarea.
  const schedulePresets = useMemo(
    () => [
      { label: 'In 30 minutes', at: () => Date.now() + 30 * 60 * 1000 },
      { label: 'In 1 hour', at: () => Date.now() + 60 * 60 * 1000 },
      { label: 'In 3 hours', at: () => Date.now() + 3 * 60 * 60 * 1000 },
      {
        label: 'Tomorrow at 9:00',
        at: () => {
          const date = new Date();
          date.setDate(date.getDate() + 1);
          date.setHours(9, 0, 0, 0);
          return date.getTime();
        }
      }
    ],
    []
  );

  useEffect(() => {
    if (!scheduleOpen) return undefined;
    let cancelled = false;
    api
      .get('/api/scheduled')
      .then((data) => {
        if (cancelled) return;
        setPending(
          (data.scheduled || []).filter((item) => item.channelId === Number(scheduleChannelId))
        );
      })
      .catch(() => {
        if (!cancelled) setPending([]);
      });
    function onPointerDown(event) {
      if (scheduleRef.current && !scheduleRef.current.contains(event.target)) {
        setScheduleOpen(false);
      }
    }
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      cancelled = true;
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [scheduleOpen, scheduleChannelId]);

  function scheduleLabel(ms) {
    return new Date(ms).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  async function scheduleFor(sendAt) {
    const content = expandEmoji(text.trim());
    if (!content) {
      setError('Type the message you want to send later.');
      return;
    }
    if (!Number.isFinite(sendAt)) {
      setError('Pick a time for this message.');
      return;
    }
    setScheduleBusy(true);
    setError('');
    try {
      const data = await api.post(`/api/channels/${scheduleChannelId}/scheduled`, {
        content,
        sendAt
      });
      setPending((list) => [...list, data.scheduled].sort((a, b) => a.sendAt - b.sendAt));
      writeDraft(draftKey, '');
      setText('');
      setScheduleAt('');
      setScheduleOpen(false);
      toast({ title: 'Scheduled for ' + scheduleLabel(sendAt) });
    } catch (err) {
      setError(err.message);
    } finally {
      setScheduleBusy(false);
    }
  }

  async function cancelScheduled(id) {
    try {
      await api.del(`/api/scheduled/${id}`);
      setPending((list) => list.filter((item) => item.id !== id));
    } catch (err) {
      setError(err.message);
    }
  }

  function insertCommand(command) {
    const next = `/${command.name} `;
    setText(next);
    setCaret(next.length);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.length, next.length);
    });
  }

  // The mention replaces the @word in place, so text on both sides of the caret
  // survives. A trailing space is part of the insert: it ends the token and lets
  // you keep typing.
  function applyMention(member) {
    if (!member || !mentionToken) return;
    const head = text.slice(0, mentionToken.start);
    const inserted = `@${member.username} `;
    const next = `${head}${inserted}${text.slice(caret)}`;
    const pos = head.length + inserted.length;
    setText(next);
    setCaret(pos);
    setMentionIndex(0);
    setMentionDismissed(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  // Replaces the word being typed, keeping everything before it. Accepting a
  // suggestion is an edit, never a send.
  function applyCommandSuggestion(choice) {
    if (!choice) return;
    // "city=os" keeps its "city=" — only the value is being replaced. Dropping
    // it would turn a named argument into a positional one.
    const head = text.replace(/([a-z0-9_-]+=)?\S*$/i, (whole, named) => named || '');
    const next = `${head}${choice.value}`;
    acceptedSuggestion.current = next;
    setText(next);
    setCaret(next.length);
    setCommandSuggestions([]);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.length, next.length);
    });
  }

  async function submit(event) {
    event?.preventDefault();
    if (disabled || sending) return;
    const content = expandEmoji(text.trim());
    if (!content && !attachment) return;

    // A slash line only becomes an interaction when the command is installed
    // here. Otherwise it falls through and sends as an ordinary message.
    const invocation =
      scheduleChannelId && !attachment ? parseCommandInvocation(content, commands) : null;
    if (invocation) {
      setSending(true);
      setError('');
      try {
        await api.post(`/api/channels/${scheduleChannelId}/interactions`, invocation);
        writeDraft(draftKey, '');
        setText('');
        textareaRef.current?.focus();
      } catch (err) {
        setError(err.message);
      } finally {
        setSending(false);
      }
      return;
    }

    if (attachment?.file && uploadLimit && attachment.file.size > uploadLimit) {
      setUpsell({ size: attachment.file.size, limit: uploadLimit });
      return;
    }
    setSending(true);
    setError('');
    try {
      await onSend(content, attachment?.file || null);
      writeDraft(draftKey, '');
      setText('');
      setAttachment(null);
      setUpsell(null);
      textareaRef.current?.focus();
    } catch (err) {
      if (err.code === 'UPLOAD_TOO_LARGE' || err.code === 'STORAGE_FULL') {
        // The server refuses the size, not the message: keep the text and the
        // file so nothing typed is lost, and say what the ceiling is.
        setUpsell({
          size: attachment?.file?.size || 0,
          limit: err.limit || uploadLimit
        });
        setError('');
      } else {
        setError(err.message);
      }
    } finally {
      setSending(false);
    }
  }

  function insertSnippet(snippet, { refocus = true } = {}) {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    setText(`${text.slice(0, start)}${snippet}${text.slice(end)}`);
    const next = start + snippet.length;
    setCaret(next);
    if (!refocus) {
      // Picking from the panel keeps the search field focused so several
      // emoji can be added in a row; the caret is restored on close.
      el?.setSelectionRange?.(next, next);
      return;
    }
    setEmojiOpen(false);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(next, next);
    });
  }

  // A GIF is a message, not a draft: it goes out on click, the way a picked
  // emoji goes into the box. Whatever is already typed stays where it is.
  async function sendGif(item) {
    if (!item?.url || disabled || sending) return;
    setEmojiOpen(false);
    setSending(true);
    setError('');
    try {
      await onSend(item.url, null);
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  }

  function acceptSuggestion(suggestion) {
    if (emoteToken === null || !suggestion) return;
    const start = caret - emoteToken.length - 1;
    if (start < 0) return;
    // Emotes stay as tokens (the renderer swaps in the image); emoji are
    // inserted as the character so they are visible in the box immediately.
    const snippet = suggestion.emote
      ? `:${suggestion.emote.name}: `
      : suggestion.emoji.char;
    const next = `${text.slice(0, start)}${snippet}${text.slice(caret)}`;
    setText(next);
    setDismissedToken(emoteToken);
    const pos = start + snippet.length;
    setCaret(pos);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  }

  function onKeyDown(event) {
    // `:D`, `:)` and friends convert straight away - there is no list to pick
    // from, so Tab is the only thing that could consume the keystroke.
    if (event.key === 'Tab' && !event.shiftKey) {
      const ascii = asciiEmoteAt(text, caret);
      if (ascii) {
        event.preventDefault();
        const next = `${text.slice(0, ascii.start)}${ascii.char}${text.slice(ascii.end)}`;
        const pos = ascii.start + ascii.char.length;
        setText(next);
        setCaret(pos);
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(pos, pos);
        });
        return;
      }
    }
    if (mentionMatches.length > 0) {
      const last = mentionMatches.length - 1;
      const active = Math.min(mentionIndex, last);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMentionIndex(active >= last ? 0 : active + 1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionIndex(active <= 0 ? last : active - 1);
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        applyMention(mentionMatches[active]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMentionDismissed(mentionToken?.query ?? null);
        return;
      }
    }
    if (commandSuggestions.length > 0) {
      const last = commandSuggestions.length - 1;
      const active = Math.min(suggestionIndex, last);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSuggestionIndex((value) => (value >= last ? 0 : value + 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSuggestionIndex((value) => (value <= 0 ? last : value - 1));
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        applyCommandSuggestion(commandSuggestions[active]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setCommandSuggestions([]);
        return;
      }
    }
    if (commandMatches.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setCommandIndex((value) => (value + 1) % commandMatches.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setCommandIndex((value) => (value - 1 + commandMatches.length) % commandMatches.length);
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        insertCommand(commandMatches[commandIndex] || commandMatches[0]);
        return;
      }
    }
    if (suggestOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveEmote((value) => (value + 1) % suggestions.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveEmote(
          (value) => (value - 1 + suggestions.length) % suggestions.length
        );
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        acceptSuggestion(suggestions[activeEmote]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissedToken(emoteToken);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
    if (event.key === 'Escape' && replyTo) {
      event.preventDefault();
      onCancelReply?.();
    }
  }

  return (
    <div className="composer">
      {upsell && (
        <div className="composer-upsell" role="status">
          <div className="composer-upsell-copy">
            <strong>That file is {fileSize(upsell.size)}.</strong>
            <p>
              The limit is {fileSize(upsell.limit)} per file. Try a smaller file, or send it as a
              link.
            </p>
          </div>
          <div className="composer-upsell-actions">
            <button
              type="button"
              className="icon-btn"
              onClick={() => setUpsell(null)}
              aria-label="Dismiss the size warning"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}
      {error && <div className="composer-error">{error}</div>}
      {replyTo && (
        <div className="composer-reply">
          <div className="composer-reply-icon">
            <Reply size={15} />
          </div>
          <div className="composer-reply-copy">
            <span>
              Replying to <strong>{replyTo.author.displayName}</strong>
            </span>
            <p>{replyTo.content || (replyTo.attachment ? 'Attachment' : 'Message')}</p>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onCancelReply}
            title="Cancel reply"
          >
            <X size={15} />
          </button>
        </div>
      )}
      {attachment && (
        <div className="composer-attachment">
          {attachment.previewUrl ? (
            <img src={attachment.previewUrl} alt={attachment.name} />
          ) : (
            <div className="composer-attachment-file">{attachment.name}</div>
          )}
          <div className="composer-attachment-meta">
            <strong>{attachment.name}</strong>
            <span>Ready to send</span>
          </div>
          <button className="icon-btn" onClick={() => setAttachment(null)} title="Remove attachment">
            <X size={15} />
          </button>
        </div>
      )}
      {previewItems.length > 0 && (
        <div className="composer-preview" aria-hidden="true">
          {previewItems.map((item) => (
            <span className="composer-preview-chip" key={item.key}>
              {item.emote ? (
                <img src={assetUrl(item.emote.url)} alt="" draggable={false} />
              ) : (
                <Emoji char={item.emoji.char} size={18} />
              )}
              <span>{item.label}</span>
            </span>
          ))}
        </div>
      )}
      {recording ? (
        <div className="composer-box composer-recording">
          <span className="recording-dot" aria-hidden="true" />
          <span className="recording-time">{clock(elapsed)}</span>
          <span className="recording-hint">Recording voice message</span>
          <button
            type="button"
            className="icon-btn"
            onClick={() => stopRecording(true)}
            title="Cancel recording"
            aria-label="Cancel recording"
          >
            <X size={16} />
          </button>
          <button
            type="button"
            className="composer-send"
            onClick={() => stopRecording(false)}
            title="Send voice message"
            aria-label="Send voice message"
          >
            <Send size={17} />
          </button>
        </div>
      ) : (
      <form className="composer-box" onSubmit={submit}>
        {scheduleOpen && scheduleChannelId && (
          <div className="schedule-popover" ref={scheduleRef} role="dialog" aria-label="Send later">
            <div className="schedule-popover-head">
              <strong>Send later</strong>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setScheduleOpen(false)}
                aria-label="Close send later"
              >
                <X size={14} />
              </button>
            </div>
            <div className="schedule-presets">
              {schedulePresets.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className="schedule-preset"
                  disabled={scheduleBusy}
                  onClick={() => scheduleFor(preset.at())}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="schedule-custom">
              <input
                type="datetime-local"
                value={scheduleAt}
                onChange={(event) => setScheduleAt(event.target.value)}
                aria-label="Send at"
              />
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={scheduleBusy || !scheduleAt}
                onClick={() => scheduleFor(new Date(scheduleAt).getTime())}
              >
                {scheduleBusy ? <Loader2 size={14} className="spin" /> : 'Schedule'}
              </button>
            </div>
            {pending.length > 0 && (
              <div className="schedule-queue">
                <span className="schedule-queue-label">Queued in this channel</span>
                {pending.map((item) => (
                  <div className="schedule-queue-item" key={item.id}>
                    <span className="schedule-queue-text">{item.content}</span>
                    <small>{scheduleLabel(item.sendAt)}</small>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => cancelScheduled(item.id)}
                      aria-label="Cancel scheduled message"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {suggestOpen && (
          <div className="composer-emote-suggest" role="listbox" aria-label="Emoji and emotes">
            {suggestions.map((item, index) => (
              <button
                type="button"
                key={item.key}
                role="option"
                aria-selected={index === activeEmote}
                className={`composer-emote-option ${index === activeEmote ? 'active' : ''}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  acceptSuggestion(item);
                }}
                onMouseEnter={() => setActiveEmote(index)}
              >
                {item.emote ? (
                  <img src={assetUrl(item.emote.url)} alt="" draggable={false} />
                ) : (
                  <Emoji char={item.emoji.char} size={18} className="composer-emote-glyph" />
                )}
                <span>{item.emote ? `:${item.emote.name}:` : `:${item.emoji.name}:`}</span>
                <small>
                  {item.emote
                    ? item.emote.kind === 'sticker'
                      ? 'sticker'
                      : 'emote'
                    : 'emoji'}
                </small>
              </button>
            ))}
          </div>
        )}
        {canPoll && (
          <button
            type="button"
            className="composer-icon"
            onClick={onCreatePoll}
            disabled={disabled}
            title="Create poll"
          >
            <BarChart3 size={19} />
          </button>
        )}
        {scheduleChannelId && (
          <button
            type="button"
            className={`composer-icon ${scheduleOpen ? 'active' : ''}`}
            onClick={() => setScheduleOpen((open) => !open)}
            disabled={disabled}
            title="Send later"
            aria-label="Send later"
            aria-expanded={scheduleOpen}
          >
            <CalendarClock size={19} />
          </button>
        )}
        {canAttach && (
          <>
            <input
              ref={fileRef}
              type="file"
              hidden
              onChange={pickFile}
              accept="image/*,video/*,audio/*,.pdf,.zip,.txt"
            />
            <button
              type="button"
              className="composer-icon"
              onClick={() => fileRef.current?.click()}
              disabled={disabled}
              title="Attach a file, or paste an image"
            >
              <ImagePlus size={19} />
            </button>
          </>
        )}
        {canRecord && (
          <button
            type="button"
            className="composer-icon composer-mic"
            onClick={startRecording}
            disabled={disabled || sending}
            title="Record a voice message"
            aria-label="Record a voice message"
          >
            <Mic size={19} />
          </button>
        )}
        {mentionMatches.length > 0 && (
          <div className="composer-mentions" role="listbox" aria-label="Mention someone">
            <div className="composer-mentions-label">
              Mention someone
              <span>
                <kbd>Tab</kbd> to complete
              </span>
            </div>
            {mentionMatches.map((member, index) => (
              <button
                key={member.id}
                type="button"
                role="option"
                aria-selected={index === Math.min(mentionIndex, mentionMatches.length - 1)}
                className={`composer-mention ${
                  index === Math.min(mentionIndex, mentionMatches.length - 1) ? 'active' : ''
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  applyMention(member);
                }}
              >
                <span className="composer-mention-avatar">
                  {(member.displayName || member.username || '?').slice(0, 1).toUpperCase()}
                </span>
                <span className="composer-mention-name">
                  {member.displayName || member.username}
                </span>
                <span className="composer-mention-handle">@{member.username}</span>
              </button>
            ))}
          </div>
        )}
        {commandMatches.length > 0 && (
          <div className="composer-commands" role="listbox" aria-label="Slash commands">
            {commandMatches.map((command, index) => (
              <button
                key={`${command.applicationId}:${command.name}`}
                type="button"
                role="option"
                aria-selected={Math.min(commandIndex, commandMatches.length - 1) === index}
                className={`composer-command ${
                  Math.min(commandIndex, commandMatches.length - 1) === index ? 'active' : ''
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  insertCommand(command);
                }}
              >
                <Terminal size={14} />
                <span className="composer-command-name">/{command.name}</span>
                <span className="composer-command-desc">{command.description}</span>
                <span className="composer-command-app">{command.applicationName}</span>
              </button>
            ))}
          </div>
        )}
        {(commandSuggestions.length > 0 || suggestionsLoading) && (
          <div className="composer-commands" role="listbox" aria-label="Suggestions">
            {suggestionLabel && (
              <div className="composer-commands-label">{suggestionLabel}</div>
            )}
            {suggestionsLoading && commandSuggestions.length === 0 && (
              <div className="composer-commands-waiting">Asking the app…</div>
            )}
            {commandSuggestions.map((choice, index) => (
              <button
                key={`${choice.value}:${index}`}
                type="button"
                role="option"
                aria-selected={index === Math.min(suggestionIndex, commandSuggestions.length - 1)}
                className={`composer-command ${
                  index === Math.min(suggestionIndex, commandSuggestions.length - 1) ? 'active' : ''
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  applyCommandSuggestion(choice);
                }}
              >
                <span className="composer-command-name">{choice.name}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart ?? event.target.value.length);
            onTyping?.();
          }}
          onSelect={(event) => setCaret(event.target.selectionStart ?? 0)}
          onClick={(event) => setCaret(event.target.selectionStart ?? 0)}
          onKeyDown={onKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          rows={1}
          maxLength={4000}
          disabled={disabled}
        />
        <div className="composer-right">
          <div className="toolbar-pop-wrap" ref={emojiRef}>
            <button
              type="button"
              className="composer-icon"
              onClick={() => setEmojiOpen((value) => !value)}
              title="Emoji"
            >
              <Smile size={19} />
            </button>
            {emojiOpen && (
              <div className="emoji-popover composer-emoji-popover">
                <EmojiPicker
                  emotes={emotes}
                  compact
                  onPickEmoji={(char) => insertSnippet(char, { refocus: false })}
                  onPickEmote={(emote) => insertSnippet(`:${emote.name}: `, { refocus: false })}
                  onPickGif={sendGif}
                />
              </div>
            )}
          </div>
          <button
            type="submit"
            className="composer-send"
            disabled={(!text.trim() && !attachment) || sending || disabled}
            title="Send"
          >
            {sending ? <Loader2 size={17} className="spin" /> : <Send size={17} />}
          </button>
        </div>
      </form>
      )}
      <div className="composer-hint">
        <span>
          <strong>Enter</strong> to send · <strong>Shift+Enter</strong> for a new line
        </span>
        <span>{text.length}/4000</span>
      </div>
    </div>
  );
}
