const crypto = require('node:crypto');
const express = require('express');
const { authRequired } = require('../auth');
const {
  stunUrls,
  turnUrls,
  turnSecret,
  turnUsername,
  turnCredential,
  turnTtlSeconds
} = require('../config');

const router = express.Router();

router.get('/voice/ice', authRequired, (req, res) => {
  const iceServers = [{ urls: stunUrls }];
  let expiresAt = null;

  if (turnUrls.length) {
    if (turnSecret) {
      expiresAt = Math.floor(Date.now() / 1000) + turnTtlSeconds;
      const username = `${expiresAt}:${req.user.id}`;
      const credential = crypto
        .createHmac('sha1', turnSecret)
        .update(username)
        .digest('base64');
      iceServers.push({ urls: turnUrls, username, credential });
    } else if (turnUsername && turnCredential) {
      iceServers.push({
        urls: turnUrls,
        username: turnUsername,
        credential: turnCredential
      });
    }
  }

  res.set('Cache-Control', 'no-store');
  res.json({ iceServers, expiresAt });
});

module.exports = router;
