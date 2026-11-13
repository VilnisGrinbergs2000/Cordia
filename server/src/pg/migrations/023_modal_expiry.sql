-- An open form stops being open after a while. Without this an unsubmitted form
-- sits in the table forever, and a bot that asked a question last Tuesday can be
-- answered on Friday.
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS expires_at bigint;
