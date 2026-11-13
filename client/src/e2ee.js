import { useSyncExternalStore } from 'react';
import api from './api';
import { assetUrl } from './runtime';
import {
  addOneTimePrekeys,
  archiveSession,
  cloneSession,
  createE2eeState,
  createReceiverSession,
  createSenderSession,
  hydrateE2eeState,
  prekeyUploadPayload,
  RATCHET_ALG,
  ratchetDecrypt,
  ratchetEncrypt,
  serializeE2eeState,
  x3dhSessionId
} from './ratchet';
import {
  clearDeviceIdentity,
  isDeviceUnlockAvailable,
  loadDeviceIdentity,
  loadRememberedIdentity,
  persistDeviceIdentity
} from './deviceUnlock';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const E2EE_ALG = 'ECDH-P256-HKDF-SHA256-AES-256-GCM';
const PBKDF2_ITERATIONS = 600000;
const ARGON2_MEMORY_KIB = 65536;
const ARGON2_ITERATIONS = 3;
const ARGON2_PARALLELISM = 1;

let argon2idLoader = null;
function loadArgon2id() {
  if (!argon2idLoader) {
    argon2idLoader = import('hash-wasm').then((module) => module.argon2id);
  }
  return argon2idLoader;
}
const BACKUP_AAD_PREFIX = 'cordia-e2ee-backup-v1:';
const MESSAGE_AAD_PREFIX = 'cordia-dm-message-v1:';
const ATTACHMENT_AAD = encoder.encode('cordia-dm-attachment-v1');
const PINS_PREFIX = 'cordia.e2ee.pins.v1:';
const MIN_PREKEYS = 20;
const dmKeyCache = new Map();
const usedMessageIvs = new Map();
// Decrypting is serialised through the crypto lock - a ratchet has to advance in
// order - so leaving a conversation and coming back meant paying for the whole
// history again, one message at a time. The result depends only on the envelope
// and the identity, so it is cached by the ciphertext. Cleared whenever the
// identity is installed or locked: plaintext must not outlive the unlock.
const decryptedCache = new Map();
const DECRYPTED_CACHE_MAX = 2000;
// Attachments are downloaded and decrypted once per mount, which meant a
// conversation with pictures re-fetched every one of them on each visit. The
// plaintext blob is cached by URL and dropped when encryption locks.
const decryptedAttachments = new Map();
const ATTACHMENT_CACHE_BYTES = 64 * 1024 * 1024;
const ATTACHMENT_CACHE_SINGLE = 16 * 1024 * 1024;
let attachmentCacheBytes = 0;
let cryptoQueue = Promise.resolve();

let snapshot = { status: 'locked', identity: null, error: '' };
const listeners = new Set();

function withCryptoLock(task) {
  const run = cryptoQueue.then(task);
  cryptoQueue = run.catch(() => {});
  return run;
}

function emit(next) {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function subscribeE2ee(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getE2eeSnapshot() {
  return snapshot;
}

export function useE2ee() {
  return useSyncExternalStore(subscribeE2ee, getE2eeSnapshot, getE2eeSnapshot);
}

export function isE2eeUnlocked() {
  return snapshot.status === 'ready' && !!snapshot.identity;
}

export function installIdentity(identity) {
  dmKeyCache.clear();
  usedMessageIvs.clear();
  decryptedCache.clear();
  forgetAttachments();
  emit({ status: 'ready', identity, error: '' });
}

/**
 * The identity signing key, used to authenticate things that are not messages -
 * currently the DTLS fingerprint of a call.
 */
export function getSigningKey() {
  const identity = snapshot.identity;
  if (!identity?.signing?.privateKey || !identity?.signing?.publicKey) return null;
  return { privateKey: identity.signing.privateKey, publicKey: identity.signing.publicKey };
}

export function lockE2ee() {
  dmKeyCache.clear();
  usedMessageIvs.clear();
  decryptedCache.clear();
  forgetAttachments();
  emit({ status: 'locked', identity: null, error: '' });
}

function requireIdentity() {
  if (!isE2eeUnlocked()) throw new Error('Unlock encrypted messages first.');
  return snapshot.identity;
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

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function deriveBackupKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

async function exportWrappingKey(wrappingKey) {
  try {
    return bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('raw', wrappingKey)));
  } catch {
    return '';
  }
}

async function deriveArgon2Key(
  password,
  salt,
  { memoryKiB = ARGON2_MEMORY_KIB, iterations = ARGON2_ITERATIONS, parallelism = ARGON2_PARALLELISM } = {}
) {
  const argon2id = await loadArgon2id();
  const raw = await argon2id({
    password,
    salt,
    memorySize: memoryKiB,
    iterations,
    parallelism,
    hashLength: 32,
    outputType: 'binary'
  });
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, [
    'encrypt',
    'decrypt'
  ]);
}

