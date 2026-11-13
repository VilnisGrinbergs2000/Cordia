import { useRef, useState } from 'react';

export const SCREEN_QUALITIES = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 }
};

export const SCREEN_FPS_OPTIONS = [15, 30, 60];

const QUALITY_KEY = 'cordia:screen-quality';
const FPS_KEY = 'cordia:screen-fps';

function readPreference(key, fallback) {
  try {
    return window.localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function writePreference(key, value) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // storage can be unavailable
  }
}

function hasDesktopPicker() {
  return Boolean(window.cordiaDesktop?.listDisplaySources && window.cordiaDesktop?.selectDisplaySource);
}

/**
 * Source selection for screen sharing: the desktop picker when the Electron
 * preload is present, the browser's own picker otherwise. Owns nothing but the
 * choice - capturing and publishing the track is the caller's job.
 */
export function useScreenPicker() {
  const [open, setOpen] = useState(false);
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [quality, setQualityState] = useState(() => {
    const stored = readPreference(QUALITY_KEY, '720p');
    return SCREEN_QUALITIES[stored] ? stored : '720p';
  });
  const [fps, setFpsState] = useState(() => {
    const stored = Number(readPreference(FPS_KEY, '30'));
    return SCREEN_FPS_OPTIONS.includes(stored) ? stored : 30;
  });

  const openRef = useRef(false);
  const resolverRef = useRef(null);
  const qualityRef = useRef(quality);
  const fpsRef = useRef(fps);
  const desktop = hasDesktopPicker();

  function reset() {
    openRef.current = false;
    setOpen(false);
    setLoading(false);
    setSources([]);
    setError('');
  }

  function cancel() {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    reset();
    window.cordiaDesktop?.clearDisplaySource?.().catch(() => {});
    resolve?.(null);
  }

  async function request() {
    if (openRef.current) return null;

    openRef.current = true;
    setOpen(true);
    setSources([]);
    setError('');
    setLoading(desktop);

    const choice = new Promise((resolve) => {
      resolverRef.current = resolve;
    });

    if (!desktop) return choice;

    try {
      const list = await window.cordiaDesktop.listDisplaySources();
      if (!resolverRef.current) return null;
      const items = Array.isArray(list) ? list : [];
      setSources(items);
      if (!items.length) setError('No screens or windows were found.');
    } catch {
      if (resolverRef.current) setError('Could not list screens and windows.');
    } finally {
      if (resolverRef.current) setLoading(false);
    }

    return choice;
  }

  async function choose(sourceId) {
    const resolve = resolverRef.current;
    if (!resolve) return;
    if (!sourceId) {
      cancel();
      return;
    }

    resolverRef.current = null;
    reset();

    if (sourceId === 'native' || !desktop) {
      resolve('native');
      return;
    }

    try {
      const selected = await window.cordiaDesktop.selectDisplaySource(sourceId);
      if (!selected) window.cordiaDesktop?.clearDisplaySource?.().catch(() => {});
      resolve(selected ? sourceId : null);
    } catch {
      resolve(null);
    }
  }

  function setQuality(value) {
    if (!SCREEN_QUALITIES[value] || value === qualityRef.current) return;
    qualityRef.current = value;
    setQualityState(value);
    writePreference(QUALITY_KEY, value);
  }

  function setFps(value) {
    const next = Number(value);
    if (!SCREEN_FPS_OPTIONS.includes(next) || next === fpsRef.current) return;
    fpsRef.current = next;
    setFpsState(next);
    writePreference(FPS_KEY, next);
  }

  function preset() {
    return SCREEN_QUALITIES[qualityRef.current] || SCREEN_QUALITIES['720p'];
  }

  function constraints() {
    const size = preset();
    return {
      video: {
        width: { ideal: size.width, max: size.width },
        height: { ideal: size.height, max: size.height },
        frameRate: { ideal: fpsRef.current, max: fpsRef.current }
      },
      audio: false
    };
  }

  function maxBitrate() {
    const size = preset();
    const pixelRate = size.width * size.height * fpsRef.current;
    // Matches the voice path: 1080p60 lands near 11 Mbps, and the cap is high
    // enough that the encoder - not this number - decides the quality.
    return Math.min(12_000_000, Math.max(900_000, Math.round(pixelRate * 0.09)));
  }

  return {
    open,
    sources,
    loading,
    error,
    desktop,
    quality,
    fps,
    setQuality,
    setFps,
    request,
    choose,
    cancel,
    constraints,
    maxBitrate,
    fpsRef
  };
}
