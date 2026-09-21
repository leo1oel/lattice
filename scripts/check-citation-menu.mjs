// Run with pnpm exec electron scripts/check-citation-menu.mjs while Vite is running.
// Real layout is required: jsdom cannot catch a scroll viewport clipped by its parent.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { app, BrowserWindow } from "electron";

async function checkCitationMenu() {
  const window = new BrowserWindow({
    width: 900, height: 700, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  try {
    await window.loadURL("http://127.0.0.1:1420/icon-lab.html");
    const results = await window.webContents.executeJavaScript(`(async () => {
    const { EditorView, EditorState, startCompletion, autocompletion, latexEditorExtensions }
      = await import('/scripts/citation-menu-fixture.ts');
    const pause = () => new Promise(resolve => setTimeout(resolve, 150));
    document.body.replaceChildren();
    const host = document.createElement('div');
    host.className = 'source-editor';
    host.style.cssText = 'width:700px;margin:40px;height:240px;';
    document.body.append(host);
    const citations = Array.from({ length: 20 }, (_, i) => ({
      key: 'paper' + String(i).padStart(2, '0'),
      title: 'Research on collaborative writing — ' + (i + 1),
      authors: 'Alice Lee and Bo Zhang', year: '2026', venue: 'CHI',
    }));
    const results = [];
    for (const height of [500, 240]) {
      for (const lines of [0, 7]) {
        host.style.height = height + 'px';
        const doc = '\\n'.repeat(lines) + '\\\\cite{}';
        const view = new EditorView({ parent: host, state: EditorState.create({
          doc, selection: { anchor: doc.length - 1 },
          extensions: [latexEditorExtensions([], citations), autocompletion({ closeOnBlur: false }),
            EditorView.theme({ '&': { height: '100%' } })],
        }) });
        view.focus();
        startCompletion(view);
        let menu;
        for (let i = 0; i < 40; i++) {
          await pause();
          menu = host.querySelector('.cm-citation-menu');
          if (menu) break;
        }
        if (!menu) throw new Error('Citation menu did not open');
        await pause();
        const list = menu.querySelector('ul');
        list.scrollTop = list.scrollHeight;
        await pause();
        const outer = menu.getBoundingClientRect();
        const viewport = list.getBoundingClientRect();
        const detail = list.lastElementChild.querySelector('.cm-completionDetail').getBoundingClientRect();
        results.push({ height, lines, outerBottom: outer.bottom, listBottom: viewport.bottom,
          outerRight: outer.right, listRight: viewport.right, detailBottom: detail.bottom,
          scrollable: list.scrollHeight > list.clientHeight });
        // Leave the constrained, upward-opening case visible for the screenshot.
        if (height === 240 && lines === 7) break;
        view.destroy();
      }
    }
    return results;
    })()`);
    console.log(results);
    await mkdir(".tmp/citation-menu", { recursive: true });
    await writeFile(".tmp/citation-menu/result.png", (await window.webContents.capturePage()).toPNG());
    for (const result of results) {
      assert.ok(result.outerBottom > 0, "Menu must be positioned on screen");
      assert.ok(result.scrollable, "Fixture must overflow");
      assert.ok(result.listBottom <= result.outerBottom - 1, "Scroll viewport extends below menu");
      assert.ok(result.listRight <= result.outerRight - 1, "Scrollbar extends beyond menu");
      assert.ok(result.detailBottom <= result.outerBottom - 1, "Last author is clipped");
    }
  } finally {
    window.destroy();
  }
}

app.whenReady().then(checkCitationMenu).then(() => app.exit(0)).catch((error) => {
  console.error(error);
  app.exit(1);
});
