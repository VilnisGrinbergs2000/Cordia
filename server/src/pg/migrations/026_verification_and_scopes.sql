-- A reviewed application says so, on the install link and in the developer panel.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS verified_at bigint;

-- What a particular install agreed to receive. Null means "whatever the
-- application declares", which is what every existing install meant.
ALTER TABLE application_installs ADD COLUMN IF NOT EXISTS intents text;
