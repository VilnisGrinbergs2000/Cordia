-- Descriptions per language. Names are not localised: a name is what people type,
-- and a command that changes its name by locale cannot be typed from memory.
ALTER TABLE application_commands ADD COLUMN IF NOT EXISTS localizations jsonb;
