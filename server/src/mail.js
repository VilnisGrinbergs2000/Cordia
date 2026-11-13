'use strict';

require('./pg/env');
const nodemailer = require('nodemailer');
const { query } = require('./pg/pool');

// Every message goes through the outbox rather than straight to SMTP. A route
// that sends mail inline turns a slow or unreachable mail server into a failed
// registration, and registration is the one thing that must not depend on a
// third party being awake.

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
const BATCH_SIZE = 25;
const DRAIN_INTERVAL_MS = 15_000;
// A message that has been sitting in the queue for a day is no longer news: a
// verification link that arrives after the token expired only confuses people.
const MAX_AGE_MS = 24 * 3_600_000;

function env(name, fallback) {
  const value = String(process.env[name] || '').trim();
  return value || fallback;
}

const config = {
  host: env('SMTP_HOST', '127.0.0.1'),
  port: Number(env('SMTP_PORT', '25')),
  secure: String(env('SMTP_SECURE', '')).toLowerCase() === 'true',
  user: env('SMTP_USER', ''),
  pass: env('SMTP_PASS', ''),
  from: env('MAIL_FROM', 'Cordia <no-reply@cordia.ext.io>'),
  replyTo: env('MAIL_REPLY_TO', ''),
  // Set to "false" on a machine with no MTA. The queue still records the
  // message, so a developer can read the verification link out of the table
  // instead of wondering why registration went quiet.
  enabled: String(env('MAIL_ENABLED', 'true')).toLowerCase() !== 'false'
};

let transport = null;
function getTransport() {
  if (transport) return transport;
  const options = {
    host: config.host,
    port: config.port,
    secure: config.secure,
    // A local Postfix speaks plain SMTP on loopback and STARTTLS elsewhere.
    ignoreTLS: config.host === '127.0.0.1' || config.host === 'localhost',
    pool: true,
    maxConnections: 3,
    maxMessages: 50,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000
  };
  if (config.user) {
    options.auth = { user: config.user, pass: config.pass };
  }
  transport = nodemailer.createTransport(options);
  return transport;
}

function publicOrigin() {
  return String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');
}

// Queues one message. Never throws: a caller in a request handler must be able
// to fire-and-forget without a try/catch around every send.
async function queueMail({ to, subject, html, text, kind, userId = null, headers = '' }) {
  const address = String(to || '').trim().toLowerCase();
  if (!address) return null;
  const now = Date.now();
  try {
    const suppressed = await query('SELECT 1 FROM email_suppressions WHERE email = $1', [address]);
    if (suppressed.rowCount) return null;
    const inserted = await query(
      `INSERT INTO email_outbox (user_id, to_email, kind, subject, html, text, headers, created_at, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING id`,
      [userId, address, kind, subject, html, text, headers, now]
    );
    return Number(inserted.rows[0].id);
  } catch (error) {
    console.error('[mail] could not queue', kind, error.message);
    return null;
  }
}

function suppress(email, reason) {
  const address = String(email || '').trim().toLowerCase();
  if (!address) return Promise.resolve();
  return query(
    `INSERT INTO email_suppressions (email, reason, created_at) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET reason = EXCLUDED.reason`,
    [address, reason, Date.now()]
  ).catch((error) => console.error('[mail] suppress failed', error.message));
}

function isPermanent(error) {
  // 5xx is the server saying "do not try again"; 4xx is "not right now".
  const code = Number(error && (error.responseCode || error.statusCode));
  if (code >= 500 && code < 600) return true;
  return /no such user|mailbox unavailable|does not exist/i.test(String(error && error.message));
}

