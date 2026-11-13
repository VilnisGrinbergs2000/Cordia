-- Gateway durability: sessions and events survive a restart, so a bot that
-- reconnects across a deploy can still be told what it missed.
CREATE TABLE IF NOT EXISTS gateway_streams (
  application_id bigint PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
  seq bigint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS gateway_events (
  id bigserial PRIMARY KEY,
  application_id bigint NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  type text NOT NULL,
  payload jsonb,
  created_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gateway_events_app_seq ON gateway_events(application_id, seq);
CREATE INDEX IF NOT EXISTS idx_gateway_events_created ON gateway_events(created_at);

CREATE TABLE IF NOT EXISTS gateway_sessions (
  application_id bigint NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (application_id, session_id)
);
