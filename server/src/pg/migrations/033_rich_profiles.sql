-- Rich profiles: a handful of social links, a curated games list, and a bio
-- that only applies inside one server. All three are additive and default to
-- empty, so an untouched account serialises exactly as it did before.
ALTER TABLE users ADD COLUMN IF NOT EXISTS social_links jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS games jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE server_members ADD COLUMN IF NOT EXISTS bio text NOT NULL DEFAULT '';
