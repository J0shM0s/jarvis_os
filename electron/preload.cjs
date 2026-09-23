// Preload — WorkWindow IPC
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('jarvisDesktop', {
  isDesktop: true,
  version: process.env.npm_package_version || '0.0.0',
  openWorkWindow: () => ipcRenderer.send('open-work-window'),
  closeWorkWindow: () => ipcRenderer.send('close-work-window'),
});
