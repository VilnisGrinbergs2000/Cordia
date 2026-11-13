-- One row per outbound SEO notification, so a restart does not re-ping for a
-- site that has not changed. IndexNow tolerates repeats poorly and there is no
-- reason to spend the allowance.
CREATE TABLE IF NOT EXISTS seo_state (
  name text PRIMARY KEY,
  value bigint NOT NULL,
  updated_at bigint NOT NULL
);
