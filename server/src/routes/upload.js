const fs = require('node:fs');
const express = require('express');
const multer = require('multer');
const path = require('node:path');
const crypto = require('node:crypto');
const { uploadsDir } = require('../config');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { withTransaction } = require('../pg/pool');
const { ACCOUNT_LIMITS } = require('../limits');
const { authRequired, rateLimit } = require('../auth');

const router = express.Router();

const uploadLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  message: 'Too many uploads. Try again in a minute.',
  key: (req) => `upload:${req.user.id}`
});

const MIME_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/webm': '.weba',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'text/plain': '.txt',
  'application/octet-stream': '.bin'
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = MIME_EXTENSIONS[file.mimetype] || path.extname(file.originalname).slice(0, 10);
    cb(null, `${crypto.randomUUID()}${ext}`);
  }
});

function fileFilter(req, file, cb) {
  if (!MIME_EXTENSIONS[file.mimetype]) {
    return cb(new Error('Unsupported file type. Images, video, audio, PDF, ZIP and text are allowed.'));
  }
  cb(null, true);
}

// multer freezes its limits at construction, so keep one parser per ceiling
// (one ceiling, shared by every account) instead of rebuilding it per request.
const parsers = new Map();
function parserFor(maxUploadBytes) {
  let parser = parsers.get(maxUploadBytes);
  if (!parser) {
    parser = multer({ storage, limits: { fileSize: maxUploadBytes, files: 1 }, fileFilter });
    parsers.set(maxUploadBytes, parser);
  }
  return parser;
}

function removeFile(filePath) {
  if (!filePath) return;
  fs.promises.unlink(filePath).catch(() => {});
}

router.post('/upload', authRequired, uploadLimiter, asyncHandler(async (req, res) => {
  // The ceiling is a constant, so multer can be handed it before the body is
  // read and stop an oversized upload mid-stream instead of after the write.
  const uploadError = await new Promise((resolve) => {
    parserFor(ACCOUNT_LIMITS.maxUploadBytes).single('file')(req, res, (error) => resolve(error || null));
  });
  if (uploadError) {
    if (uploadError.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: 'UPLOAD_TOO_LARGE',
        code: 'UPLOAD_TOO_LARGE',
        limit: ACCOUNT_LIMITS.maxUploadBytes
      });
    }
    return res.status(400).json({ error: uploadError.message });
  }
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  const bytes = Number(req.file.size) || 0;
  const quota = ACCOUNT_LIMITS.storageQuotaBytes;

  // Lock the user row so two concurrent uploads cannot both pass the quota
  // check and overshoot together; the SUM then runs inside the same snapshot.
  let outcome;
  try {
    outcome = await withTransaction(async (client) => {
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
      const used = Number(
        (await client.query('SELECT COALESCE(SUM(bytes), 0) AS used FROM uploads WHERE user_id = $1', [
          req.user.id
        ])).rows[0].used
      ) || 0;
      if (used + bytes > quota) return { ok: false, used };
      // Remember the file so the prune job can find uploads that never got
      // attached to a message, avatar, icon or sound.
      await client.query(
        `INSERT INTO uploads (name, user_id, created_at, bytes) VALUES ($1, $2, $3, $4)
         ON CONFLICT (name) DO UPDATE SET
           user_id = excluded.user_id,
           created_at = excluded.created_at,
           bytes = excluded.bytes`,
        [req.file.filename, req.user.id, Date.now(), bytes]
      );
      return { ok: true, used };
    });
  } catch (error) {
    console.error('[upload] could not record upload:', error.message);
    removeFile(req.file.path);
    return res.status(500).json({ error: 'Could not save that upload.' });
  }

  if (!outcome.ok) {
    removeFile(req.file.path);
    return res.status(413).json({
      error: 'STORAGE_FULL',
      code: 'STORAGE_FULL',
      used: outcome.used,
      quota
    });
  }

  res.status(201).json({
    attachment: {
      url: `/uploads/${req.file.filename}`,
      name: req.file.originalname.slice(0, 200),
      type: req.file.mimetype,
      size: bytes
    }
  });
}));

module.exports = router;
