/**
 * Preload for the desktop lock window. Exposes a minimal, promise-based bridge
 * so the lock page (data: URL, contextIsolation on) can talk to the main
 * process without gaining Node access.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopLock", {
  submitUnlock: (password) => ipcRenderer.invoke("lock:unlock", String(password || "")),
  submitSetup: (password) => ipcRenderer.invoke("lock:setup", String(password || "")),
  skip: () => ipcRenderer.invoke("lock:skip"),
});
