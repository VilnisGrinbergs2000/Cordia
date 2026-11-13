'use strict';
// Documents: a wiki page per channel, versioned. The edit-history rule from
// messages applies here too — an overwrite without a record is the thing this
// exists to prevent.
const express = require('express');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query } = require('../pg/pool');
const { authRequired } = require('../auth');
const { assertChannelAccess, trim } = require('../util');
const { hasServerPermission } = require('../permissions');

const router = express.Router();

const MAX_BODY = 100_000;
const MAX_DOCS = 500;

function serializeDoc(row) {
  return {
    id: Number(row.id),
    channelId: row.channel_id ? Number(row.channel_id) : null,
    title: row.title,
    body: row.body || '',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    author: row.created_by
      ? { id: Number(row.created_by), displayName: row.author_name || '' }
      : null,
    editor: row.updated_by ? { id: Number(row.updated_by), displayName: row.editor_name || '' } : null
  };
}

router.get('/channels/:id/docs', authRequired, asyncHandler(async (req, res) => {
  const access = await assertChannelAccess(req.params.id, req.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  const { rows } = await query(
    `SELECT d.*, a.display_name AS author_name, e.display_name AS editor_name
       FROM docs d
       LEFT JOIN users a ON a.id = d.created_by
       LEFT JOIN users e ON e.id = d.updated_by
      WHERE d.channel_id = $1
      ORDER BY d.updated_at DESC
      LIMIT 200`,
    [access.channel.id]
  );
  res.json({ docs: rows.map(serializeDoc) });
}));

router.post('/channels/:id/docs', authRequired, asyncHandler(async (req, res) => {
  const access = await assertChannelAccess(req.params.id, req.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  if (!(await hasServerPermission(access.channel.server_id, req.user.id, 'sendMessages', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to write here." });
  }
  const title = trim(req.body.title).slice(0, 120);
  if (!title) return res.status(400).json({ error: 'Give the document a title.' });
  const { rows: count } = await query('SELECT COUNT(*)::int AS c FROM docs WHERE channel_id = $1', [
    access.channel.id
  ]);
  if (count[0].c >= MAX_DOCS) {
    return res.status(409).json({ error: 'This channel has too many documents.' });
  }
  const now = Date.now();
  const { rows } = await query(
    `INSERT INTO docs (server_id, channel_id, title, body, created_by, updated_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $6) RETURNING *`,
    [
      access.channel.server_id,
      access.channel.id,
      title,
      trim(req.body.body).slice(0, MAX_BODY),
      req.user.id,
      now
    ]
  );
  req.app.get('io').to('server:' + access.channel.server_id).emit('server:docs-changed', {
    serverId: Number(access.channel.server_id),
    channelId: Number(access.channel.id)
  });
  res.status(201).json({ doc: serializeDoc(rows[0]) });
}));

router.get('/docs/:id', authRequired, asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM docs WHERE id = $1', [Number(req.params.id)]);
  const doc = rows[0];
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  const access = await assertChannelAccess(doc.channel_id, req.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  res.json({ doc: serializeDoc(doc) });
}));

router.patch('/docs/:id', authRequired, asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM docs WHERE id = $1', [Number(req.params.id)]);
  const doc = rows[0];
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  const access = await assertChannelAccess(doc.channel_id, req.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  const mine = Number(doc.created_by) === Number(req.user.id);
  if (
    !mine &&
    !(await hasServerPermission(doc.server_id, req.user.id, 'manageChannels', req.user.role))
  ) {
    return res.status(403).json({ error: 'You can only edit documents you wrote.' });
  }
  const title = req.body.title !== undefined ? trim(req.body.title).slice(0, 120) : doc.title;
  if (!title) return res.status(400).json({ error: 'Give the document a title.' });
  const body =
    req.body.body !== undefined ? trim(req.body.body).slice(0, MAX_BODY) : doc.body || '';
  const now = Date.now();
  await query(
    'INSERT INTO doc_versions (doc_id, editor_id, title, body, at) VALUES ($1, $2, $3, $4, $5)',
    [doc.id, req.user.id, doc.title, doc.body || '', now]
  );
  const updated = await query(
    'UPDATE docs SET title = $1, body = $2, updated_by = $3, updated_at = $4 WHERE id = $5 RETURNING *',
    [title, body, req.user.id, now, doc.id]
  );
  req.app.get('io').to('server:' + doc.server_id).emit('server:docs-changed', {
    serverId: Number(doc.server_id),
    channelId: Number(doc.channel_id)
  });
  res.json({ doc: serializeDoc(updated.rows[0]) });
}));

router.get('/docs/:id/versions', authRequired, asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM docs WHERE id = $1', [Number(req.params.id)]);
  const doc = rows[0];
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  const access = await assertChannelAccess(doc.channel_id, req.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  const { rows: versions } = await query(
    `SELECT v.*, u.display_name FROM doc_versions v
       LEFT JOIN users u ON u.id = v.editor_id
      WHERE v.doc_id = $1 ORDER BY v.id DESC LIMIT 50`,
    [doc.id]
  );
  res.json({
    versions: versions.map((version) => ({
      id: Number(version.id),
      title: version.title,
      body: version.body,
      at: Number(version.at),
      editor: version.editor_id ? { id: Number(version.editor_id), displayName: version.display_name } : null
    }))
  });
}));

router.delete('/docs/:id', authRequired, asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM docs WHERE id = $1', [Number(req.params.id)]);
  const doc = rows[0];
  if (!doc) return res.status(404).json({ error: 'Document not found.' });
  const access = await assertChannelAccess(doc.channel_id, req.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  const mine = Number(doc.created_by) === Number(req.user.id);
  if (!mine && !(await hasServerPermission(doc.server_id, req.user.id, 'manageChannels', req.user.role))) {
    return res.status(403).json({ error: 'You can only delete documents you wrote.' });
  }
  await query('DELETE FROM docs WHERE id = $1', [doc.id]);
  req.app.get('io').to('server:' + doc.server_id).emit('server:docs-changed', {
    serverId: Number(doc.server_id),
    channelId: Number(doc.channel_id)
  });
  res.json({ ok: true });
}));

module.exports = router;
