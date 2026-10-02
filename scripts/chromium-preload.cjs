const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Expose only the path of a user-supplied File, never filesystem or IPC access.
// The isolated, sandboxed renderer otherwise cannot recover Finder paths.
contextBridge.exposeInMainWorld("latticeDesktop", {
  getPathForFile: (file) => webUtils.getPathForFile(file),
});

// Perf-lab launches only (scripts/chromium-perf-lab.mjs passes the argument):
// native input through Chromium's input pipeline for the measurement harness.
if (process.argv.includes("--lattice-perf-lab")) {
  const send = (message) => ipcRenderer.invoke("lattice-lab", message);
  contextBridge.exposeInMainWorld("latticeLab", {
    focus: () => send({ type: "focus" }),
    keys: (text) => send({ type: "keys", text }),
    wheel: (x, y, dy) => send({ type: "wheel", x, y, dy }),
    mouse: (points, intervalMs) => send({ type: "mouse", points, intervalMs }),
    pinch: (x, y, dy) => send({ type: "pinch", x, y, dy }),
    snapshot: (path) => send({ type: "snapshot", path }),
    metrics: () => send({ type: "metrics" }),
  });
}
