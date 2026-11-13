-- The onboarding checklist was dismissed per browser (localStorage), so a
-- second device showed it again. One row per member per server fixes that.
CREATE TABLE IF NOT EXISTS server_onboarding (
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id bigint NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  dismissed_at bigint NOT NULL,
  PRIMARY KEY (user_id, server_id)
);
