// Run with pnpm exec electron scripts/check-navigator-folder-drop.mjs while Vite is on 127.0.0.1:1420.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { app, BrowserWindow } from "electron";

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1000, height: 700, show: true,
    webPreferences: { backgroundThrottling: false },
  });
  const pause = () => new Promise((resolve) => setTimeout(resolve, 200));
  try {
    await window.loadURL("http://127.0.0.1:1420/icon-lab.html");
    const start = await window.webContents.executeJavaScript(`(async () => {
      const { mountNavigatorDragPreviewFixture } = await import('/scripts/navigator-drag-preview-fixture.tsx');
      window.moves = [];
      return mountNavigatorDragPreviewFixture(async (paths, target) => {
        window.moves.push({ paths, target });
        return paths;
      }, 'zh-CN');
    })()`);
    const target = await window.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('file-tree-container.lattice-file-tree').shadowRoot;
      const rect = root.querySelector('[data-item-path="sections/"]').getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`);
    window.webContents.sendInputEvent({ type: "mouseMove", ...start });
    window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...start });
    await pause();
    window.webContents.sendInputEvent({ type: "mouseMove", x: start.x + 10, y: start.y + 10 });
    await pause();
    window.webContents.sendInputEvent({ type: "mouseMove", ...target });
    await pause();
    window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...target });
    const moves = await window.webContents.executeJavaScript(`(async () => {
      const deadline = performance.now() + 5000;
      while (!window.moves.length && performance.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return window.moves;
    })()`);
    assert.deepEqual(moves, [{ paths: ["chapter-one.tex"], target: "sections" }]);
    window.webContents.sendInputEvent({ type: "mouseDown", button: "right", clickCount: 1, ...target });
    window.webContents.sendInputEvent({ type: "mouseUp", button: "right", clickCount: 1, ...target });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const iconVisible = await window.webContents.executeJavaScript(`(() => {
      const icon = document.querySelector('[role="menuitemcheckbox"] svg');
      return !!icon && getComputedStyle(icon).visibility === 'visible';
    })()`);
    await mkdir(".amp/in/artifacts", { recursive: true });
    await writeFile(".amp/in/artifacts/navigator-folder-menu.png", (await window.webContents.capturePage()).toPNG());
    assert.equal(iconVisible, true, "Hidden-files toggle must have a visible icon even when unchecked");
    console.log("Native mouse folder drop and unchecked menu icon passed");
  } finally {
    window.destroy();
  }
}).then(() => app.exit(0)).catch((error) => { console.error(error); app.exit(1); });