function backupAad(userId) {
  return encoder.encode(`${BACKUP_AAD_PREFIX}${userId}`);
}

async function wrapStateWithKey(stateJson, userId, wrappingKey, params) {
  const iv = randomBytes(12);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: backupAad(userId) },
      wrappingKey,
      encoder.encode(stateJson)
    )
  );
  return JSON.stringify({
    v: 3,
    kdf: 'Argon2id',
    hash: 'SHA-256',
    memoryKiB: params.memoryKiB,
    iterations: params.iterations,
    parallelism: params.parallelism,
    cipher: 'AES-GCM',
    salt: bytesToBase64(params.salt),
    iv: bytesToBase64(iv),
    ct: bytesToBase64(ciphertext)
  });
}

async function wrapStateWithSecret(state, userId, secret) {
  if (!secret) throw new Error('Enter your account password.');
  const params = {
    salt: randomBytes(16),
    memoryKiB: ARGON2_MEMORY_KIB,
    iterations: ARGON2_ITERATIONS,
    parallelism: ARGON2_PARALLELISM
  };
  const wrappingKey = await deriveArgon2Key(secret, params.salt, params);
  const stateJson = JSON.stringify(await serializeE2eeState(state));
  const backup = await wrapStateWithKey(stateJson, userId, wrappingKey, params);
  return { backup, wrappingKey, params };
}

async function saveIdentityBackup(identity) {
  if (identity?.persistBackup === false) return identity?.backup || '';
  if (!identity?.state || !identity.wrappingKey || !identity.backupParams) {
    throw new Error('Encrypted session state is not ready.');
  }
  const stateJson = JSON.stringify(await serializeE2eeState(identity.state));
  const backup = await wrapStateWithKey(
    stateJson,
    identity.userId,
    identity.wrappingKey,
    identity.backupParams
  );
  await api.put('/api/e2ee/backup', { keyBackup: backup });
  identity.backup = backup;
  try {
    await persistDeviceIdentity(identity, stateJson);
  } catch (error) {
    console.warn('[e2ee] could not update remembered device:', error.message);
  }
  return backup;
}

export async function ensurePrekeys(identity) {
  return withCryptoLock(async () => {
    if (!identity?.state) throw new Error('Unlock encrypted messages first.');
    if (identity.persistBackup === false) return identity;
    if (identity.needsBackupUpload) {
      await saveIdentityBackup(identity);
      identity.needsBackupUpload = false;
    }
    const me = await api.get('/api/e2ee/me');
    const count = Number(me.e2ee?.prekeyCount) || 0;
    let changed = false;
    if (!identity.needsPrekeyUpload && count < MIN_PREKEYS) {
      const own = await api.get('/api/e2ee/prekeys');
      const available = new Set((own.prekeys || []).map((prekey) => Number(prekey.id)));
      identity.state.oneTimePrekeys = identity.state.oneTimePrekeys.filter((prekey) =>
        available.has(Number(prekey.id))
      );
      await addOneTimePrekeys(identity.state, 100);
      changed = true;
    }
    if (identity.needsPrekeyUpload || changed) {
      await saveIdentityBackup(identity);
      await api.post('/api/e2ee/prekeys', prekeyUploadPayload(identity.state));
      identity.needsPrekeyUpload = false;
    }
    return identity;
  });
}

