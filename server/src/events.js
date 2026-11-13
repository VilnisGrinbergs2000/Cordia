require('./pg/env');
const { query } = require('./pg/pool');

// The funnel worth measuring: someone signs up, makes a place, invites, someone
// else arrives, and somebody finally talks. Anything outside this list is a typo
// and is dropped rather than written, so the table cannot fill with noise.
const EVENT_TYPES = new Set([
  'user_created',
  'server_created',
  'invite_created',
  'member_joined',
  'first_message',
  // One per account per day, written the first time the app asks who it is.
  // This is what makes day-1 and day-7 retention readable at all.
  'session_started'
]);

// Fire-and-forget by design: callers do not await this, and a failure is logged
// instead of thrown. Activation data is never worth failing a signup over.
function logEvent(type, { userId = null, serverId = null } = {}) {
  if (!EVENT_TYPES.has(type)) return Promise.resolve(false);
  return query(
    'INSERT INTO events (type, user_id, server_id, created_at) VALUES ($1, $2, $3, $4)',
    [type, userId ?? null, serverId ?? null, Date.now()]
  )
    .then(() => true)
    .catch((error) => {
      console.error('[events] could not record', type, error.message);
      return false;
    });
}

// Session rows are the only event that needs deduplication: /api/auth/me runs on
// every app load. The check is one indexed lookup against today's rows, and it
// fails open (a duplicate row only overcounts a little).
async function logSession(userId) {
  try {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const seen = await query(
      `SELECT 1 FROM events
        WHERE type = 'session_started' AND user_id = $1 AND created_at >= $2
        LIMIT 1`,
      [userId, startOfDay.getTime()]
    );
    if (seen.rows[0]) return false;
  } catch {
    return false;
  }
  return logEvent('session_started', { userId });
}

module.exports = { logEvent, logSession, EVENT_TYPES };
