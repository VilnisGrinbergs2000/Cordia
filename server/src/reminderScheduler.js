'use strict';
// Reminders fire on a timer, not on a request: the point of a reminder is that
// it arrives when the person is not looking.
require('./pg/env');
const { query } = require('./pg/pool');

const TICK_MS = 30_000;
const BATCH = 100;
const BRIDGE_CHANNEL = 'cordia_reminder_due';
let bridgeClient = null;

// Every process listens; every process emits into its own user:<id> room, and
// only the one holding that socket actually delivers anything.
function startReminderBridge(io) {
  if (bridgeClient) return;
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  bridgeClient = client;
  client.on('error', (error) => console.error('[reminders] bridge error:', error.message));
  client.on('notification', (message) => {
    if (message.channel !== BRIDGE_CHANNEL) return;
    let note = null;
    try {
      note = JSON.parse(message.payload);
    } catch {
      return;
    }
    if (!note || !note.userId || !note.payload) return;
    io.to('user:' + Number(note.userId)).emit('reminder:due', note.payload);
  });
  client
    .connect()
    .then(() => client.query('LISTEN ' + BRIDGE_CHANNEL))
    .catch((error) => console.error('[reminders] bridge unavailable:', error.message));
}

async function publishDue(io, userId, payload) {
  try {
    await query('SELECT pg_notify($1, $2)', [
      BRIDGE_CHANNEL,
      JSON.stringify({ userId: Number(userId), payload })
    ]);
  } catch (error) {
    // The bridge is an optimisation over a direct emit, not a requirement.
    console.error('[reminders] notify failed:', error.message);
    io.to('user:' + Number(userId)).emit('reminder:due', payload);
  }
}

// Claiming and reading in one statement is what stops two processes from
// delivering the same reminder twice: whoever sets delivered_at owns it, and
// the UPDATE ... RETURNING only hands the row to one of them.
async function deliverDue(io) {
  const now = Date.now();
  const { rows } = await query(
    `UPDATE reminders SET delivered_at = $1
      WHERE delivered_at IS NULL
        AND id IN (
        SELECT id FROM reminders
         WHERE delivered_at IS NULL AND remind_at <= $1
         ORDER BY remind_at ASC
         LIMIT $2
      )
      RETURNING id, user_id, message_id, channel_id, dm_id, event_id, note, remind_at`,
    [now, BATCH]
  );
  if (!rows.length) return 0;

  const ids = rows.map((row) => Number(row.message_id)).filter(Boolean);
  const previews = new Map();
  if (ids.length) {
    const { rows: messages } = await query(
      `SELECT m.id, m.content, m.e2ee, m.channel_id, m.dm_id,
              u.display_name, u.username, c.name AS channel_name
         FROM messages m
         LEFT JOIN users u ON u.id = m.user_id
         LEFT JOIN channels c ON c.id = m.channel_id
        WHERE m.id = ANY($1::bigint[])`,
      [ids]
    );
    for (const message of messages) previews.set(Number(message.id), message);
  }

  const eventIds = rows.map((row) => Number(row.event_id)).filter(Boolean);
  const events = new Map();
  if (eventIds.length) {
    const { rows: found } = await query(
      'SELECT id, title, starts_at FROM server_events WHERE id = ANY($1::bigint[])',
      [eventIds]
    );
    for (const event of found) events.set(Number(event.id), event);
  }

  for (const row of rows) {
    const message = row.message_id ? previews.get(Number(row.message_id)) : null;
    const event = row.event_id ? events.get(Number(row.event_id)) : null;
    const payload = {
      id: Number(row.id),
      note: row.note || '',
      remindAt: Number(row.remind_at),
      event: event ? { id: Number(event.id), title: event.title, startsAt: Number(event.starts_at) } : null,
      message: message
        ? {
            id: Number(message.id),
            content: message.content || '',
            e2ee: !!message.e2ee,
            channelId: message.channel_id ? Number(message.channel_id) : null,
            dmId: message.dm_id ? Number(message.dm_id) : null,
            authorName: message.display_name || message.username || '',
            where: message.channel_name ? '#' + message.channel_name : 'a direct message'
          }
        : null
    };
    // The claim above is single-winner across processes, but the socket may be
    // on a different process than the one that claimed the row. Delivering
    // through the same NOTIFY bridge the gateway uses means whichever process
    // holds the socket is the one that emits, and only one does.
    await publishDue(io, Number(row.user_id), payload);
  }
  return rows.length;
}

// Server subscriptions lapse on the same tick. They live here rather than in a
// timer of their own because this is already the thirty-second housekeeping
// sweep, and a second timer would only be a second thing to forget to unref.
function startReminderScheduler(io) {
  startReminderBridge(io);
  const { expireServerSubscriptions } = require('./routes/serverBilling');
  const run = async () => {
    try {
      await deliverDue(io);
    } catch (error) {
      console.error('[reminders] sweep failed:', error.message);
    }
    try {
      await expireServerSubscriptions();
    } catch (error) {
      console.error('[subscriptions] sweep failed:', error.message);
    }
    try {
      // A voice row whose process died never sends a leave. Ninety seconds of
      // silence is three missed transport heartbeats.
      await require('./voicePresence').expireStale();
    } catch (error) {
      console.error('[voice] sweep failed:', error.message);
    }
  };
  run();
  const timer = setInterval(run, TICK_MS);
  timer.unref();
  return timer;
}

module.exports = { startReminderScheduler, deliverDue };
