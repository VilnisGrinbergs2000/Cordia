const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  nativeImage,
  net,
  protocol,
  safeStorage,
  screen,
  session,
  shell
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');

// The media session Windows keeps for every player on the machine. Read through
// WinRT, which PowerShell can call; there is no Node binding for it and adding a
// native module for one feature would mean rebuilding it per Electron version.
// Encoded before it reaches powershell.exe, so no quoting rule can break it.
const MEDIA_SESSION_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
  "$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
  'function Await($op, $type) { $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op)); $task.Wait(3000) | Out-Null; $task.Result }',
  '[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null',
  '$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])',
  // Spotify only, by request: the media session also reports whatever browser
  // tab or video player is open, and nobody wants their afternoon's viewing on
  // their profile. The manager keeps every session, so pick the Spotify one.
  "$session = $mgr.GetSessions() | Where-Object { $_.SourceAppUserModelId -match 'spotify' } | Select-Object -First 1",
  "if (-not $session) { Write-Output '{\"none\":true}'; exit }",
  '$props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])',
  '$info = $session.GetPlaybackInfo()',
  '$timeline = $session.GetTimelineProperties()',
  '$out = @{ app = $session.SourceAppUserModelId; title = $props.Title; artist = $props.Artist; album = $props.AlbumTitle; playing = ($info.PlaybackStatus -eq 4); position = [int]$timeline.Position.TotalMilliseconds; duration = [int]$timeline.EndTime.TotalMilliseconds }',
  'Write-Output ($out | ConvertTo-Json -Compress)'
].join('\n');
const { initUpdater, registerUpdaterHandlers } = require('./updater.cjs');

const APP_SCHEME = 'cordia';
const APP_ORIGIN = 'cordia://app';
const isDev = !app.isPackaged;
const devUrl = process.env.CORDIA_DEV_URL || 'http://localhost:3001/app';
const distDir = path.join(__dirname, '..', 'client', 'dist');

let mainWindow = null;
let tray = null;
let quitting = false;
let pendingDisplaySource = null;
let pendingInvite = '';

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

function trustedOrigins() {
  const origins = new Set([APP_ORIGIN]);
  try {
    origins.add(new URL(devUrl).origin);
  } catch {
    // ignore malformed dev URL
  }
  return origins;
}

function originKey(value) {
  try {
    const url = new URL(value);
    if (url.protocol === `${APP_SCHEME}:` && url.host === 'app') return APP_ORIGIN;
    return url.origin;
  } catch {
    return '';
  }
}

function isTrustedOrigin(value) {
  return trustedOrigins().has(originKey(value));
}

function inviteCodeFromArg(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== `${APP_SCHEME}:` || url.host !== 'invite') return '';
    return decodeURIComponent(url.pathname.replace(/^\/+/, '').split('/')[0] || '');
  } catch {
    return '';
  }
}

function inviteCodeFromArgs(args) {
  for (const arg of args || []) {
    const code = inviteCodeFromArg(arg);
    if (code) return code;
  }
  return '';
}

function inviteUrl(code) {
  let base = APP_ORIGIN;
  if (isDev) {
    try {
      base = new URL(devUrl).origin;
    } catch {
      base = APP_ORIGIN;
    }
  }
  return `${base}/invite/${encodeURIComponent(code)}?auto=1`;
}

function openInvite(code) {
  if (!code) return;
  if (!mainWindow) {
    pendingInvite = code;
    return;
  }
  pendingInvite = '';
  mainWindow.loadURL(inviteUrl(code));
  showMainWindow();
}

function registerProtocolClient() {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(APP_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient(APP_SCHEME);
  }
}

