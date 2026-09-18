// Preload — aktuell nichts nötig, aber Kontext-Isolation aktiv
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('jarvisDesktop', { isDesktop: true, version: process.env.npm_package_version || '0.0.0' });
