-- Vanity invite links. The random code stays the default; a manager can
-- replace it with something pronounceable. Uniqueness is enforced by the index
-- below rather than by a check-then-insert, so two people claiming the same
-- link at the same moment cannot both win: the second write fails at commit.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS invite_code_custom bigint NOT NULL DEFAULT 0;

-- Codes are stored lowercase from now on, but older rows are uppercase hex and
-- shared links must keep working, so the index folds case and every lookup does
-- too.
CREATE UNIQUE INDEX IF NOT EXISTS servers_invite_code_fold_idx ON servers (lower(invite_code));
CREATE UNIQUE INDEX IF NOT EXISTS server_invites_code_fold_idx ON server_invites (lower(code));
