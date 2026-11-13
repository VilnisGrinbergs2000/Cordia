-- The calendar already existed: server_events with RSVPs, no recurrence. This
-- adds what was missing rather than a second calendar.
ALTER TABLE server_events ADD COLUMN IF NOT EXISTS channel_id bigint REFERENCES channels(id) ON DELETE SET NULL;
ALTER TABLE server_events ADD COLUMN IF NOT EXISTS all_day boolean NOT NULL DEFAULT false;
ALTER TABLE server_events ADD COLUMN IF NOT EXISTS recurrence text NOT NULL DEFAULT 'none';

-- A second RSVP table was created by mistake while building this; the original
-- (server_event_rsvps) is the one the app has always used.
DROP TABLE IF EXISTS event_rsvps;
