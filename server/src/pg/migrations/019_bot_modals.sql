-- Modal forms opened by a bot, and the values they come back with.
-- The definition is stored on the interaction it was opened from so a submit
-- can be validated against the fields the bot actually asked for.
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS modal jsonb;
