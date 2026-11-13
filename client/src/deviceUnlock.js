import { hydrateE2eeState, serializeE2eeState } from './ratchet';

const DEVICE_PAYLOAD_VERSION = 1;

function desktopBridge() {
  if (typeof window === 'undefined') return null;
  const desktop = window.cordiaDesktop;
  return desktop?.isDesktop ? desktop : null;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(String(value || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeBackupParams(params) {
  if (!params?.salt) return null;
  return {
    ...params,
    salt: bytesToBase64(params.salt)
  };
}

function decodeBackupParams(params) {
  if (!params?.salt) return null;
  return {
    ...params,
    salt: base64ToBytes(params.salt)
  };
}

async function importWrappingKey(rawKey) {
  return crypto.subtle.importKey(
    'raw',
    base64ToBytes(rawKey),
    { name: 'AES-GCM' },
    true,
    ['encrypt', 'decrypt']
  );
}

export async function isDeviceUnlockAvailable() {
  const desktop = desktopBridge();
  if (typeof desktop?.isE2eeDeviceStorageAvailable !== 'function') return false;
  try {
    return !!(await desktop.isE2eeDeviceStorageAvailable());
  } catch {
    return false;
  }
}

export async function loadDeviceIdentity(userId) {
  const desktop = desktopBridge();
  if (typeof desktop?.loadE2eeDeviceIdentity !== 'function') return '';
  try {
    const payload = await desktop.loadE2eeDeviceIdentity(Number(userId));
    return typeof payload === 'string' ? payload : '';
  } catch {
    return '';
  }
}

export async function saveDeviceIdentity(userId, payload) {
  const desktop = desktopBridge();
  if (typeof desktop?.saveE2eeDeviceIdentity !== 'function') return false;
  try {
    return !!(await desktop.saveE2eeDeviceIdentity(Number(userId), String(payload || '')));
  } catch {
    return false;
  }
}

export async function clearDeviceIdentity(userId) {
  const desktop = desktopBridge();
  if (typeof desktop?.clearE2eeDeviceIdentity !== 'function') return false;
  try {
    return !!(await desktop.clearE2eeDeviceIdentity(Number(userId)));
  } catch {
    return false;
  }
}

export async function persistDeviceIdentity(identity, stateJson) {
  if (!identity?.rememberDevice || identity.persistBackup === false) return false;
  if (!identity?.state || !identity.wrappingKeyRaw || !identity.backupParams) return false;
  const serializedState = stateJson || JSON.stringify(await serializeE2eeState(identity.state));
  const payload = JSON.stringify({
    v: DEVICE_PAYLOAD_VERSION,
    userId: Number(identity.userId),
    publicKey: identity.publicKey,
    keyVersion: Number(identity.keyVersion) || 1,
    backup: identity.backup || '',
    wrappingKey: identity.wrappingKeyRaw,
    backupParams: encodeBackupParams(identity.backupParams),
    backupSalt: identity.backupSalt ? bytesToBase64(identity.backupSalt) : '',
    persistBackup: identity.persistBackup !== false,
    state: JSON.parse(serializedState)
  });
  return saveDeviceIdentity(identity.userId, payload);
}

export async function loadRememberedIdentity(user) {
  const userId = Number(user?.id);
  if (!userId || !user?.e2eePublicKey) return null;
  const payload = await loadDeviceIdentity(userId);
  if (!payload) return null;

  try {
    const data = JSON.parse(payload);
    if (
      data?.v !== DEVICE_PAYLOAD_VERSION ||
      Number(data.userId) !== userId ||
      data.publicKey !== user.e2eePublicKey ||
      Number(data.keyVersion) !== Number(user.e2eeKeyVersion) ||
      !data.state ||
      !data.wrappingKey ||
      !data.backupParams?.salt
    ) {
      return null;
    }

    const state = await hydrateE2eeState(data.state);
    if (Number(state.userId) !== userId || state.identity.publicKey !== data.publicKey) {
      return null;
    }

    const backupParams = decodeBackupParams(data.backupParams);
    const backupSalt = data.backupSalt ? base64ToBytes(data.backupSalt) : backupParams.salt;
    const wrappingKey = await importWrappingKey(data.wrappingKey);

    return {
      userId,
      publicKey: data.publicKey,
      keyVersion: Number(data.keyVersion) || 1,
      privateKey: state.identity.privateKey,
      state,
      backup: data.backup || '',
      wrappingKey,
      wrappingKeyRaw: data.wrappingKey,
      backupParams,
      backupSalt,
      needsBackupUpload: false,
      needsPrekeyUpload: false,
      persistBackup: data.persistBackup !== false,
      rememberDevice: true
    };
  } catch {
    await clearDeviceIdentity(userId);
    return null;
  }
}
