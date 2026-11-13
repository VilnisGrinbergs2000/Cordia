ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_at bigint;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_by bigint;

CREATE INDEX IF NOT EXISTS messages_channel_pinned_idx
  ON messages (channel_id, pinned_at DESC)
  WHERE pinned_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS messages_dm_pinned_idx
  ON messages (dm_id, pinned_at DESC)
  WHERE pinned_at IS NOT NULL;