function uniqueDownloadPath(filename) {
  const dir = app.getPath('downloads');
  const safeName = path.basename(String(filename || 'cordia-export.json'));
  const extension = path.extname(safeName);
  const base = path.basename(safeName, extension);
  let candidate = path.join(dir, safeName);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${index})${extension}`);
    index += 1;
  }
  return candidate;
}

function configureDownloads() {
  session.defaultSession.on('will-download', (event, item) => {
    item.setSavePath(uniqueDownloadPath(item.getFilename()));
  });
}

function configurePermissions() {
  const ses = session.defaultSession;
  const allowed = new Set(['media', 'display-capture', 'notifications', 'fullscreen', 'clipboard-sanitized-write']);

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = details?.requestingUrl || webContents.getURL();
    callback(isTrustedOrigin(origin) && allowed.has(permission));
  });

  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const origin =
      requestingOrigin && requestingOrigin !== 'null' ? requestingOrigin : webContents.getURL();
    if (!isTrustedOrigin(origin)) return false;
    return permission === 'media' || permission === 'display-capture' || permission === 'notifications';
  });

  ses.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        const selectedId = pendingDisplaySource;
        pendingDisplaySource = null;
        if (!selectedId) return callback({});
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 0, height: 0 }
        });
        const source = sources.find((entry) => entry.id === selectedId);
        if (!source) return callback({});
        callback({
          video: source,
          audio: process.platform === 'win32' ? 'loopback' : undefined
        });
      } catch {
        callback({});
      }
    },
    { useSystemPicker: false }
  );
}

function trustedSender(event) {
  const url = event.senderFrame?.url || event.sender.getURL();
  return isTrustedOrigin(url);
}

function registerDisplaySourceHandlers() {
  ipcMain.handle('cordia:list-display-sources', async (event) => {
    if (!trustedSender(event)) return [];
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 }
      });
      return sources.map((source) => ({
        id: source.id,
        name: source.name,
        kind: source.id.startsWith('screen:') ? 'screen' : 'window',
        displayId: source.display_id || '',
        thumbnail:
          source.thumbnail && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : ''
      }));
    } catch {
      return [];
    }
  });

  ipcMain.handle('cordia:select-display-source', (event, sourceId) => {
    if (!trustedSender(event) || typeof sourceId !== 'string' || !sourceId) return false;
    pendingDisplaySource = sourceId;
    return true;
  });

  ipcMain.handle('cordia:clear-display-source', (event) => {
    if (!trustedSender(event)) return false;
    pendingDisplaySource = null;
    return true;
  });
}

function deviceIdentityFile() {
  return path.join(app.getPath('userData'), 'e2ee-device-identities.json');
}

function readDeviceIdentityStore() {
  try {
    const raw = fs.readFileSync(deviceIdentityFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeDeviceIdentityStore(store) {
  const file = deviceIdentityFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(store), { mode: 0o600 });
}

function validUserId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? String(id) : '';
}

function registerE2eeDeviceHandlers() {
  ipcMain.handle('cordia:e2ee-device-available', (event) => {
    if (!trustedSender(event)) return false;
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  });

  ipcMain.handle('cordia:e2ee-device-save', (event, userId, payload) => {
    if (!trustedSender(event)) return false;
    const id = validUserId(userId);
    if (!id || typeof payload !== 'string' || !payload || payload.length > 4_000_000) return false;
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      const encrypted = safeStorage.encryptString(payload).toString('base64');
      const store = readDeviceIdentityStore();
      store[id] = { encrypted, updatedAt: new Date().toISOString() };
      writeDeviceIdentityStore(store);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle('cordia:e2ee-device-load', (event, userId) => {
    if (!trustedSender(event)) return '';
    const id = validUserId(userId);
    if (!id) return '';
    try {
      if (!safeStorage.isEncryptionAvailable()) return '';
      const entry = readDeviceIdentityStore()[id];
      if (!entry?.encrypted) return '';
      return safeStorage.decryptString(Buffer.from(entry.encrypted, 'base64'));
    } catch {
      return '';
    }
  });

  ipcMain.handle('cordia:e2ee-device-clear', (event, userId) => {
    if (!trustedSender(event)) return false;
    const id = validUserId(userId);
    if (!id) return false;
    try {
      const store = readDeviceIdentityStore();
      if (!store[id]) return true;
      delete store[id];
      writeDeviceIdentityStore(store);
      return true;
    } catch {
      return false;
    }
  });
}

function registerAppProtocol() {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });

    let pathname = decodeURIComponent(url.pathname);
    if (!pathname || pathname === '/') pathname = '/index.html';
    const relative = path.normalize(pathname).replace(/^[/\\]+/, '');
    let filePath = path.join(distDir, relative);

    if (!filePath.startsWith(distDir)) {
      return new Response('Not found', { status: 404 });
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(distDir, 'index.html');
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });
}

function applyContentSecurityPolicy() {
  if (isDev) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; " +
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
            "img-src 'self' data: blob: http: https:; media-src 'self' blob: http: https:; " +
            "connect-src 'self' http: https: ws: wss:; " +
            "font-src 'self' data: https://fonts.gstatic.com;"
        ]
      }
    });
  });
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;
  const iconPath = isDev
    ? path.join(__dirname, '..', 'client', 'public', 'icon-192.png')
    : path.join(distDir, 'icon-192.png');
  const image = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip('Cordia');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Cordia', click: showMainWindow },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ])
  );
  tray.on('click', showMainWindow);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only needs contextBridge, ipcRenderer and process, all of
      // which exist in a sandboxed renderer, so the renderer never gets Node.
      sandbox: true,
      spellcheck: true
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // A server-side 302 is not a navigation the page started, so will-navigate
  // never sees it. The OAuth entry point is same-origin and trusted, so the
  // guard below lets it through - and the hop to Spotify then carries the whole
  // window away, leaving the app on someone else's login page with no way back.
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (isTrustedOrigin(url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isTrustedOrigin(url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  if (isDev) mainWindow.loadURL(devUrl);
  else mainWindow.loadURL(`${APP_ORIGIN}/`);
}

// ── Game overlay ────────────────────────────────────────────────────────────
// A transparent, click-through, always-on-top window that draws over a windowed
// or borderless game. It is not an injected renderer hook: an exclusive-
// fullscreen game owns the display and no ordinary window can appear over it,
// so the settings card says that instead of pretending otherwise.
const OVERLAY_WIDTH = 300;
const OVERLAY_MARGIN = 16;
const OVERLAY_HOTKEY = 'Shift+`';
const OVERLAY_LOCK_HOTKEY = 'CommandOrControl+Shift+`';
const OVERLAY_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

