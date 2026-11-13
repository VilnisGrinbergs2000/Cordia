const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const RATCHET_ALG = 'X3DH-DOUBLE-RATCHET-P256-AES-256-GCM';
export const SIGNED_PREKEY_PREFIX = 'cordia-signed-prekey-v1';
const X3DH_INFO_PREFIX = 'cordia-x3dh-v1|';
const ROOT_INFO = encoder.encode('cordia-ratchet-root-v1');
const MESSAGE_AAD_PREFIX = 'cordia-dm-message-v2';
const MAX_SKIP = 1000;
const MAX_STORED_KEYS = 500;
const PREKEY_BATCH = 100;

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

function randomId() {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
  return value || 1;
}

function uniqueId(used) {
  let id = randomId();
  while (used.has(id)) id = randomId();
  used.add(id);
  return id;
}

function concatBytes(...parts) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

async function hmacSha256(keyBytes, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

async function hkdfBytes(ikm, salt, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info },
      key,
      length * 8
    )
  );
}

async function kdfRoot(rootKey, dhOutput) {
  const material = await hkdfBytes(
    dhOutput,
    base64ToBytes(rootKey),
    ROOT_INFO,
    64
  );
  return {
    rootKey: bytesToBase64(material.subarray(0, 32)),
    chainKey: bytesToBase64(material.subarray(32, 64))
  };
}

async function kdfChain(chainKey) {
  const raw = base64ToBytes(chainKey);
  const messageKey = await hmacSha256(raw, new Uint8Array([1]));
  const nextChainKey = await hmacSha256(raw, new Uint8Array([2]));
  return {
    messageKey: bytesToBase64(messageKey),
    chainKey: bytesToBase64(nextChainKey)
  };
}

async function importEcdhPublic(publicKey) {
  return crypto.subtle.importKey(
    'spki',
    base64ToBytes(publicKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
}

async function importEcdhPrivate(privateKey) {
  return crypto.subtle.importKey(
    'pkcs8',
    base64ToBytes(privateKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
}

async function importSigningPublic(publicKey) {
  return crypto.subtle.importKey(
    'spki',
    base64ToBytes(publicKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
}

async function importSigningPrivate(privateKey) {
  return crypto.subtle.importKey(
    'pkcs8',
    base64ToBytes(privateKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign']
  );
}

async function generateEcdhPair() {
  return crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
}

async function generateSigningPair() {
  return crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
}

async function exportPublicKey(key) {
  return bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('spki', key)));
}

async function exportPrivateKey(key) {
  return bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', key)));
}

async function dh(privateKey, publicKey) {
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: await importEcdhPublic(publicKey) },
      privateKey,
      256
    )
  );
}

export function signedPrekeyMessage(userId, prekeyId, publicKey) {
  return `${SIGNED_PREKEY_PREFIX}|${Number(userId)}|${Number(prekeyId)}|${publicKey}`;
}

export async function signSignedPrekey(signingPrivateKey, userId, prekeyId, publicKey) {
  return bytesToBase64(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        signingPrivateKey,
        encoder.encode(signedPrekeyMessage(userId, prekeyId, publicKey))
      )
    )
  );
}

async function verifySignedPrekey(signingPublicKey, userId, prekeyId, publicKey, signature) {
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    await importSigningPublic(signingPublicKey),
    base64ToBytes(signature),
    encoder.encode(signedPrekeyMessage(userId, prekeyId, publicKey))
  );
}

const CALL_BINDING_PREFIX = 'cordia-call-dtls-v1';

export function callBindingMessage({ callId, userId, fingerprint }) {
  return `${CALL_BINDING_PREFIX}|${Number(callId)}|${Number(userId)}|${String(fingerprint || '')}`;
}

/**
 * Signs the DTLS fingerprint of a peer connection with the identity signing
 * key, so the peer can tell our fingerprint apart from one the server made up.
 */
