'use strict';
// Shared lists: a checklist that lives in a channel and belongs to everybody who
// can see it. No private items, no owners — the point is that a group can keep
// one list instead of pasting it into chat every morning.
const express = require('express');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query } = require('../pg/pool');
const { authRequired } = require('../auth');
const { assertChannelAccess, trim } = require('../util');
const { hasServerPermission } = require('../permissions');

const router = express.Router();

const MAX_LISTS = 100;
const MAX_ITEMS = 500;
const MAX_TEXT = 300;

function serializeList(row, items) {
  return {
    id: Number(row.id),
    channelId: row.channel_id ? Number(row.channel_id) : null,
    title: row.title,
    createdAt: Number(row.created_at),
    items: (items || []).map((item) => ({
      id: Number(item.id),
      text: item.text,
      done: !!item.done,
      assigneeId: item.assignee_id ? Number(item.assignee_id) : null,
      assigneeName: item.assignee_name || '',
      position: Number(item.position)
    }))
  };
}

async function itemsFor(listIds) {
  if (!listIds.length) return new Map();
  const { rows } = await query(
    `SELECT i.*, u.display_name AS assignee_name FROM list_items i
       LEFT JOIN users u ON u.id = i.assignee_id
      WHERE i.list_id = ANY($1::bigint[])
      ORDER BY i.position ASC, i.id ASC`,
    [listIds]
  );
  const map = new Map();
  for (const row of rows) {
    const id = Number(row.list_id);
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(row);
  }
  return map;
}

