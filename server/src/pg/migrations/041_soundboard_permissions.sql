-- 041_soundboard_permissions.sql
-- The soundboard had no permission of its own: playing was open to every
-- member, and adding or deleting required Manage server. Those are now two
-- switches, so the migration hands out exactly what each group already had.
--
-- Using it was universal, so every group keeps it.
UPDATE server_groups
SET permissions = (
  SELECT jsonb_agg(entry)::text
  FROM (
    SELECT DISTINCT jsonb_array_elements_text(permissions::jsonb) AS entry
    UNION ALL
    SELECT 'useSoundboard'
  ) AS merged
)
WHERE permissions ~ '^\['
  AND NOT (permissions::jsonb ? 'useSoundboard');

-- Managing it was Manage server, so only groups that already had that keep it.
-- Nobody gains the ability to upload sounds they could not upload yesterday.
UPDATE server_groups
SET permissions = (
  SELECT jsonb_agg(entry)::text
  FROM (
    SELECT DISTINCT jsonb_array_elements_text(permissions::jsonb) AS entry
    UNION ALL
    SELECT 'manageSoundboard'
  ) AS merged
)
WHERE permissions ~ '^\['
  AND (permissions::jsonb ? 'manageServer')
  AND NOT (permissions::jsonb ? 'manageSoundboard');