export async function signCallBinding(signingPrivateKey, payload) {
  if (!signingPrivateKey) return '';
  try {
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      signingPrivateKey,
      encoder.encode(callBindingMessage(payload))
    );
    return bytesToBase64(new Uint8Array(signature));
  } catch {
    return '';
  }
}

export async function verifyCallBinding(signingPublicKey, payload, signature) {
  if (!signingPublicKey || !signature) return false;
  try {
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      await importSigningPublic(signingPublicKey),
      base64ToBytes(signature),
      encoder.encode(callBindingMessage(payload))
    );
  } catch {
    return false;
  }
}

async function makeSignedPrekey(state) {
  const pair = await generateEcdhPair();
  const publicKey = await exportPublicKey(pair.publicKey);
  const id = uniqueId(new Set(state.oneTimePrekeys.map((prekey) => prekey.id)));
  const signature = await signSignedPrekey(state.signing.privateKey, state.userId, id, publicKey);
  return {
    id,
    publicKey,
    privateKey: pair.privateKey,
    signature,
    createdAt: Date.now()
  };
}

export async function createE2eeState(userId, identityPair) {
  const signing = await generateSigningPair();
  const state = {
    version: 3,
    userId: Number(userId),
    identity: {
      publicKey: await exportPublicKey(identityPair.publicKey),
      privateKey: identityPair.privateKey
    },
    signing: {
      publicKey: await exportPublicKey(signing.publicKey),
      privateKey: signing.privateKey
    },
    signedPrekey: null,
    oneTimePrekeys: [],
    sessions: {},
    previousSessions: {}
  };
  state.signedPrekey = await makeSignedPrekey(state);
  await addOneTimePrekeys(state, PREKEY_BATCH);
  return state;
}

export async function addOneTimePrekeys(state, count = PREKEY_BATCH) {
  const used = new Set(state.oneTimePrekeys.map((prekey) => prekey.id));
  for (let index = 0; index < count; index += 1) {
    const pair = await generateEcdhPair();
    state.oneTimePrekeys.push({
      id: uniqueId(used),
      publicKey: await exportPublicKey(pair.publicKey),
      privateKey: pair.privateKey
    });
  }
  return state.oneTimePrekeys;
}

export function prekeyUploadPayload(state) {
  return {
    signingPublicKey: state.signing.publicKey,
    signedPrekey: {
      id: state.signedPrekey.id,
      publicKey: state.signedPrekey.publicKey,
      signature: state.signedPrekey.signature,
      createdAt: state.signedPrekey.createdAt
    },
    oneTimePrekeys: state.oneTimePrekeys.map((prekey) => ({
      id: prekey.id,
      publicKey: prekey.publicKey
    }))
  };
}

function serializeSession(session) {
  return {
    peerId: session.peerId,
    dmId: session.dmId,
    peerIdentityKey: session.peerIdentityKey,
    peerIdentityKeyVersion: session.peerIdentityKeyVersion,
    sessionId: session.sessionId || '',
    initialDh: session.initialDh || '',
    rootKey: session.rootKey,
    dhRemote: session.dhRemote,
    dhSelfPublic: session.dhSelfPublic,
    dhSelfPrivate: session.dhSelfPrivate,
    chainSend: session.chainSend,
    chainRecv: session.chainRecv,
    nSend: session.nSend,
    nRecv: session.nRecv,
    pn: session.pn,
    skipped: session.skipped,
    sentKeys: session.sentKeys || {},
    receivedKeys: session.receivedKeys || {},
    x3dhInit: session.x3dhInit,
    suspect: !!session.suspect,
    established: !!session.established
  };
}