export async function activateIdentity(identity) {
  if (identity?.needsBackupUpload) {
    await withCryptoLock(async () => {
      await saveIdentityBackup(identity);
      identity.needsBackupUpload = false;
    });
  }
  installIdentity(identity);
  try {
    await ensurePrekeys(identity);
  } catch (error) {
    console.warn('[e2ee] prekey upload failed:', error.message);
  }
  return identity;
}

export async function isRememberDeviceAvailable() {
  return isDeviceUnlockAvailable();
}

export async function isRememberedDevice(userId) {
  if (!(await isDeviceUnlockAvailable())) return false;
  return !!(await loadDeviceIdentity(userId));
}

export async function rememberDeviceIdentity(identity) {
  if (!identity?.state || !identity.wrappingKeyRaw || !identity.backupParams) return false;
  identity.rememberDevice = true;
  return withCryptoLock(async () => {
    const stateJson = JSON.stringify(await serializeE2eeState(identity.state));
    return persistDeviceIdentity(identity, stateJson);
  });
}

export async function forgetRememberedDevice(userId) {
  const cleared = await clearDeviceIdentity(userId);
  const identity = snapshot.identity;
  if (identity && Number(identity.userId) === Number(userId)) {
    identity.rememberDevice = false;
  }
  return cleared;
}

export async function restoreRememberedDevice(user) {
  if (!user?.e2eeReady || isE2eeUnlocked()) return false;
  if (!(await isDeviceUnlockAvailable())) return false;
  const identity = await loadRememberedIdentity(user);
  if (!identity) return false;
  const me = await api.get('/api/e2ee/me');
  const e2ee = me.e2ee || {};
  if (
    !e2ee.keyBackup ||
    e2ee.keyBackup !== identity.backup ||
    e2ee.publicKey !== identity.publicKey ||
    Number(e2ee.keyVersion) !== Number(identity.keyVersion)
  ) {
    await clearDeviceIdentity(user.id);
    return false;
  }
  await activateIdentity(identity);
  return true;
}

export async function createIdentity(userId, password) {
  if (!password) throw new Error('Enter your account password.');
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const state = await createE2eeState(userId, pair);
  const wrapped = await wrapStateWithSecret(state, userId, password);
  return {
    userId: Number(userId),
    publicKey: state.identity.publicKey,
    keyVersion: 1,
    privateKey: pair.privateKey,
    state,
    backup: wrapped.backup,
    wrappingKey: wrapped.wrappingKey,
    wrappingKeyRaw: await exportWrappingKey(wrapped.wrappingKey),
    backupParams: wrapped.params,
    backupSalt: wrapped.params.salt,
    needsBackupUpload: false,
    needsPrekeyUpload: true
  };
}

export async function createRecoveryBackup(identity, userId, recoveryCode) {
  if (!identity?.state) throw new Error('Unlock encrypted messages first.');
  if (!recoveryCode) throw new Error('Enter a recovery code.');
  const wrapped = await wrapStateWithSecret(identity.state, userId, recoveryCode);
  return wrapped.backup;
}

export async function rewrapIdentityBackup(identity, userId, secret) {
  if (!identity?.state) throw new Error('Unlock encrypted messages first.');
  if (identity.wrappingKey && identity.backupParams) {
    const stateJson = JSON.stringify(await serializeE2eeState(identity.state));
    return wrapStateWithKey(stateJson, userId, identity.wrappingKey, identity.backupParams);
  }
  const wrapped = await wrapStateWithSecret(identity.state, userId, secret);
  identity.wrappingKey = wrapped.wrappingKey;
  identity.wrappingKeyRaw = await exportWrappingKey(wrapped.wrappingKey);
  identity.backupParams = wrapped.params;
  identity.backupSalt = wrapped.params.salt;
  return wrapped.backup;
}

