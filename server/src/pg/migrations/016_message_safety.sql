-- The predatory-DM notice used to live only in the socket payload, so a
-- recipient who reopened the conversation (or reloaded the app) never saw it.
-- Storing it on the row keeps the warning attached to the message, and
-- serializeMessage only exposes it to the recipient, never to the sender.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS safety_level text NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS safety_categories text NOT NULL DEFAULT '';
