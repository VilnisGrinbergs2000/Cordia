const { contextBridge, ipcRenderer } = require('electron');

// The overlay page is deliberately dumb: it renders whatever state the main
// process last received, reports its own size so the window can hug the panel,
// and sends commands back up the chain (overlay -> main -> renderer) instead of
// talking to the server itself.
contextBridge.exposeInMainWorld('cordiaOverlay', {
  onState: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('overlay:state', handler);
    return () => ipcRenderer.removeListener('overlay:state', handler);
  },
  onVisible: (listener) => {
    const handler = (_event, visible) => listener(visible);
    ipcRenderer.on('overlay:visible', handler);
    return () => ipcRenderer.removeListener('overlay:visible', handler);
  },
  onMode: (listener) => {
    const handler = (_event, interactive) => listener(interactive);
    ipcRenderer.on('overlay:mode', handler);
    return () => ipcRenderer.removeListener('overlay:mode', handler);
  },
  resize: (size) => ipcRenderer.send('overlay:resize', size),
  command: (command) => ipcRenderer.send('overlay:command', command)
});
