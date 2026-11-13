-- Who joined through which link. Rows are kept when an invite is revoked so
-- the manager can still answer "where did these people come from".
CREATE TABLE IF NOT EXISTS invite_joins (
  invite_id bigint NOT NULL REFERENCES server_invites(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at bigint NOT NULL,
  PRIMARY KEY (invite_id, user_id)
);

CREATE INDEX IF NOT EXISTS invite_joins_user_idx ON invite_joins (user_id);