export function backupNeedsUpgrade(backupJson) {
  try {
    const backup = JSON.parse(backupJson);
    return backup.v !== 3 || backup.kdf !== 'Argon2id';
  } catch {
    return true;
  }
}

export function generateRecoveryCode() {
  return bytesToBase64(randomBytes(32))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function normalizeRecoveryCode(code) {
  return String(code || '').replace(/\s+/g, '');
}

export async function hashRecoveryCode(code) {
  return sha256Hex(normalizeRecoveryCode(code));
}

export async function createPasswordBackup(identity, userId, password) {
  if (!identity?.state) throw new Error('Unlock encrypted messages first.');
  if (!password) throw new Error('Enter your account password.');
  const wrapped = await wrapStateWithSecret(identity.state, userId, password);
  return {
    backup: wrapped.backup,
    wrappingKey: wrapped.wrappingKey,
    wrappingKeyRaw: await exportWrappingKey(wrapped.wrappingKey),
    params: wrapped.params
  };
}

export async function unlockIdentity(userId, password, backupJson, publicKey, keyVersion) {
  if (!password) throw new Error('Enter your account password.');
  if (!backupJson || !publicKey) throw new Error('Encryption keys are not available.');
  let backup;
  try {
    backup = JSON.parse(backupJson);
  } catch {
    throw new Error('Encrypted key backup is damaged.');
  }
  const isLegacy =
    (backup?.v === 1 || backup?.v === 2) &&
    backup.cipher === 'AES-GCM' &&
    ((backup.v === 1 && backup.kdf === 'PBKDF2-SHA256') ||
      (backup.v === 2 && backup.kdf === 'Argon2id'));
  const isCurrent =
    backup?.v === 3 &&
    backup.kdf === 'Argon2id' &&
    backup.cipher === 'AES-GCM' &&
    Number.isInteger(backup.memoryKiB) &&
    Number.isInteger(backup.iterations) &&
    Number.isInteger(backup.parallelism);
  if (!backup || (!isLegacy && !isCurrent) || !backup.salt || !backup.iv || !backup.ct) {
    throw new Error('Encrypted key backup is damaged.');
  }
  const salt = base64ToBytes(backup.salt);
  const iv = base64ToBytes(backup.iv);
  const wrappingKey =
    backup.v === 1
      ? await deriveBackupKey(password, salt, backup.iterations)
      : await deriveArgon2Key(password, salt, {
          memoryKiB: backup.memoryKiB,
          iterations: backup.iterations,
          parallelism: backup.parallelism
        });
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: backupAad(userId) },
      wrappingKey,
      base64ToBytes(backup.ct)
    );
  } catch {
    throw new Error('That password or recovery code did not unlock your encrypted messages.');
  }
  if (isCurrent) {
    let serialized;
    try {
      serialized = JSON.parse(decoder.decode(plaintext));
    } catch {
      throw new Error('Encrypted key backup is damaged.');
    }
    const state = await hydrateE2eeState(serialized);
    if (Number(state.userId) !== Number(userId) || state.identity.publicKey !== publicKey) {
      throw new Error('Encrypted key backup does not match this account.');
    }
    return {
      userId: Number(userId),
      publicKey,
      keyVersion: Number(keyVersion) || 1,
      privateKey: state.identity.privateKey,
      state,
      backup: backupJson,
      wrappingKey,
      wrappingKeyRaw: await exportWrappingKey(wrappingKey),
      backupParams: {
        salt,
        memoryKiB: backup.memoryKiB,
        iterations: backup.iterations,
        parallelism: backup.parallelism
      },
      backupSalt: salt,
      needsBackupUpload: false,
      needsPrekeyUpload: false
    };
  }
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    plaintext,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const publicKeyObject = await crypto.subtle.importKey(
    'spki',
    base64ToBytes(publicKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    []
  );
  const state = await createE2eeState(userId, {
    privateKey,
    publicKey: publicKeyObject
  });
  const wrapped = await wrapStateWithSecret(state, userId, password);
  return {
    userId: Number(userId),
    publicKey,
    keyVersion: Number(keyVersion) || 1,
    privateKey,
    state,
    backup: wrapped.backup,
    wrappingKey: wrapped.wrappingKey,
    wrappingKeyRaw: await exportWrappingKey(wrapped.wrappingKey),
    backupParams: wrapped.params,
    backupSalt: wrapped.params.salt,
    needsBackupUpload: true,
    needsPrekeyUpload: true
  };
}
function pinStorageKey(userId) {
  return `${PINS_PREFIX}${Number(userId)}`;
}

