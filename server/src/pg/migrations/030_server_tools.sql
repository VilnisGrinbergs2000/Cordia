-- Server tools that Discord leaves to bots: a calendar, documents, shared lists,
-- and a gallery channel. Each is scoped to a server and hangs off a channel, so
-- permissions are the ones that already exist.

CREATE TABLE IF NOT EXISTS server_events (
  id bigserial PRIMARY KEY,
  server_id bigint NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel_id bigint REFERENCES channels(id) ON DELETE SET NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  location text NOT NULL DEFAULT '',
  starts_at bigint NOT NULL,
  ends_at bigint,
  all_day boolean NOT NULL DEFAULT false,
  recurrence text NOT NULL DEFAULT 'none',
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_server_events_server ON server_events(server_id, starts_at);

CREATE TABLE IF NOT EXISTS event_rsvps (
  event_id bigint NOT NULL REFERENCES server_events(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE IF NOT EXISTS docs (
  id bigserial PRIMARY KEY,
  server_id bigint NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel_id bigint REFERENCES channels(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  updated_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_docs_channel ON docs(channel_id, updated_at);

CREATE TABLE IF NOT EXISTS doc_versions (
  id bigserial PRIMARY KEY,
  doc_id bigint NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  editor_id bigint REFERENCES users(id) ON DELETE SET NULL,
  title text NOT NULL,
  body text NOT NULL,
  at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS lists (
  id bigserial PRIMARY KEY,
  server_id bigint NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel_id bigint REFERENCES channels(id) ON DELETE CASCADE,
  title text NOT NULL,
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS list_items (
  id bigserial PRIMARY KEY,
  list_id bigint NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  text text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  assignee_id bigint REFERENCES users(id) ON DELETE SET NULL,
  position integer NOT NULL DEFAULT 0,
  created_by bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_list_items_list ON list_items(list_id, position);
