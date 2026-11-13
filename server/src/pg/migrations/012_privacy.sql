-- 012_privacy.sql
-- Per-user privacy controls beyond dm_privacy (001_baseline).
-- Values are validated in the API, matching how dm_privacy is handled.
ALTER TABLE users ADD COLUMN IF NOT EXISTS friend_requests text NOT NULL DEFAULT 'anyone';
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_visibility text NOT NULL DEFAULT 'everyone';
ALTER TABLE users ADD COLUMN IF NOT EXISTS presence_visibility text NOT NULL DEFAULT 'everyone';
ALTER TABLE users ADD COLUMN IF NOT EXISTS show_typing bigint NOT NULL DEFAULT 1;