function readPins(userId) {
  try {
    const parsed = JSON.parse(localStorage.getItem(pinStorageKey(userId)) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function getE2eePin(userId, peerId) {
  return readPins(userId)[String(Number(peerId))] || null;
}

export function checkE2eePin(userId, peerId, publicKey, keyVersion) {
  const pin = getE2eePin(userId, peerId);
  if (!pin) return { status: 'unverified', pin: null };
  if (pin.publicKey !== publicKey || Number(pin.keyVersion) !== Number(keyVersion)) {
    return { status: 'changed', pin };
  }
  return { status: 'verified', pin };
}

export function setE2eePin(userId, peerId, { publicKey, keyVersion, headHash }) {
  const pins = readPins(userId);
  const pin = {
    publicKey,
    keyVersion: Number(keyVersion),
    headHash: headHash || '',
    verifiedAt: Date.now()
  };
  pins[String(Number(peerId))] = pin;
  try {
    localStorage.setItem(pinStorageKey(userId), JSON.stringify(pins));
  } catch {
    throw new Error('Could not save the verification locally.');
  }
  return pin;
}

async function sha256Hex(value) {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(value))
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function fingerprintPublicKey(publicKey) {
  return sha256Hex(String(publicKey || ''));
}

export function formatFingerprint(hex) {
  const groups = String(hex || '')
    .toUpperCase()
    .match(/.{1,4}/g);
  return groups ? groups.join(' ') : '';
}

export async function safetyNumber(meId, myPublicKey, peerId, peerPublicKey) {
  if (!myPublicKey || !peerPublicKey) return '';
  const mine = `${Number(meId)}:${myPublicKey}`;
  const theirs = `${Number(peerId)}:${peerPublicKey}`;
  const ordered = Number(meId) < Number(peerId) ? [mine, theirs] : [theirs, mine];
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-512', encoder.encode(ordered.join('|')))
  );
  const groups = [];
  for (let index = 0; index < 12; index += 1) {
    const value = (digest[index * 2] << 8) | digest[index * 2 + 1];
    groups.push(String(value % 100000).padStart(5, '0'));
  }
  return groups.join(' ');
}

export async function verifyKeyHistory(userId, events) {
  const list = events || [];
  if (!list.length) return false;
  let previousHash = list[0].previousHash || '';
  for (const event of list) {
    if (event.previousHash !== previousHash) return false;
    const expected = await sha256Hex(
      [
        previousHash,
        Number(userId),
        Number(event.keyVersion),
        event.publicKey,
        event.eventType,
        Number(event.createdAt)
      ].join('|')
    );
    if (expected !== event.eventHash) return false;
    previousHash = event.eventHash;
  }
  return true;
}

function messageAad({ dmId, senderId, senderKeyVersion, recipientKeyVersion }) {
  return encoder.encode(
    `${MESSAGE_AAD_PREFIX}${dmId}:${senderId}:${senderKeyVersion}:${recipientKeyVersion}`
  );
}

async function deriveDmKey(identity, peerPublicKey, dmId, senderKeyVersion, recipientKeyVersion) {
  if (!peerPublicKey) throw new Error('This contact has not set up encrypted messages.');
  const cacheKey = [
    dmId,
    identity.publicKey,
    peerPublicKey,
    senderKeyVersion,
    recipientKeyVersion
  ].join(':');
  const cached = dmKeyCache.get(cacheKey);
  if (cached) return cached;

  const peerKey = await crypto.subtle.importKey(
    'spki',
    base64ToBytes(peerPublicKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerKey },
    identity.privateKey,
    256
  );
  const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(`cordia-dm-v1:${dmId}`),
      info: encoder.encode('cordia-dm-message-v1')
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  dmKeyCache.set(cacheKey, key);
  return key;
}

function sessionKey(session) {
  return `${session?.sessionId || ''}|${session?.initialDh || session?.dhRemote || ''}`;
}

function sessionList(state, peerId) {
  const active = state.sessions?.[String(peerId)] || null;
  const history = state.previousSessions?.[String(peerId)] || [];
  const seen = new Set();
  const list = [];
  for (const session of [active, ...history]) {
    if (!session) continue;
    const key = sessionKey(session);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(session);
  }
  return list;
}

function sessionNeedsReset(session) {
  if (!session) return false;
  if (session.suspect) return true;
  return Number(session.nRecv) > 0 && Object.keys(session.receivedKeys || {}).length === 0;
}

function marksSessionSuspect(error) {
  if (!error?.message || error.name === 'OperationError') return true;
  return !/already read|key changed|no longer available|missing its session setup/i.test(error.message);
}

function promoteSession(state, peerId, session) {
  const key = String(peerId);
  const active = state.sessions?.[key];
  if (active === session) return;
  if (active) archiveSession(state, peerId, active);
  if (!state.previousSessions) state.previousSessions = {};
  const list = state.previousSessions[key] || [];
  const id = sessionKey(session);
  state.previousSessions[key] = list.filter((entry) => sessionKey(entry) !== id);
  state.sessions[key] = session;
}

export async function encryptDmMessage({
  text,
  attachment,
  dmId,
  senderId,
  senderKeyVersion,
  recipientId,
  recipientPublicKey,
  recipientKeyVersion
}) {
  return withCryptoLock(async () => {
    const identity = requireIdentity();
    const state = identity.state;
    const peerId = Number(recipientId);
    if (!state || !peerId) throw new Error('Could not identify the encrypted conversation.');
    let session = state.sessions[String(peerId)];
    if (
      session &&
      ((recipientPublicKey && session.peerIdentityKey !== recipientPublicKey) ||
        (recipientKeyVersion &&
          Number(session.peerIdentityKeyVersion) !== Number(recipientKeyVersion)))
    ) {
      archiveSession(state, peerId, session);
      delete state.sessions[String(peerId)];
      session = null;
    }
    if (sessionNeedsReset(session)) {
      archiveSession(state, peerId, session);
      delete state.sessions[String(peerId)];
      session = null;
    }
    if (!session) {
      const data = await api.get(`/api/e2ee/users/${peerId}/bundle`);
      const bundle = data.bundle || data;
      if (recipientPublicKey && bundle.identityPublicKey !== recipientPublicKey) {
        throw new Error('Encryption key changed. Verify the safety number before sending.');
      }
      if (
        recipientKeyVersion &&
        Number(bundle.identityKeyVersion) !== Number(recipientKeyVersion)
      ) {
        throw new Error('Encryption key changed. Verify the safety number before sending.');
      }
      session = await createSenderSession(state, bundle, Number(dmId), peerId);
    }
    const envelope = await ratchetEncrypt(
      state,
      session,
      { text: text || '', attachment: attachment || null },
      {
        dmId: Number(dmId),
        senderId: Number(senderId),
        recipientId: peerId,
        senderKeyVersion: Number(senderKeyVersion) || Number(identity.keyVersion) || 1,
        recipientKeyVersion: Number(session.peerIdentityKeyVersion)
      }
    );
    await saveIdentityBackup(identity);
    return envelope;
  });
}

async function decryptLegacyDmMessage(identity, envelope, peerPublicKey) {
  const key = await deriveDmKey(
    identity,
    peerPublicKey,
    Number(envelope.dmId),
    Number(envelope.senderKeyVersion),
    Number(envelope.recipientKeyVersion)
  );
  const iv = base64ToBytes(envelope.iv);
  if (iv.length !== 12) throw new Error('Unsupported encrypted message.');
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: messageAad({
        dmId: Number(envelope.dmId),
        senderId: Number(envelope.senderId),
        senderKeyVersion: Number(envelope.senderKeyVersion),
        recipientKeyVersion: Number(envelope.recipientKeyVersion)
      })
    },
    key,
    base64ToBytes(envelope.ct)
  );
  const parsed = JSON.parse(decoder.decode(plaintext));
  return {
    text: typeof parsed.text === 'string' ? parsed.text : '',
    attachment: parsed.attachment || null
  };
}