let overlayWindow = null;
let overlayState = null;
let overlayVisible = true;
// Locked means click-through and focusable:false, which is the default. Unlocked
// (Ctrl+Shift+`) turns the window into a normal, movable, focusable one so the
// controls and the composer can be used without leaving the game.
let overlayInteractive = false;
let overlayConfig = {
  enabled: false,
  corner: 'top-right',
  showSelf: true,
  showChat: true,
  opacity: 94
};
let overlayShortcutOn = false;
let overlayDragged = null;
let overlayApplyingBounds = false;

function overlayPositionFile() {
  return path.join(app.getPath('userData'), 'overlay-window.json');
}

function readOverlayPosition() {
  if (overlayDragged) return overlayDragged;
  try {
    const saved = JSON.parse(fs.readFileSync(overlayPositionFile(), 'utf8'));
    if (Number.isFinite(saved && saved.x) && Number.isFinite(saved && saved.y)) {
      return { x: saved.x, y: saved.y };
    }
  } catch {
    // first run, or a corrupt file: the corner wins
  }
  return null;
}

function saveOverlayPosition(bounds) {
  overlayDragged = { x: bounds.x, y: bounds.y };
  try {
    fs.writeFileSync(overlayPositionFile(), JSON.stringify(overlayDragged));
  } catch {
    // a read-only profile is not worth failing a drag over
  }
}

function overlayBounds(height, width) {
  const area = screen.getPrimaryDisplay().bounds;
  const w = Math.max(240, Math.min(440, Math.round(Number(width) || OVERLAY_WIDTH)));
  const h = Math.max(72, Math.min(560, Math.round(Number(height) || 120)));
  const dragged = readOverlayPosition();
  if (dragged) {
    // A dragged window keeps its spot until the corner setting changes.
    return { x: dragged.x, y: dragged.y, width: w, height: h };
  }
  const corner = String(overlayConfig.corner || 'top-right');
  const left = corner.endsWith('left');
  const top = corner.startsWith('top');
  return {
    x: left ? area.x + OVERLAY_MARGIN : area.x + area.width - w - OVERLAY_MARGIN,
    y: top ? area.y + OVERLAY_MARGIN : area.y + area.height - h - OVERLAY_MARGIN,
    width: w,
    height: h
  };
}

function ensureOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
  overlayWindow = new BrowserWindow({
    ...overlayBounds(120),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  // screen-saver level survives a game window claiming focus; 'floating' does
  // not. Click-through means the game keeps every mouse event while locked.
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.on('moved', () => {
    // Programmatic setBounds also emits 'moved'; only a real drag should
    // overwrite the saved spot.
    if (!overlayInteractive || overlayApplyingBounds) return;
    saveOverlayPosition(overlayWindow.getBounds());
  });
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
  overlayWindow.webContents.once('did-finish-load', () => {
    if (overlayState) overlayWindow.webContents.send('overlay:state', overlayState);
    overlayWindow.webContents.send('overlay:visible', overlayVisible);
    overlayWindow.webContents.send('overlay:mode', overlayInteractive);
  });
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  return overlayWindow;
}

function setOverlayInteractive(next) {
  const value = !!next;
  if (value === overlayInteractive) return;
  overlayInteractive = value;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.setIgnoreMouseEvents(!value, { forward: true });
  overlayWindow.setFocusable(value);
  overlayWindow.setMovable(value);
  overlayWindow.webContents.send('overlay:mode', value);
  if (value) {
    overlayWindow.show();
    overlayWindow.focus();
  } else {
    overlayWindow.blur();
  }
}

function applyOverlay() {
  const wanted = overlayConfig.enabled && overlayVisible && !!(overlayState && overlayState.connected);
  if (!wanted) {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      setOverlayInteractive(false);
      overlayWindow.hide();
    }
    return;
  }
  const win = ensureOverlay();
  // The panel is translucent by design: it sits over a game, so a little of the
  // scene showing through keeps it from reading as a black hole.
  win.setOpacity(Math.max(0.5, Math.min(1, overlayConfig.opacity / 100)));
  overlayApplyingBounds = true;
  win.setBounds(overlayBounds(win.getBounds().height, win.getBounds().width));
  overlayApplyingBounds = false;
  if (!win.isVisible()) {
    if (overlayInteractive) win.show();
    else win.showInactive();
  }
}

