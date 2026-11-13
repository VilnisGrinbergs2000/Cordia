-- Reminders: a message you want to come back to at a time you choose, rather
-- than a bookmark you forget about. Kept separate from saved_messages because
-- the lifetime is different — a reminder is finished when it fires.
CREATE TABLE IF NOT EXISTS reminders (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id bigint REFERENCES messages(id) ON DELETE CASCADE,
  channel_id bigint,
  dm_id bigint,
  note text,
  remind_at bigint NOT NULL,
  created_at bigint NOT NULL,
  delivered_at bigint
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(remind_at);
CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id, remind_at);
