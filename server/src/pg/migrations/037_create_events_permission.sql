-- 037_create_events_permission.sql
-- Event creation used to be open to every member, so granting it to every
-- existing group is the faithful translation: the switch exists now, and
-- turning it off is something a manager decides rather than something this
-- migration does to them.
--
-- permissions is a text column holding a JSON array. Rows whose text is not a
-- JSON array are skipped: parsePermissions already reads those as "no
-- permissions", so they have nothing to preserve.
UPDATE server_groups
SET permissions = (
  SELECT jsonb_agg(entry)::text
  FROM (
    SELECT DISTINCT jsonb_array_elements_text(permissions::jsonb) AS entry
    UNION ALL
    SELECT 'createEvents'
  ) AS merged
)
WHERE permissions ~ '^\['
  AND NOT (permissions::jsonb ? 'createEvents');
