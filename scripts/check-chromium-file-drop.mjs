// Run with pnpm exec electron scripts/check-chromium-file-drop.mjs while Vite is on 127.0.0.1:1420.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

// Keep the process alive for async fixture cleanup and assertion reporting.
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  console.log("Preparing desktop file-drop regression");
  const directory = await mkdtemp(join(tmpdir(), "lattice-finder-drop-"));
  const path = join(directory, "notes.md");
  await writeFile(path, "# Finder drop regression\n");
  const window = new BrowserWindow({
    width: 1000, height: 700, show: true,
    webPreferences: {
      preload: fileURLToPath(new URL("./chromium-preload.cjs", import.meta.url)),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
    },
  });
  try {
    await window.loadURL("http://127.0.0.1:1420/icon-lab.html");
    console.log("Page loaded");
    const target = await window.webContents.executeJavaScript(`(async () => {
      const { mountNavigatorDragPreviewFixture } = await import('/scripts/navigator-drag-preview-fixture.tsx');
      await mountNavigatorDragPreviewFixture();
      const { BrowserEventRegistry } = await import('/src/platform/browser-runtime.ts');
      const { dropDirectoryAt } = await import('/src/app-utils.ts');
      window.received = [];
      window.domDrops = 0;
      const registry = new BrowserEventRegistry((subscriber, event) => {
        window.received.push({ subscriber, event: event.event, ...event.payload,
          directory: dropDirectoryAt(event.payload.position) });
      });
      // Match the paper-lookup listener and the later project-file importer.
      for (const subscriber of [11, 22]) {
        for (const kind of ['enter', 'over', 'drop', 'leave']) {
          registry.listen('tauri://drag-' + kind, subscriber);
        }
      }
      const row = document.querySelector('file-tree-container.lattice-file-tree')
        .shadowRoot.querySelector('[data-item-path="sections/"]');
      row.addEventListener('drop', () => window.domDrops++);
      const rect = row.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    console.log("Drop target", target);
    window.webContents.debugger.attach("1.3");
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await window.webContents.debugger.sendCommand("Input.dispatchDragEvent", {
        type, ...target, data: { items: [], files: [path], dragOperationsMask: 1 },
      });
    }
    const result = await window.webContents.executeJavaScript("({ received: window.received, domDrops: window.domDrops })");
    const drops = result.received.filter((event) => event.event === "tauri://drag-drop");
    assert.deepEqual(drops.map(({ subscriber, paths, directory }) => ({ subscriber, paths, directory })), [
      { subscriber: 11, paths: [path], directory: "sections" },
      { subscriber: 22, paths: [path], directory: "sections" },
    ]);
    assert.equal(result.domDrops, 0, "DOM importers must not process the same file twice");
    console.log("OS-backed file paths reach both desktop subscribers and resolve to sections/");
  } finally {
    window.destroy();
    await rm(directory, { recursive: true, force: true });
  }
}).then(() => app.exit(0)).catch((error) => { console.error(error); app.exit(1); });
