-- Components, component interactions and event subscriptions.
-- intents is a comma list; empty means "everything", which is what an app that
-- never touched the setting should get.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS intents text NOT NULL DEFAULT '';

-- A bot message can carry interactive components (buttons, select menus).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS components jsonb;

-- 'command' | 'component' — what the user did to raise the interaction.
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'command';
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS custom_id text NOT NULL DEFAULT '';
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS message_id bigint;
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS values jsonb;

CREATE INDEX IF NOT EXISTS idx_messages_components ON messages(id) WHERE components IS NOT NULL;
