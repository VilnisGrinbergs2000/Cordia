-- Which server permissions a slash command requires. An empty array means
-- "anyone who can post in the channel", which is what every existing command
-- meant before this column existed.
ALTER TABLE application_commands ADD COLUMN IF NOT EXISTS permissions jsonb;