async function hydrateSession(session) {
  return {
    peerId: Number(session.peerId),
    dmId: Number(session.dmId),
    peerIdentityKey: session.peerIdentityKey,
    peerIdentityKeyVersion: Number(session.peerIdentityKeyVersion) || 1,
    sessionId: session.sessionId || '',
    initialDh: session.initialDh || '',
    rootKey: session.rootKey,
    dhRemote: session.dhRemote,
    dhSelfPublic: session.dhSelfPublic,
    dhSelfPrivate: session.dhSelfPrivate,
    dhSelf: await importEcdhPrivate(session.dhSelfPrivate),
    chainSend: session.chainSend || null,
    chainRecv: session.chainRecv || null,
    nSend: Number(session.nSend) || 0,
    nRecv: Number(session.nRecv) || 0,
    pn: Number(session.pn) || 0,
    skipped: session.skipped || {},
    sentKeys: session.sentKeys || {},
    receivedKeys: session.receivedKeys || {},
    x3dhInit: session.x3dhInit || null,
    suspect: !!session.suspect,
    established: !!session.established
  };
}

export async function serializeE2eeState(state) {
  const sessions = {};
  for (const [peerId, session] of Object.entries(state.sessions || {})) {
    sessions[peerId] = serializeSession(session);
  }
  const previousSessions = {};
  for (const [peerId, list] of Object.entries(state.previousSessions || {})) {
    previousSessions[peerId] = (list || []).map(serializeSession);
  }
  return {
    v: 3,
    userId: state.userId,
    identity: {
      publicKey: state.identity.publicKey,
      privateKey: await exportPrivateKey(state.identity.privateKey)
    },
    signing: {
      publicKey: state.signing.publicKey,
      privateKey: await exportPrivateKey(state.signing.privateKey)
    },
    signedPrekey: {
      id: state.signedPrekey.id,
      publicKey: state.signedPrekey.publicKey,
      privateKey: await exportPrivateKey(state.signedPrekey.privateKey),
      signature: state.signedPrekey.signature,
      createdAt: state.signedPrekey.createdAt
    },
    oneTimePrekeys: await Promise.all(
      state.oneTimePrekeys.map(async (prekey) => ({
        id: prekey.id,
        publicKey: prekey.publicKey,
        privateKey: await exportPrivateKey(prekey.privateKey)
      }))
    ),
    sessions,
    previousSessions
  };
}

export async function hydrateE2eeState(serialized) {
  if (!serialized || serialized.v !== 3) throw new Error('Unsupported encryption state.');
  const sessions = {};
  for (const [peerId, session] of Object.entries(serialized.sessions || {})) {
    sessions[peerId] = await hydrateSession(session);
  }
  const previousSessions = {};
  for (const [peerId, list] of Object.entries(serialized.previousSessions || {})) {
    previousSessions[peerId] = await Promise.all((list || []).map(hydrateSession));
  }
  return {
    version: 3,
    userId: Number(serialized.userId),
    identity: {
      publicKey: serialized.identity.publicKey,
      privateKey: await importEcdhPrivate(serialized.identity.privateKey)
    },
    signing: {
      publicKey: serialized.signing.publicKey,
      privateKey: await importSigningPrivate(serialized.signing.privateKey)
    },
    signedPrekey: {
      id: Number(serialized.signedPrekey.id),
      publicKey: serialized.signedPrekey.publicKey,
      privateKey: await importEcdhPrivate(serialized.signedPrekey.privateKey),
      signature: serialized.signedPrekey.signature,
      createdAt: Number(serialized.signedPrekey.createdAt)
    },
    oneTimePrekeys: await Promise.all(
      (serialized.oneTimePrekeys || []).map(async (prekey) => ({
        id: Number(prekey.id),
        publicKey: prekey.publicKey,
        privateKey: await importEcdhPrivate(prekey.privateKey)
      }))
    ),
    sessions,
    previousSessions
  };
}

function x3dhInfo(initiatorIdentityKey, recipientIdentityKey) {
  return encoder.encode(
    `${X3DH_INFO_PREFIX}${initiatorIdentityKey}|${recipientIdentityKey}`
  );
}

