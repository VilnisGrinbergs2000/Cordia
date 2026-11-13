-- Guidelines acceptance is recorded per account at the moment of registration,
-- with the version that was actually shown. Existing accounts predate the page,
-- so they keep an empty string rather than being back-dated into an agreement
-- nobody displayed to them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS guidelines_version text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS guidelines_accepted_at bigint;
