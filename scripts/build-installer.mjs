#!/usr/bin/env node
// Builds the desktop client and the Windows installer in one step.
//
// Set CORDIA_UPDATE_URL to also emit latest.yml for a generic feed. That file is
// what electron-updater fetches from the same URL at runtime, so a self-hosted
// release is: build with the env var, upload the installer, the blockmap and
// latest.yml to that URL.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const feed = String(process.env.CORDIA_UPDATE_URL || '').trim();
const outDir = String(process.env.CORDIA_OUTPUT_DIR || '').trim();

function run(command, args, { shell = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(command + ' exited with ' + code));
    });
  });
}

try {
  console.log('[installer] building the desktop client');
  await run('npm --prefix client run build:desktop', [], { shell: true });

  const args = [
    path.join(root, 'node_modules/electron-builder/cli.js'),
    '--win',
    'nsis',
    '--publish',
    'never'
  ];
  if (outDir) args.push('--config.directories.output=' + outDir);
  if (feed) {
    args.push('--config.publish.provider=generic', '--config.publish.url=' + feed);
    console.log('[installer] feed: ' + feed);
  } else {
    console.log('[installer] no CORDIA_UPDATE_URL, so latest.yml is not generated');
  }

  console.log('[installer] packaging');
  await run(process.execPath, args);

  console.log('[installer] done');
  const out = outDir || 'release';
  console.log('  ' + out + '/Cordia-Setup-<version>.exe');
  if (feed) console.log('  ' + out + '/latest.yml  (upload this next to the installer)');
} catch (error) {
  console.error('[installer] ' + (error?.message || error));
  process.exit(1);
}
