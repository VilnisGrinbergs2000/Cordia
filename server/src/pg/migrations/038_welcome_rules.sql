-- House rules are one short line each, so they are stored as newline-separated
-- text rather than in a second table: the welcome card renders them in order
-- and nothing ever queries a single rule on its own.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS welcome_rules text NOT NULL DEFAULT '';