// Identity, conversation and ciphertext: three things that cannot collide
// without a duplicate message, and short enough to keep thousands of them.
function decryptedKey(envelope, peerId) {
  const ct = typeof envelope?.ct === 'string' ? envelope.ct : '';
  if (!ct) return '';
  return [peerId || 0, envelope.dmId || 0, envelope.senderId || 0, ct.length, ct.slice(0, 32), ct.slice(-16)].join('|');
}

/**
 * The cache entry for an envelope, or null. Used to paint a conversation that is
 * being reopened without a round of "Decrypting…" placeholders first.
 */
export function cachedDecryptedMessage(envelope, peerId) {
  const key = decryptedKey(envelope, peerId);
  return key ? decryptedCache.get(key) || null : null;
}

function rememberDecrypted(key, payload) {
  if (!key) return;
  if (decryptedCache.size >= DECRYPTED_CACHE_MAX) {
    const oldest = decryptedCache.keys().next().value;
    if (oldest !== undefined) decryptedCache.delete(oldest);
  }
  decryptedCache.set(key, payload);
}

export async function decryptDmMessage(envelope, { peerPublicKey, peerId } = {}) {
  const cacheKey = decryptedKey(envelope, peerId);
  if (cacheKey) {
    const cached = decryptedCache.get(cacheKey);
    if (cached) return cached;
  }
  const payload = await withCryptoLock(async () => {
    const identity = requireIdentity();
    if (!envelope) throw new Error('Unsupported encrypted message.');
    if (envelope.v === 1 && envelope.alg === E2EE_ALG) {
      return decryptLegacyDmMessage(identity, envelope, peerPublicKey);
    }
    if (envelope.v !== 2 || envelope.alg !== RATCHET_ALG) {
      throw new Error('Unsupported encrypted message.');
    }
    const senderId = Number(envelope.senderId);
    const recipientId = Number(envelope.recipientId);
    const own = senderId === Number(identity.userId);
    if (!own && recipientId !== Number(identity.userId)) {
      throw new Error('This encrypted message is not addressed to this account.');
    }
    const peer = Number(peerId || (own ? 0 : senderId));
    if (!peer) throw new Error('Could not identify the encrypted conversation.');
    const state = identity.state;
    const key = String(peer);
    let candidates = sessionList(state, peer);
    if (!own && envelope.x3dh) {
      const sessionId = x3dhSessionId(envelope.x3dh);
      const matching = candidates.filter((session) => session.sessionId === sessionId);
      if (matching.length) {
        candidates = matching;
      } else {
        const created = await createReceiverSession(
          state,
          envelope,
          Number(envelope.dmId),
          peer,
          peerPublicKey
        );
        candidates = [created];
      }
    }
    if (!candidates.length) {
      if (own) throw new Error('This sent message is no longer available on this device.');
      throw new Error('This message is missing its session setup data.');
    }
    let lastError = null;
    for (const candidate of candidates) {
      if (!own && peerPublicKey && candidate.peerIdentityKey !== peerPublicKey) {
        lastError = new Error('Encryption key changed. Verify the safety number before reading.');
        continue;
      }
      if (!own && envelope.x3dh && candidate.peerIdentityKey !== envelope.x3dh.identityKey) {
        lastError = new Error('Encryption key changed. Verify the safety number before reading.');
        continue;
      }
      const session = cloneSession(candidate);
      try {
        const payload = await ratchetDecrypt(state, session, envelope, {
          dmId: Number(envelope.dmId),
          senderId,
          recipientId
        });
        session.suspect = false;
        if (state.sessions[key] === candidate) {
          state.sessions[key] = session;
        } else if (own) {
          const history = state.previousSessions?.[key] || [];
          state.previousSessions[key] = history.map((entry) =>
            entry === candidate ? session : entry
          );
        } else {
          promoteSession(state, peer, session);
        }
        await saveIdentityBackup(identity);
        return {
          text: typeof payload.text === 'string' ? payload.text : '',
          attachment: payload.attachment || null
        };
      } catch (error) {
        lastError = error;
        if (
          !own &&
          state.sessions[key] === candidate &&
          !candidate.suspect &&
          marksSessionSuspect(error)
        ) {
          candidate.suspect = true;
          await saveIdentityBackup(identity);
        }
      }
    }
    if (!lastError?.message || lastError.name === 'OperationError') {
      throw new Error('The secure session is out of sync. Send a new message to refresh it.');
    }
    throw lastError;
  });
  rememberDecrypted(cacheKey, payload);
  return payload;
}
export async function encryptAttachment(file) {
  const raw = new Uint8Array(await file.arrayBuffer());
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
  const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  const iv = randomBytes(12);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: ATTACHMENT_AAD },
      key,
      raw
    )
  );
  return {
    blob: new Blob([ciphertext], { type: 'application/octet-stream' }),
    name: file.name || 'attachment',
    type: file.type || 'application/octet-stream',
    key: bytesToBase64(rawKey),
    iv: bytesToBase64(iv)
  };
}