function registerOverlayShortcuts() {
  if (!app.isReady()) return;
  globalShortcut.unregister(OVERLAY_HOTKEY);
  globalShortcut.unregister(OVERLAY_LOCK_HOTKEY);
  overlayShortcutOn = false;
  if (!overlayConfig.enabled) return;
  try {
    overlayShortcutOn = globalShortcut.register(OVERLAY_HOTKEY, () => {
      overlayVisible = !overlayVisible;
      if (!overlayVisible) setOverlayInteractive(false);
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send('overlay:visible', overlayVisible);
      }
      applyOverlay();
    });
    globalShortcut.register(OVERLAY_LOCK_HOTKEY, () => {
      if (!overlayWindow || !overlayWindow.isVisible()) {
        overlayVisible = true;
        applyOverlay();
        setOverlayInteractive(true);
        return;
      }
      setOverlayInteractive(!overlayInteractive);
    });
  } catch {
    overlayShortcutOn = false;
  }
  if (!overlayShortcutOn) console.warn('[overlay] could not register', OVERLAY_HOTKEY);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setAppUserModelId('app.cordia.client');
  registerProtocolClient();

  const startupInvite = inviteCodeFromArgs(process.argv);

  app.on('second-instance', (event, commandLine) => {
    const code = inviteCodeFromArgs(commandLine);
    if (code) openInvite(code);
    else showMainWindow();
  });

  app.on('open-url', (event, url) => {
    const code = inviteCodeFromArg(url);
    if (!code) return;
    event.preventDefault();
    if (app.isReady()) openInvite(code);
    else pendingInvite = code;
  });

  app.whenReady().then(() => {
    registerAppProtocol();
    configurePermissions();
    configureDownloads();
    registerDisplaySourceHandlers();
    registerE2eeDeviceHandlers();
    registerUpdaterHandlers();
    applyContentSecurityPolicy();
    createWindow();
    if (startupInvite) openInvite(startupInvite);
    else if (pendingInvite) openInvite(pendingInvite);
    createTray();
    initUpdater({ getWindow: () => mainWindow });

    app.on('activate', () => {
      if (!mainWindow) createWindow();
      else showMainWindow();
    });
  });

  app.on('before-quit', () => {
    quitting = true;
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  app.on('window-all-closed', () => {
    if (process.platform === 'darwin') return;
  });

  ipcMain.on('cordia:show-window', showMainWindow);

  // The renderer owns the overlay's settings and its data; the main process only
  // applies them. Config arrives on every state push, so the shortcut is only
  // re-registered when the switch actually changes.
  ipcMain.on('cordia:overlay-config', (event, config) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    const next = config && typeof config === 'object' ? config : {};
    const wasEnabled = overlayConfig.enabled;
    const corner = OVERLAY_CORNERS.includes(next.corner) ? next.corner : 'top-right';
    // Choosing a corner is an explicit instruction, so it clears a dragged spot.
    if (corner !== overlayConfig.corner) overlayDragged = null;
    overlayConfig = {
      enabled: next.enabled === true,
      corner,
      showSelf: next.showSelf !== false,
      showChat: next.showChat !== false,
      opacity: Math.max(50, Math.min(100, Math.round(Number(next.opacity) || 94)))
    };
    if (!overlayConfig.enabled) {
      overlayVisible = true;
      setOverlayInteractive(false);
    }
    if (overlayConfig.enabled !== wasEnabled) registerOverlayShortcuts();
    applyOverlay();
  });

  ipcMain.on('cordia:overlay-state', (event, state) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return;
    overlayState = state && typeof state === 'object' ? state : null;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('overlay:state', overlayState || { connected: false });
    }
    applyOverlay();
  });

  // Only the overlay page may resize the overlay window. It reports both
  // dimensions because the panel widens when the chat column is shown.
  ipcMain.on('overlay:resize', (event, size) => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    if (event.sender !== overlayWindow.webContents) return;
    const height = typeof size === 'number' ? size : size && size.height;
    const width = size && typeof size === 'object' ? size.width : undefined;
    overlayApplyingBounds = true;
    overlayWindow.setBounds(overlayBounds(height, width));
    overlayApplyingBounds = false;
  });

  // Controls inside the overlay (mic, deafen, leave, send) are executed by the
  // renderer, which already owns the voice session and the socket. Main is only
  // the wire between the two windows.
  ipcMain.on('overlay:command', (event, command) => {
    if (!overlayWindow || event.sender !== overlayWindow.webContents) return;
    if (!command || typeof command.type !== 'string') return;
    // Locking is a window concern, not a voice one: doing it here avoids a
    // pointless round trip through the renderer.
    if (command.type === 'lock') {
      setOverlayInteractive(false);
      return;
    }
    if (!mainWindow) return;
    mainWindow.webContents.send('cordia:overlay-command', command);
  });


  // The renderer asks for this instead of navigating. Used for OAuth entry
  // points, where the consent screen must live in a different cookie jar from
  // the app.
  ipcMain.handle('cordia:open-external', (_event, url) => {
    const target = String(url || '');
    if (!/^https?:/i.test(target)) return false;
    shell.openExternal(target);
    return true;
  });

  // What this computer is playing, for the "now playing" presence. Resolves to
  // null rather than throwing: a machine without the WinRT surface (an old
  // Windows build, a locked-down policy) simply has no answer, and the settings
  // card already says detection is desktop-only.
  ipcMain.handle('cordia:media-session', () => new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    const encoded = Buffer.from(MEDIA_SESSION_SCRIPT, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 5000 },
      (error, stdout) => {
        if (error || !stdout) return resolve(null);
        const line = String(stdout).trim().split(/\r?\n/).pop();
        try {
          resolve(JSON.parse(line));
        } catch {
          resolve(null);
        }
      }
    );
  }));
}
