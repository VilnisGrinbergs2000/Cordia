-- 042_pin_permissions.sql
-- Pinning used to ride on Manage messages, which meant a server that trusted
-- someone to tidy a channel also trusted them to pin to the top of it. Those
-- are different jobs, so pinning gets its own switch.
--
-- The migration is faithful: every group that could pin yesterday still can,
-- because every group that had Manage messages gets Pin messages. Nobody gains
-- or loses the ability in this step; managers can narrow it afterwards.
UPDATE server_groups
SET permissions = (
  SELECT jsonb_agg(entry)::text
  FROM (
    SELECT DISTINCT jsonb_array_elements_text(permissions::jsonb) AS entry
    UNION ALL
    SELECT 'pinMessages'
  ) AS merged
)
WHERE permissions ~ '^\['
  AND (permissions::jsonb ? 'manageMessages')
  AND NOT (permissions::jsonb ? 'pinMessages');
