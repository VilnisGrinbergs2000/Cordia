-- Join and leave lines were unconditional. A busy server needs a way to turn
-- them off, so the flag lives next to the other per-server switches. Default 1
-- keeps existing servers behaving exactly as they did.
ALTER TABLE servers ADD COLUMN IF NOT EXISTS join_messages integer NOT NULL DEFAULT 1;
