const express = require('express');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query } = require('../pg/pool');
const { authRequired } = require('../auth');
const { trim, getMembership } = require('../util');
const { hasServerPermission } = require('../permissions');
const { getAutomod, saveAutomod } = require('../automod');

const router = express.Router();

const EVENT_SELECT = `
  SELECT e.*,
    u.display_name AS creator_name, u.username AS creator_username,
    u.avatar_color AS creator_color, u.avatar_url AS creator_avatar,
    (SELECT COUNT(*) FROM server_event_rsvps r
     WHERE r.event_id = e.id AND r.status = 'going') AS going_count,
    (SELECT COUNT(*) FROM server_event_rsvps r
     WHERE r.event_id = e.id AND r.status = 'interested') AS interested_count,
    (SELECT r.status FROM server_event_rsvps r
     WHERE r.event_id = e.id AND r.user_id = $1) AS my_status
  FROM server_events e
  JOIN users u ON u.id = e.created_by
`;

async function serializeEvent(row, viewerId) {
  if (!row) return null;
  return {
    id: row.id,
    serverId: row.server_id,
    title: row.title,
    description: row.description || '',
    location: row.location || '',
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    allDay: !!row.all_day,
    recurrence: row.recurrence || 'none',
    channelId: row.channel_id ? Number(row.channel_id) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    goingCount: Number(row.going_count) || 0,
    interestedCount: Number(row.interested_count) || 0,
    myStatus: row.my_status || null,
    canManage:
      row.created_by === Number(viewerId) ||
      (await hasServerPermission(row.server_id, viewerId, 'manageServer')),
    creator: {
      id: row.created_by,
      username: row.creator_username,
      displayName: row.creator_name,
      avatarColor: row.creator_color,
      avatarUrl: row.creator_avatar || ''
    }
  };
}

async function getEventRow(eventId, viewerId) {
  const { rows } = await query(`${EVENT_SELECT} WHERE e.id = $2`, [
    Number(viewerId) || 0,
    Number(eventId)
  ]);
  return rows[0];
}

function validateEvent(body, existing = null) {
  const title = trim(body.title !== undefined ? body.title : existing?.title).slice(0, 100);
  if (title.length < 2) return { error: 'Event title must be at least 2 characters.' };
  const description = trim(
    body.description !== undefined ? body.description : existing?.description
  ).slice(0, 1000);
  const location = trim(
    body.location !== undefined ? body.location : existing?.location
  ).slice(0, 120);
  const startsAt = Number(
    body.startsAt !== undefined ? body.startsAt : existing?.starts_at
  );
  if (!Number.isFinite(startsAt) || startsAt <= 0) {
    return { error: 'Choose a valid start time.' };
  }
  if (!existing && startsAt < Date.now() - 60_000) {
    return { error: 'Event start time must be in the future.' };
  }
  const rawEndsAt = body.endsAt !== undefined ? body.endsAt : existing?.ends_at;
  let endsAt = null;
  if (rawEndsAt !== null && rawEndsAt !== undefined && rawEndsAt !== '') {
    endsAt = Number(rawEndsAt);
    if (!Number.isFinite(endsAt) || endsAt <= 0) {
      return { error: 'Choose a valid end time.' };
    }
    if (endsAt <= startsAt) return { error: 'Event end time must be after the start time.' };
  }
  const recurrence =
    body.recurrence !== undefined
      ? String(body.recurrence)
      : existing?.recurrence || 'none';
  if (!['none', 'weekly', 'monthly'].includes(recurrence)) {
    return { error: 'Repeat can be none, weekly or monthly.' };
  }
  const allDay = body.allDay !== undefined ? !!body.allDay : !!existing?.all_day;
  return {
    values: {
      title,
      description,
      location,
      startsAt: Math.round(startsAt),
      endsAt: endsAt === null ? null : Math.round(endsAt),
      recurrence,
      allDay
    }
  };
}

