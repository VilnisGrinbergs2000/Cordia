'use strict';

// pg/pool throws at import time when DATABASE_URL is missing, and nothing in the
// app loads server/.env (there is no dotenv dependency). Without this shim a
// plain `node src/index.js` would stop booting the moment a route imports the
// pool, so fill the gap from server/.env before pool.js reads process.env.
//
// Every key is filled, not just DATABASE_URL: the file is also where the SMTP
// credentials and the TURN credentials live, and a shell that happened to export
// DATABASE_URL used to skip the whole file, which made those settings look
// ignored. Real environment variables still win - the loop only fills what is
// not already set.
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    if (!process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '').trim();
    }
  }
}

module.exports = {};
