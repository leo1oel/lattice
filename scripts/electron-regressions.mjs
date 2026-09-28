// Manual Electron regressions for what jsdom cannot see: real layout, native
// drag and drop, pointer input, and compositor-driven animation.
//
//   pnpm dev                                          # Vite on 127.0.0.1:1420
//   pnpm exec electron scripts/electron-regressions.mjs [case ...]
//
// Runs every case, or only the named ones, against the page-side fixtures in
// electron-regression-fixtures.tsx. It does not start Lattice itself;
// LATTICE_DEV_URL points it at a dev server on another port. Screenshots are
// written to .tmp/electron-regressions/.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const DEV_URL = process.env.LATTICE_DEV_URL ?? "http://127.0.0.1:1420";
const FIXTURES = "/scripts/electron-regression-fixtures.tsx";
const SCREENSHOTS = fileURLToPath(new URL("../.tmp/electron-regressions/", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A window on the dev server's icon-lab page, which loads the app's styles.
 * Offscreen windows render without a visible window; native drops and mouse
 * input need a shown one.
 */
async function openWindow({ width = 1000, height = 700, offscreen = false, preload = false } = {}) {
  const window = new BrowserWindow({
    width,
    height,
    show: !offscreen,
    webPreferences: {
      ...(preload ? { preload: fileURLToPath(new URL("./chromium-preload.cjs", import.meta.url)) } : {}),
      offscreen,
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") console.error(event.message);
  });
  await window.loadURL(`${DEV_URL}/icon-lab.html`);
  return window;
}

/** Call an export of the fixture module inside the page and await its result. */
function fixture(window, name, ...args) {
  return window.webContents.executeJavaScript(
    `import(${JSON.stringify(FIXTURES)}).then((module) => module[${JSON.stringify(name)}](...${JSON.stringify(args)}))`,
  );
}

const move = (window, point) => window.webContents.sendInputEvent({ type: "mouseMove", ...point });
const button = (window, type, point, which = "left") =>
  window.webContents.sendInputEvent({ type, button: which, clickCount: 1, ...point });
function click(window, point, which = "left") {
  button(window, "mouseDown", point, which);
  button(window, "mouseUp", point, which);
}

/** A native OS file drop at `point`, the way Finder delivers one. */
async function dropFile(window, point, path) {
  window.webContents.debugger.attach("1.3");
  for (const type of ["dragEnter", "dragOver", "drop"]) {
    await window.webContents.debugger.sendCommand("Input.dispatchDragEvent", {
      type, ...point, data: { items: [], files: [path], dragOperationsMask: 1 },
    });
  }
}

async function withTempFile(name, content, body) {
  const directory = await mkdtemp(join(tmpdir(), "lattice-electron-regression-"));
  try {
    const path = join(directory, name);
    await writeFile(path, content);
    return await body(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function screenshot(window, name, rect) {
  await mkdir(SCREENSHOTS, { recursive: true });
  await writeFile(join(SCREENSHOTS, `${name}.png`), (await window.webContents.capturePage(rect)).toPNG());
}

const CASES = {
  // No preload: an ordinary browser tab has neither native file paths nor latticeDesktop.
  async "browser-project-drop"() {
    const window = await openWindow();
    await withTempFile("notes.md", "hello", async (path) => {
      await dropFile(window, await fixture(window, "listenForBrowserDrops"), path);
      const result = await fixture(window, "browserDropResult");
      assert.deepEqual(result.upload, { directory: "sections", files: [{ name: "notes.md", base64: "aGVsbG8=" }] });
      assert.ok(result.targets.includes("sections"));
      assert.equal(result.targets.at(-1), null);
    });
    return "Ordinary browser file drop: target, byte content, and hover cleanup passed";
  },

  async "chromium-file-drop"() {
    const window = await openWindow({ preload: true });
    await withTempFile("notes.md", "# Finder drop regression\n", async (path) => {
      await dropFile(window, await fixture(window, "listenForDesktopDrops"), path);
      const result = await fixture(window, "desktopDropResult");
      const drops = result.received.filter((event) => event.event === "tauri://drag-drop");
      assert.deepEqual(drops.map(({ subscriber, paths, directory }) => ({ subscriber, paths, directory })), [
        { subscriber: 11, paths: [path], directory: "sections" },
        { subscriber: 22, paths: [path], directory: "sections" },
      ]);
      assert.equal(result.domDrops, 0, "DOM importers must not process the same file twice");
    });
    return "OS-backed file paths reach both desktop subscribers and resolve to sections/";
  },

  // jsdom cannot catch a scroll viewport clipped by its parent.
  async "citation-menu"() {
    const window = await openWindow({ width: 900, offscreen: true });
    const results = await fixture(window, "measureCitationMenus");
    console.log(results);
    await screenshot(window, "citation-menu");
    for (const result of results) {
      assert.ok(result.outerBottom > 0, "Menu must be positioned on screen");
      assert.ok(result.scrollable, "Fixture must overflow");
      assert.ok(result.listBottom <= result.outerBottom - 1, "Scroll viewport extends below menu");
      assert.ok(result.listRight <= result.outerRight - 1, "Scrollbar extends beyond menu");
      assert.ok(result.detailBottom <= result.outerBottom - 1, "Last author is clipped");
    }
    return "Citation menu stays inside the window with its last entry visible";
  },

  async "comment-tooltip"() {
    const window = await openWindow({ width: 900, offscreen: true });
    const results = [];
    for (const long of [false, true]) {
      for (const top of [40, 320, 580]) {
        move(window, { x: 850, y: 20 });
        move(window, await fixture(window, "mountComment", top, long));
        await pause(900);
        const result = await fixture(window, "measureCommentTooltip");
        const reply = { x: result.buttonX, y: result.buttonY };
        move(window, reply);
        click(window, reply);
        const replied = await fixture(window, "commentReplied");
        results.push({ long, anchorTop: top, ...result, replied });
        if (long && top === 320) await screenshot(window, "comment-tooltip", { x: 0, y: 300, width: 420, height: 400 });
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
    return "Comment cards fit the window and keep Reply usable";
  },

  async "navigator-drag-preview"() {
    const window = await openWindow({ offscreen: true });
    const start = await fixture(window, "mountDragFixture");
    const destination = { x: 650, y: 300 };
    await fixture(window, "startPointerDrag", start, destination);
    await pause(150);
    const result = await fixture(window, "measureDragPreview");
    await screenshot(window, "navigator-drag-preview");
    await fixture(window, "endPointerDrag", destination);
    await pause(100);
    const cleanedUp = await fixture(window, "dragPreviewRemoved");
    assert.equal(result.open, true, "Drag preview must be promoted to the browser top layer");
    assert.match(result.text, /chapter-one/);
    assert.match(result.text, /tex/);
    assert.equal(result.count, "2", "Multi-selection count must be retained");
    assert.equal(result.pointerEvents, "none", "Preview must not intercept the drag");
    assert.ok(result.left > 260, "Drag preview did not cross into the editor pane");
    assert.equal(cleanedUp, true, "Preview must be removed after the drag");
    console.log(result);
    return "Pointer drag preview crosses into the editor pane and cleans up";
  },

  async "navigator-folder-drop"() {
    const window = await openWindow();
    const start = await fixture(window, "mountDragFixture", "zh-CN");
    const target = await fixture(window, "rowCenter", "sections/");
    move(window, start);
    button(window, "mouseDown", start);
    await pause(200);
    move(window, { x: start.x + 10, y: start.y + 10 });
    await pause(200);
    move(window, target);
    await pause(200);
    button(window, "mouseUp", target);
    assert.deepEqual(await fixture(window, "recordedMoves"), [{ paths: ["chapter-one.tex"], target: "sections" }]);
    click(window, target, "right");
    await pause(1000);
    const iconVisible = await fixture(window, "hiddenFilesToggleIconVisible");
    await screenshot(window, "navigator-folder-menu");
    assert.equal(iconVisible, true, "Hidden-files toggle must have a visible icon even when unchecked");
    return "Native mouse folder drop and unchecked menu icon passed";
  },

  async "navigator-scroll-motion"() {
    const window = await openWindow({ width: 700 });
    const sidebar = { x: 0, y: 0, width: 280, height: 700 };
    await fixture(window, "mountScrollFixture");
    console.log(await fixture(window, "scrollGeometry"));
    await fixture(window, "clickRow", "chapters/");
    await pause(300);
    const motion = await fixture(window, "collapseMotion");
    console.log(JSON.stringify(motion, null, 2));
    await pause(300); // Let the compositor paint the paused frame.
    await screenshot(window, "navigator-collapse", sidebar);
    for (const frame of motion) {
      assert.ok(Math.abs(frame.visibleBottom - frame.siblingTop) < 1, "Exit boundary and following files must move together without overlap");
    }
    await fixture(window, "finishAnimations");
    const track = await fixture(window, "scrollTrack");
    move(window, { x: track.x - 40, y: track.y });
    await pause(300);
    move(window, track);
    await pause(300);
    const hover = await fixture(window, "scrollbarOpacity");
    button(window, "mouseDown", track);
    move(window, { x: track.x, y: track.bottom });
    button(window, "mouseUp", { x: track.x, y: track.bottom });
    await pause(300);
    const end = await fixture(window, "scrollEnd");
    console.log({ track, hover, end });
    const bottom = await fixture(window, "thumbAtBottom");
    console.log({ bottom });
    await screenshot(window, "navigator-scroll-bottom", sidebar);
    assert.ok(Math.abs(bottom.track - bottom.window) <= 1, "Track must extend to the window bottom, not just the last file");
    assert.ok(Math.abs(bottom.thumb - (bottom.window - 4)) <= 1, "Thumb must reach the window bottom with only its standard 4px inset");
    assert.ok(Math.abs(track.top - track.viewportTop) <= 1, "Track must align with viewport top");
    assert.ok(Math.abs(track.bottom + 4 - track.viewportBottom) <= 1, "Track must align with viewport bottom");
    assert.equal(hover, "1", "Scrollbar must stay visible when approached from the left");
    assert.ok(Math.abs(end.scrollTop - end.max) <= 1, "Dragging must reach the last file");
    assert.ok(end.last && end.last.bottom <= track.viewportBottom + 1, "Last file must be fully visible");
    return "Collapse motion and the external scrollbar track, hover, and drag passed";
  },
};

// Keep the process alive between cases for async cleanup and reporting.
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  const requested = process.argv.slice(2).filter((argument) => !argument.startsWith("-"));
  const unknown = requested.filter((name) => !(name in CASES));
  if (unknown.length > 0) throw new Error(`Unknown case ${unknown.join(", ")}; choose from ${Object.keys(CASES).join(", ")}`);
  let failures = 0;
  for (const name of requested.length > 0 ? requested : Object.keys(CASES)) {
    const windowsBefore = new Set(BrowserWindow.getAllWindows());
    try {
      console.log(`PASS ${name}: ${await CASES[name]()}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${name}:`, error);
    } finally {
      for (const window of BrowserWindow.getAllWindows()) if (!windowsBefore.has(window)) window.destroy();
    }
  }
  app.exit(failures > 0 ? 1 : 0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
