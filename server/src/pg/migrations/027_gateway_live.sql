-- Which gateways are open right now, across every process. The in-memory map
-- answers that question for one process; a cap that only one process enforces is
-- a cap of five times the number of processes.
CREATE TABLE IF NOT EXISTS gateway_live (
  application_id bigint NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  socket_id text NOT NULL,
  seen_at bigint NOT NULL,
  PRIMARY KEY (application_id, socket_id)
);
CREATE INDEX IF NOT EXISTS idx_gateway_live_seen ON gateway_live(seen_at);
