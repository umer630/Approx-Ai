// Exposes only version + update actions to the Approx web app (no Node access for the page).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('approxDesktop', {
  version: () => ipcRenderer.invoke('approx:version'),
  checkForUpdates: () => ipcRenderer.invoke('approx:check'),
  updateNow: () => ipcRenderer.invoke('approx:update'),
});
