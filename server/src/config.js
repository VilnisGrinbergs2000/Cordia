const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const dataDir = process.env.CORDIA_DATA_DIR
  ? path.resolve(process.env.CORDIA_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const uploadsDir = process.env.CORDIA_UPLOADS_DIR
  ? path.resolve(process.env.CORDIA_UPLOADS_DIR)
  : path.join(__dirname, '..', 'uploads');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });

function csv(value, fallback = []) {
  const entries = String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length ? entries : fallback;
}

let secret = process.env.JWT_SECRET;
if (!secret) {
  const secretFile = path.join(dataDir, 'jwt.secret');
  if (fs.existsSync(secretFile)) {
    secret = fs.readFileSync(secretFile, 'utf8').trim();
  } else {
    secret = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  }
}

module.exports = {
  dataDir,
  uploadsDir,
  port: Number(process.env.PORT) || 3001,
  secret,
  isProd: process.env.NODE_ENV === 'production',
  cookieName: 'cordia_token',
  sessionDays: 30,
  stunUrls: csv(process.env.STUN_URLS, [
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302'
  ]),
  turnUrls: csv(process.env.TURN_URLS || process.env.TURN_URL),
  turnSecret: process.env.TURN_SECRET || '',
  turnUsername: process.env.TURN_USERNAME || '',
  turnCredential: process.env.TURN_CREDENTIAL || '',
  turnTtlSeconds: Math.max(300, Number(process.env.TURN_TTL_SECONDS) || 86400),
  // KLIPY issues one app key per platform and puts it in the request path.
  // The picker calls KLIPY from the browser, so the key is handed to signed-in
  // clients rather than baked into the bundle — rotating it is an env change.
  klipyKey: String(process.env.KLIPY_KEY || process.env.KLIPY_API_KEY || '').trim()
};
