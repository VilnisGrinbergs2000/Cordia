'use strict';
// Cross-process WebRTC signalling.
//
// With one process this is a no-op: the target socket is in the local room and
// the caller emits straight to it. With two, the offer has to reach a socket
// this process does not own, so it travels through Postgres NOTIFY - the same
// transport the gateway bridge already uses. The payload is a single SDP blob
// or ICE candidate, well under the 8 KB NOTIFY limit.
require('./pg/env');
const crypto = require('crypto');
const { Client } = require('pg');
const { query } = require('./pg/pool');

const CHANNEL = 'cordia_voice_signal';
// Join/leave/state changes also cross processes, otherwise a peer on another
// process appears in the participant list but never in the call: the client
// only builds a connection when it is told somebody arrived.
const PEER_CHANNEL = 'cordia_voice_peer';
const PROCESS_ID = crypto.randomUUID();
let client = null;

function startVoiceBridge(io) {
  if (client) return;
  const connection = new Client({ connectionString: process.env.DATABASE_URL });
  client = connection;
  connection.on('error', (error) => console.error('[voice] bridge error:', error.message));
  connection.on('notification', (message) => {
    let note = null;
    try {
      note = JSON.parse(message.payload);
    } catch {
      return;
    }
    if (!note || note.from === PROCESS_ID) return;
    if (message.channel === CHANNEL) {
      if (!note.to) return;
      io.to(String(note.to)).emit('webrtc:signal', { from: note.sender, data: note.data });
      return;
    }
    if (message.channel === PEER_CHANNEL) {
      if (!note.channelId || !note.event) return;
      io.to('voice:' + Number(note.channelId)).emit(note.event, note.payload);
    }
  });
  connection
    .connect()
    .then(() => connection.query('LISTEN ' + CHANNEL))
    .then(() => connection.query('LISTEN ' + PEER_CHANNEL))
    .catch((error) => console.error('[voice] bridge unavailable:', error.message));
}

async function notifySignal({ to, sender, data }) {
  try {
    await query('SELECT pg_notify($1, $2)', [
      CHANNEL,
      JSON.stringify({ to: String(to), sender: String(sender), data, from: PROCESS_ID })
    ]);
  } catch (error) {
    console.error('[voice] signal relay failed:', error.message);
  }
}

async function notifyPeer({ channelId, event, payload }) {
  try {
    await query('SELECT pg_notify($1, $2)', [
      PEER_CHANNEL,
      JSON.stringify({ channelId: Number(channelId), event, payload, from: PROCESS_ID })
    ]);
  } catch (error) {
    console.error('[voice] peer relay failed:', error.message);
  }
}

module.exports = { startVoiceBridge, notifySignal, notifyPeer };
