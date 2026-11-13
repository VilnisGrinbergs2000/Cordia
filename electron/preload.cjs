const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cordiaDesktop', {
  isDesktop: true,
  platform: process.platform,
  // True when Electron runs this preload in a sandboxed renderer. Surfaced so a
  // packaged build can be checked without attaching a debugger.
  sandboxed: process.sandboxed === true,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome
  },
  // Sandboxed preloads expose a cut-down process; guard the read so a missing
  // env object cannot take the whole bridge down with it.
  apiUrl: (process.env && process.env.CORDIA_API_URL) || '',
  showWindow: () => ipcRenderer.send('cordia:show-window'),
  // Opens a link in the system browser. Used for OAuth entry points, where the
  // consent screen has to be a different cookie jar from the app.
  openExternal: (url) => ipcRenderer.invoke('cordia:open-external', url),
  listDisplaySources: () => ipcRenderer.invoke('cordia:list-display-sources'),
  selectDisplaySource: (sourceId) => ipcRenderer.invoke('cordia:select-display-source', sourceId),
  clearDisplaySource: () => ipcRenderer.invoke('cordia:clear-display-source'),
  isE2eeDeviceStorageAvailable: () => ipcRenderer.invoke('cordia:e2ee-device-available'),
  saveE2eeDeviceIdentity: (userId, payload) =>
    ipcRenderer.invoke('cordia:e2ee-device-save', userId, payload),
  loadE2eeDeviceIdentity: (userId) => ipcRenderer.invoke('cordia:e2ee-device-load', userId),
  clearE2eeDeviceIdentity: (userId) => ipcRenderer.invoke('cordia:e2ee-device-clear', userId),
  appInfo: () => ipcRenderer.invoke('cordia:app-info'),
  // What this computer is playing, straight from the Windows media session.
  // Resolves to null on anything that is not Windows or when nothing is open.
  mediaSession: () => ipcRenderer.invoke('cordia:media-session'),
  // Game overlay: the renderer owns the data and the settings, the main process
  // owns the window. Both calls are fire-and-forget.
  overlay: {
    configure: (config) => ipcRenderer.send('cordia:overlay-config', config),
    pushState: (state) => ipcRenderer.send('cordia:overlay-state', state),
    // Commands typed or clicked in the overlay window, relayed here so the app
    // can act on them with the session it already holds.
    onCommand: (listener) => {
      const handler = (_event, command) => listener(command);
      ipcRenderer.on('cordia:overlay-command', handler);
      return () => ipcRenderer.removeListener('cordia:overlay-command', handler);
    }
  },
  updates: {
    status: () => ipcRenderer.invoke('cordia:update-status'),
    check: () => ipcRenderer.invoke('cordia:update-check'),
    download: () => ipcRenderer.invoke('cordia:update-download'),
    install: () => ipcRenderer.invoke('cordia:update-install'),
    onStatus: (listener) => {
      const handler = (_event, payload) => listener(payload);
      ipcRenderer.on('cordia:update-status', handler);
      return () => ipcRenderer.removeListener('cordia:update-status', handler);
    }
  }
});