function forgetAttachments() {
  decryptedAttachments.clear();
  attachmentCacheBytes = 0;
}

function rememberAttachment(key, blob) {
  const size = blob.size || 0;
  // One 40 MB video would otherwise evict everything worth keeping.
  if (size > ATTACHMENT_CACHE_SINGLE) return;
  while (attachmentCacheBytes + size > ATTACHMENT_CACHE_BYTES && decryptedAttachments.size) {
    const [oldKey, oldBlob] = decryptedAttachments.entries().next().value;
    decryptedAttachments.delete(oldKey);
    attachmentCacheBytes -= oldBlob.size || 0;
  }
  decryptedAttachments.set(key, blob);
  attachmentCacheBytes += size;
}

export async function decryptAttachment(url, meta) {
  const cacheKey = `${url}|${(meta && meta.iv) || ''}`;
  const cached = decryptedAttachments.get(cacheKey);
  if (cached) return cached;
  const response = await fetch(assetUrl(url));
  if (!response.ok) throw new Error('Could not download encrypted attachment.');
  const ciphertext = new Uint8Array(await response.arrayBuffer());
  const key = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(meta.key),
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(meta.iv), additionalData: ATTACHMENT_AAD },
    key,
    ciphertext
  );
  const blob = new Blob([plaintext], { type: meta.type || 'application/octet-stream' });
  rememberAttachment(cacheKey, blob);
  return blob;
}







