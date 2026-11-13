-- 043_group_category_color.sql
-- Role categories were a name and nothing else, which made them hard to tell
-- apart at a glance and impossible to colour-code. The default matches the
-- colour a new group gets, so existing categories look the same as before.
ALTER TABLE group_categories
  ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT '#7a8798';