async function deliver(row) {
  const mail = {
    from: config.from,
    to: row.to_email,
    subject: row.subject,
    text: row.text,
    html: row.html
  };
  if (config.replyTo) mail.replyTo = config.replyTo;
  const extra = String(row.headers || '').trim();
  if (extra) {
    mail.headers = {};
    for (const line of extra.split(/\r?\n/)) {
      const index = line.indexOf(':');
      if (index > 0) mail.headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
  }
  await getTransport().sendMail(mail);
}

async function drainOnce() {
  if (!config.enabled) return 0;
  const now = Date.now();
  const due = await query(
    `SELECT * FROM email_outbox
      WHERE sent_at IS NULL AND failed_at IS NULL AND next_attempt_at <= $1
      ORDER BY next_attempt_at ASC LIMIT ${BATCH_SIZE}`,
    [now]
  );
  if (!due.rowCount) return 0;

  let sent = 0;
  for (const row of due.rows) {
    const id = Number(row.id);
    // Claim the row before touching SMTP so a second worker (or a restart that
    // overlaps the old process) cannot send the same message twice.
    const claim = await query(
      `UPDATE email_outbox SET attempts = attempts + 1, next_attempt_at = $2
        WHERE id = $1 AND sent_at IS NULL AND failed_at IS NULL AND attempts = $3
        RETURNING id`,
      [id, now + RETRY_DELAYS_MS[0], Number(row.attempts)]
    );
    if (!claim.rowCount) continue;

    const attempts = Number(row.attempts) + 1;
    if (now - Number(row.created_at) > MAX_AGE_MS) {
      await query('UPDATE email_outbox SET failed_at = $2, last_error = $3 WHERE id = $1', [
        id,
        now,
        'expired before it could be delivered'
      ]);
      continue;
    }

    const suppressed = await query('SELECT 1 FROM email_suppressions WHERE email = $1', [row.to_email]);
    if (suppressed.rowCount) {
      await query('UPDATE email_outbox SET failed_at = $2, last_error = $3 WHERE id = $1', [
        id,
        now,
        'address is suppressed'
      ]);
      continue;
    }

    try {
      await deliver(row);
      await query('UPDATE email_outbox SET sent_at = $2, last_error = NULL WHERE id = $1', [id, Date.now()]);
      sent += 1;
    } catch (error) {
      const message = String((error && error.message) || error).slice(0, 500);
      if (isPermanent(error) || attempts >= RETRY_DELAYS_MS.length) {
        await query('UPDATE email_outbox SET failed_at = $2, last_error = $3 WHERE id = $1', [id, now, message]);
        if (/no such user|mailbox unavailable|does not exist/i.test(message)) {
          await suppress(row.to_email, 'hard bounce');
        }
      } else {
        const delay = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length - 1)];
        await query('UPDATE email_outbox SET next_attempt_at = $2, last_error = $3 WHERE id = $1', [
          id,
          Date.now() + delay,
          message
        ]);
      }
    }
  }
  return sent;
}

let timer = null;
let running = false;

async function tick() {
  // Overlapping ticks would double-send on a slow SMTP server, and the claim
  // query only protects against concurrent workers, not against this process.
  if (running) return;
  running = true;
  try {
    await drainOnce();
  } catch (error) {
    console.error('[mail] drain failed', error.message);
  } finally {
    running = false;
  }
}

function startMailer() {
  if (timer || !config.enabled) return;
  timer = setInterval(tick, DRAIN_INTERVAL_MS);
  if (timer.unref) timer.unref();
  // First pass immediately: a restart should flush whatever queued before it
  // died, not wait fifteen seconds for the interval.
  setImmediate(tick);
}

function stopMailer() {
  if (timer) clearInterval(timer);
  timer = null;
}

async function verifyTransport() {
  if (!config.enabled) return { ok: false, detail: 'MAIL_ENABLED is false' };
  try {
    await getTransport().verify();
    return { ok: true, detail: `${config.host}:${config.port}` };
  } catch (error) {
    return { ok: false, detail: String((error && error.message) || error) };
  }
}

module.exports = {
  config,
  queueMail,
  drainOnce,
  startMailer,
  stopMailer,
  verifyTransport,
  suppress,
  publicOrigin
};
