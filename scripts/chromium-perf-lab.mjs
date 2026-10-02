// The perf lab's Chromium half (docs/driving-the-app.md). chromium-shell.mjs
// imports this only when scripts/perf-lab.mjs launched the app with a run plan,
// so a normal launch never registers the input bridge below.
//
// Copied into the Electron app beside chromium-shell.mjs, so it stays
// self-contained like the shell.
import { appendFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { app, ipcMain, powerSaveBlocker } from "electron";

// Passed to the renderer so chromium-preload.cjs exposes `latticeLab` only here.
export const PRELOAD_ARGUMENT = "--lattice-perf-lab";

// The lab account's windows are never composited on the console user's
// screen. Keep Chromium rendering anyway, matching LATTICE_WK_NOOCC on the
// WebKit side (src-tauri/src/perf_lab.rs).
const noOcclusion = process.env.LATTICE_CR_NOOCC === "1";
const traceFile = process.env.LATTICE_CR_TRACE;
const epochMs = () => performance.timeOrigin + performance.now();

/** Append a startup mark to LATTICE_CR_TRACE, the file the Rust half also writes. */
export function trace(what) {
  if (traceFile) appendFileSync(traceFile, `${epochMs().toFixed(1)} ${what}\n`);
}

// Electron keeps its profile under the app name; one per lab identifier keeps
// concurrent labs (and the shipped app) out of each other's profiles.
export const appName = `${process.env.LATTICE_LAB_ID ?? "LatticeLab"}.chromium`;

export const webPreferences = {
  backgroundThrottling: !noOcclusion,
  additionalArguments: [PRELOAD_ARGUMENT],
};

/** Trace the window's navigation milestones for the startup breakdown. */
export function watchLoad(window) {
  window.webContents.once("did-start-navigation", () => trace("did-start-navigation"));
  window.webContents.once("dom-ready", () => trace("dom-ready"));
}

trace(`shell-start processUptime=${process.uptime().toFixed(3)}`);
for (const flag of (process.env.LATTICE_CR_SWITCHES ?? "").split(",").filter(Boolean)) {
  app.commandLine.appendSwitch(...flag.split("=", 2));
}
if (noOcclusion) {
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-background-timer-throttling");
}
app.whenReady().then(() => {
  trace("app-ready");
  if (noOcclusion) powerSaveBlocker.start("prevent-app-suspension");
});

// Input through Chromium's own input pipeline, so the harness measures the
// path real keys, wheels and drags take. Each handler returns the epoch ms of
// its first send for the harness's input→paint latency.
const KEY_NAMES = { " ": "Space", "\n": "Return" };
ipcMain.handle("lattice-lab", (event, message) => {
  const contents = event.sender;
  switch (message?.type) {
    case "focus":
      contents.focus();
      return { focused: contents.isFocused() };
    case "keys": {
      let first = 0;
      for (const character of String(message.text)) {
        const keyCode = KEY_NAMES[character] ?? character;
        if (!first) first = epochMs();
        contents.sendInputEvent({ type: "keyDown", keyCode });
        contents.sendInputEvent({ type: "char", keyCode: character === "\n" ? "\r" : character });
        contents.sendInputEvent({ type: "keyUp", keyCode });
      }
      return first;
    }
    case "wheel":
    case "pinch": {
      const sent = epochMs();
      contents.sendInputEvent({
        type: "mouseWheel", x: Math.round(message.x), y: Math.round(message.y), deltaX: 0, deltaY: message.dy,
        hasPreciseScrollingDeltas: true, canScroll: true,
        ...(message.type === "pinch" ? { modifiers: ["control"] } : {}),
      });
      return sent;
    }
    case "mouse":
      return drag(contents, message.points, message.intervalMs);
    case "snapshot":
      return contents.capturePage().then((image) => writeFile(message.path, image.toPNG())).then(() => true);
    case "metrics":
      return app.getAppMetrics();
    default:
      return null;
  }
});

/** Press at the first point, drag through the rest, release at the last. */
async function drag(contents, points, intervalMs) {
  const started = epochMs();
  for (let index = 0; index < points.length; index += 1) {
    const [x, y] = points[index].map(Math.round);
    if (index === 0) {
      contents.sendInputEvent({ type: "mouseMove", x, y });
      contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
    } else {
      contents.sendInputEvent({ type: "mouseMove", x, y, button: "left", modifiers: ["leftButtonDown"] });
    }
    if (index === points.length - 1) contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
    if (index + 1 < points.length) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return started;
}