async function deriveX3dhSecret(state, peer, ephemeral, x3dh) {
  const parts = [];
  if (peer.role === 'initiator') {
    parts.push(await dh(state.identity.privateKey, peer.signedPrekeyPublic));
    parts.push(await dh(ephemeral.privateKey, peer.identityPublicKey));
    parts.push(await dh(ephemeral.privateKey, peer.signedPrekeyPublic));
    if (peer.oneTimePrekeyPublic) {
      parts.push(await dh(ephemeral.privateKey, peer.oneTimePrekeyPublic));
    }
    return hkdfBytes(
      concatBytes(...parts),
      new Uint8Array(32),
      x3dhInfo(state.identity.publicKey, peer.identityPublicKey),
      32
    );
  }
  parts.push(await dh(peer.signedPrekeyPrivate, x3dh.identityKey));
  parts.push(await dh(state.identity.privateKey, x3dh.ephemeralKey));
  parts.push(await dh(peer.signedPrekeyPrivate, x3dh.ephemeralKey));
  if (peer.oneTimePrekeyPrivate) {
    parts.push(await dh(peer.oneTimePrekeyPrivate, x3dh.ephemeralKey));
  }
  return hkdfBytes(
    concatBytes(...parts),
    new Uint8Array(32),
    x3dhInfo(x3dh.identityKey, state.identity.publicKey),
    32
  );
}

async function verifyBundle(bundle, userId) {
  if (!bundle?.identityPublicKey || !bundle?.signingPublicKey || !bundle?.signedPrekey) {
    throw new Error('This contact has not published forward-secret prekeys yet.');
  }
  if (Number(bundle.userId) !== Number(userId)) {
    throw new Error('Encryption bundle does not match this contact.');
  }
  const valid = await verifySignedPrekey(
    bundle.signingPublicKey,
    bundle.userId,
    bundle.signedPrekey.id,
    bundle.signedPrekey.publicKey,
    bundle.signedPrekey.signature
  );
  if (!valid) throw new Error('The signed prekey could not be verified.');
}

export function x3dhSessionId(x3dh) {
  if (!x3dh?.identityKey || !x3dh?.ephemeralKey) return '';
  return `${x3dh.identityKey}|${x3dh.ephemeralKey}`;
}

export function sessionMatchesX3dh(session, x3dh) {
  const id = x3dhSessionId(x3dh);
  return !!id && session?.sessionId === id;
}

export function cloneSession(session) {
  if (!session) return null;
  return {
    ...session,
    skipped: { ...(session.skipped || {}) },
    sentKeys: { ...(session.sentKeys || {}) },
    receivedKeys: { ...(session.receivedKeys || {}) },
    x3dhInit: session.x3dhInit ? { ...session.x3dhInit } : null
  };
}

export function archiveSession(state, peerId, session) {
  if (!session) return;
  const key = String(peerId);
  if (!state.previousSessions) state.previousSessions = {};
  const list = state.previousSessions[key] || [];
  const id = `${session.sessionId || session.x3dhInit?.ephemeralKey || ''}|${session.initialDh || session.dhRemote || ''}`;
  const entryId = (entry) =>
    `${entry.sessionId || entry.x3dhInit?.ephemeralKey || ''}|${entry.initialDh || entry.dhRemote || ''}`;
  if (!list.some((entry) => entryId(entry) === id)) list.push(session);
  while (list.length > 4) list.shift();
  state.previousSessions[key] = list;
}

