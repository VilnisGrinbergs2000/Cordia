import api from './api';
import { notificationPermission, requestNotificationPermission } from './notifications';
import { isNativeApp } from './runtime';

export function backgroundPushSupported() {
  return (
    !isNativeApp &&
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export async function registerServiceWorker() {
  if (isNativeApp) return null;
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    registration.update().catch(() => undefined);
    return registration;
  } catch {
    return null;
  }
}

function withTimeout(promise, milliseconds) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('The browser push service did not respond. Try again.')), milliseconds);
    })
  ]);
}

function applicationServerKey(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

export async function readBackgroundPushState() {
  if (!backgroundPushSupported()) {
    return { supported: false, enabled: false, permission: 'unsupported' };
  }
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    return {
      supported: true,
      enabled: !!subscription,
      permission: notificationPermission()
    };
  } catch {
    return { supported: true, enabled: false, permission: notificationPermission() };
  }
}

export async function enableBackgroundPush() {
  if (!backgroundPushSupported()) {
    throw new Error('Background notifications are not supported in this browser.');
  }
  let permission = notificationPermission();
  if (permission !== 'granted') permission = await requestNotificationPermission();
  if (permission !== 'granted') {
    throw new Error('Allow notifications in your browser to enable background alerts.');
  }

  const registration = await registerServiceWorker();
  if (!registration) throw new Error('Could not register the Cordia service worker.');
  const { publicKey } = await api.get('/api/push/public-key');
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await withTimeout(
      registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(publicKey)
      }),
      15000
    );
  }
  await api.post('/api/push/subscribe', subscription.toJSON());
  return subscription;
}

export async function disableBackgroundPush() {
  const registration = await navigator.serviceWorker?.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return false;
  try {
    await api.post('/api/push/unsubscribe', { endpoint: subscription.endpoint });
  } catch {
    // still remove the local subscription
  }
  await subscription.unsubscribe();
  return true;
}

export async function syncPushSubscription() {
  if (!backgroundPushSupported() || notificationPermission() !== 'granted') return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) await api.post('/api/push/subscribe', subscription.toJSON());
  } catch {
    // ignore sync failures; enabling from settings can retry
  }
}
