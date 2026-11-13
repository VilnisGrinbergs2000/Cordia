'use strict';

const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
require('../pg/env');
const asyncHandler = require('../pg/asyncHandler');
const { query } = require('../pg/pool');
const { signToken, setSessionCookie, rateLimit } = require('../auth');
const { findToken, burnToken, originFor, hashToken } = require('../email');
const { publicOrigin } = require('../mail');

const router = express.Router();

// The link target is a page, not a JSON endpoint. People click these from a
// mail client, so the response has to be readable by a browser that has no
// JavaScript bundle, no session and no idea what Cordia is.

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page({ title, heading, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex" />
<meta name="color-scheme" content="dark" />
<title>${escapeHtml(title)} · Cordia</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px; background: #0b0c12; color: #e8e9f2;
    font-family: 'Segoe UI', system-ui, -apple-system, Helvetica, Arial, sans-serif;
    background-image: radial-gradient(900px 520px at 50% -10%, rgba(124,107,255,.18), transparent 70%);
  }
  .card {
    width: 100%; max-width: 440px; background: #14151f; border: 1px solid #242637;
    border-radius: 18px; padding: 32px; box-shadow: 0 24px 60px rgba(0,0,0,.45);
  }
  .brand { font-size: 15px; font-weight: 700; letter-spacing: .3px; color: #a99cff; margin: 0 0 20px; }
  h1 { margin: 0 0 14px; font-size: 21px; line-height: 1.35; }
  p { margin: 0 0 14px; font-size: 14.5px; line-height: 1.65; color: #a7abbd; }
  .actions { margin-top: 24px; }
  a.button, button {
    display: inline-block; width: 100%; text-align: center; padding: 12px 18px; border: 0; border-radius: 10px;
    background: #6c5cf0; color: #fff; font-size: 14.5px; font-weight: 600; text-decoration: none; cursor: pointer;
    font-family: inherit;
  }
  a.button:hover, button:hover { background: #7c6bff; }
  a.quiet { color: #8f93a8; font-size: 13px; text-decoration: none; display: inline-block; margin-top: 14px; }
  label { display: block; font-size: 12.5px; font-weight: 600; color: #b9bccd; margin: 0 0 6px; letter-spacing: .2px; }
  input[type=password] {
    width: 100%; padding: 11px 13px; margin-bottom: 16px; border-radius: 10px; border: 1px solid #2b2d3f;
    background: #0f1018; color: #e8e9f2; font-size: 14.5px; font-family: inherit;
  }
  input[type=password]:focus { outline: 2px solid rgba(124,107,255,.55); outline-offset: 1px; border-color: #6c5cf0; }
  .notice { padding: 12px 14px; border-radius: 10px; font-size: 13.5px; line-height: 1.6; margin: 0 0 18px; }
  .notice.warn { background: rgba(255,183,77,.1); border-left: 3px solid #ffb74d; color: #ffd9a3; }
  .notice.bad { background: rgba(255,107,107,.1); border-left: 3px solid #ff6b6b; color: #ffc2c2; }
  .notice.ok { background: rgba(80,200,140,.1); border-left: 3px solid #50c88c; color: #b8f0d2; }
  .error { color: #ff9d9d; font-size: 13.5px; margin: 0 0 14px; min-height: 1px; }
</style>
</head>
<body>
  <main class="card">
    <p class="brand">Cordia</p>
    <h1>${escapeHtml(heading)}</h1>
    ${body}
  </main>
</body>
</html>`;
}

function sendPage(res, status, options) {
  res.status(status).type('html').send(page(options));
}

function appHref(req) {
  const origin = publicOrigin() || originFor(req);
  return origin ? `${origin}/app` : '/app';
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

router.get(
  '/email/verify',
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const row = await findToken(req.query.token, 'verify');
    if (!row) {
      return sendPage(res, 400, {
        title: 'Link expired',
        heading: 'This link no longer works',
        body: `<p>Confirmation links work once and expire after a day. Sign in to Cordia and ask for a new one from your settings.</p>
               <div class="actions"><a class="button" href="${escapeHtml(appHref(req))}">Open Cordia</a></div>`
      });
    }

    const user = (await query('SELECT * FROM users WHERE id = $1', [row.user_id])).rows[0];
    if (!user) {
      return sendPage(res, 400, {
        title: 'Link expired',
        heading: 'This link no longer works',
        body: '<p>The account it belonged to no longer exists.</p>'
      });
    }

    await query('UPDATE users SET email_verified = true, email_verified_at = $2 WHERE id = $1', [
      user.id,
      Date.now()
    ]);
    await burnToken(row.id);

    return sendPage(res, 200, {
      title: 'Email confirmed',
      heading: 'Your email is confirmed',
      body: `<div class="notice ok">${escapeHtml(user.email)} is now attached to @${escapeHtml(user.username)}. We will use it for password resets and account notices, and nothing else.</div>
             <p>You can close this tab, or jump straight into the app.</p>
             <div class="actions"><a class="button" href="${escapeHtml(appHref(req))}">Open Cordia</a></div>`
    });
  })
);

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

router.get(
  '/email/reset',
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const token = String(req.query.token || '');
    const row = await findToken(token, 'reset');
    if (!row) {
      return sendPage(res, 400, {
        title: 'Link expired',
        heading: 'This reset link has expired',
        body: `<p>Reset links last an hour and work once. Ask for a fresh one from the sign-in page.</p>
               <div class="actions"><a class="button" href="${escapeHtml(appHref(req))}">Open Cordia</a></div>`
      });
    }
    const user = (await query('SELECT * FROM users WHERE id = $1', [row.user_id])).rows[0];
    if (!user || user.banned) {
      return sendPage(res, 400, {
        title: 'Link expired',
        heading: 'This reset link has expired',
        body: '<p>The account is not available right now.</p>'
      });
    }

    return sendPage(res, 200, {
      title: 'Choose a new password',
      heading: 'Choose a new password',
      body: `<p>Resetting the password for <strong>${escapeHtml(user.username)}</strong>.</p>
             <form method="post" action="/api/email/reset" autocomplete="off">
               <input type="hidden" name="token" value="${escapeHtml(token)}" />
               <label for="password">New password</label>
               <input id="password" name="password" type="password" minlength="8" maxlength="128" required autocomplete="new-password" />
               <label for="confirm">Repeat it</label>
               <input id="confirm" name="confirm" type="password" minlength="8" maxlength="128" required autocomplete="new-password" />
               <div class="notice warn"><strong>Encrypted messages stay encrypted.</strong> This changes the password only. To read existing encrypted DMs on a new device you still need your recovery code.</div>
               <div class="actions"><button type="submit">Set password and sign in</button></div>
             </form>`
    });
  })
);

router.post(
  '/email/reset',
  rateLimit({ windowMs: 15 * 60_000, max: 10, message: 'Too many reset attempts. Try again later.' }),
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const token = String(req.body.token || '');
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const confirm = typeof req.body.confirm === 'string' ? req.body.confirm : '';

    const row = await findToken(token, 'reset');
    const fail = (message) =>
      sendPage(res, 400, {
        title: 'Could not reset',
        heading: 'That did not work',
        body: `<div class="notice bad">${escapeHtml(message)}</div>
               <div class="actions"><a class="button" href="${escapeHtml(appHref(req))}">Back to Cordia</a></div>`
      });

    if (!row) return fail('This reset link has expired. Ask for a new one from the sign-in page.');
    if (password.length < 8 || password.length > 128) return fail('Passwords must be between 8 and 128 characters.');
    if (password !== confirm) return fail('The two passwords did not match.');

    const user = (await query('SELECT * FROM users WHERE id = $1', [row.user_id])).rows[0];
    if (!user || user.banned) return fail('This account is not available right now.');

    const hash = bcrypt.hashSync(password, 11);
    await query('UPDATE users SET password_hash = $2, token_version = token_version + 1 WHERE id = $1', [
      user.id,
      hash
    ]);
    await burnToken(row.id);
    // Every other session dies with the old password; this one is the only
    // survivor, which is the whole point of a reset.
    await query('DELETE FROM email_tokens WHERE user_id = $1 AND purpose = $2', [user.id, 'reset']);

    const updated = (await query('SELECT * FROM users WHERE id = $1', [user.id])).rows[0];
    const session = signToken(updated);
    setSessionCookie(res, session);
    const io = req.app.get('io');
    if (io) io.in(`user:${user.id}`).disconnectSockets(true);

    return res.redirect(303, appHref(req));
  })
);

// ---------------------------------------------------------------------------
// Product-update opt-out
// ---------------------------------------------------------------------------

function unsubscribeSecret() {
  return String(process.env.MAIL_UNSUBSCRIBE_SECRET || process.env.JWT_SECRET || 'cordia');
}

function unsubscribeToken(userId) {
  return crypto.createHmac('sha256', unsubscribeSecret()).update(`unsub:${userId}`).digest('base64url');
}

function validUnsubscribe(userId, token) {
  const expected = Buffer.from(unsubscribeToken(userId));
  const given = Buffer.from(String(token || ''));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

router.get(
  '/email/unsubscribe',
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const userId = Number(req.query.u);
    if (!userId || !validUnsubscribe(userId, req.query.t)) {
      return sendPage(res, 400, {
        title: 'Link expired',
        heading: 'This link is not valid',
        body: '<p>Unsubscribe links are tied to one account. Sign in and change your email preferences instead.</p>'
      });
    }
    await query('UPDATE users SET email_optout = true WHERE id = $1', [userId]);
    return sendPage(res, 200, {
      title: 'Unsubscribed',
      heading: 'You are off the list',
      body: `<div class="notice ok">No more product updates. You will still receive password resets and account notices, because those are part of the service.</div>
             <div class="actions"><a class="button" href="${escapeHtml(appHref(req))}">Open Cordia</a></div>`
    });
  })
);

module.exports = { router, unsubscribeToken, validUnsubscribe, hashToken };
