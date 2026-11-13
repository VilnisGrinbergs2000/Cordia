const fs = require('node:fs');
const path = require('node:path');
const webpush = require('web-push');
require('./pg/env');
const { query } = require('./pg/pool');
const { dataDir } = require('./config');
const { isOnline } = require('./presence');
const { getChannelRow, getDmRow } = require('./util');

let publicKey = '';
let ready = false;
let initError = '';

function loadKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY
    };
  }
  const keyFile = path.join(dataDir, 'vapid.json');
  try {
    const stored = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    if (stored.publicKey && stored.privateKey) return stored;
  } catch {
    // generate a new pair below
  }
  const generated = webpush.generateVAPIDKeys();
  fs.writeFileSync(keyFile, JSON.stringify(generated, null, 2), { mode: 0o600 });
  return generated;
}

try {
  const keys = loadKeys();
  publicKey = keys.publicKey;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@cordia.ext.io',
    keys.publicKey,
    keys.privateKey
  );
  ready = true;
} catch (error) {
  initError = error.message;
  console.error('[push] disabled:', error.message);
}

function getPublicKey() {
  return ready ? publicKey : '';
}

function isPushEndpointAllowed(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    if (url.port && url.port !== '443') return false;
    const host = url.hostname.toLowerCase();
    return (
      host === 'fcm.googleapis.com' ||
      host === 'android.googleapis.com' ||
      host === 'updates.push.services.mozilla.com' ||
      host === 'push.services.mozilla.com' ||
      host.endsWith('.push.apple.com') ||
      host.endsWith('.notify.windows.com')
    );
  } catch {
    return false;
  }
}

function pushErrorStatus(error) {
  return Number(error?.statusCode || error?.status || 0);
}

async function sendToSubscription(subscription, payload, options) {
  if (!isPushEndpointAllowed(subscription.endpoint)) {
    await query('DELETE FROM push_subscriptions WHERE id = $1', [subscription.id]);
    return false;
  }
  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth }
      },
      payload,
      options
    );
    await query('UPDATE push_subscriptions SET last_used_at = $1 WHERE id = $2', [
      Date.now(),
      subscription.id
    ]);
    return true;
  } catch (error) {
    const status = pushErrorStatus(error);
    if (status === 404 || status === 410) {
      await query('DELETE FROM push_subscriptions WHERE id = $1', [subscription.id]);
    } else {
      console.error(`[push] delivery failed (${status || 'unknown'}):`, error.message);
    }
    return false;
  }
}

async function sendToUsers(userIds, payload, options = {}) {
  if (!ready || !userIds.length) return 0;
  const placeholders = userIds.map((_, index) => '$' + (index + 1)).join(', ');
  const { rows: subscriptions } = await query(
    `SELECT id, user_id, endpoint, p256dh, auth
     FROM push_subscriptions WHERE user_id IN (${placeholders})`,
    userIds
  );
  if (!subscriptions.length) return 0;
  const body = JSON.stringify(payload);
  const results = await Promise.all(
    subscriptions.map((subscription) => sendToSubscription(subscription, body, options))
  );
  return results.filter(Boolean).length;
}

function preview(message) {
  if (message.encrypted) return 'New encrypted message. Open Cordia to decrypt.';
  const text = String(message.content || '').replace(/\s+/g, ' ').trim();
  if (text) return text.length > 140 ? `${text.slice(0, 137)}...` : text;
  if (message.attachment?.name) return `Sent an attachment: ${message.attachment.name}`;
  return 'Sent a message';
}

async function buildPayload(message, mentioned) {
  const author = message.author?.displayName || 'Someone';
  let title = author;
  let scopeType = 'channel';
  let scopeId = Number(message.channelId);
  let tag = `ch-${scopeId}`;

  if (message.dmId) {
    scopeType = 'dm';
    scopeId = Number(message.dmId);
    tag = `dm-${scopeId}`;
    if (mentioned) title = `${author} mentioned you`;
  } else {
    const channel = await getChannelRow(message.channelId);
    const channelName = channel?.name ? `#${channel.name}` : 'a channel';
    title = mentioned ? `${author} mentioned you in ${channelName}` : `${author} in ${channelName}`;
  }

  return {
    title,
    body: preview(message),
    tag,
    scopeType,
    scopeId,
    url: '/'
  };
}

async function mutedUsers(scopeType, scopeId) {
  const { rows } = await query(
    `SELECT user_id FROM read_states
     WHERE scope_type = $1 AND scope_id = $2 AND muted = 1`,
    [scopeType, scopeId]
  );
  return new Set(rows.map((row) => Number(row.user_id)));
}

async function sendMessagePush(message, mentionedUserIds = []) {
  if (!ready || !message) return;
  const mentioned = new Set(mentionedUserIds.map(Number));
  let recipients = [];
  let scopeType = 'channel';
  let scopeId = Number(message.channelId);

  if (message.dmId) {
    scopeType = 'dm';
    scopeId = Number(message.dmId);
    const dm = await getDmRow(scopeId);
    if (!dm) return;
    const otherId = dm.user_a === message.author.id ? dm.user_b : dm.user_a;
    recipients = [Number(otherId)];
  } else {
    const channel = await getChannelRow(scopeId);
    if (!channel) return;
    const { rows: memberRows } = await query(
      'SELECT user_id FROM server_members WHERE server_id = $1',
      [channel.server_id]
    );
    recipients = memberRows.map((row) => Number(row.user_id));
  }

  const muted = await mutedUsers(scopeType, scopeId);
  recipients = recipients.filter(
    (userId) =>
      userId !== Number(message.author.id) && (!muted.has(userId) || mentioned.has(userId))
  );
  recipients = recipients.filter((userId) => !isOnline(userId));
  if (!recipients.length) return;

  const mentionedRecipients = recipients.filter((userId) => mentioned.has(userId));
  const otherRecipients = recipients.filter((userId) => !mentioned.has(userId));
  const options = { TTL: 60 * 60 * 24 };
  await Promise.all([
    sendToUsers(mentionedRecipients, await buildPayload(message, true), {
      ...options,
      urgency: 'high'
    }),
    sendToUsers(otherRecipients, await buildPayload(message, false), {
      ...options,
      urgency: 'normal'
    })
  ]);
}

module.exports = {
  getPublicKey,
  isPushEndpointAllowed,
  get ready() {
    return ready;
  },
  get initError() {
    return initError;
  },
  sendMessagePush,
  sendToUsers
};
