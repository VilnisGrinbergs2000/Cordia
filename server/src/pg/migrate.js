'use strict';

// Minimal forward-only migration runner: schema_migrations(version, applied_at).
// Each pending file is applied inside its own transaction while holding a
// Postgres advisory lock, so concurrent runners cannot interleave.
const fs = require('node:fs');
const path = require('node:path');
require('./env');
const { pool } = require('./pool');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const ADVISORY_LOCK_KEY = 7526391820465;

const CREATE_MIGRATIONS_TABLE = 'CREATE TABLE IF NOT EXISTS schema_migrations (\n' +
  '  version integer PRIMARY KEY,\n' +
  '  applied_at bigint NOT NULL\n' +
  ')';

function listMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d+_[A-Za-z0-9_]+\.sql$/.test(name))
    .map((name) => ({ name, version: Number(name.split('_')[0]), file: path.join(MIGRATIONS_DIR, name) }))
    .sort((a, b) => a.version - b.version || a.name.localeCompare(b.name));
}

async function migrate() {
  const files = listMigrations();
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await client.query(CREATE_MIGRATIONS_TABLE);
    const rows = (await client.query('SELECT version FROM schema_migrations')).rows;
    const done = new Set(rows.map((r) => r.version));
    for (const m of files) {
      if (done.has(m.version)) continue;
      const sql = fs.readFileSync(m.file, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)', [m.version, Date.now()]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error('migration ' + m.name + ' failed: ' + err.message);
      }
      applied.push(m.name);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    client.release();
  }
  return { applied, skipped: files.length - applied.length };
}

async function main() {
  try {
    const result = await migrate();
    console.log('applied: ' + (result.applied.length ? result.applied.join(', ') : '(none)'));
    console.log('already applied: ' + result.skipped);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

module.exports = { migrate };
