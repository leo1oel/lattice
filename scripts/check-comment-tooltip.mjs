// Run with pnpm exec electron scripts/check-comment-tooltip.mjs while Vite is running.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { app, BrowserWindow } from "electron";

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 900, height: 700, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") console.error(event.message);
  });
  try {
    await window.loadURL("http://127.0.0.1:1420/icon-lab.html");
    const results = [];
    for (const long of [false, true]) {
      for (const top of [40, 320, 580]) {
        window.webContents.sendInputEvent({ type: "mouseMove", x: 850, y: 20 });
        const point = await window.webContents.executeJavaScript(`(async () => {
          const { mountComment } = await import('/scripts/comment-tooltip-fixture.ts');
          return mountComment(${top}, ${long});
        })()`);
        window.webContents.sendInputEvent({ type: "mouseMove", ...point });
        await new Promise(resolve => setTimeout(resolve, 900));
        const result = await window.webContents.executeJavaScript(`(() => {
          const card = document.querySelector('.cm-editor-comment-tooltip');
          if (!card) throw new Error('Comment tooltip did not open');
          const outer = card.closest('.cm-tooltip-hover');
          const scroll = [outer, card].find(element => /auto|scroll/.test(getComputedStyle(element).overflowY)) ?? outer;
          scroll.scrollTop = scroll.scrollHeight;
          const rect = outer.getBoundingClientRect();
          const button = card.querySelector('button:last-child');
          const buttonRect = button.getBoundingClientRect();
          return {
            top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
            viewportHeight: innerHeight, viewportWidth: innerWidth,
            scrollable: scroll.scrollTop > 1,
            buttonTop: buttonRect.top, buttonBottom: buttonRect.bottom,
            buttonX: Math.round((buttonRect.left + buttonRect.right) / 2),
            buttonY: Math.round((buttonRect.top + buttonRect.bottom) / 2),
          };
        })()`);
        const click = { x: result.buttonX, y: result.buttonY };
        window.webContents.sendInputEvent({ type: "mouseMove", ...click });
        window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...click });
        window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...click });
        const replied = await window.webContents.executeJavaScript(`(async () => {
          const deadline = performance.now() + 2000;
          while (performance.now() < deadline) {
            if (document.querySelector('.source-editor').dataset.replied === 'true') return true;
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          return false;
        })()`);
        results.push({ long, anchorTop: top, ...result, replied });
        if (long && top === 320) {
          await mkdir(".tmp/comment-tooltip", { recursive: true });
          await writeFile(".tmp/comment-tooltip/result.png", (await window.webContents.capturePage({ x: 0, y: 300, width: 420, height: 400 })).toPNG());
        }
      }
    }
    console.log(results);
    for (const result of results) {
      assert.ok(result.top >= 0 && result.bottom <= result.viewportHeight, "Comment exceeds window height");
      assert.ok(result.left >= 0 && result.right <= result.viewportWidth, "Comment exceeds window width");
      assert.equal(result.scrollable, result.long, "Only long comments should scroll");
      assert.ok(result.buttonTop >= result.top && result.buttonBottom <= result.bottom, "Reply button is clipped after scrolling");
      assert.ok(result.replied, "Reply action must remain usable");
    }
  } finally {
    window.destroy();
  }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
