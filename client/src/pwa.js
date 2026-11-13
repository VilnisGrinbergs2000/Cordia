import { useEffect, useState } from 'react';
import { isNativeApp } from './runtime';

const DISMISS_KEY = 'cordia:pwa-install-dismissed';
const DISMISS_MS = 14 * 24 * 60 * 60 * 1000;
const promptSubscribers = new Set();
let deferredPrompt = null;

if (typeof window !== 'undefined' && !isNativeApp) {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    promptSubscribers.forEach((subscriber) => subscriber(event));
  });
}

export function isStandalone() {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

export function isIosDevice() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function readDismissed() {
  try {
    const timestamp = Number(window.localStorage.getItem(DISMISS_KEY));
    return Number.isFinite(timestamp) && timestamp > 0 && Date.now() - timestamp < DISMISS_MS;
  } catch {
    return false;
  }
}

export function usePwaInstall() {
  const [promptEvent, setPromptEvent] = useState(deferredPrompt);
  const [installed, setInstalled] = useState(isStandalone);
  const [dismissed, setDismissed] = useState(readDismissed);

  useEffect(() => {
    if (isNativeApp) return undefined;
    function onBeforeInstall(event) {
      setPromptEvent(event);
    }
    function onInstalled() {
      setInstalled(true);
      setPromptEvent(null);
    }
    promptSubscribers.add(onBeforeInstall);
    if (deferredPrompt) setPromptEvent(deferredPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      promptSubscribers.delete(onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  function dismiss() {
    try {
      window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // storage can be unavailable in private browsing
    }
    deferredPrompt = null;
    setDismissed(true);
  }

  async function install() {
    if (!promptEvent) return 'unavailable';
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    deferredPrompt = null;
    setPromptEvent(null);
    if (choice.outcome === 'accepted') setInstalled(true);
    else dismiss();
    return choice.outcome;
  }

  const ios = isIosDevice() && !installed;
  return {
    visible: !isNativeApp && !installed && !dismissed && (!!promptEvent || ios),
    ios,
    install,
    dismiss
  };
}

export function useOnlineStatus() {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  );

  useEffect(() => {
    function update() {
      setOnline(navigator.onLine);
    }
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  return online;
}
