// Run with pnpm exec electron scripts/check-navigator-scroll-motion.mjs and Vite on :1420.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { app, BrowserWindow } from "electron";

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 700, height: 700, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false } });
  const run = (code) => window.webContents.executeJavaScript(code);
  const pause = () => new Promise(resolve => setTimeout(resolve, 300));
  try {
    await window.loadURL("http://127.0.0.1:1420/icon-lab.html");
    await run(`(async () => {
      const { mountNavigatorScrollMotionFixture } = await import('/scripts/navigator-scroll-motion-fixture.tsx');
      await mountNavigatorScrollMotionFixture();
      window.tree = document.querySelector('file-tree-container.lattice-file-tree').shadowRoot;
      window.viewport = tree.querySelector('[data-file-tree-virtualized-scroll="true"]');
    })()`);
    console.log(await run(`(() => {
      const track = document.querySelector('.external-scrollbar');
      return { viewport: viewport.getBoundingClientRect().toJSON(), track: track.getBoundingClientRect().toJSON(), surface: track.parentElement.getBoundingClientRect().toJSON() };
    })()`));
    await run(`tree.querySelector('[data-item-path="chapters/"]').click()`);
    await pause();
    const motion = await run(`(async () => {
      const folder = tree.querySelector('[data-item-path="chapters/"]');
      folder.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      folder.click();
      await new Promise(requestAnimationFrame);
      const animations = tree.getAnimations();
      const picture = tree.querySelector('[data-tree-exit]');
      const sibling = tree.querySelector('[data-item-path="notes-00.tex"]');
      if (!picture) throw new Error('Collapse did not create an exit picture');
      return [20, 120, 60].map(time => {
        for (const animation of animations) { animation.pause(); animation.currentTime = time; }
        const rect = picture.getBoundingClientRect();
        const clip = getComputedStyle(picture).clipPath;
        const percent = Number(clip.match(/([\\d.]+)%/)[1]);
        return { time, visibleBottom: rect.bottom - rect.height * percent / 100, siblingTop: sibling.getBoundingClientRect().top };
      });
    })()`);
    console.log(JSON.stringify(motion, null, 2));
    await mkdir('.amp/in/artifacts', { recursive: true });
    await pause(); // Let the offscreen compositor paint the paused frame.
    await writeFile('.amp/in/artifacts/navigator-collapse.png', (await window.webContents.capturePage({ x: 0, y: 0, width: 280, height: 700 })).toPNG());
    for (const frame of motion) {
      assert.ok(Math.abs(frame.visibleBottom - frame.siblingTop) < 1, 'Exit boundary and following files must move together without overlap');
    }
    await run(`tree.getAnimations().forEach(a => a.finish())`);
    const track = await run(`(() => {
      const r = document.querySelector('.external-scrollbar').getBoundingClientRect();
      const v = viewport.getBoundingClientRect();
      return { x: Math.round(r.right - 6), y: Math.round(r.top + 12), bottom: Math.round(r.bottom - 4), viewportBottom: v.bottom, top: r.top, viewportTop: v.top };
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseMove', x: track.x - 40, y: track.y });
    await pause();
    window.webContents.sendInputEvent({ type: 'mouseMove', x: track.x, y: track.y });
    await pause();
    const hover = await run(`getComputedStyle(document.querySelector('.external-scrollbar')).opacity`);
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: track.x, y: track.y });
    window.webContents.sendInputEvent({ type: 'mouseMove', x: track.x, y: track.bottom });
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: track.x, y: track.bottom });
    await pause();
    const end = await run(`({ scrollTop: viewport.scrollTop, max: viewport.scrollHeight - viewport.clientHeight, last: tree.querySelector('[data-item-path="notes-79.tex"]')?.getBoundingClientRect().toJSON() })`);
    console.log({ track, hover, end });
    await writeFile('.amp/in/artifacts/navigator-scroll-bottom.png', (await window.webContents.capturePage({ x: 0, y: 0, width: 280, height: 700 })).toPNG());
    const bottom = await run(`({ window: innerHeight, track: document.querySelector('.external-scrollbar').getBoundingClientRect().bottom, thumb: document.querySelector('.external-scrollbar [data-slot="scroll-area-thumb"]').getBoundingClientRect().bottom })`);
    console.log({ bottom });
    assert.ok(Math.abs(bottom.track - bottom.window) <= 1, 'Track must extend to the window bottom, not just the last file');
    assert.ok(Math.abs(bottom.thumb - (bottom.window - 4)) <= 1, 'Thumb must reach the window bottom with only its standard 4px inset');
    assert.ok(Math.abs(track.top - track.viewportTop) <= 1, 'Track must align with viewport top');
    assert.ok(Math.abs(track.bottom + 4 - track.viewportBottom) <= 1, 'Track must align with viewport bottom');
    assert.equal(hover, '1', 'Scrollbar must stay visible when approached from the left');
    assert.ok(Math.abs(end.scrollTop - end.max) <= 1, 'Dragging must reach the last file');
    assert.ok(end.last && end.last.bottom <= track.viewportBottom + 1, 'Last file must be fully visible');
  } finally { window.destroy(); }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
