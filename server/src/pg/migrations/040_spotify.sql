-- One row per linked Spotify account. The tokens are the whole point of the
-- row: there is no way to read a user's playback without them, and Spotify
-- refresh tokens do not expire on their own, so the only way out is to revoke
-- from Spotify's side or to delete this row.
--
-- show_activity is separate from the row's existence because "connected" and
-- "tell everyone what I am playing" are different consents: someone can keep
-- the link and still want their listening kept to themselves.
CREATE TABLE IF NOT EXISTS user_spotify (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  spotify_user_id text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  scope text NOT NULL DEFAULT '',
  expires_at timestamptz NOT NULL,
  show_activity boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