export async function createSenderSession(state, bundle, dmId, peerId) {
  await verifyBundle(bundle, peerId);
  const ephemeral = await generateEcdhPair();
  const ephemeralPublicKey = await exportPublicKey(ephemeral.publicKey);
  const secret = await deriveX3dhSecret(
    state,
    {
      role: 'initiator',
      identityPublicKey: bundle.identityPublicKey,
      signedPrekeyPublic: bundle.signedPrekey.publicKey,
      oneTimePrekeyPublic: bundle.oneTimePrekey?.publicKey || ''
    },
    ephemeral,
    null
  );
  const ratchet = await generateEcdhPair();
  const dhSelfPublic = await exportPublicKey(ratchet.publicKey);
  const first = await kdfRoot(
    bytesToBase64(secret),
    await dh(ratchet.privateKey, bundle.signedPrekey.publicKey)
  );
  const x3dhInit = {
    identityKey: state.identity.publicKey,
    ephemeralKey: ephemeralPublicKey,
    signedPrekeyId: Number(bundle.signedPrekey.id),
    oneTimePrekeyId: bundle.oneTimePrekey ? Number(bundle.oneTimePrekey.id) : null
  };
  const session = {
    peerId: Number(peerId),
    dmId: Number(dmId),
    peerIdentityKey: bundle.identityPublicKey,
    peerIdentityKeyVersion: Number(bundle.identityKeyVersion) || 1,
    sessionId: x3dhSessionId(x3dhInit),
    initialDh: dhSelfPublic,
    rootKey: first.rootKey,
    dhRemote: bundle.signedPrekey.publicKey,
    dhSelfPublic,
    dhSelfPrivate: await exportPrivateKey(ratchet.privateKey),
    dhSelf: ratchet.privateKey,
    chainSend: first.chainKey,
    chainRecv: null,
    nSend: 0,
    nRecv: 0,
    pn: 0,
    skipped: {},
    sentKeys: {},
    receivedKeys: {},
    x3dhInit,
    established: false
  };
  state.sessions[String(peerId)] = session;
  return session;
}

export async function createReceiverSession(state, envelope, dmId, peerId, peerPublicKey) {
  const x3dh = envelope.x3dh;
  if (!x3dh?.identityKey || !x3dh?.ephemeralKey) {
    throw new Error('This message is missing its session setup data.');
  }
  if (peerPublicKey && x3dh.identityKey !== peerPublicKey) {
    throw new Error('Encryption key changed. Verify the safety number before reading.');
  }
  if (Number(x3dh.signedPrekeyId) !== Number(state.signedPrekey.id)) {
    throw new Error('This message used an encryption prekey that is no longer available.');
  }
  const oneTimePrekey = x3dh.oneTimePrekeyId
    ? state.oneTimePrekeys.find((prekey) => Number(prekey.id) === Number(x3dh.oneTimePrekeyId))
    : null;
  if (x3dh.oneTimePrekeyId && !oneTimePrekey) {
    throw new Error('This message used a one-time prekey that is no longer available.');
  }
  const secret = await deriveX3dhSecret(
    state,
    {
      role: 'receiver',
      signedPrekeyPrivate: state.signedPrekey.privateKey,
      oneTimePrekeyPrivate: oneTimePrekey?.privateKey || null
    },
    null,
    x3dh
  );
  const first = await kdfRoot(
    bytesToBase64(secret),
    await dh(state.signedPrekey.privateKey, envelope.header.dh)
  );
  const session = {
    peerId: Number(peerId),
    dmId: Number(dmId),
    peerIdentityKey: x3dh.identityKey,
    peerIdentityKeyVersion: Number(envelope.senderKeyVersion) || 1,
    sessionId: x3dhSessionId(x3dh),
    initialDh: envelope.header.dh,
    rootKey: first.rootKey,
    dhRemote: envelope.header.dh,
    dhSelfPublic: state.signedPrekey.publicKey,
    dhSelfPrivate: await exportPrivateKey(state.signedPrekey.privateKey),
    dhSelf: state.signedPrekey.privateKey,
    chainSend: null,
    chainRecv: first.chainKey,
    nSend: 0,
    nRecv: 0,
    pn: 0,
    skipped: {},
    sentKeys: {},
    receivedKeys: {},
    x3dhInit: null,
    established: true
  };
  const existing = state.sessions[String(peerId)];
  if (existing) archiveSession(state, peerId, existing);
  state.sessions[String(peerId)] = session;
  if (oneTimePrekey) {
    state.oneTimePrekeys = state.oneTimePrekeys.filter(
      (prekey) => Number(prekey.id) !== Number(oneTimePrekey.id)
    );
  }
  return session;
}

