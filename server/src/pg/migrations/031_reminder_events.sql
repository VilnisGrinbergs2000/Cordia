-- A reminder can be about an event as well as a message: "remind me 15 minutes
-- before the raid" is the same promise as "remind me about this message", and
-- it should land in the same list.
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS event_id bigint REFERENCES server_events(id) ON DELETE CASCADE;
