const { app, ipcMain } = require('electron');

const FEED_ENV = 'CORDIA_UPDATE_URL';
// Baked, because a packaged build launched from a shortcut has no environment
// at all - the env var only ever exists for a build someone started by hand.
// The variable still wins when it is set, which is what points a test build at
// a local feed.
const DEFAULT_FEED_URL = 'https://cordia.ext.io/downloads';
const CHECK_DELAY_MS = 8000;

let autoUpdater = null;
let getWindow = () => null;
let initialized = false;

let state = {
  status: 'idle',
  currentVersion: app.getVersion(),
  version: '',
  percent: 0,
  error: '',
  releaseNotes: ''
};

function snapshot() {
  return { ...state, currentVersion: app.getVersion() };
}

function broadcast() {
  const win = getWindow();
  if (!win || win.isDestroyed()) return;
  win.webContents.send('cordia:update-status', snapshot());
}

function setState(patch) {
  state = { ...state, ...patch };
  broadcast();
}

function disabled(reason) {
  setState({ status: 'disabled', error: reason });
}

function releaseNotesOf(info) {
  const notes = info?.releaseNotes;
  if (typeof notes === 'string') return notes.slice(0, 8000);
  if (Array.isArray(notes)) {
    return notes
      .map((entry) => (typeof entry === 'string' ? entry : entry?.note || ''))
      .filter(Boolean)
      .join('\n')
      .slice(0, 8000);
  }
  return '';
}

function wireEvents() {
  autoUpdater.on('checking-for-update', () => setState({ status: 'checking', error: '' }));

  autoUpdater.on('update-available', (info) => {
    setState({
      status: 'available',
      version: info?.version || '',
      releaseNotes: releaseNotesOf(info),
      percent: 0
    });
  });

  autoUpdater.on('update-not-available', () => setState({ status: 'current', version: '', percent: 0 }));

  autoUpdater.on('download-progress', (progress) => {
    setState({
      status: 'downloading',
      percent: Math.max(0, Math.min(100, Math.round(progress?.percent || 0)))
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    setState({
      status: 'downloaded',
      version: info?.version || state.version,
      percent: 100,
      releaseNotes: releaseNotesOf(info) || state.releaseNotes
    });
  });

  autoUpdater.on('error', (error) => {
    setState({ status: 'error', error: String(error?.message || error || 'Update failed') });
  });
}

function initUpdater(options = {}) {
  if (initialized) return;
  initialized = true;
  getWindow = options.getWindow || getWindow;

  if (!app.isPackaged) {
    disabled('Updates are only checked in a packaged build.');
    return;
  }

  const feedUrl = String(process.env[FEED_ENV] || DEFAULT_FEED_URL).trim();
  if (!feedUrl) {
    disabled('No update feed configured.');
    return;
  }

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    disabled('Updater component is not installed.');
    return;
  }

  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
    // Downloaded without a prompt: an update nobody opens Settings to accept is
    // an update nobody gets. Installing still waits for the app to quit, or for
    // the Restart button in the updates panel.
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    wireEvents();
    setState({ status: 'idle', error: '' });
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((error) => {
        setState({ status: 'error', error: String(error?.message || error) });
      });
    }, CHECK_DELAY_MS).unref?.();
  } catch (error) {
    disabled(String(error?.message || error));
  }
}

async function check() {
  if (!autoUpdater) return snapshot();
  setState({ status: 'checking', error: '' });
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    setState({ status: 'error', error: String(error?.message || error) });
  }
  return snapshot();
}

async function download() {
  if (!autoUpdater) return snapshot();
  try {
    setState({ status: 'downloading', percent: 0 });
    await autoUpdater.downloadUpdate();
  } catch (error) {
    setState({ status: 'error', error: String(error?.message || error) });
  }
  return snapshot();
}

function install() {
  if (!autoUpdater) return false;
  // Silent. The first argument is the whole point: false brings up the NSIS
  // wizard, which is the installer the person already ran once and does not
  // want to see again. The quit handler electron-updater installs itself is
  // silent too, so closing the app and pressing Restart now behave the same.
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
  return true;
}

function registerUpdaterHandlers() {
  ipcMain.handle('cordia:app-info', () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform
  }));

  ipcMain.handle('cordia:update-status', () => snapshot());
  ipcMain.handle('cordia:update-check', () => check());
  ipcMain.handle('cordia:update-download', () => download());
  ipcMain.handle('cordia:update-install', () => install());
}

module.exports = { initUpdater, registerUpdaterHandlers };
