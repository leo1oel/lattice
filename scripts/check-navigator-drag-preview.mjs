// Run with pnpm exec electron scripts/check-navigator-drag-preview.mjs while Vite is on 127.0.0.1:1420.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { app, BrowserWindow } from "electron";

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 1000, height: 700, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") console.error(event.message);
  });
  try {
    await window.loadURL("http://127.0.0.1:1420/icon-lab.html");
    const start = await window.webContents.executeJavaScript(`(async () => {
      const { mountNavigatorDragPreviewFixture } = await import('/scripts/navigator-drag-preview-fixture.tsx');
      return mountNavigatorDragPreviewFixture();
    })()`);
    const destination = { x: 650, y: 300 };
    await window.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('file-tree-container.lattice-file-tree').shadowRoot;
      const row = root.querySelector('[data-item-path="chapter-one.tex"]');
      root.querySelector('[data-item-path="chapter-two.tex"]')
        .dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, metaKey: true }));
      row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true, button: 0, pointerId: 1, clientX: ${start.x}, clientY: ${start.y} }));
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: ${start.x + 8}, clientY: ${start.y + 8} }));
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: ${destination.x}, clientY: ${destination.y} }));
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const result = await window.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('file-tree-container.lattice-file-tree').shadowRoot;
      const preview = root.querySelector('[data-lattice-pointer-drag-preview]');
      if (!preview) throw new Error('Pointer interaction did not create a drag preview');
      const rect = preview.getBoundingClientRect();
      return {
        open: preview.matches(':popover-open'), text: preview.textContent,
        count: preview.querySelector('[data-lattice-pointer-drag-count]')?.textContent,
        pointerEvents: getComputedStyle(preview).pointerEvents, left: rect.left, top: rect.top,
      };
    })()`);
    await mkdir(".amp/in/artifacts", { recursive: true });
    await writeFile(".amp/in/artifacts/navigator-drag-preview.png", (await window.webContents.capturePage()).toPNG());
    await window.webContents.executeJavaScript(`window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: ${destination.x}, clientY: ${destination.y} }))`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const cleanedUp = await window.webContents.executeJavaScript(`!document.querySelector('file-tree-container.lattice-file-tree').shadowRoot.querySelector('[data-lattice-pointer-drag-preview]')`);
    assert.equal(result.open, true, "Drag preview must be promoted to the browser top layer");
    assert.match(result.text, /chapter-one/);
    assert.match(result.text, /tex/);
    assert.equal(result.count, "2", "Multi-selection count must be retained");
    assert.equal(result.pointerEvents, "none", "Preview must not intercept the drag");
    assert.ok(result.left > 260, "Drag preview did not cross into the editor pane");
    assert.equal(cleanedUp, true, "Preview must be removed after the drag");
    console.log(result);
  } finally {
    window.destroy();
  }
}).then(() => app.exit(0)).catch((error) => { console.error(error); app.exit(1); });
