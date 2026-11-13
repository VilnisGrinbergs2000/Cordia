-- 003_soundboard_unique.sql
-- SQLite declared soundboard_sounds UNIQUE (server_id, name COLLATE NOCASE).
-- The translated baseline dropped that table-level constraint, so restore it as
-- an expression index over lower(name).
CREATE UNIQUE INDEX IF NOT EXISTS soundboard_sounds_server_id_name_lower_key
  ON soundboard_sounds (server_id, lower(name));
