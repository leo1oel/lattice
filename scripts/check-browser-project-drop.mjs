// Run with pnpm exec electron scripts/check-browser-project-drop.mjs while Vite is on 127.0.0.1:1420.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";

app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  const directory = await mkdtemp(join(tmpdir(), "lattice-browser-drop-"));
  const path = join(directory, "notes.md");
  await writeFile(path, "hello");
  // No preload: this page has neither native file paths nor latticeDesktop.
  const window = new BrowserWindow({ width: 1000, height: 700, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  try {
    await window.loadURL("http://127.0.0.1:1420/icon-lab.html");
    const target = await window.webContents.executeJavaScript(`(async () => {
      if (window.latticeDesktop) throw new Error('This test must not use the desktop bridge');
      const { mountNavigatorDragPreviewFixture } = await import('/scripts/navigator-drag-preview-fixture.tsx');
      await mountNavigatorDragPreviewFixture();
      const { listenForBrowserProjectDrops } = await import('/src/project/browser-project-drop.ts');
      const { fileToBase64 } = await import('/src/editor/insert/clipboard-image.ts');
      window.upload = null;
      window.targets = [];
      window.disposeDrop = listenForBrowserProjectDrops(async (files, directory) => {
        window.upload = { directory, files: await Promise.all(files.map(async file => ({ name: file.name, base64: await fileToBase64(file) }))) };
      }, target => window.targets.push(target));
      const row = document.querySelector('file-tree-container.lattice-file-tree').shadowRoot.querySelector('[data-item-path="sections/"]');
      const bounds = row.getBoundingClientRect();
      return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    })()`);
    window.webContents.debugger.attach("1.3");
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await window.webContents.debugger.sendCommand("Input.dispatchDragEvent", {
        type, ...target, data: { items: [], files: [path], dragOperationsMask: 1 },
      });
    }
    const result = await window.webContents.executeJavaScript(`(async () => {
      const deadline = performance.now() + 5000;
      while (!window.upload && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      window.disposeDrop();
      return { upload: window.upload, targets: window.targets };
    })()`);
    assert.deepEqual(result.upload, { directory: "sections", files: [{ name: "notes.md", base64: "aGVsbG8=" }] });
    assert.ok(result.targets.includes("sections"));
    assert.equal(result.targets.at(-1), null);
    console.log("Ordinary browser file drop: target, byte content, and hover cleanup passed");
  } finally {
    window.destroy();
    await rm(directory, { recursive: true, force: true });
  }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
