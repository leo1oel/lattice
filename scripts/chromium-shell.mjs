import { writeFile } from "node:fs/promises";
import { app, BrowserWindow, Menu, shell } from "electron";

const DEFAULT_ENTRY_URL = "http://127.0.0.1:18452/";
const entryUrl = new URL(process.env.LATTICE_CHROMIUM_URL ?? DEFAULT_ENTRY_URL);
const developmentOrigins = new Set([
  "http://127.0.0.1:1420",
  "http://localhost:1420",
]);

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
  try {
    const response = await fetch(entryUrl, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
    return response.status >= 200 && response.status < 400;
  } catch {
    return false;
  }
}

async function inspectRenderer(window) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await window.webContents.executeJavaScript(`({
      appMounted: Boolean(document.querySelector('.app-shell')),
      browserHosted: document.querySelector('.app-shell')?.classList.contains('browser-hosted') ?? false,
      visualEditorMounted: Boolean(document.querySelector('.visual-markdown-editor')),
      contentVisibility: CSS.supports('content-visibility', 'auto'),
      scrollTimeline: typeof ScrollTimeline === 'function',
      userAgent: navigator.userAgent,
    })`);
    if (state.appMounted) return state;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The Chromium renderer loaded, but Lattice did not mount within 10 seconds.");
}

async function createWindow() {
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

  try {
    await window.loadURL(entryUrl.href);
    return window;
  } catch (error) {
    window.destroy();
    throw error;
  }
}

app.setName("Lattice Chromium");

const lockAcquired = app.requestSingleInstanceLock();
if (!lockAcquired) {
  app.quit();
} else {
  let mainWindow = null;
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.on("window-all-closed", () => app.quit());
  app.whenReady().then(async () => {
    installApplicationMenu();
    if (!await latticeBackendAvailable()) {
      console.error(
        `Lattice is not serving ${entryUrl.href}. Start the installed app with browser access enabled, then run pnpm chromium again.`,
      );
      app.quit();
      return;
    }
    mainWindow = await createWindow();
    const renderer = await inspectRenderer(mainWindow);
    const chromiumVersion = process.versions.chrome;
    console.log(`Lattice Chromium shell ready — Chromium ${chromiumVersion}, Electron ${process.versions.electron}`);
    console.log("Renderer capabilities:", renderer);
    if (process.env.LATTICE_CHROMIUM_SCREENSHOT) {
      const image = await mainWindow.webContents.capturePage();
      await writeFile(process.env.LATTICE_CHROMIUM_SCREENSHOT, image.toPNG());
      console.log(`Captured ${process.env.LATTICE_CHROMIUM_SCREENSHOT}`);
    }
  }).catch((error) => {
    console.error(error);
    app.quit();
  });
}
