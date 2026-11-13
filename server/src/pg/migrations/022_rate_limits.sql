-- Counters that have to be shared: two processes and a restart used to mean two
-- budgets and a clean slate.
CREATE TABLE IF NOT EXISTS rate_hits (
  key text PRIMARY KEY,
  count integer NOT NULL DEFAULT 0,
  reset bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_hits_reset ON rate_hits(reset);
