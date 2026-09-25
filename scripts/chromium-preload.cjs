const { contextBridge, webUtils } = require("electron");

// Expose only the path of a user-supplied File, never filesystem or IPC access.
// The isolated, sandboxed renderer otherwise cannot recover Finder paths.
contextBridge.exposeInMainWorld("latticeDesktop", {
  getPathForFile: (file) => webUtils.getPathForFile(file),
});
