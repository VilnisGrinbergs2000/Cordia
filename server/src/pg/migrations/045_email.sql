-- Outbound email: proof that an address exists, and a durable queue so an
-- SMTP hiccup never fails the request that triggered it.

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at bigint;
-- Product updates only. Password resets and suspension notices ignore this flag:
-- they are part of the service, not marketing.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_optout boolean NOT NULL DEFAULT false;

-- One row per outstanding link. The token itself is never stored: a database
-- dump must not be enough to take over an account, so only the sha256 lands
-- here and the plaintext exists solely in the message that was sent.
CREATE TABLE IF NOT EXISTS email_tokens (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  email text NOT NULL,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  used_at bigint
);

CREATE INDEX IF NOT EXISTS email_tokens_user_idx ON email_tokens (user_id, purpose);

-- The queue. A row is claimed by bumping attempts and pushing next_attempt_at
-- forward, so two workers cannot send the same message twice.
CREATE TABLE IF NOT EXISTS email_outbox (
  id bigserial PRIMARY KEY,
  user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  to_email text NOT NULL,
  kind text NOT NULL,
  subject text NOT NULL,
  html text NOT NULL,
  text text NOT NULL,
  headers text NOT NULL DEFAULT '',
  created_at bigint NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at bigint NOT NULL,
  sent_at bigint,
  failed_at bigint,
  last_error text
);

CREATE INDEX IF NOT EXISTS email_outbox_pending_idx
  ON email_outbox (next_attempt_at) WHERE sent_at IS NULL AND failed_at IS NULL;

-- Addresses that hard-bounced or were reported as spam. Sending again damages
-- the domain's reputation for every other recipient, so the queue checks here
-- before it hands anything to SMTP.
CREATE TABLE IF NOT EXISTS email_suppressions (
  email text PRIMARY KEY,
  reason text NOT NULL,
  created_at bigint NOT NULL
);
