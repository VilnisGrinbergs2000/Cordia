import { isCapacitor } from './runtime';

let notificationId = Math.floor(Date.now() % 1000000000);

async function localNotifications() {
  return import('@capacitor/local-notifications');
}

function permissionState(value) {
  if (value === 'granted') return 'granted';
  if (value === 'denied') return 'denied';
  return 'default';
}

export async function nativeNotificationPermission() {
  if (!isCapacitor) return 'unsupported';
  try {
    const { LocalNotifications } = await localNotifications();
    const status = await LocalNotifications.checkPermissions();
    return permissionState(status.display);
  } catch {
    return 'unsupported';
  }
}

export async function requestNativeNotificationPermission() {
  if (!isCapacitor) return 'unsupported';
  try {
    const { LocalNotifications } = await localNotifications();
    const status = await LocalNotifications.requestPermissions();
    return permissionState(status.display);
  } catch {
    return 'unsupported';
  }
}

export async function sendNativeNotification({ title, body, tag }) {
  if (!isCapacitor) return false;
  try {
    const { LocalNotifications } = await localNotifications();
    const status = await LocalNotifications.checkPermissions();
    if (status.display !== 'granted') return false;
    notificationId = (notificationId % 2147483646) + 1;
    await LocalNotifications.schedule({
      notifications: [
        {
          id: notificationId,
          title,
          body,
          silent: true,
          extra: tag ? { tag } : undefined
        }
      ]
    });
    return true;
  } catch {
    return false;
  }
}

function inviteCodeFromUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol === 'cordia:' && url.host === 'invite') {
      return decodeURIComponent(url.pathname.replace(/^\/+/, '').split('/')[0] || '');
    }
    const match = url.pathname.match(/\/invite\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  } catch {
    return '';
  }
}

function openInviteLink(code) {
  if (!code) return;
  try {
    const params = new URLSearchParams(window.location.search);
    if (window.location.pathname === '/' && params.get('invite') === code) return;
    const handled = JSON.parse(sessionStorage.getItem('cordia:invite-handled') || 'null');
    if (handled?.code === code && Date.now() - handled.at < 5000) return;
    sessionStorage.setItem('cordia:invite-handled', JSON.stringify({ code, at: Date.now() }));
  } catch {
    // continue with the redirect
  }
  window.location.assign(`/?invite=${encodeURIComponent(code)}&auto=1`);
}

export async function listenForInviteLinks() {
  if (!isCapacitor) return;
  try {
    const { App } = await import('@capacitor/app');
    const handle = ({ url }) => openInviteLink(inviteCodeFromUrl(url));
    App.addListener('appUrlOpen', handle);
    const launch = await App.getLaunchUrl();
    if (launch?.url) {
      let handled = '';
      try {
        handled = sessionStorage.getItem('cordia:launch-url-handled') || '';
      } catch {
        handled = '';
      }
      if (handled !== launch.url) {
        try {
          sessionStorage.setItem('cordia:launch-url-handled', launch.url);
        } catch {
          // continue with the redirect
        }
        handle(launch);
      }
    }
  } catch {
    return;
  }
}
