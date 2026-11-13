'use strict';
// Which applications currently have a gateway connection open. Kept in its own
// module so util.js (which renders users) and bots.js (which accepts sockets)
// can share it without requiring each other.
const live = new Set();

function markBotOnline(applicationId) {
  live.add(Number(applicationId));
}

function markBotOffline(applicationId) {
  live.delete(Number(applicationId));
}

function isBotOnline(applicationId) {
  return live.has(Number(applicationId));
}

module.exports = { markBotOnline, markBotOffline, isBotOnline };
