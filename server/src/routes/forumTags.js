const express = require('express');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query, withTransaction } = require('../pg/pool');
const { authRequired } = require('../auth');
const { assertChannelAccess, isHexColor, logAudit, trim } = require('../util');
const { hasServerPermission } = require('../permissions');
const { normalizeTagName, serializeTag } = require('../forumTags');

const router = express.Router();
const DEFAULT_COLOR = '#6d5efc';
// Tags render as a filter bar, so an unbounded list turns into a wall of chips
// and an unbounded ORDER BY. Twenty is more than fits on one row at 1440px.
const TAG_LIMIT = 20;

function publishTags(req, serverId) {
  req.app.get('io').to(`server:${serverId}`).emit('server:threads-changed', { serverId });
}

async function forumForManage(channelId, user) {
  const access = await assertChannelAccess(channelId, user.id);
  if (access.error) return access;
  if (access.channel.type !== 'forum') {
    return { error: 'Tags only exist in forum channels.', status: 400 };
  }
  if (
    !(await hasServerPermission(
      access.channel.server_id,
      user.id,
      'manageChannels',
      user.role
    ))
  ) {
    return { error: "You don't have permission to manage forum tags here.", status: 403 };
  }
  return { channel: access.channel };
}

async function tagForManage(tagId, user) {
  const { rows } = await query('SELECT * FROM forum_tags WHERE id = $1', [Number(tagId)]);
  const tag = rows[0];
  if (!tag) return { error: 'Tag not found.', status: 404 };
  const access = await forumForManage(tag.channel_id, user);
  if (access.error) return access;
  return { tag, channel: access.channel };
}

router.get('/channels/:channelId/tags', authRequired, asyncHandler(async (req, res) => {
  const access = await assertChannelAccess(req.params.channelId, req.user.id);
  if (access.error) return res.status(access.status).json({ error: access.error });
  if (access.channel.type !== 'forum') {
    return res.status(400).json({ error: 'Tags only exist in forum channels.' });
  }
  const { rows } = await query(
    'SELECT * FROM forum_tags WHERE channel_id = $1 ORDER BY position ASC, id ASC',
    [access.channel.id]
  );
  res.json({ tags: rows.map(serializeTag) });
}));

router.post('/channels/:channelId/tags', authRequired, asyncHandler(async (req, res) => {
  const access = await forumForManage(req.params.channelId, req.user);
  if (access.error) return res.status(access.status).json({ error: access.error });
  const { channel } = access;

  const name = normalizeTagName(req.body?.name);
  if (!name) return res.status(400).json({ error: 'Give the tag a name.' });
  const color = req.body?.color === undefined ? DEFAULT_COLOR : trim(req.body.color);
  if (!isHexColor(color)) return res.status(400).json({ error: 'Invalid tag color.' });

  const existing = Number(
    (await query('SELECT COUNT(*)::int AS count FROM forum_tags WHERE channel_id = $1', [channel.id]))
      .rows[0].count
  );
  if (existing >= TAG_LIMIT) {
    return res.status(400).json({ error: `A forum can have at most ${TAG_LIMIT} tags.` });
  }

  let tag;
  try {
    const position = (
      await query(
        'SELECT COALESCE(MAX(position), 0) + 1 AS position FROM forum_tags WHERE channel_id = $1',
        [channel.id]
      )
    ).rows[0].position;
    const { rows } = await query(
      `INSERT INTO forum_tags (channel_id, name, color, position, created_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [channel.id, name, color, position, Date.now()]
    );
    tag = serializeTag(rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: `This forum already has a tag called ${name}.` });
    }
    throw error;
  }

  await logAudit(req.user.id, 'forum.tag.create', 'forum_tag', tag.id, `${name} in #${channel.name}`);
  publishTags(req, channel.server_id);
  res.status(201).json({ tag });
}));

// The client sends the whole order rather than one move: swapping a pair on the
// server would need the client to know the neighbour's position, and two quick
// moves could race. One request also keeps positions dense (1..n).
router.post('/channels/:channelId/tags/reorder', authRequired, asyncHandler(async (req, res) => {
  const access = await forumForManage(req.params.channelId, req.user);
  if (access.error) return res.status(access.status).json({ error: access.error });
  const { channel } = access;

  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((id) => Number(id)) : [];
  const owned = new Set(
    (await query('SELECT id FROM forum_tags WHERE channel_id = $1', [channel.id])).rows.map((row) =>
      Number(row.id)
    )
  );
  const unique = new Set(ids);
  if (
    !ids.length ||
    unique.size !== ids.length ||
    ids.length !== owned.size ||
    ids.some((id) => !owned.has(id))
  ) {
    return res.status(400).json({ error: 'Send every tag in this forum exactly once.' });
  }

  await withTransaction(async () => {
    for (const [index, id] of ids.entries()) {
      await query('UPDATE forum_tags SET position = $1 WHERE id = $2', [index + 1, id]);
    }
  });

  const tags = (
    await query('SELECT * FROM forum_tags WHERE channel_id = $1 ORDER BY position ASC, id ASC', [
      channel.id
    ])
  ).rows.map(serializeTag);
  await logAudit(req.user.id, 'forum.tag.reorder', 'channel', channel.id, `#${channel.name}`);
  publishTags(req, channel.server_id);
  res.json({ tags });
}));

router.patch('/tags/:tagId', authRequired, asyncHandler(async (req, res) => {
  const access = await tagForManage(req.params.tagId, req.user);
  if (access.error) return res.status(access.status).json({ error: access.error });
  const { tag, channel } = access;

  const name = req.body?.name === undefined ? tag.name : normalizeTagName(req.body.name);
  if (!name) return res.status(400).json({ error: 'Give the tag a name.' });
  const color = req.body?.color === undefined ? tag.color : trim(req.body.color);
  if (!isHexColor(color)) return res.status(400).json({ error: 'Invalid tag color.' });

  let updated;
  try {
    const { rows } = await query(
      'UPDATE forum_tags SET name = $1, color = $2 WHERE id = $3 RETURNING *',
      [name, color, tag.id]
    );
    updated = serializeTag(rows[0]);
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: `This forum already has a tag called ${name}.` });
    }
    throw error;
  }

  await logAudit(
    req.user.id,
    'forum.tag.update',
    'forum_tag',
    tag.id,
    `${tag.name} -> ${name} in #${channel.name}`
  );
  publishTags(req, channel.server_id);
  res.json({ tag: updated });
}));

router.delete('/tags/:tagId', authRequired, asyncHandler(async (req, res) => {
  const access = await tagForManage(req.params.tagId, req.user);
  if (access.error) return res.status(access.status).json({ error: access.error });
  const { tag, channel } = access;

  await query('DELETE FROM forum_tags WHERE id = $1', [tag.id]);
  await logAudit(req.user.id, 'forum.tag.delete', 'forum_tag', tag.id, `${tag.name} in #${channel.name}`);
  publishTags(req, channel.server_id);
  res.json({ ok: true, id: tag.id });
}));

module.exports = router;
