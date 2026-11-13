-- Voice occupancy used to live in a per-process Map, which meant a restart
-- emptied every voice channel and a second process could not see the first
-- one's participants. The row is the truth now; the Map is a cache of the
-- sockets this process actually owns.
CREATE TABLE IF NOT EXISTS voice_participants (
  channel_id bigint NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id bigint NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  socket_id text NOT NULL,
  muted boolean NOT NULL DEFAULT false,
  video boolean NOT NULL DEFAULT false,
  sharing boolean NOT NULL DEFAULT false,
  joined_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_voice_participants_server ON voice_participants(server_id);
CREATE INDEX IF NOT EXISTS idx_voice_participants_socket ON voice_participants(socket_id);
