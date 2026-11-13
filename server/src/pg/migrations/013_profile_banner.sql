-- 013_profile_banner.sql
-- Profile banner images, matching server banners. Empty means "use banner_color".
ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_url text NOT NULL DEFAULT '';
