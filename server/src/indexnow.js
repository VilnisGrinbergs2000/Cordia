'use strict';

require('./pg/env');
const fs = require('node:fs');
const path = require('node:path');
const { query } = require('./pg/pool');

// IndexNow: one POST tells Bing, Yandex, Seznam and Naver that a URL changed,
// instead of waiting for them to crawl on their own schedule. It needs no
// account - ownership is proved by serving the key from the host itself, which
// is why the key file route in index.js is the real credential here.

const ENDPOINT = 'https://api.indexnow.org/indexnow';
const STATE_NAME = 'indexnow';

function key() {
  return String(process.env.INDEXNOW_KEY || '').trim();
}

function originFor(req) {
  const configured = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  if (configured) return configured;
  if (!req) return '';
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

const PAGES = ['/', '/guidelines', '/privacy', '/terms', '/status'];

function pageUrls(origin) {
  return PAGES.map((route) => origin + route);
}

async function submit({ origin, urls, timeoutMs = 10_000 }) {
  const token = key();
  if (!token) return { ok: false, detail: 'INDEXNOW_KEY is not set' };
  if (!origin) return { ok: false, detail: 'no public origin' };

  const body = {
    host: new URL(origin).host,
    key: token,
    keyLocation: `${origin}/${token}.txt`,
    urlList: urls && urls.length ? urls : pageUrls(origin)
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    // 200 and 202 both mean accepted; 422 means the key file was not readable
    // at keyLocation, which is the failure worth surfacing loudly.
    return {
      ok: response.ok,
      status: response.status,
      detail: response.ok ? 'accepted' : `HTTP ${response.status}`,
      urls: body.urlList.length
    };
  } catch (error) {
    return { ok: false, detail: String((error && error.message) || error) };
  } finally {
    clearTimeout(timer);
  }
}

// Newest mtime across the pages a search engine can see. Cheap, and it is the
// only honest signal that the content actually changed - a restart is not a
// content change and must not trigger a ping.
function newestPageMtime(landingDir) {
  const files = ['index.html', 'guidelines.html', 'privacy.html', 'terms.html', 'status.html'];
  let newest = 0;
  for (const file of files) {
    try {
      const stat = fs.statSync(path.join(landingDir, file));
      if (stat.mtimeMs > newest) newest = stat.mtimeMs;
    } catch (error) {
      // a missing page is not a reason to skip the others
    }
  }
  return Math.floor(newest);
}

async function notifyIfChanged({ origin, landingDir }) {
  const newest = newestPageMtime(landingDir);
  if (!newest) return { ok: false, detail: 'no pages found' };
  const row = (await query('SELECT value FROM seo_state WHERE name = $1', [STATE_NAME])).rows[0];
  if (row && Number(row.value) >= newest) {
    return { ok: true, skipped: true, detail: 'no change since the last submission' };
  }
  const result = await submit({ origin });
  if (result.ok) {
    await query(
      `INSERT INTO seo_state (name, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [STATE_NAME, newest, Date.now()]
    );
  }
  return result;
}

module.exports = { key, originFor, pageUrls, submit, notifyIfChanged, newestPageMtime };
