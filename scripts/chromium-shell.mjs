import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, Menu, shell } from "electron";

const DEFAULT_ENTRY_URL = "http://127.0.0.1:18452/";
const entryUrl = new URL(process.env.LATTICE_CHROMIUM_URL ?? DEFAULT_ENTRY_URL);
const shellMarker = "latticeChromium";
const developmentOrigins = new Set([
  "http://127.0.0.1:1420",
  "http://localhost:1420",
]);
const windowsByLabel = new Map();
const pendingLabels = new Set();
let quitting = false;

if (entryUrl.protocol !== "http:" || entryUrl.hostname !== "127.0.0.1") {
  throw new Error("LATTICE_CHROMIUM_URL must use http://127.0.0.1 so credentials stay on loopback.");
}

function isTrustedAppUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.origin === entryUrl.origin || developmentOrigins.has(url.origin);
  } catch {
    return false;
  }
}

function chromiumUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.set(shellMarker, "1");
  return url;
}

function labelFromUrl(rawUrl) {
  try {
    const hash = new URLSearchParams(new URL(rawUrl).hash.replace(/^#/, ""));
    return hash.get("label");
  } catch {
    return null;
  }
}

function focusWindow(window) {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function installApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ]));
}

async function latticeBackendAvailable() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(entryUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status >= 200 && response.status < 400) return true;
    } catch {
      // The native owner may still be binding the loopback listener.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function inspectRenderer(window) {
  let lastState = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await window.webContents.executeJavaScript(`({
      appMounted: Boolean(document.querySelector('#root > *')),
      browserHosted: document.querySelector('.app-shell')?.classList.contains('browser-hosted') ?? false,
      visualEditorMounted: Boolean(document.querySelector('.visual-markdown-editor')),
      contentVisibility: CSS.supports('content-visibility', 'auto'),
      scrollTimeline: typeof ScrollTimeline === 'function',
      userAgent: navigator.userAgent,
      label: window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ?? null,
      href: window.location.href,
    })`);
    lastState = state;
    if (state.appMounted) return state;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `The Chromium renderer loaded, but Lattice did not mount within 10 seconds: ${JSON.stringify(lastState)}`,
  );
}

async function createWindow(rawUrl) {
  const url = chromiumUrl(rawUrl);
  const requestedLabel = labelFromUrl(url);
  if (requestedLabel) pendingLabels.add(requestedLabel);
  const window = new BrowserWindow({
    title: "Lattice",
    width: 1_440,
    height: 900,
    minWidth: 1_222,
    minHeight: 680,
    backgroundColor: "#F7F7F6",
    show: false,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isTrustedAppUrl(url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("did-finish-load", () => {
    // Browser-hosted CSS assumes an ordinary browser tab has no traffic
    // lights. Restore the native macOS inset and make only the empty titlebar
    // strip draggable so this Chromium experiment behaves like an app window.
    void window.webContents.insertCSS(`
      .app-shell.browser-hosted .traffic-space {
        width: 70px !important;
      }
      .app-shell.browser-hosted .titlebar-navigator {
        width: var(--titlebar-navigator-width) !important;
        padding: 0 !important;
      }
      .app-shell.browser-hosted .titlebar-sidebar-toggle .icon-button {
        left: var(--titlebar-toggle-center) !important;
      }
      .titlebar-drag-area {
        -webkit-app-region: drag;
      }
    `);
  });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    for (const [label, candidate] of windowsByLabel) {
      if (candidate === window) windowsByLabel.delete(label);
    }
    if (requestedLabel) pendingLabels.delete(requestedLabel);
  });

  try {
    await window.loadURL(url.href);
    const renderer = await inspectRenderer(window);
    const label = renderer.label ?? requestedLabel;
    if (label) windowsByLabel.set(label, window);
    if (requestedLabel) pendingLabels.delete(requestedLabel);
    return { window, renderer };
  } catch (error) {
    if (requestedLabel) pendingLabels.delete(requestedLabel);
    window.destroy();
    throw error;
  }
}

async function openWorkspace(rawUrl) {
  if (!isTrustedAppUrl(rawUrl)) {
    throw new Error("The Chromium shell refused a non-Lattice workspace URL.");
  }
  const label = labelFromUrl(rawUrl);
  const existing = label ? windowsByLabel.get(label) : null;
  if (existing && !existing.isDestroyed()) {
    focusWindow(existing);
    return existing;
  }
  if (label && pendingLabels.has(label)) return null;
  const created = await createWindow(rawUrl);
  return created.window;
}

function focusExistingWindow() {
  const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
  if (!window) return false;
  focusWindow(window);
  return true;
}

function installControlPipe() {
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message?.type !== "open-url" || typeof message.url !== "string") return;
    void openWorkspace(message.url).catch((error) => {
      console.error(error);
      dialog.showErrorBox("Could not open Lattice", error instanceof Error ? error.message : String(error));
    });
  });
  input.on("close", () => {
    if (process.env.LATTICE_CHROMIUM_MANAGED === "1" && !quitting) app.quit();
  });
}

app.setName("Lattice");

const lockAcquired = app.requestSingleInstanceLock();
if (!lockAcquired) {
  app.quit();
} else {
  app.on("second-instance", () => {
    focusExistingWindow();
  });
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("activate", () => {
    if (!focusExistingWindow()) {
      void openWorkspace(entryUrl.href).catch((error) => {
        console.error(error);
        dialog.showErrorBox("Could not open Lattice", error instanceof Error ? error.message : String(error));
      });
    }
  });
  app.whenReady().then(async () => {
    const scriptDirectory = dirname(fileURLToPath(import.meta.url));
    const packagedIcon = join(scriptDirectory, "..", "lattice.png");
    const developmentIcon = join(scriptDirectory, "..", "src-tauri", "icons", "icon.png");
    const icon = [packagedIcon, developmentIcon].find(existsSync);
    if (icon && app.dock) app.dock.setIcon(icon);
    installApplicationMenu();
    installControlPipe();
    if (!await latticeBackendAvailable()) {
      const reason = `Lattice could not connect to its local service at ${entryUrl.href}.`;
      console.error(reason);
      dialog.showErrorBox("Could not start Lattice", reason);
      app.quit();
      return;
    }
    const { window, renderer } = await createWindow(entryUrl.href);
    const chromiumVersion = process.versions.chrome;
    console.log(`Lattice Chromium shell ready — Chromium ${chromiumVersion}, Electron ${process.versions.electron}`);
    console.log("Renderer capabilities:", renderer);
    if (process.env.LATTICE_CHROMIUM_SCREENSHOT) {
      const image = await window.webContents.capturePage();
      await writeFile(process.env.LATTICE_CHROMIUM_SCREENSHOT, image.toPNG());
      console.log(`Captured ${process.env.LATTICE_CHROMIUM_SCREENSHOT}`);
    }
  }).catch((error) => {
    console.error(error);
    app.quit();
  });
}
