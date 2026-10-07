const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('audioScene', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  getDefaultDir: () => ipcRenderer.invoke('settings:default-dir'),
  pickDir: () => ipcRenderer.invoke('dialog:pick-dir'),
  saveFileDialog: (opts) => ipcRenderer.invoke('dialog:save-file', opts),
  saveBuffer: (filePath, buffer) => ipcRenderer.invoke('file:save-buffer', { filePath, buffer }),
  openDir: (dir) => ipcRenderer.invoke('shell:open-dir', dir),
  getPaths: () => ipcRenderer.invoke('app:get-music-path'),
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  listWindows: () => ipcRenderer.invoke('windows:list')
});
