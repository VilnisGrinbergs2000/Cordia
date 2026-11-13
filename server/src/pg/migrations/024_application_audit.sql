-- Who did what to an application: installed it, removed it, rotated the token,
-- changed a command, or tried to run something they were not allowed to run.
-- Deliberately separate from "events", which is a funnel and drops anything it
-- does not recognise.
CREATE TABLE IF NOT EXISTS application_audit (
  id bigserial PRIMARY KEY,
  application_id bigint NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  server_id bigint,
  actor_id bigint,
  action text NOT NULL,
  detail jsonb,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_audit_app ON application_audit(application_id, created_at DESC);
