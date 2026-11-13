const express = require('express');
const asyncHandler = require('../pg/asyncHandler');
const { authRequired } = require('../auth');
const nowPlaying = require('../nowPlaying');

const router = express.Router();

// One endpoint for every player. The desktop build reads the operating system's
// media session and posts here; a script, a browser extension or another client
// can post the same body. Nothing about it is Spotify-shaped, which is the
// point: the card renders whatever arrives.
router.post('/presence/now-playing', authRequired, asyncHandler(async (req, res) => {
  const activity = nowPlaying.set(req.user.id, req.body || {});
  res.json({ ok: true, activity });
}));

router.delete('/presence/now-playing', authRequired, asyncHandler(async (req, res) => {
  nowPlaying.clear(req.user.id);
  res.json({ ok: true });
}));

module.exports = router;
