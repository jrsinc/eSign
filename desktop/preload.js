// Bridge for the app's own local pages (settings and offline screen) only.
// The remote Method 365 website never gets this bridge, so it cannot change the app's settings.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('esignDesktop', {
    getSettings: () => ipcRenderer.invoke('settings:get'),
    saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
    retry: () => ipcRenderer.invoke('app:retry'),
    openSettings: () => ipcRenderer.invoke('app:openSettings'),
  });
}