router.get('/channels/:id/lists', authRequired, asyncHandler(async (req, res) => {
  const access = await assertChannelAccess(req.params.id, req.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  const { rows } = await query(
    'SELECT * FROM lists WHERE channel_id = $1 ORDER BY id ASC LIMIT $2',
    [access.channel.id, MAX_LISTS]
  );
  const items = await itemsFor(rows.map((row) => Number(row.id)));
  res.json({ lists: rows.map((row) => serializeList(row, items.get(Number(row.id)))) });
}));

router.post('/channels/:id/lists', authRequired, asyncHandler(async (req, res) => {
  const access = await assertChannelAccess(req.params.id, req.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  if (!(await hasServerPermission(access.channel.server_id, req.user.id, 'sendMessages', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to add lists here." });
  }
  const title = trim(req.body.title).slice(0, 120);
  if (!title) return res.status(400).json({ error: 'Give the list a name.' });
  const { rows: count } = await query('SELECT COUNT(*)::int AS c FROM lists WHERE channel_id = $1', [
    access.channel.id
  ]);
  if (count[0].c >= MAX_LISTS) return res.status(409).json({ error: 'This channel has too many lists.' });
  const { rows } = await query(
    `INSERT INTO lists (server_id, channel_id, title, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [access.channel.server_id, access.channel.id, title, req.user.id, Date.now()]
  );
  req.app.get('io').to('server:' + access.channel.server_id).emit('server:lists-changed', {
    serverId: Number(access.channel.server_id),
    channelId: Number(access.channel.id)
  });
  res.status(201).json({ list: serializeList(rows[0], []) });
}));

async function listAccess(listId, userId) {
  const { rows } = await query('SELECT * FROM lists WHERE id = $1', [Number(listId)]);
  const list = rows[0];
  if (!list) return { error: 'List not found.', status: 404 };
  const access = await assertChannelAccess(list.channel_id, userId);
  if (access.error) return { error: access.error, status: access.status };
  return { list, channel: access.channel };
}

router.post('/lists/:id/items', authRequired, asyncHandler(async (req, res) => {
  const found = await listAccess(req.params.id, req.user.id);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const text = trim(req.body.text).slice(0, MAX_TEXT);
  if (!text) return res.status(400).json({ error: 'Write something to do.' });
  const { rows: count } = await query('SELECT COUNT(*)::int AS c FROM list_items WHERE list_id = $1', [
    found.list.id
  ]);
  if (count[0].c >= MAX_ITEMS) return res.status(409).json({ error: 'This list is full.' });
  const { rows } = await query(
    `INSERT INTO list_items (list_id, text, done, assignee_id, position, created_by, created_at)
     VALUES ($1, $2, false, $3, $4, $5, $6) RETURNING *`,
    [
      found.list.id,
      text,
      req.body.assigneeId ? Number(req.body.assigneeId) : null,
      count[0].c,
      req.user.id,
      Date.now()
    ]
  );
  req.app.get('io').to('server:' + found.list.server_id).emit('server:lists-changed', {
    serverId: Number(found.list.server_id),
    channelId: Number(found.list.channel_id)
  });
  res.status(201).json({
    item: {
      id: Number(rows[0].id),
      text: rows[0].text,
      done: !!rows[0].done,
      assigneeId: rows[0].assignee_id ? Number(rows[0].assignee_id) : null,
      position: Number(rows[0].position)
    }
  });
}));

router.patch('/list-items/:id', authRequired, asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM list_items WHERE id = $1', [Number(req.params.id)]);
  const item = rows[0];
  if (!item) return res.status(404).json({ error: 'Item not found.' });
  const found = await listAccess(item.list_id, req.user.id);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const fields = [];
  const values = [];
  const set = (column, value) => {
    fields.push(column + ' = $' + (fields.length + 1));
    values.push(value);
  };
  if (req.body.done !== undefined) set('done', !!req.body.done);
  if (req.body.text !== undefined) {
    const text = trim(req.body.text).slice(0, MAX_TEXT);
    if (!text) return res.status(400).json({ error: 'Write something to do.' });
    set('text', text);
  }
  if (req.body.assigneeId !== undefined) {
    set('assignee_id', req.body.assigneeId ? Number(req.body.assigneeId) : null);
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to change.' });
  values.push(item.id);
  const updated = await query(
    'UPDATE list_items SET ' + fields.join(', ') + ' WHERE id = $' + values.length + ' RETURNING *',
    values
  );
  req.app.get('io').to('server:' + found.list.server_id).emit('server:lists-changed', {
    serverId: Number(found.list.server_id),
    channelId: Number(found.list.channel_id)
  });
  res.json({
    item: {
      id: Number(updated.rows[0].id),
      text: updated.rows[0].text,
      done: !!updated.rows[0].done,
      assigneeId: updated.rows[0].assignee_id ? Number(updated.rows[0].assignee_id) : null,
      position: Number(updated.rows[0].position)
    }
  });
}));

router.delete('/list-items/:id', authRequired, asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM list_items WHERE id = $1', [Number(req.params.id)]);
  const item = rows[0];
  if (!item) return res.status(404).json({ error: 'Item not found.' });
  const found = await listAccess(item.list_id, req.user.id);
  if (found.error) return res.status(found.status).json({ error: found.error });
  await query('DELETE FROM list_items WHERE id = $1', [item.id]);
  req.app.get('io').to('server:' + found.list.server_id).emit('server:lists-changed', {
    serverId: Number(found.list.server_id),
    channelId: Number(found.list.channel_id)
  });
  res.json({ ok: true });
}));

router.delete('/lists/:id', authRequired, asyncHandler(async (req, res) => {
  const found = await listAccess(req.params.id, req.user.id);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const mine = Number(found.list.created_by) === Number(req.user.id);
  if (
    !mine &&
    !(await hasServerPermission(found.list.server_id, req.user.id, 'manageChannels', req.user.role))
  ) {
    return res.status(403).json({ error: 'You can only delete lists you made.' });
  }
  await query('DELETE FROM lists WHERE id = $1', [found.list.id]);
  req.app.get('io').to('server:' + found.list.server_id).emit('server:lists-changed', {
    serverId: Number(found.list.server_id),
    channelId: Number(found.list.channel_id)
  });
  res.json({ ok: true });
}));

module.exports = router;
