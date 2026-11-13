const desktopApiBase =
  typeof window !== 'undefined' ? String(window.cordiaDesktop?.apiUrl || '').trim() : '';
const rawApiBase = String(desktopApiBase || import.meta.env.VITE_API_URL || '').trim();
const rawSocketUrl = String(import.meta.env.VITE_SOCKET_URL || '').trim();

export const API_BASE = rawApiBase.replace(/\/+$/, '');
export const SOCKET_URL = (rawSocketUrl || API_BASE).replace(/\/+$/, '');
export const isElectron =
  typeof window !== 'undefined' && !!window.cordiaDesktop?.isDesktop;
export const isCapacitor =
  typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.();
export const isNativeApp = isElectron || isCapacitor;

const NATIVE_TOKEN_KEY = 'cordia:native-token';

export function getNativeToken() {
  if (!isNativeApp) return '';
  try {
    return localStorage.getItem(NATIVE_TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setNativeToken(token) {
  if (!isNativeApp || !token) return;
  try {
    localStorage.setItem(NATIVE_TOKEN_KEY, token);
  } catch {
    // storage may be unavailable
  }
}

export function clearNativeToken() {
  try {
    localStorage.removeItem(NATIVE_TOKEN_KEY);
  } catch {
    // ignore
  }
}

export function apiUrl(path) {
  if (/^https?:\/\//.test(path)) return path;
  return `${API_BASE}${path}`;
}

// /uploads is authenticated now. <img>, <video> and <audio> cannot send an
// Authorization header, so the server hands out a scoped upload token that is
// appended here. It unlocks uploads only; it is not a session.
let uploadToken = '';

export function setUploadToken(token) {
  uploadToken = typeof token === 'string' ? token : '';
}

export function assetUrl(value) {
  if (!value) return value;
  if (/^(https?:|data:|blob:)/.test(value)) return value;
  const url = API_BASE ? `${API_BASE}${value.startsWith('/') ? '' : '/'}${value}` : value;
  if (!value.startsWith('/uploads/')) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}t=${encodeURIComponent(uploadToken)}`;
}