// One stored event, many calendar entries. Expanding on read means editing a
// series does not rewrite a year of rows, and the cap means a daily event
// cannot turn into ten thousand entries.
function expandOccurrences(event, from, to) {
  const start = Number(event.starts_at);
  const duration = event.ends_at ? Number(event.ends_at) - start : 0;
  if (event.recurrence === 'none' || !event.recurrence) {
    return start + duration >= from && start <= to ? [start] : [];
  }
  const dates = [];
  if (event.recurrence === 'weekly') {
    const step = 7 * 24 * 60 * 60 * 1000;
    let at = start;
    if (at < from) at += Math.ceil((from - at) / step) * step;
    while (at <= to && dates.length < 400) {
      dates.push(at);
      at += step;
    }
    return dates;
  }
  const origin = new Date(start);
  for (let index = 0; index < 1200 && dates.length < 400; index += 1) {
    const at = new Date(origin);
    at.setMonth(origin.getMonth() + index);
    // A monthly event on the 31st lands on the last day of shorter months
    // rather than skipping them.
    if (at.getDate() !== origin.getDate()) at.setDate(0);
    const value = at.getTime();
    if (value > to) break;
    if (value + duration >= from) dates.push(value);
  }
  return dates;
}

function emitEventChange(req, serverId, reason) {
  req.app
    .get('io')
    .to(`server:${serverId}`)
    .emit('server:events-changed', { serverId: Number(serverId), reason });
}

router.get('/servers/:id/automod', authRequired, asyncHandler(async (req, res) => {
  if (!(await hasServerPermission(req.params.id, req.user.id, 'viewServerSettings', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to view this server's settings." });
  }
  res.json({ automod: await getAutomod(req.params.id) });
}));

router.patch('/servers/:id/automod', authRequired, asyncHandler(async (req, res) => {
  if (!(await hasServerPermission(req.params.id, req.user.id, 'manageServer', req.user.role))) {
    return res.status(403).json({ error: "You don't have permission to manage automod." });
  }
  const automod = await saveAutomod(req.params.id, req.body || {}, req.user.id);
  res.json({ automod });
}));

router.get('/servers/:id/events', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await getMembership(serverId, req.user.id))) {
    return res.status(403).json({ error: 'You are not a member of this server' });
  }
  const { rows } = await query(
    `${EVENT_SELECT} WHERE e.server_id = $2 ORDER BY e.starts_at ASC, e.id ASC LIMIT 100`,
    [req.user.id, serverId]
  );
  // A window turns the list into a calendar: a weekly event becomes one entry
  // per week inside the window, each with its own start.
  const from = Number(req.query.from);
  const to = Number(req.query.to);
  if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
    const expanded = [];
    for (const row of rows) {
      const base = await serializeEvent(row, req.user.id);
      for (const start of expandOccurrences(row, from, to)) {
        expanded.push({
          ...base,
          occurrenceStart: start,
          occurrenceEnd: row.ends_at
            ? start + (Number(row.ends_at) - Number(row.starts_at))
            : null
        });
      }
    }
    expanded.sort((one, two) => one.occurrenceStart - two.occurrenceStart);
    return res.json({ events: expanded, from, to });
  }
  const events = [];
  for (const row of rows) {
    events.push(await serializeEvent(row, req.user.id));
  }
  res.json({ events });
}));