async function ensureSendChain(session) {
  if (session.chainSend) return;
  if (!session.dhRemote) throw new Error('Encrypted session is not ready.');
  const ratchet = await generateEcdhPair();
  const dhSelfPublic = await exportPublicKey(ratchet.publicKey);
  const next = await kdfRoot(
    session.rootKey,
    await dh(ratchet.privateKey, session.dhRemote)
  );
  session.rootKey = next.rootKey;
  session.chainSend = next.chainKey;
  session.dhSelfPublic = dhSelfPublic;
  session.dhSelfPrivate = await exportPrivateKey(ratchet.privateKey);
  session.dhSelf = ratchet.privateKey;
  session.pn = session.nSend;
  session.nSend = 0;
}

function messageAad({ dmId, senderId, recipientId, header, x3dh }) {
  const parts = [
    MESSAGE_AAD_PREFIX,
    Number(dmId),
    Number(senderId),
    Number(recipientId),
    header.dh,
    Number(header.pn),
    Number(header.n)
  ];
  if (x3dh) {
    parts.push(
      x3dh.identityKey,
      x3dh.ephemeralKey,
      Number(x3dh.signedPrekeyId),
      x3dh.oneTimePrekeyId === null || x3dh.oneTimePrekeyId === undefined
        ? ''
        : Number(x3dh.oneTimePrekeyId)
    );
  }
  return encoder.encode(parts.join(':'));
}

async function encryptPayload(messageKey, payload, aad) {
  const iv = randomBytes(12);
  const key = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(messageKey),
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad },
      key,
      encoder.encode(JSON.stringify(payload))
    )
  );
  return {
    iv: bytesToBase64(iv),
    ct: bytesToBase64(ciphertext)
  };
}

async function decryptPayload(messageKey, iv, ct, aad) {
  const key = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(messageKey),
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(iv), additionalData: aad },
    key,
    base64ToBytes(ct)
  );
  return JSON.parse(decoder.decode(plaintext));
}

export async function ratchetEncrypt(state, session, payload, meta) {
  await ensureSendChain(session);
  const step = await kdfChain(session.chainSend);
  session.chainSend = step.chainKey;
  const header = {
    dh: session.dhSelfPublic,
    pn: session.pn,
    n: session.nSend
  };
  session.nSend += 1;
  const x3dh = session.x3dhInit || null;
  const aad = messageAad({
    dmId: meta.dmId,
    senderId: meta.senderId,
    recipientId: meta.recipientId,
    header,
    x3dh
  });
  const encrypted = await encryptPayload(step.messageKey, payload, aad);
  if (!session.sentKeys) session.sentKeys = {};
  session.sentKeys[`${header.dh}:${header.n}`] = step.messageKey;
  const sentIds = Object.keys(session.sentKeys);
  if (sentIds.length > MAX_STORED_KEYS) {
    for (const key of sentIds.slice(0, sentIds.length - MAX_STORED_KEYS)) {
      delete session.sentKeys[key];
    }
  }
  return {
    v: 2,
    alg: RATCHET_ALG,
    dmId: Number(meta.dmId),
    senderId: Number(meta.senderId),
    recipientId: Number(meta.recipientId),
    senderKeyVersion: Number(meta.senderKeyVersion),
    recipientKeyVersion: Number(meta.recipientKeyVersion),
    header,
    x3dh,
    iv: encrypted.iv,
    ct: encrypted.ct
  };
}

async function skipMessageKeys(session, until) {
  if (until <= session.nRecv) return;
  if (until - session.nRecv > MAX_SKIP) {
    throw new Error('Too many skipped encrypted messages.');
  }
  if (!session.chainRecv) throw new Error('Encrypted receiving chain is not ready.');
  while (session.nRecv < until) {
    const step = await kdfChain(session.chainRecv);
    session.chainRecv = step.chainKey;
    session.skipped[`${session.dhRemote}:${session.nRecv}`] = step.messageKey;
    session.nRecv += 1;
  }
  const keys = Object.keys(session.skipped);
  if (keys.length > MAX_SKIP) {
    for (const key of keys.slice(0, keys.length - MAX_SKIP)) delete session.skipped[key];
  }
}

