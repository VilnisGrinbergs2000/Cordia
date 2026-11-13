import {
  nativeNotificationPermission,
  requestNativeNotificationPermission,
  sendNativeNotification
} from './native';
import { isCapacitor } from './runtime';

const STORAGE_KEY = 'cordia:notification-prefs';

export const DEFAULT_NOTIFICATION_PREFS = Object.freeze({
  desktop: true,
  sounds: true
});

export function readNotificationPrefs() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...DEFAULT_NOTIFICATION_PREFS, ...stored };
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFS };
  }
}

export function writeNotificationPrefs(prefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // storage may be unavailable in private contexts
  }
}

export function notificationPermission() {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return window.Notification.permission;
}

export async function requestNotificationPermission() {
  if (isCapacitor) return requestNativeNotificationPermission();
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  try {
    return await window.Notification.requestPermission();
  } catch {
    return window.Notification.permission;
  }
}

export async function notificationPermissionAsync() {
  if (isCapacitor) return nativeNotificationPermission();
  return notificationPermission();
}

export function showDesktopNotification({
  title,
  body,
  tag,
  onClick,
  requireInteraction = false
}) {
  if (isCapacitor) {
    sendNativeNotification({ title, body, tag });
    return null;
  }
  if (typeof window === 'undefined' || !('Notification' in window)) return null;
  if (window.Notification.permission !== 'granted') return null;
  try {
    const notification = new window.Notification(title, {
      body,
      tag,
      icon: '/favicon.svg',
      silent: true,
      requireInteraction
    });
    notification.onclick = () => {
      window.cordiaDesktop?.showWindow?.();
      window.focus();
      onClick?.();
      notification.close();
    };
    return notification;
  } catch {
    return null;
  }
}

let audioContext = null;
let ringtoneTimer = null;

function getAudioContext() {
  if (typeof window === 'undefined') return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try {
    if (!audioContext) audioContext = new Ctx();
    if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
    return audioContext;
  } catch {
    return null;
  }
}

function playTone(context, frequency, start, duration, volume) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.linearRampToValueAtTime(volume, start + 0.018);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.03);
}

export function playMessageSound() {
  const context = getAudioContext();
  if (!context) return;
  const now = context.currentTime + 0.01;
  playTone(context, 880, now, 0.09, 0.035);
  playTone(context, 1174.66, now + 0.1, 0.12, 0.028);
}

function playRingBurst() {
  const context = getAudioContext();
  if (!context) return;
  const now = context.currentTime + 0.01;
  playTone(context, 740, now, 0.18, 0.045);
  playTone(context, 987.77, now + 0.2, 0.18, 0.04);
  playTone(context, 740, now + 0.52, 0.18, 0.045);
  playTone(context, 987.77, now + 0.72, 0.2, 0.04);
}

export function startCallRingtone() {
  if (ringtoneTimer) return;
  playRingBurst();
  ringtoneTimer = setInterval(playRingBurst, 2900);
}

export function stopCallRingtone() {
  if (ringtoneTimer) {
    clearInterval(ringtoneTimer);
    ringtoneTimer = null;
  }
}
