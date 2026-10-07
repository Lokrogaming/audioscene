const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('audioScene', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  pickDir: () => ipcRenderer.invoke('dialog:pick-dir'),
  openDir: (dir) => ipcRenderer.invoke('shell:open-dir', dir),
  getPaths: () => ipcRenderer.invoke('app:get-music-path'),
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  listWindows: () => ipcRenderer.invoke('windows:list'),
  recBegin: (opts) => ipcRenderer.invoke('rec:begin', opts),
  recAppend: (sessionId, chunk) => ipcRenderer.invoke('rec:append', { sessionId, chunk }),
  recFinalize: (sessionId, filename) => ipcRenderer.invoke('rec:finalize', { sessionId, filename }),
  recAbort: (sessionId) => ipcRenderer.invoke('rec:abort', { sessionId }),
  recPartials: () => ipcRenderer.invoke('rec:partials')
});
