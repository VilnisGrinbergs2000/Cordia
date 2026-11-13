'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { uploadsDir } = require('../config');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query } = require('../pg/pool');
const { authRequired } = require('../auth');
const { ACCOUNT_LIMITS } = require('../limits');
const { deleteUploadIfUnused } = require('../util');

const router = express.Router();

async function storageUsed(userId) {
  const row = (
    await query('SELECT COALESCE(SUM(bytes), 0) AS used FROM uploads WHERE user_id = $1', [userId])
  ).rows[0];
  return Number(row.used) || 0;
}

async function accountPayload(userId) {
  const used = await storageUsed(userId);
  const quota = ACCOUNT_LIMITS.storageQuotaBytes;
  const percent = quota > 0 ? Math.round((used / quota) * 1000) / 10 : 0;
  return { limits: ACCOUNT_LIMITS, storage: { used, quota, percent } };
}

// Every place an upload can be referenced from, with the wording shown to the
// person trying to delete it. Order matters only for readability.
const UPLOAD_USES = [
  ['SELECT icon_url AS value FROM servers WHERE icon_url = ANY($1)', 'server icon'],
  ['SELECT banner AS value FROM servers WHERE banner = ANY($1)', 'server banner'],
  ['SELECT avatar_url AS value FROM users WHERE avatar_url = ANY($1)', 'avatar'],
  ['SELECT banner_url AS value FROM users WHERE banner_url = ANY($1)', 'profile banner'],
  ['SELECT url AS value FROM server_emotes WHERE url = ANY($1)', 'emote'],
  ['SELECT file AS value FROM soundboard_sounds WHERE file = ANY($1)', 'soundboard sound'],
  ['SELECT attachment_url AS value FROM messages WHERE attachment_url = ANY($1)', 'message attachment']
];

router.get('/support/me', authRequired, asyncHandler(async (req, res) => {
  res.json(await accountPayload(Number(req.user.id)));
}));

// What is this account actually spending its quota on, and what can it drop?
// The meter alone never answered that, which made running out of space a dead
// end: there was no way to see or reclaim a single byte.
router.get('/support/me/storage', authRequired, asyncHandler(async (req, res) => {
  const userId = Number(req.user.id);
  const { rows } = await query(
    'SELECT name, bytes, created_at FROM uploads WHERE user_id = $1 ORDER BY created_at DESC LIMIT 400',
    [userId]
  );
  const names = rows.map((row) => '/uploads/' + row.name);
  const uses = new Map();
  if (names.length) {
    for (const [sql, label] of UPLOAD_USES) {
      const found = (await query(sql, [names])).rows;
      for (const row of found) {
        if (!row.value) continue;
        if (!uses.has(row.value)) uses.set(row.value, []);
        uses.get(row.value).push(label);
      }
    }
  }
  const payload = await accountPayload(userId);
  res.json({
    ...payload,
    files: rows.map((row) => {
      const url = '/uploads/' + row.name;
      const usage = uses.get(url) || [];
      return {
        name: row.name,
        url,
        bytes: Number(row.bytes) || 0,
        createdAt: Number(row.created_at) || null,
        usage,
        inUse: usage.length > 0
      };
    })
  });
}));

router.delete('/support/me/storage/:name', authRequired, asyncHandler(async (req, res) => {
  const name = String(req.params.name || '');
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return res.status(400).json({ error: 'Unknown file.' });
  const owned = await query('SELECT name FROM uploads WHERE name = $1 AND user_id = $2', [
    name,
    Number(req.user.id)
  ]);
  if (!owned.rows.length) return res.status(404).json({ error: 'That file is not yours.' });
  const filePath = path.join(uploadsDir, name);
  // A row whose file vanished still holds quota; clearing it must not need the
  // file to exist first.
  if (fs.existsSync(filePath)) {
    const removed = await deleteUploadIfUnused('/uploads/' + name);
    if (!removed) {
      return res.status(409).json({
        error: 'That file is still in use. Remove it from the message, profile or emote that uses it first.'
      });
    }
  } else {
    await query('DELETE FROM uploads WHERE name = $1', [name]);
  }
  res.json(await accountPayload(Number(req.user.id)));
}));

module.exports = router;
