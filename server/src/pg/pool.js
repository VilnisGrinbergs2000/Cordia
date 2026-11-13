'use strict';

// Postgres access layer (Phase 1: additive, not yet wired into the app).
const { Pool, types } = require('pg');
const { AsyncLocalStorage } = require('node:async_hooks');

// pg hands back int8 (OID 20) as a string by default. The schema stores every
// integer as bigint, so parse them into JS numbers to preserve app semantics.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('pg/pool: DATABASE_URL is not set');
}

const pool = new Pool({ connectionString, max: 10 });

// Holds the checked-out client for the current transaction so that any helper
// calling query() inside withTransaction() automatically joins that transaction.
const txStorage = new AsyncLocalStorage();

function query(text, params) {
  const txClient = txStorage.getStore();
  return txClient ? txClient.query(text, params) : pool.query(text, params);
}

async function withTransaction(fn) {
  // A nested call (ensureDefaultGroups inside server creation, for example)
  // must join the open transaction. Taking a second connection would hide the
  // outer transaction's uncommitted rows and fail foreign keys that point at
  // them.
  const current = txStorage.getStore();
  if (current) return fn(current);
  const client = await pool.connect();
  let open = false;
  try {
    await client.query('BEGIN');
    open = true;
    const result = await txStorage.run(client, () => fn(client));
    await client.query('COMMIT');
    open = false;
    return result;
  } catch (err) {
    if (open) {
      try { await client.query('ROLLBACK'); } catch (rollbackErr) { /* connection already gone */ }
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
