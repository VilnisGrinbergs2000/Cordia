const express = require('express');
const { authRequired } = require('../auth');
const { klipyKey } = require('../config');

const router = express.Router();

// Keys for third-party services the client calls directly. Nothing secret is
// returned: a KLIPY app key identifies the platform, not the user, and it has
// to reach the browser because KLIPY requires the request to originate there.
router.get('/integrations', authRequired, (req, res) => {
  res.json({ klipy: klipyKey ? { key: klipyKey } : null });
});

module.exports = router;