async function dhRatchet(session, remoteDh) {
  session.pn = session.nSend;
  session.nSend = 0;
  session.nRecv = 0;
  session.dhRemote = remoteDh;
  const receiving = await kdfRoot(session.rootKey, await dh(session.dhSelf, remoteDh));
  session.rootKey = receiving.rootKey;
  session.chainRecv = receiving.chainKey;
  const ratchet = await generateEcdhPair();
  session.dhSelfPublic = await exportPublicKey(ratchet.publicKey);
  session.dhSelfPrivate = await exportPrivateKey(ratchet.privateKey);
  session.dhSelf = ratchet.privateKey;
  const sending = await kdfRoot(session.rootKey, await dh(session.dhSelf, remoteDh));
  session.rootKey = sending.rootKey;
  session.chainSend = sending.chainKey;
}

export async function ratchetDecrypt(state, session, envelope, meta) {
  const own = Number(meta.senderId) === Number(state.userId);
  if (!own) {
    if (session.peerIdentityKey !== envelope.x3dh?.identityKey && envelope.x3dh) {
      throw new Error('Encryption key changed. Verify the safety number before reading.');
    }
    if (Number(envelope.senderKeyVersion) !== Number(session.peerIdentityKeyVersion)) {
      throw new Error('Encryption key changed. Verify the safety number before reading.');
    }
  }
  const header = envelope.header;
  if (!header?.dh || !Number.isInteger(Number(header.n)) || !Number.isInteger(Number(header.pn))) {
    throw new Error('Unsupported encrypted message.');
  }
  if (own) {
    const messageKey = session.sentKeys?.[`${header.dh}:${Number(header.n)}`];
    if (!messageKey) {
      throw new Error('This sent message is no longer available on this device.');
    }
    const aad = messageAad({
      dmId: meta.dmId,
      senderId: meta.senderId,
      recipientId: meta.recipientId,
      header,
      x3dh: envelope.x3dh || null
    });
    return decryptPayload(messageKey, envelope.iv, envelope.ct, aad);
  }
  const keyId = `${header.dh}:${Number(header.n)}`;
  const cachedKey = session.receivedKeys?.[keyId];
  if (cachedKey) {
    const aad = messageAad({
      dmId: meta.dmId,
      senderId: meta.senderId,
      recipientId: meta.recipientId,
      header,
      x3dh: envelope.x3dh || null
    });
    return decryptPayload(cachedKey, envelope.iv, envelope.ct, aad);
  }
  if (header.dh !== session.dhRemote) {
    await skipMessageKeys(session, Number(header.pn));
    await dhRatchet(session, header.dh);
  }
  await skipMessageKeys(session, Number(header.n));
  const skippedKey = keyId;
  let messageKey = session.skipped[skippedKey];
  if (messageKey) {
    delete session.skipped[skippedKey];
  } else {
    if (Number(header.n) < session.nRecv) {
      throw new Error('This encrypted message was already read.');
    }
    if (!session.chainRecv) throw new Error('Encrypted receiving chain is not ready.');
    const step = await kdfChain(session.chainRecv);
    session.chainRecv = step.chainKey;
    messageKey = step.messageKey;
    session.nRecv += 1;
  }
  const aad = messageAad({
    dmId: meta.dmId,
    senderId: meta.senderId,
    recipientId: meta.recipientId,
    header,
    x3dh: envelope.x3dh || null
  });
  const payload = await decryptPayload(messageKey, envelope.iv, envelope.ct, aad);
  if (!session.receivedKeys) session.receivedKeys = {};
  session.receivedKeys[keyId] = messageKey;
  const receivedIds = Object.keys(session.receivedKeys);
  if (receivedIds.length > MAX_STORED_KEYS) {
    for (const key of receivedIds.slice(0, receivedIds.length - MAX_STORED_KEYS)) {
      delete session.receivedKeys[key];
    }
  }
  if (envelope.x3dh) {
    session.established = true;
    session.x3dhInit = null;
  }
  return payload;
}