router.post('/servers/:id/events', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await getMembership(serverId, req.user.id))) {
    return res.status(403).json({ error: 'You are not a member of this server' });
  }
  // Scheduling an event is its own permission so a server can keep the calendar
  // curated without taking away the ability to talk.
  if (!(await hasServerPermission(serverId, req.user.id, 'createEvents', req.user.role))) {
    return res.status(403).json({ error: 'You do not have permission to create events here.' });
  }
  const result = validateEvent(req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  const now = Date.now();
  const insert = (
    await query(
      `INSERT INTO server_events
         (server_id, created_by, title, description, location, starts_at, ends_at, recurrence, all_day, channel_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        serverId,
        req.user.id,
        result.values.title,
        result.values.description,
        result.values.location,
        result.values.startsAt,
        result.values.endsAt,
        result.values.recurrence,
        result.values.allDay,
        req.body.channelId ? Number(req.body.channelId) : null,
        now,
        now
      ]
    )
  ).rows[0];
  const event = await serializeEvent(await getEventRow(insert.id, req.user.id), req.user.id);
  emitEventChange(req, serverId, 'created');
  res.status(201).json({ event });
}));

router.patch('/servers/:id/events/:eventId', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  const event = await getEventRow(req.params.eventId, req.user.id);
  if (!event || event.server_id !== serverId) {
    return res.status(404).json({ error: 'Event not found.' });
  }
  if (
    event.created_by !== req.user.id &&
    !(await hasServerPermission(serverId, req.user.id, 'manageServer', req.user.role))
  ) {
    return res.status(403).json({ error: 'You cannot edit this event.' });
  }
  const result = validateEvent(req.body || {}, event);
  if (result.error) return res.status(400).json({ error: result.error });
  await query(
    `UPDATE server_events
     SET title = $1, description = $2, location = $3, starts_at = $4, ends_at = $5,
         recurrence = $6, all_day = $7, updated_at = $8
     WHERE id = $9`,
    [
      result.values.title,
      result.values.description,
      result.values.location,
      result.values.startsAt,
      result.values.endsAt,
      result.values.recurrence,
      result.values.allDay,
      Date.now(),
      event.id
    ]
  );
  const updated = await serializeEvent(await getEventRow(event.id, req.user.id), req.user.id);
  emitEventChange(req, serverId, 'updated');
  res.json({ event: updated });
}));

router.delete('/servers/:id/events/:eventId', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  const event = await getEventRow(req.params.eventId, req.user.id);
  if (!event || event.server_id !== serverId) {
    return res.status(404).json({ error: 'Event not found.' });
  }
  if (
    event.created_by !== req.user.id &&
    !(await hasServerPermission(serverId, req.user.id, 'manageServer', req.user.role))
  ) {
    return res.status(403).json({ error: 'You cannot delete this event.' });
  }
  await query('DELETE FROM server_events WHERE id = $1', [event.id]);
  emitEventChange(req, serverId, 'deleted');
  res.json({ ok: true });
}));

router.post('/servers/:id/events/:eventId/rsvp', authRequired, asyncHandler(async (req, res) => {
  const serverId = Number(req.params.id);
  if (!(await getMembership(serverId, req.user.id))) {
    return res.status(403).json({ error: 'You are not a member of this server' });
  }
  const event = await getEventRow(req.params.eventId, req.user.id);
  if (!event || event.server_id !== serverId) {
    return res.status(404).json({ error: 'Event not found.' });
  }
  const status = req.body?.status;
  if (status !== null && status !== undefined && status !== 'going' && status !== 'interested') {
    return res.status(400).json({ error: 'Invalid RSVP status.' });
  }
  if (status === null || status === undefined) {
    await query('DELETE FROM server_event_rsvps WHERE event_id = $1 AND user_id = $2', [
      event.id,
      req.user.id
    ]);
    // Withdrawing an answer withdraws the reminder it created, or the person
    // gets told about an event they explicitly said they are not going to.
    await query('DELETE FROM reminders WHERE event_id = $1 AND user_id = $2', [
      event.id,
      req.user.id
    ]);
  } else {
    await query(
      `INSERT INTO server_event_rsvps (event_id, user_id, status, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT(event_id, user_id) DO UPDATE SET status = excluded.status, created_at = excluded.created_at`,
      [event.id, req.user.id, status, Date.now()]
    );
    // Saying you are going sets a reminder fifteen minutes before the event.
    // "Remind me" has one home, so it goes in the same list as message
    // reminders rather than inventing a second kind of notification.
    const at = Number(event.starts_at) - 15 * 60 * 1000;
    if (status === 'going' && at > Date.now() + 30_000) {
      await query('DELETE FROM reminders WHERE event_id = $1 AND user_id = $2', [
        event.id,
        req.user.id
      ]);
      await query(
        `INSERT INTO reminders (user_id, message_id, channel_id, dm_id, event_id, note, remind_at, created_at)
         VALUES ($1, NULL, $2, NULL, $3, $4, $5, $6)`,
        [req.user.id, event.channel_id, event.id, 'Event: ' + event.title, at, Date.now()]
      );
    } else {
      await query('DELETE FROM reminders WHERE event_id = $1 AND user_id = $2', [
        event.id,
        req.user.id
      ]);
    }
  }
  const updated = await serializeEvent(await getEventRow(event.id, req.user.id), req.user.id);
  emitEventChange(req, serverId, 'rsvp');
  res.json({ event: updated });
}));

module.exports = router;
