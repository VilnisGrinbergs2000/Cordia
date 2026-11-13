-- Edit history. "(edited)" tells you a message changed; it does not tell you what
-- it said before, which is the part people actually want when a conversation
-- stops making sense.
CREATE TABLE IF NOT EXISTS message_edits (
  id bigserial PRIMARY KEY,
  message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  editor_id bigint REFERENCES users(id) ON DELETE SET NULL,
  before text NOT NULL,
  after text NOT NULL,
  at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_message_edits_message ON message_edits(message_id, id);
