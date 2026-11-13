-- The Spotify integration is gone: presence comes from whatever the client
-- pushes through /api/presence/now-playing, which needs no account and no
-- tokens. The table held plaintext refresh tokens that never expire on their
-- own, so leaving it behind would keep a liability for a feature nobody can
-- reach.
DROP TABLE IF EXISTS user_spotify;
