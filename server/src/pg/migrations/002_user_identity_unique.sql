-- 002_user_identity_unique.sql
-- SQLite declared users.username/email as UNIQUE COLLATE NOCASE. The Postgres
-- baseline only kept the plain columns, so recreate the case-insensitive
-- uniqueness as expression indexes (same names 001 already uses for fresh DBs).
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_key ON users (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));

-- uploads was added to the SQLite schema after the snapshot 001 was translated
-- from; the orphan-upload sweep and deleteUploadIfUnused both write to it.
CREATE TABLE IF NOT EXISTS uploads (
  name text PRIMARY KEY,
  user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uploads_created ON uploads (created_at);
