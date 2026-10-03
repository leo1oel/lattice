/* eslint-disable lingui/no-unlocalized-strings, @typescript-eslint/ban-ts-comment, @typescript-eslint/no-unused-expressions, no-useless-assignment --
   Measurement code compiled only into perf-lab builds (VITE_PERF_LAB, see
   scripts/perf-lab.mjs), never into the shipped app. Bare style reads force a
   synchronous layout on purpose. */
// @ts-nocheck
// The real-app measurement lab's in-page half: it drives scenarios through
// native AppKit input (src-tauri/src/perf_lab.rs) and writes JSON results
// through `perf_write`. Scenario logic matches the webkit-vs-chromium report's harness,
// so keep changes to a scenario deliberate: they move every number it reports.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { EditorView } from "@codemirror/view";

const epoch = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nextPaint = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(() => resolve(performance.now()), 0)));
const loadedAt = performance.now();
const marks = {};
const visibilityLog = [];
const startupDebug = [];
const invokeLog = [];
let config = null;

// Per-callback time for ResizeObserver and requestAnimationFrame callbacks,
// keyed by where they were registered (lab flag "cbtime").
const callbackTimes = new Map();
function callerKey() {
  const stack = new Error().stack?.split("\n") ?? [];
  const frame = stack.slice(2).find((line) => !line.includes("lab-harness")) ?? "?";
  return frame.replace(/\?[^:]*/, "").replace(/^.*\/assets\//, "").slice(0, 120);
}
function timeCallback(kind, key, fn) {
  return function timed(...args) {
    const started = performance.now();
    try {
      return fn.apply(this, args);
    } finally {
      const entry = callbackTimes.get(`${kind} ${key}`) ?? { calls: 0, ms: 0, max: 0 };
      const spent = performance.now() - started;
      entry.calls += 1; entry.ms += spent; entry.max = Math.max(entry.max, spent);
      callbackTimes.set(`${kind} ${key}`, entry);
    }
  };
}
function installCallbackTiming() {
  const NativeResizeObserver = window.ResizeObserver;
  window.ResizeObserver = class extends NativeResizeObserver {
    constructor(callback) { super(timeCallback("RO", callerKey(), callback)); }
  };
  const nativeRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => nativeRaf(timeCallback("rAF", callerKey(), callback));
  for (const type of ["pointermove", "mousemove"]) {
    window.addEventListener(type, () => undefined, { capture: true });
  }
}
function takeCallbackTimes() {
  const result = [...callbackTimes].map(([key, value]) => ({ key, calls: value.calls, ms: Math.round(value.ms), max: Math.round(value.max) })).sort((a, b) => b.ms - a.ms).slice(0, 25);
  callbackTimes.clear();
  return result;
}

export async function labPrepare() {
  config = await invoke("perf_config").catch(() => null);
  if (!config?.plan) return false;
  try {
    localStorage.setItem("lattice.tutorial-seen.v1", "1");
    const appearance = JSON.parse(localStorage.getItem("lattice.appearance.v5") ?? "{}");
    localStorage.setItem("lattice.appearance.v5", JSON.stringify({ ...appearance, interfaceLanguage: "en", interfaceSounds: false }));
  } catch {
    // ignore
  }
  window.__latticeLab = true;
  performance.setResourceTimingBufferSize?.(5000);

  const flags = (config.flags ?? "").split(",").filter(Boolean);
  window.__latticeLabFlags = flags;
  if (flags.includes("cbtime")) installCallbackTiming();
  const labStyles = {
    norail: ".visual-heading-rail { display: none !important; }",
    nopdf: ".pdf-preview .pdfViewer { display: none !important; }",
    noeditor: ".lx-md-editor .ProseMirror { display: none !important; }",
    nocqpdf: ".pdf-preview { container: none !important; }",
    nocqbars: ".editor-status-bar, .canvas-toolbar { container-type: normal !important; }",
    phstrict: "[data-lx-virtual] { contain: strict; }",
    pmlayout: ".ProseMirror { contain: layout; }",
    vwchange: ".pdf-preview .pdfViewer { will-change: transform; }",
    noclip: ".pdf-preview .pdfViewer { clip-path: none !important; }",
    noresizestyle: ".trellis[data-resizing] { cursor: auto !important; user-select: auto !important; -webkit-user-select: auto !important; }",
    pagestatic: ".pdfViewer .page { position: static !important; }",
    pagecv: ".pdfViewer .page { content-visibility: auto; }",
    pagecontain: ".pdfViewer .page { position: static !important; contain: layout; }",
    pageunloaded: ".pdfViewer .page:not([data-loaded]) { position: static !important; }",
    nocq: ".pdf-preview, .paper-reader-shell { container: none !important; } .editor-status-bar, .canvas-toolbar { container-type: normal !important; }",
  };
  for (const flag of flags) {
    if (!labStyles[flag]) continue;
    const style = document.createElement("style");
    style.textContent = labStyles[flag];
    document.head.append(style);
  }
  marks.prepared = epoch();
  visibilityLog.push(`${Math.round(performance.now())}:${document.visibilityState}:${document.hasFocus()}`);
  document.addEventListener("visibilitychange", () => visibilityLog.push(`${Math.round(performance.now())}:${document.visibilityState}:${document.hasFocus()}`));
  watchStartup();
  return true;
}

function watchStartup() {
  const checks = [
    ["appMounted", () => !!document.querySelector("#root > *")],
    ["treeVisible", () => !!deep("file-tree-container.lattice-file-tree >>> [data-item-path]")],
    ["editable", () => {
      const content = document.querySelector(".cm-editor .cm-content");
      return !!(content && content.isContentEditable && content.querySelector(".cm-line") && content.textContent);
    }],
    ["pdfPage", () => !!document.querySelector(".pdfViewer .page canvas")],
  ];
  let lastDebug = 0;
  const tick = () => {
    if (!("editable" in marks) && performance.now() - lastDebug > 500) {
      lastDebug = performance.now();
      const content = document.querySelector(".cm-editor .cm-content");
      startupDebug.push(`${Math.round(performance.now())}:${content ? `ce=${content.getAttribute("contenteditable")} lines=${content.querySelectorAll(".cm-line").length} text=${content.textContent?.length}` : "no-cm"} tabs=${[...document.querySelectorAll('[role="tab"][aria-selected="true"]')].map((tab) => tab.textContent?.trim()).join("|")} dialogs=${document.querySelectorAll('[role="dialog"]').length}`);
    }
    for (const [name, check] of checks) if (!(name in marks) && check()) marks[name] = epoch();
    if (checks.some(([name]) => !(name in marks)) && performance.now() - loadedAt < 120_000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function deep(selector) {
  let root = document;
  const parts = selector.split(" >>> ");
  for (let index = 0; index < parts.length; index += 1) {
    const element = root.querySelector(parts[index]);
    if (!element) return null;
    if (index === parts.length - 1) return element;
    if (!element.shadowRoot) return null;
    root = element.shadowRoot;
  }
  return null;
}

async function waitFor(check, what, timeout = 30_000) {
  const deadline = performance.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (performance.now() > deadline) throw Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

function center(element) {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, rect };
}

async function settle(quietMs = 600, timeout = 20_000, root = document) {
  const started = performance.now();
  let last = performance.now();
  const observer = new MutationObserver(() => { last = performance.now(); });
  observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  try {
    while (performance.now() - last < quietMs && performance.now() - started < timeout) await sleep(50);
  } finally {
    observer.disconnect();
  }
  return last - started;
}

const input = {
  async focus() {
    return invoke("perf_focus");
  },
  async keys(text) {
    return invoke("perf_key", { text });
  },
  wheelDirect: false,
  wheelDebug: null,
  async wheel(x, y, dy) {
    const result = await invoke("perf_wheel", { x, y, dy: -Math.round(dy), phase: 0, direct: input.wheelDirect });
    input.wheelDebug = result;
    return result.sent;
  },
  async mouse(points, intervalMs = 8) {
    return invoke("perf_mouse", { points, intervalMs });
  },
  async click(element, fx = 0.5, fy = 0.5) {
    const rect = element.getBoundingClientRect();
    await input.mouse([[rect.left + rect.width * fx, rect.top + rect.height * fy]]);
  },
};

function layout() {
  return {
    tabs: [...document.querySelectorAll('[data-trellis-part="tab"]')].map((tab) => `${tab.textContent?.trim()}${tab.getAttribute("aria-selected") === "true" ? "*" : ""}`),
    iframes: [...document.querySelectorAll("iframe")].map((frame) => frame.src.replace(/token=[^&]+/, "token=…").slice(0, 80)),
  };
}

function domSize() {
  return {
    all: document.getElementsByTagName("*").length,
    pdfText: document.querySelectorAll(".textLayer span").length,
    pdfPages: document.querySelectorAll(".pdfViewer .page").length,
    visual: document.querySelectorAll(".ProseMirror *").length,
    code: document.querySelectorAll(".cm-editor *").length,
  };
}

function syntheticKey(key, init = {}) {
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true, ...init }));
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(2));
}

function stats(values) {
  if (!values.length) return { n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { n: values.length, mean: Number(mean.toFixed(2)), p50: quantile(values, 0.5), p90: quantile(values, 0.9), p95: quantile(values, 0.95), max: quantile(values, 1) };
}

function frameMeter() {
  const stamps = [];
  let running = true;
  const started = performance.now();
  const tick = (time) => {
    stamps.push(time);
    if (running) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return {
    stop() {
      running = false;
      const duration = performance.now() - started;
      const intervals = [];
      for (let index = 1; index < stamps.length; index += 1) intervals.push(stamps[index] - stamps[index - 1]);
      return frameStats(intervals, duration);
    },
  };
}

function frameStats(intervals, duration) {
  return {
    durationMs: Math.round(duration),
    frames: intervals.length,
    fps: Number((intervals.length / (duration / 1000)).toFixed(1)),
    interval: stats(intervals),
    over25ms: intervals.filter((v) => v > 25).length,
    over50ms: intervals.filter((v) => v > 50).length,
    over100ms: intervals.filter((v) => v > 100).length,
    longestMs: Math.round(Math.max(0, ...intervals)),
    jankMs: Math.round(intervals.filter((v) => v > 33.4).reduce((sum, v) => sum + v - 16.7, 0)),
  };
}

const treeItem = (path) => `file-tree-container.lattice-file-tree >>> [data-item-path="${path}"]`;

async function tabSelected(name) {
  return [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].some((tab) => tab.textContent?.trim() === name);
}

async function collapseFolders(keep = "") {
  for (const folder of ["notes/", "chapters/"]) {
    if (keep.startsWith(folder)) continue;
    const item = deep(treeItem(folder));
    if (item?.getAttribute("aria-expanded") === "true") {
      item.scrollIntoView({ block: "nearest" });
      await nextPaint();
      await input.click(item, 0.3);
      await waitFor(() => deep(treeItem(folder))?.getAttribute("aria-expanded") !== "true", `${folder} collapsed`, 3000).catch(() => null);
      await sleep(250);
    }
  }
}

async function quickOpen(path) {
  const name = path.split("/").pop();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", metaKey: true, bubbles: true, cancelable: true }));
  (await waitFor(() => document.querySelector('[role="dialog"] input'), "quick open input", 5000)).focus();
  await sleep(200);
  await input.keys(name.replace(/\.[^.]+$/, ""));
  await sleep(500);
  await input.keys("\n");
  await waitFor(() => tabSelected(name), `tab ${name} via quick open`, 6000);
  await waitFor(() => !document.querySelector('[role="dialog"]'), "quick open closed", 3000).catch(() => syntheticKey("Escape"));
}

async function openFile(path) {
  try {
    await openFromTree(path);
  } catch (error) {
    if (!path.includes("/")) throw error;
    await quickOpen(path);
  }
}

async function openFromTree(path) {
  await collapseFolders(path);
  const parts = path.split("/");
  for (let depth = 1; depth < parts.length; depth += 1) {
    const folder = `${parts.slice(0, depth).join("/")}/`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const item = await waitFor(() => deep(treeItem(folder)), folder);
      if (item.getAttribute("aria-expanded") === "true") break;
      item.scrollIntoView({ block: "nearest" });
      await nextPaint();
      await input.click(item, 0.3);
      await waitFor(() => deep(treeItem(folder))?.getAttribute("aria-expanded") === "true", `${folder} expanded`, 5000).catch(() => null);
      await sleep(300);
    }
  }
  const name = parts[parts.length - 1];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const item = await waitFor(() => deep(treeItem(path)), path, 8000).catch((error) => {
      const trees = [...document.querySelectorAll("file-tree-container")].map((tree) => {
        const items = [...tree.shadowRoot?.querySelectorAll("[data-item-path]") ?? []].map((node) => `${node.getAttribute("data-item-path")}:${node.getAttribute("aria-expanded") ?? ""}`);
        return `${tree.className}|${tree.getBoundingClientRect().width}|${items.slice(0, 14).join(",")}`;
      });
      throw Error(`${error instanceof Error ? error.message : error}; trees=${JSON.stringify(trees)}`);
    });
    item.scrollIntoView({ block: "nearest" });
    await nextPaint();
    await input.click(item, 0.3);
    if (await waitFor(() => tabSelected(name), `tab ${name}`, 4000).then(() => true, () => false)) return;
    await sleep(300);
  }
  throw Error(`could not open ${path}`);
}

async function selectView(name) {
  const tab = await waitFor(() => [...document.querySelectorAll('[role="tablist"][aria-label="Document view"] [role="tab"]')].find((candidate) => candidate.textContent?.trim() === name), `${name} view tab`, 10_000);
  if (tab.getAttribute("aria-selected") !== "true") {
    await input.click(tab);
    await waitFor(() => tab.getAttribute("aria-selected") === "true", `${name} selected`, 5000);
  }
}

function visibleCodeEditor() {
  const editors = [...document.querySelectorAll(".cm-editor")].filter((editor) => editor.getBoundingClientRect().width > 50);
  for (const editor of editors) {
    const view = EditorView.findFromDOM(editor);
    if (view) return view;
  }
  return null;
}

async function typeAndMeasure(text, gapMs) {
  const keydowns = [];
  const toPaint = [];
  const sendToKeydown = [];
  const onKeydown = (event) => {
    if (event.key.length !== 1) return;
    const start = performance.now();
    keydowns.push({ start, epoch: epoch() });
    requestAnimationFrame(() => setTimeout(() => toPaint.push(performance.now() - start), 0));
  };
  window.addEventListener("keydown", onKeydown, { capture: true });
  const sends = [];
  const meter = frameMeter();
  for (const character of text) {
    const before = keydowns.length;
    const sent = await input.keys(character);
    sends.push(sent);
    await waitFor(() => keydowns.length > before, "keydown", 2000).catch(() => null);
    if (keydowns.length > before) sendToKeydown.push(keydowns[keydowns.length - 1].epoch - clockOffset - sent);
    await sleep(gapMs);
  }
  await nextPaint();
  await sleep(50);
  const frames = meter.stop();
  window.removeEventListener("keydown", onKeydown, { capture: true });
  return {
    keysSent: text.length,
    keydownsSeen: keydowns.length,
    keydownToNextPaint: stats(toPaint),
    sendToKeydown: stats(sendToKeydown),
    sendToPaint: stats(toPaint.map((value, index) => value + (sendToKeydown[index] ?? 0))),
    frames,
  };
}

async function clickLine(index) {
  const view = await waitFor(() => visibleCodeEditor(), "code editor");
  const lines = await waitFor(() => {
    const rendered = [...view.contentDOM.querySelectorAll(".cm-line")];
    return rendered.length > index ? rendered : null;
  }, "rendered lines");
  await input.click(lines[index], 0.02, 0.5);
  await sleep(200);
  await nextPaint();
  return view;
}

async function sourceTyping(path, view) {
  await openFile(path);
  if (view) await selectView(view);
  await settle(800);
  const editor = await clickLine(8);
  const before = editor.state.doc.length;
  const result = await typeAndMeasure("the quick brown fox jumps over lazy dogs ".repeat(2), 110);
  await settle(1200);
  await sleep(path.endsWith(".tex") ? 7000 : 500);
  await settle(800, 20_000);
  return { ...result, inserted: editor.state.doc.length - before, docLength: editor.state.doc.length };
}

async function visualTyping() {
  await openFile("large.md");
  await selectView("Preview");
  await settle(1500, 30_000);
  const paragraph = await waitFor(() => document.querySelector(".ProseMirror > p:nth-of-type(3), .ProseMirror > * > p:nth-of-type(3)") ?? document.querySelectorAll(".ProseMirror p")[2], "visual paragraph", 15_000);
  paragraph.scrollIntoView({ block: "center" });
  await settle(600);
  await input.click(paragraph, 0.02, 0.3);
  await sleep(300);
  const editor = document.querySelector(".ProseMirror");
  const count = () => (editor.textContent?.match(/quick/g) ?? []).length;
  const before = count();
  const result = await typeAndMeasure("the quick brown fox jumps ", 110);
  await settle(1500, 20_000);
  return { ...result, insertedWords: count() - before };
}

function pdfViewport() {
  return [...document.querySelectorAll(".pdf-scroll-area-viewport")].find((viewport) => viewport.getBoundingClientRect().width > 100) ?? null;
}

function blankPages(viewport) {
  const rect = viewport.getBoundingClientRect();
  let visible = 0;
  let blank = 0;
  for (const page of viewport.querySelectorAll(".pdfViewer .page")) {
    const box = page.getBoundingClientRect();
    if (Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top) < 40) continue;
    visible += 1;
    if (!page.querySelector("canvas") || page.querySelector(".loadingIcon:not(.notVisible)") || !page.getAttribute("data-loaded")) blank += 1;
  }
  return { visible, blank };
}

async function pdfOpen() {
  await openFile("notes/note-000.md");
  await settle(600);
  const started = performance.now();
  await openFile("reference.pdf");
  await waitFor(() => document.querySelector(".pdfViewer .page canvas"), "first PDF canvas", 30_000);
  const firstCanvasMs = performance.now() - started;
  const quiet = await settle(500, 20_000);
  return { firstCanvasMs: Math.round(firstCanvasMs), settledMs: Math.round(firstCanvasMs + quiet) };
}

async function pdfScroll() {
  const viewport = await waitFor(() => pdfViewport(), "PDF area");
  viewport.scrollTop = 0;
  await settle(800);
  const { x, y } = center(viewport);
  let sign = 1;
  const attempts = [];
  calibrate: for (const direct of [true, false]) {
    input.wheelDirect = direct;
    for (const candidate of [1, -1]) {
      await input.wheel(x, y, 40 * candidate);
      await sleep(150);
      await nextPaint();
      attempts.push({ direct, candidate, top: viewport.scrollTop, debug: input.wheelDebug });
      if (viewport.scrollTop > 0) {
        sign = candidate;
        break calibrate;
      }
    }
  }
  const calibrated = viewport.scrollTop > 0;
  viewport.scrollTop = 0;
  await settle(600);
  const samples = [];
  let sampling = true;
  const sample = () => {
    samples.push({ t: performance.now(), top: viewport.scrollTop, ...blankPages(viewport) });
    if (sampling) requestAnimationFrame(sample);
  };
  const meter = frameMeter();
  requestAnimationFrame(sample);
  const inputStart = performance.now();
  for (let index = 0; index < 150; index += 1) {
    input.wheel(x, y, 40 * sign);
    await sleep(8);
  }
  for (let index = 0; index < 60; index += 1) {
    input.wheel(x, y, 12 * sign);
    await sleep(16);
  }
  const inputEnd = performance.now();
  await waitFor(() => blankPages(viewport).blank === 0, "pages painted", 15_000).catch(() => null);
  const painted = performance.now();
  sampling = false;
  const frames = meter.stop();
  const during = samples.filter((entry) => entry.t <= inputEnd);
  let stalled = 0;
  for (let index = 1; index < during.length; index += 1) if (during[index].top === during[index - 1].top) stalled += 1;
  return {
    calibrated,
    sign,
    direct: input.wheelDirect,
    attempts: calibrated ? attempts.length : attempts,
    scrolledPx: Math.round(viewport.scrollTop),
    inputMs: Math.round(inputEnd - inputStart),
    blankFrames: during.filter((entry) => entry.blank > 0).length,
    sampledFrames: during.length,
    stalledFrames: stalled,
    paintedAfterInputMs: Math.round(painted - inputEnd),
    frames,
  };
}

async function pdfZoom(kind) {
  const viewport = await waitFor(() => pdfViewport(), "PDF area");
  await settle(600);
  const { x, y } = center(viewport);
  const scale = () => viewport.querySelector(".pdfViewer")?.style.getPropertyValue("--scale-factor") ?? "";
  const result = {};
  for (const direction of ["in", "out"]) {
    const before = scale();
    const meter = frameMeter();
    const inputStart = performance.now();
    for (let step = 0; step < 20; step += 1) {
      if (kind === "native-pinch") {
        invoke("perf_magnify", { steps: 1, magnification: direction === "in" ? 0.03 : -0.0291, x, y, intervalMs: 0 });
      } else {
        viewport.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: direction === "in" ? -3 : 3, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      }
      await sleep(16);
    }
    const inputEnd = performance.now();
    await waitFor(() => scale() !== before, "scale change", 5000).catch(() => null);
    await sleep(200);
    await waitFor(() => blankPages(viewport).blank === 0, "zoomed pages painted", 15_000).catch(() => null);
    const quiet = await settle(400, 15_000, viewport);
    const settled = performance.now();
    result[direction] = {
      scaleBefore: before,
      scaleAfter: scale(),
      inputMs: Math.round(inputEnd - inputStart),
      settledAfterInputMs: Math.round(settled - inputEnd - Math.max(0, 400 - quiet)),
      frames: meter.stop(),
    };
  }
  return result;
}

async function fling(scroller, count, delta, gapMs, trackBlank) {
  const { x, y } = center(scroller);
  input.wheelDirect = true;
  const samples = [];
  let sampling = true;
  const sample = () => {
    samples.push({ t: performance.now(), top: scroller.scrollTop, blank: trackBlank ? blankPages(scroller).blank : 0 });
    if (sampling) requestAnimationFrame(sample);
  };
  const meter = frameMeter();
  requestAnimationFrame(sample);
  const inputStart = performance.now();
  const startTop = scroller.scrollTop;
  const timeline = [];
  let lastFrame = inputStart;
  const trackFrames = (now) => {
    if (now - lastFrame > 12) timeline.push(`@${Math.round(lastFrame - inputStart)}+${Math.round(now - lastFrame)}:${Math.round(scroller.scrollTop - startTop)}px`);
    lastFrame = now;
    if (sampling) requestAnimationFrame(trackFrames);
  };
  requestAnimationFrame(trackFrames);
  for (let index = 0; index < count; index += 1) {
    input.wheel(x, y, delta);
    await sleep(gapMs);
  }
  const inputEnd = performance.now();
  if (trackBlank) await waitFor(() => blankPages(scroller).blank === 0, "pages painted", 20_000).catch(() => null);
  else await sleep(300);
  const painted = performance.now();
  sampling = false;
  const frames = meter.stop();
  const during = samples.filter((entry) => entry.t <= inputEnd);
  let run = 0;
  let longestRun = 0;
  for (const entry of during) {
    run = entry.blank > 0 ? run + 1 : 0;
    longestRun = Math.max(longestRun, run);
  }
  return {
    scrolledPx: Math.round(scroller.scrollTop - startTop),
    inputMs: Math.round(inputEnd - inputStart),
    blankFrameShare: during.length ? Number((during.filter((entry) => entry.blank > 0).length / during.length).toFixed(3)) : null,
    longestBlankRun: longestRun,
    paintedAfterInputMs: Math.round(painted - inputEnd),
    frames,
    timeline,
  };
}

async function bigPdf(path, pages) {
  await openFile("notes/note-001.md").catch(() => null);
  await settle(500);
  const started = performance.now();
  await openFile(path);
  const viewport = await waitFor(() => [...document.querySelectorAll(".pdf-scroll-area-viewport")].find((candidate) => candidate.getBoundingClientRect().width > 100 && candidate.querySelectorAll(".pdfViewer .page").length === pages), `${path} viewer`, 60_000);
  await waitFor(() => viewport.querySelector(".pdfViewer .page canvas"), "first canvas", 60_000);
  const firstCanvasMs = Math.round(performance.now() - started);
  await settle(800, 30_000);
  const pageCount = viewport.querySelectorAll(".pdfViewer .page").length;
  const flingResult = await fling(viewport, 200, 120, 8, true);
  await settle(500, 20_000);
  const jumpStart = performance.now();
  viewport.scrollTop = viewport.scrollHeight * 0.7;
  await nextPaint();
  const jumped = await waitFor(() => blankPages(viewport).blank === 0, "jump painted", 20_000).then(() => true, () => false);
  const jumpPaintedMs = Math.round(performance.now() - jumpStart);
  await settle(500, 20_000);
  return { pages: pageCount, firstCanvasMs, fling: flingResult, jumpPaintedMs, jumped, zoom: await bigPdfZoom(viewport), dom: domSize() };
}

async function longTex() {
  const started = performance.now();
  await openFile("long.tex");
  const editor = await waitFor(() => [...document.querySelectorAll(".cm-editor")].map((element) => EditorView.findFromDOM(element)).find((view) => view && view.state.doc.length > 1e6 && view.dom.getBoundingClientRect().width > 50), "long.tex editor", 30_000);
  await nextPaint();
  const openMs = Math.round(performance.now() - started);
  await settle(800, 20_000);
  const flingResult = await fling(editor.scrollDOM, 200, 120, 8, false);
  await settle(800, 20_000);
  const rect = editor.scrollDOM.getBoundingClientRect();
  const line = [...editor.contentDOM.querySelectorAll(".cm-line")].find((candidate) => {
    const box = candidate.getBoundingClientRect();
    return box.top > rect.top + 60 && box.bottom < rect.bottom - 60 && (candidate.textContent ?? "").length > 20;
  });
  if (line) await input.click(line, 0.05, 0.5);
  await sleep(200);
  const before = editor.state.doc.length;
  await profileMarker("longtex-typing");
  const typing = await typeAndMeasure("the quick brown fox jumps over lazy dogs ", 110);
  await settle(1200);
  return { openMs, docChars: before, fling: flingResult, typing: { ...typing, inserted: editor.state.doc.length - before } };
}

async function longMarkdown() {
  await openFile("main.tex");
  await settle(800);
  const started = performance.now();
  await openFile("large.md");
  await selectView("Preview");
  await waitFor(() => (document.querySelector(".ProseMirror")?.childElementCount ?? 0) > 1000, "visual editor filled", 60_000);
  await nextPaint();
  const openMs = Math.round(performance.now() - started);
  await settle(1500, 30_000);
  const scroller = await waitFor(() => document.querySelector(".markdown-preview .editor-doc-scroll"), "visual scroller", 10_000);
  await profileMarker("md-fling");
  await sleep(300);
  const flingResult = await fling(scroller, 200, 120, 8, false);
  await settle(800, 20_000);
  return { openMs, fling: flingResult, dom: domSize() };
}

async function bigPdfZoom(viewport) {
  await profileMarker("bigzoom-start");
  const { x, y } = center(viewport);
  const scale = () => viewport.querySelector(".pdfViewer")?.style.getPropertyValue("--scale-factor") ?? "";
  const before = scale();
  const meter = frameMeter();
  const inputStart = performance.now();
  const timeline = [];
  let last = inputStart;
  let tracking = true;
  const track = (now) => {
    if (now - last > 12) timeline.push(`@${Math.round(last - inputStart)}+${Math.round(now - last)}`);
    last = now;
    if (tracking) requestAnimationFrame(track);
  };
  requestAnimationFrame(track);
  for (let step = 0; step < 20; step += 1) {
    viewport.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: -3, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    await sleep(16);
  }
  const inputEnd = performance.now();
  await waitFor(() => scale() !== before, "scale change", 5000).catch(() => null);
  const scaled = performance.now();
  await sleep(200);
  await waitFor(() => blankPages(viewport).blank === 0, "zoomed pages painted", 20_000).catch(() => null);
  const painted = performance.now();
  tracking = false;
  return { scaleBefore: before, scaleAfter: scale(), inputMs: Math.round(inputEnd - inputStart), scaledAfterInputMs: Math.round(scaled - inputEnd), paintedAfterInputMs: Math.round(painted - inputEnd), frames: meter.stop(), timeline };
}

async function panels() {
  const result = {};
  const toggles = [...document.querySelectorAll(".trellis-titlebar-toggle[aria-pressed]")];
  result.toggleLabels = toggles.map((toggle) => toggle.getAttribute("aria-label"));
  for (const name of ["Papers"]) {
    const toggle = toggles.find((candidate) => (candidate.getAttribute("aria-label") ?? "").includes(name));
    if (!toggle) continue;
    const runs = {};
    for (const step of ["hide", "show"]) {
      await settle(400);
      const meter = frameMeter();
      const started = performance.now();
      await input.click(toggle);
      const quiet = await settle(300, 10_000);
      runs[step] = { settledMs: Math.round(performance.now() - started - 300 + Math.min(quiet, 0)), frames: meter.stop() };
    }
    result[name] = runs;
  }
  await settle(400);
  await sleep(300);
  const dividers = [...document.querySelectorAll('[data-trellis-part="divider"]')].map((element) => ({ element, rect: element.getBoundingClientRect() }));
  result.dividerRects = dividers.map(({ element, rect }) => `${element.getAttribute("aria-orientation")} ${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
  const divider = dividers.filter(({ element, rect }) => element.getAttribute("aria-orientation") === "vertical" && rect.height > 200).sort((a, b) => b.rect.left - a.rect.left)[0];
  if (divider) {
    const x = divider.rect.left + divider.rect.width / 2;
    const y = divider.rect.top + divider.rect.height / 2;
    const points = [[x, y]];
    for (let step = 1; step <= 60; step += 1) points.push([x - step * 4, y]);
    for (let step = 59; step >= 0; --step) points.push([x - step * 4, y]);
    await settle(400);
    let maxShift = 0;
    let tracking = true;
    const track = () => {
      const now = divider.element.isConnected ? divider.element.getBoundingClientRect().left : divider.rect.left;
      maxShift = Math.max(maxShift, Math.abs(now - divider.rect.left));
      if (tracking) requestAnimationFrame(track);
    };
    requestAnimationFrame(track);
    const meter = frameMeter();
    const started = performance.now();
    await input.mouse(points, 8);
    const ended = performance.now();
    tracking = false;
    result.resizeMaxShiftPx = Math.round(maxShift);
    const quiet = await settle(400, 10_000);
    result.resize = { inputMs: Math.round(ended - started), settledAfterInputMs: Math.max(0, Math.round(performance.now() - ended - 400 + Math.min(quiet, 0))), frames: meter.stop() };
  }
  return result;
}

async function dialogs() {
  const result = {};
  for (const [name, init] of [["settings", { key: ",", metaKey: true }], ["palette", { key: "P", metaKey: true, shiftKey: true }], ["quickOpen", { key: "p", metaKey: true }]]) {
    await settle(400);
    const meter = frameMeter();
    let inserted = 0;
    const observer = new MutationObserver(() => {
      if (!inserted && document.querySelector('[role="dialog"]')) inserted = performance.now();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const started = performance.now();
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
    const handled = performance.now();
    await Promise.resolve();
    await Promise.resolve();
    const microtasks = performance.now();
    getComputedStyle(document.body).color;
    const styled = performance.now();
    document.body.offsetWidth;
    const laidOut = performance.now();
    const bodyState = `${document.body.getAttribute("style") ?? ""} ${[...document.body.attributes].map((attribute) => attribute.name).join(",")}`;
    const dialog = await waitFor(() => document.querySelector('[role="dialog"]'), `${name} dialog`, 5000).catch(() => null);
    observer.disconnect();
    const firstPaint = await nextPaint();
    const shownMs = performance.now() - started;
    await nextPaint();
    const running = (dialog ? dialog.getAnimations({ subtree: true }) : []).filter((animation) => animation.playState === "running");
    await Promise.race([Promise.all(running.map((animation) => animation.finished.catch(() => null))), sleep(2000)]);
    const animationsDone = performance.now() - started;
    await sleep(150);
    const frames = meter.stop();
    syntheticKey("Escape");
    await waitFor(() => !document.querySelector('[role="dialog"]'), `${name} closed`, 3000).catch(() => null);
    result[name] = {
      breakdown: {
        handlersMs: Math.round(handled - started),
        microtasksMs: Math.round(microtasks - handled),
        forcedStyleMs: Math.round(styled - microtasks),
        forcedLayoutMs: Math.round(laidOut - styled),
        bodyState,
        domInsertMs: inserted ? Math.round(inserted - started) : null,
        firstPaintAfterMs: Math.round(firstPaint - started),
      },
      opened: !!dialog,
      shownMs: Math.round(shownMs),
      animationsDoneMs: Math.round(animationsDone),
      runningAnimations: running.length,
      frames,
    };
    await sleep(300);
  }
  return result;
}

async function repeat(times, action) {
  const durations = [];
  for (let index = 0; index < times; index += 1) {
    const started = performance.now();
    await action();
    durations.push(performance.now() - started);
  }
  return stats(durations);
}

async function ipc() {
  const project = config?.project ?? null;
  const result = {
    echo1k: await repeat(100, () => invoke("perf_echo", { payload: "x".repeat(1e3) })),
    echo100k: await repeat(20, () => invoke("perf_echo", { payload: "x".repeat(1e5) })),
    bytes1m: await repeat(10, () => invoke("perf_bytes", { len: 1e6 })),
    bytes10m: await repeat(3, () => invoke("perf_bytes", { len: 1e7 })),
    readLargeMd: await repeat(3, () => invoke("read_project_file", { path: "large.md" })),
  };
  if (project) result.readCompiledPdf = await repeat(3, () => invoke("read_compiled_pdf", { projectRoot: project }).catch(() => null));
  const delivered = [];
  const unlisten = await listen("perf-tick", (event) => delivered.push(epoch() - clockOffset - event.payload.sentAt));
  await invoke("perf_emit", { count: 200, intervalMs: 10, size: 2000 });
  await waitFor(() => delivered.length >= 200, "200 events", 15_000).catch(() => null);
  unlisten();
  result.eventDelivery = stats(delivered);
  return result;
}

async function liveEdit() {
  await openFile("chapters/ch02.tex");
  await settle(800);
  const editor = await clickLine(6);
  let applied = 0;
  const delivered = [];
  const unlisten = await listen("perf-tick", (event) => {
    delivered.push(epoch() - clockOffset - event.payload.sentAt);
    const at = Math.min(editor.state.doc.length, Math.floor(editor.state.doc.length * 0.6));
    editor.dispatch({ changes: { from: at, insert: `r${event.payload.seq} ` }, userEvent: "input.remote" });
    applied += 1;
  });
  await invoke("perf_emit", { count: 120, intervalMs: 50, size: 300 });
  const typing = await typeAndMeasure("the quick brown fox jumps over lazy dogs ", 120);
  await waitFor(() => applied >= 120, "remote edits", 10_000).catch(() => null);
  unlisten();
  await settle(1200);
  return { ...typing, remoteApplied: applied, remoteDelivery: stats(delivered) };
}

let clockOffset = 0;
async function calibrateClock() {
  const samples = [];
  for (let index = 0; index < 30; index += 1) {
    const sent = epoch();
    const remote = await invoke("perf_now");
    const received = epoch();
    samples.push({ rtt: received - sent, offset: (sent + received) / 2 - remote });
  }
  samples.sort((a, b) => a.rtt - b.rtt);
  const offsets = samples.slice(0, 10).map((sample) => sample.offset).sort((a, b) => a - b);
  clockOffset = offsets[Math.floor(offsets.length / 2)];
  return { offsetMs: Number(clockOffset.toFixed(2)), bestRttMs: Number(samples[0].rtt.toFixed(2)) };
}

async function idle() {
  await settle(500);
  const meter = frameMeter();
  await sleep(1500);
  return meter.stop();
}

async function agentOpen() {
  const tab = await waitFor(() => [...document.querySelectorAll('[data-trellis-part="tab"]')].find((candidate) => candidate.textContent?.trim() === "Agent"), "Agent tab", 10_000);
  await settle(400);
  const meter = frameMeter();
  const started = performance.now();
  await input.click(tab);
  const frame = await waitFor(() => [...document.querySelectorAll("iframe")].find((candidate) => candidate.getBoundingClientRect().width > 100), "visible agent iframe", 20_000).catch(() => null);
  const visibleMs = performance.now() - started;
  const quiet = await settle(800, 20_000);
  return { iframeVisibleMs: Math.round(visibleMs), settledMs: Math.round(performance.now() - started - 800 + Math.min(quiet, 0)), hasFrame: !!frame, frames: meter.stop() };
}

async function profileMarker(name) {
  await invoke("perf_write", { name: `${config?.label}-${name}.marker`, content: String(epoch()) }).catch(() => null);
}

async function dividerDragPoints() {
  await settle(400);
  await sleep(300);
  const divider = [...document.querySelectorAll('[data-trellis-part="divider"]')]
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .filter(({ element, rect }) => element.getAttribute("aria-orientation") === "vertical" && rect.height > 200)
    .sort((a, b) => b.rect.left - a.rect.left)[0];
  const x = divider.rect.left + divider.rect.width / 2;
  const y = divider.rect.top + divider.rect.height / 2;
  const points = [[x, y]];
  for (let step = 1; step <= 60; step += 1) points.push([x - step * 4, y]);
  for (let step = 59; step >= 0; --step) points.push([x - step * 4, y]);
  return points;
}

const dragTimeline = [];
async function dragLoop() {
  dragTimeline.length = 0;
  const points = await dividerDragPoints();
  const mutationCounts = new Map();
  const describe = (node) => node instanceof Element ? `${node.tagName.toLowerCase()}.${[...node.classList].slice(0, 2).join(".")}${node.getAttribute("data-trellis-part") ? `[${node.getAttribute("data-trellis-part")}]` : ""}` : node.nodeName;
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const key = `${record.type}:${record.attributeName ?? ""}:${describe(record.target)}`;
      mutationCounts.set(key, (mutationCounts.get(key) ?? 0) + 1);
    }
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true, attributeOldValue: false });
  await profileMarker("drag-start");
  takeCallbackTimes();
  const results = [];
  const pin = window.__latticeLabFlags.includes("pinpm");
  for (let round = 0; round < 6; round += 1) {
    const pinned = pin ? [...document.querySelectorAll(".ProseMirror")] : [];
    for (const element of pinned) element.style.width = `${element.getBoundingClientRect().width}px`;
    const meter = frameMeter();
    const roundStart = performance.now();
    let last = roundStart;
    let tracking = true;
    const track = (now) => {
      if (now - last > 12) dragTimeline.push(`r${round}@${Math.round(last - roundStart)}+${Math.round(now - last)}`);
      last = now;
      if (tracking) requestAnimationFrame(track);
    };
    requestAnimationFrame(track);
    await input.mouse(points, 8);
    dragTimeline.push(`r${round}:up@${Math.round(performance.now() - roundStart)}`);
    await sleep(100);
    tracking = false;
    results.push(meter.stop());
    for (const element of pinned) element.style.width = "";
  }
  await profileMarker("drag-end");
  observer.disconnect();
  const mutations = [...mutationCounts].sort((a, b) => b[1] - a[1]).slice(0, 30);
  return { fps: results.map((r) => r.fps), longest: results.map((r) => r.longestMs), mutations: mutations.slice(0, 8), callbacks: takeCallbackTimes(), timeline: dragTimeline };
}

async function openVisual() {
  await openFile("large.md");
  await selectView("Preview");
  await waitFor(() => (document.querySelector(".ProseMirror")?.childElementCount ?? 0) > 1000, "visual editor filled", 60_000);
  await settle(1500, 30_000);
}

async function zoomLoop(path, pages) {
  await openFile(path);
  const viewport = await waitFor(() => [...document.querySelectorAll(".pdf-scroll-area-viewport")].find((candidate) => candidate.getBoundingClientRect().width > 100 && candidate.querySelectorAll(".pdfViewer .page").length === pages), `${path} viewer`, 60_000);
  await waitFor(() => viewport.querySelector(".pdfViewer .page canvas"), "first canvas", 60_000);
  await settle(800, 30_000);
  const { x, y } = center(viewport);
  await profileMarker("zoom-start");
  const results = [];
  const timeline = [];
  for (let round = 0; round < 6; round += 1) {
    const meter = frameMeter();
    const roundStart = performance.now();
    let last = roundStart;
    let tracking = true;
    const track = (now) => {
      if (now - last > 12) timeline.push(`r${round}@${Math.round(last - roundStart)}+${Math.round(now - last)}`);
      last = now;
      if (tracking) requestAnimationFrame(track);
    };
    requestAnimationFrame(track);
    for (let step = 0; step < 20; step += 1) {
      viewport.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: round % 2 ? 3 : -3, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      await sleep(16);
    }
    await sleep(500);
    tracking = false;
    results.push(meter.stop());
  }
  await profileMarker("zoom-end");
  return { fps: results.map((r) => r.fps), longest: results.map((r) => r.longestMs), timeline };
}

async function scaleBench(path, pages) {
  await openFile(path);
  const viewport = await waitFor(() => [...document.querySelectorAll(".pdf-scroll-area-viewport")].find((candidate) => candidate.getBoundingClientRect().width > 100 && candidate.querySelectorAll(".pdfViewer .page").length === pages), `${path} viewer`, 60_000);
  await waitFor(() => viewport.querySelector(".pdfViewer .page canvas"), "first canvas", 60_000);
  await settle(800, 30_000);
  const viewer = viewport.querySelector(".pdfViewer");
  if (window.__latticeLabFlags.includes("nopdfcss")) {
    for (const sheet of document.styleSheets) {
      let rules = [];
      try { rules = [...sheet.cssRules]; } catch { continue; }
      if (rules.some((rule) => rule.cssText?.includes("pdfSlickViewer"))) sheet.disabled = true;
    }
  }
  if (window.__latticeLabFlags.includes("nouniversal")) {
    // Drop the pdf.js rules whose subject has no class, id or tag to bucket them by.
    let dropped = 0;
    for (const sheet of document.styleSheets) {
      let rules = [];
      try { rules = [...sheet.cssRules]; } catch { continue; }
      if (!rules.some((rule) => rule.cssText?.includes("pdfSlickViewer"))) continue;
      for (let index = sheet.cssRules.length - 1; index >= 0; index -= 1) {
        const rule = sheet.cssRules[index];
        const selector = rule.selectorText;
        if (!selector) continue;
        const subjects = selector.split(",").map((part) => part.trim().split(/\s+|>|\+|~/).pop() ?? "");
        if (subjects.some((subject) => !/[.#]|^[a-z]/i.test(subject.replace(/:is\(.*\)|:where\(.*\)|:not\(.*\)|::?[a-z-]+(\(.*\))?/gi, "")))) {
          sheet.deleteRule(index);
          dropped += 1;
        }
      }
    }
    window.__labDropped = dropped;
  }
  const original = viewer.style.getPropertyValue("--scale-factor");
  const base = Number(original) || 1;
  const style = [];
  const layout = [];
  for (let step = 0; step < 20; step += 1) {
    viewer.style.setProperty("--scale-factor", String(base * (step % 2 ? 1.01 : 0.99)));
    const started = performance.now();
    getComputedStyle(viewer.querySelector(".page")).width;
    const styled = performance.now();
    void viewer.offsetHeight;
    const laidOut = performance.now();
    style.push(styled - started);
    layout.push(laidOut - styled);
    await nextPaint();
  }
  viewer.style.setProperty("--scale-factor", original);
  await settle(400);
  return { style: stats(style), layout: stats(layout), elements: viewer.getElementsByTagName("*").length, pages: viewer.querySelectorAll(".page").length, dropped: window.__labDropped };
}

async function cssVarBench() {
  const variants = {
    ownVars: ".lab-x > div { --a: 1; --b: calc(var(--s) * var(--a)); width: calc(var(--b) * 100px); height: 10px; }",
    parentVars: ".lab-x { --a: 1; --b: calc(var(--s) * var(--a)); } .lab-x > div { width: calc(var(--b) * 100px); height: 10px; }",
    noVarsInline: ".lab-x > div { height: 10px; }",
    pdfjsLike: ".lab-x > div { --user-unit: 1; --total: calc(var(--s) * var(--user-unit)); --rx: 1px; --ry: 1px; }",
    pdfjsLikeCalc: ".lab-x > div { --user-unit: 1; --total: calc(var(--s) * var(--user-unit)); --rx: 1px; --ry: 1px; }",
  };
  const inlineFor = {
    pdfjsLike: "width: round(down, var(--total) * 612px, var(--rx)); height: round(down, var(--total) * 792px, var(--ry));",
    pdfjsLikeCalc: "width: calc(var(--total) * 612px); height: calc(var(--total) * 792px);",
  };
  const result = {};
  for (const [name, css] of Object.entries(variants)) {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    const host = document.createElement("div");
    host.className = "lab-x";
    host.style.cssText = "position:fixed;left:0;top:0;width:10px;height:10px;overflow:hidden;opacity:0;--s:1";
    for (let index = 0; index < 2000; index += 1) {
      const child = document.createElement("div");
      if (inlineFor[name]) child.style.cssText = inlineFor[name];
      host.append(child);
    }
    document.body.append(host);
    void host.offsetHeight;
    await nextPaint();
    const times = [];
    for (let step = 0; step < 20; step += 1) {
      const value = step % 2 ? 1.01 : 0.99;
      const started = performance.now();
      if (name === "noVarsInline") for (const child of host.children) child.style.width = `${value * 100}px`;
      else host.style.setProperty("--s", String(value));
      void host.lastElementChild.offsetWidth;
      times.push(performance.now() - started);
      await nextPaint();
    }
    host.remove();
    style.remove();
    result[name] = stats(times);
  }
  return result;
}

async function restyleTime(viewer, rounds = 8) {
  const times = [];
  for (let step = 0; step < rounds; step += 1) {
    viewer.style.setProperty("--lab-dummy", String(step));
    const started = performance.now();
    void viewer.lastElementChild?.offsetWidth;
    times.push(performance.now() - started);
    await nextPaint();
  }
  return quantile(times, 0.5);
}

async function styleBisect(path, pages) {
  await openFile(path);
  const viewport = await waitFor(() => [...document.querySelectorAll(".pdf-scroll-area-viewport")].find((candidate) => candidate.getBoundingClientRect().width > 100 && candidate.querySelectorAll(".pdfViewer .page").length === pages), `${path} viewer`, 60_000);
  await waitFor(() => viewport.querySelector(".pdfViewer .page canvas"), "first canvas", 60_000);
  await settle(800, 30_000);
  const viewer = viewport.querySelector(".pdfViewer");
  const base = await restyleTime(viewer);
  const sheets = [];
  for (const sheet of document.styleSheets) {
    let rules = [];
    try { rules = [...sheet.cssRules]; } catch { continue; }
    sheets.push({ sheet, count: rules.length, pdf: rules.some((rule) => rule.cssText?.includes("pdfSlickViewer")) });
  }
  const result = { base, sheets: [], chunks: [] };
  for (const entry of sheets) {
    entry.sheet.disabled = true;
    const without = await restyleTime(viewer, 4);
    entry.sheet.disabled = false;
    result.sheets.push({ rules: entry.count, pdf: entry.pdf, saved: base - without });
  }
  for (const entry of sheets.filter((candidate) => candidate.count > 50)) {
    const { sheet } = entry;
    const chunk = Math.max(25, Math.ceil(sheet.cssRules.length / 24));
    for (let start = 0; start < sheet.cssRules.length; start += chunk) {
      const removed = [];
      const end = Math.min(sheet.cssRules.length, start + chunk);
      for (let index = end - 1; index >= start; index -= 1) {
        removed.unshift(sheet.cssRules[index].cssText);
        sheet.deleteRule(index);
      }
      const without = await restyleTime(viewer, 4);
      removed.forEach((text, offset) => sheet.insertRule(text, start + offset));
      const saved = base - without;
      if (saved >= 2) result.chunks.push({ pdf: entry.pdf, start, end, saved, sample: removed.slice(0, 3).map((text) => text.slice(0, 90)) });
    }
  }
  return result;
}

async function resizeBench() {
  const pane = document.querySelector(".markdown-preview") ?? document.querySelector(".lx-md-editor");
  const scroller = document.querySelector(".markdown-preview .editor-doc-scroll") ?? pane;
  const width = pane.getBoundingClientRect().width;
  const times = [];
  for (let step = 0; step < 60; step += 1) {
    pane.style.width = `${Math.round(width - 4 - (step % 10) * 4)}px`;
    const started = performance.now();
    void scroller.offsetHeight;
    times.push(performance.now() - started);
    await nextPaint();
  }
  pane.style.width = "";
  await settle(400);
  return { width, layout: stats(times), dom: domSize(), placeholders: document.querySelectorAll("[data-lx-virtual]").length, topLevel: document.querySelector(".ProseMirror")?.childElementCount };
}

async function zoomPreviewOnly(path, pages) {
  await openFile(path);
  const viewport = await waitFor(() => [...document.querySelectorAll(".pdf-scroll-area-viewport")].find((candidate) => candidate.getBoundingClientRect().width > 100 && candidate.querySelectorAll(".pdfViewer .page").length === pages), `${path} viewer`, 60_000);
  await waitFor(() => viewport.querySelector(".pdfViewer .page canvas"), "first canvas", 60_000);
  await settle(800, 30_000);
  const { x, y } = center(viewport);
  await profileMarker("preview-start");
  const meter = frameMeter();
  for (let step = 0; step < 240; step += 1) {
    viewport.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: Math.floor(step / 20) % 2 ? 3 : -3, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    await sleep(12);
  }
  const frames = meter.stop();
  await settle(800, 20_000);
  return { frames, layers: viewport.querySelectorAll(".pdfViewer .page.latticeLayered").length, canvases: viewport.querySelectorAll("canvas").length };
}

async function typingBreakdown(text, gapMs) {
  const records = [];
  let current = null;
  const finish = (record) => queueMicrotask(() => {
    record.t2 = performance.now();
    getComputedStyle(document.documentElement).color;
    record.t3 = performance.now();
    void document.documentElement.offsetHeight;
    record.t4 = performance.now();
    requestAnimationFrame(() => setTimeout(() => {
      record.t5 = performance.now();
      records.push(record);
    }, 0));
  });
  const onKeydown = (event) => { if (event.key.length === 1) current = { t0: performance.now() }; };
  const onBeforeInput = (event) => {
    if (current && event.defaultPrevented) { current.t1 = performance.now(); finish(current); current = null; }
  };
  const onInput = () => { if (current) { current.t1 = performance.now(); finish(current); current = null; } };
  window.addEventListener("keydown", onKeydown, { capture: true });
  window.addEventListener("beforeinput", onBeforeInput);
  window.addEventListener("input", onInput);
  for (const character of text) {
    await input.keys(character);
    await sleep(gapMs);
  }
  await sleep(300);
  window.removeEventListener("keydown", onKeydown, { capture: true });
  window.removeEventListener("beforeinput", onBeforeInput);
  window.removeEventListener("input", onInput);
  const done = records.filter((record) => record.t5 !== undefined);
  return {
    n: done.length,
    inputHandlersMs: stats(done.map((r) => r.t2 - r.t0)),
    styleMs: stats(done.map((r) => r.t3 - r.t2)),
    layoutMs: stats(done.map((r) => r.t4 - r.t3)),
    toNextPaintMs: stats(done.map((r) => r.t5 - r.t4)),
    totalMs: stats(done.map((r) => r.t5 - r.t0)),
  };
}

async function longTexBreakdown() {
  await openFile("long.tex");
  const editor = await waitFor(() => [...document.querySelectorAll(".cm-editor")].map((element) => EditorView.findFromDOM(element)).find((view) => view && view.state.doc.length > 1e6 && view.dom.getBoundingClientRect().width > 50), "long.tex editor", 30_000);
  await settle(800, 20_000);
  const rect = editor.scrollDOM.getBoundingClientRect();
  const line = [...editor.contentDOM.querySelectorAll(".cm-line")].find((candidate) => {
    const box = candidate.getBoundingClientRect();
    return box.top > rect.top + 60 && box.bottom < rect.bottom - 60 && (candidate.textContent ?? "").length > 20;
  });
  if (line) await input.click(line, 0.05, 0.5);
  await sleep(200);
  takeCallbackTimes();
  const longTex = await typingBreakdown("the quick brown fox jumps over lazy dogs ", 110);
  longTex.callbacks = takeCallbackTimes().slice(0, 12);
  await settle(1200);
  await openFile("chapters/ch01.tex");
  await settle(800);
  await clickLine(8);
  const shortTex = await typingBreakdown("the quick brown fox jumps over lazy dogs ", 110);
  return { longTex, shortTex };
}

function pageGeometry(viewport) {
  const area = viewport.getBoundingClientRect();
  const problems = [];
  let checked = 0;
  for (const page of viewport.querySelectorAll(".pdfViewer .page")) {
    const box = page.getBoundingClientRect();
    if (box.bottom < area.top || box.top > area.bottom) continue;
    const canvas = page.querySelector("canvas");
    const text = page.querySelector(".textLayer");
    if (!canvas) continue;
    checked += 1;
    const near = (a, b) => Math.abs(a.left - b.left) <= 1.5 && Math.abs(a.top - b.top) <= 1.5 && Math.abs(a.width - b.width) <= 1.5 && Math.abs(a.height - b.height) <= 1.5;
    const canvasBox = canvas.getBoundingClientRect();
    if (!near(canvasBox, box)) problems.push(`p${page.dataset.pageNumber} canvas ${Math.round(canvasBox.left)},${Math.round(canvasBox.top)} ${Math.round(canvasBox.width)}x${Math.round(canvasBox.height)} vs page ${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}`);
    if (text && !text.hidden && getComputedStyle(text).display !== "none") {
      const textBox = text.getBoundingClientRect();
      if (!near(textBox, box)) problems.push(`p${page.dataset.pageNumber} text ${Math.round(textBox.left)},${Math.round(textBox.top)} ${Math.round(textBox.width)}x${Math.round(textBox.height)}`);
    }
    if (getComputedStyle(page).position !== "relative") problems.push(`p${page.dataset.pageNumber} position ${getComputedStyle(page).position}`);
  }
  return { checked, problems: problems.slice(0, 6), staticPages: [...viewport.querySelectorAll(".pdfViewer .page")].filter((page) => getComputedStyle(page).position === "static").length };
}

async function pdfGeometry() {
  const viewport = await waitFor(() => pdfViewport(), "PDF area");
  await settle(600);
  const result = { initial: pageGeometry(viewport) };
  const { x, y } = center(viewport);
  for (const [name, delta] of [["zoomIn", -3], ["zoomOut", 3]]) {
    for (let step = 0; step < 15; step += 1) {
      viewport.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: delta, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      await sleep(16);
    }
    await sleep(400);
    await waitFor(() => blankPages(viewport).blank === 0, "painted", 15_000).catch(() => null);
    await settle(400);
    result[name] = pageGeometry(viewport);
  }
  viewport.scrollTop = viewport.scrollHeight * 0.5;
  await sleep(300);
  await waitFor(() => blankPages(viewport).blank === 0, "painted", 15_000).catch(() => null);
  await settle(400);
  result.jumped = pageGeometry(viewport);
  return result;
}

async function longMarkdownTwice() {
  const first = await longMarkdown();
  const scroller = document.querySelector(".markdown-preview .editor-doc-scroll");
  scroller.scrollTop = 0;
  await settle(1500, 20_000);
  const second = await fling(scroller, 200, 120, 8, false);
  return { first: first.fling.timeline.slice(0, 4), firstLongest: first.fling.frames.longestMs, second: second.timeline.slice(0, 4), secondLongest: second.frames.longestMs };
}

// Cold versus warm first open of a lazily loaded tool (Settings, History,
// Comments), whose Suspense boundary falls back to nothing (P21). `contentMs` runs
// from the input event to the first animation frame the tool's own element is
// in the page, so it is the time the reader sees no answer to the click.
const COLD_TOOLS = {
  settings: {
    load: () => import("../settings/settings-dialog"),
    open: () => window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true, cancelable: true })),
    content: ".settings-modal",
    close: () => syntheticKey("Escape"),
  },
  history: {
    load: () => import("../history/history-drawer"),
    button: 'button[aria-label="Project history"]',
    content: "aside.project-history-drawer",
    close: () => document.querySelector('aside.project-history-drawer [data-slot="panel-header-actions"] button:last-child')?.click(),
  },
  comments: {
    load: () => import("../editor/comments/editor-comments-panel"),
    button: 'button[aria-label="Editor comments"]',
    content: ".editor-comments-drawer",
    close: () => document.querySelector('.editor-comments-drawer [data-slot="panel-header-actions"] button:last-child')?.click(),
  },
};

async function openToolOnce(tool) {
  let inputAt = null;
  const onClick = (event) => { inputAt ??= event.timeStamp; };
  window.addEventListener("click", onClick, { capture: true });
  let contentAt = null;
  let watching = true;
  const watch = () => {
    if (!watching) return;
    const element = document.querySelector(tool.content);
    if (element && element.getBoundingClientRect().width > 0) contentAt = performance.now();
    else requestAnimationFrame(watch);
  };
  requestAnimationFrame(watch);
  const meter = frameMeter();
  try {
    if (tool.button) {
      await input.click(await waitFor(() => document.querySelector(tool.button), tool.button, 5000));
    } else {
      inputAt = performance.now();
      tool.open();
    }
    await waitFor(() => contentAt !== null, tool.content, 10_000);
  } finally {
    watching = false;
    window.removeEventListener("click", onClick, { capture: true });
  }
  const frames = meter.stop();
  // The chunks the open fetched, as start-end milliseconds after the input.
  const chunks = performance.getEntriesByType("resource")
    .filter((entry) => entry.startTime >= inputAt - 1 && /\.(js|css)$/.test(entry.name))
    .map((entry) => `${entry.name.split("/").pop()} ${Math.round(entry.startTime - inputAt)}-${Math.round(entry.responseEnd - inputAt)}`);
  return { ms: Number((contentAt - inputAt).toFixed(1)), longestFrameMs: frames.longestMs, chunks };
}

async function coldTool(name) {
  const tool = COLD_TOOLS[name];
  const closeTool = async () => {
    tool.close();
    await waitFor(() => !document.querySelector(tool.content), `${name} closed`, 5000);
    await settle(500, 10_000);
  };
  await settle(800, 20_000);
  // Lab flag `late`: open once startup's background work (idle chunk
  // prewarming, indexing, the first TexLab sync) has long finished.
  const flags = window.__latticeLabFlags ?? [];
  if (flags.includes("late")) {
    await sleep(12_000);
    await settle(1500, 20_000);
  }
  // Lab flag `prewarm`: load the tool's chunk first, so the cold open is
  // first render alone and the difference is the chunk.
  let loadMs = null;
  if (flags.includes("prewarm")) {
    const started = performance.now();
    await tool.load();
    loadMs = Math.round(performance.now() - started);
    await settle(500, 10_000);
  }
  const cold = await openToolOnce(tool);
  await settle(500, 10_000);
  await closeTool();
  const warm = [];
  for (let index = 0; index < 5; index += 1) {
    warm.push((await openToolOnce(tool)).ms);
    await settle(400, 10_000);
    await closeTool();
  }
  return { loadMs, coldMs: cold.ms, coldLongestFrameMs: cold.longestFrameMs, coldChunks: cold.chunks, warmMs: warm, warm: stats(warm) };
}

// TexLab traffic on the long source (P22). Every request carries the whole
// document: this splits a completion into the editor's `toString`, the IPC
// that carries the text (a non-.tex path stops in Rust before TexLab), and
// TexLab's own share, measured inside the app by `perf_texlab_probe` with a
// full-text sync, a one-range incremental sync and no sync at all.
async function texlabRequestCosts(path, text, line, character, rounds) {
  const toString = [];
  const completion = { sync: [], total: [], items: 0 };
  const ipcOnly = { sync: [], total: [] };
  const probe = { full: [], incremental: [], position: [], fullWrite: [] };
  const timed = async (into, command, args) => {
    const started = performance.now();
    const pending = invoke(command, args);
    into.sync.push(performance.now() - started);
    const answer = await pending.catch(() => null);
    into.total.push(performance.now() - started);
    return answer;
  };
  for (let round = 0; round < rounds; round += 1) {
    const started = performance.now();
    const fresh = typeof text === "function" ? text() : text;
    toString.push(performance.now() - started);
    const items = await timed(completion, "texlab_completion", { path, text: fresh, line, character });
    completion.items = Math.max(completion.items, items?.length ?? 0);
    await timed(ipcOnly, "texlab_completion", { path: `${path}.not-tex`, text: fresh, line, character });
    for (const mode of ["full", "incremental", "position"]) {
      const result = await invoke("perf_texlab_probe", { path, line, character, mode });
      probe[mode].push(result.totalMs);
      if (mode === "full") probe.fullWrite.push(result.syncMs);
    }
    await sleep(60);
  }
  return {
    chars: (typeof text === "function" ? text() : text).length,
    toString: stats(toString),
    completion: { sync: stats(completion.sync), total: stats(completion.total), items: completion.items },
    ipcOnly: { sync: stats(ipcOnly.sync), total: stats(ipcOnly.total) },
    rust: Object.fromEntries(Object.entries(probe).map(([mode, values]) => [mode, stats(values)])),
  };
}

// Records every TexLab request the editor makes while typing: its size, the
// main-thread time the IPC `fetch` took to start, and when its answer came
// back relative to the keystroke that asked. Tauri's `invoke` is read-only,
// so this wraps the `ipc://` fetch underneath it.
function recordTexlabTraffic() {
  const native = window.fetch;
  const requests = [];
  let lastKeydown = 0;
  const onKeydown = (event) => { if (event.key.length === 1) lastKeydown = performance.now(); };
  window.addEventListener("keydown", onKeydown, { capture: true });
  window.fetch = function (resource, init) {
    const command = /^ipc:\/\/localhost\/(texlab_completion|texlab_hover)$/.exec(String(resource))?.[1];
    if (!command) return native.call(this, resource, init);
    const started = performance.now();
    const entry = { command, chars: typeof init?.body === "string" ? init.body.length : 0, sinceKeydownMs: Number((started - lastKeydown).toFixed(1)) };
    requests.push(entry);
    const pending = native.call(this, resource, init);
    entry.fetchMs = Number((performance.now() - started).toFixed(2));
    const keydown = lastKeydown;
    return pending.finally(() => {
      entry.totalMs = Number((performance.now() - started).toFixed(1));
      entry.keyToResultMs = Number((performance.now() - keydown).toFixed(1));
    });
  };
  return () => {
    window.fetch = native;
    window.removeEventListener("keydown", onKeydown, { capture: true });
    const completions = requests.filter((entry) => entry.command === "texlab_completion");
    const measured = (key) => stats(completions.filter((entry) => entry[key] !== undefined).map((entry) => entry[key]));
    return {
      requests: completions.length,
      megabytes: Number((completions.reduce((sum, entry) => sum + entry.chars, 0) / 1e6).toFixed(1)),
      fetchMs: measured("fetchMs"),
      totalMs: measured("totalMs"),
      keyToResultMs: measured("keyToResultMs"),
      hovers: requests.length - completions.length,
    };
  };
}

async function texlabTraffic() {
  await openFile("long.tex");
  const editor = await waitFor(() => [...document.querySelectorAll(".cm-editor")].map((element) => EditorView.findFromDOM(element)).find((view) => view && view.state.doc.length > 1e6 && view.dom.getBoundingClientRect().width > 50), "long.tex editor", 30_000);
  await settle(1500, 20_000);
  // A prose word about 60% of the way in, where a writer types most.
  const doc = editor.state.doc;
  let lineNumber = Math.floor(doc.lines * 0.6);
  while (!/[a-z]{5}/.test(doc.line(lineNumber).text)) lineNumber += 1;
  const character = doc.line(lineNumber).text.search(/[a-z]{5}/) + 4;
  const long = await texlabRequestCosts("long.tex", () => editor.state.doc.toString(), lineNumber, character, 30);
  const chapterText = await invoke("read_project_file", { path: "chapters/ch01.tex" });
  const small = await texlabRequestCosts("chapters/ch01.tex", chapterText, 20, 4, 30);
  await settle(800, 20_000);
  const rect = editor.scrollDOM.getBoundingClientRect();
  const line = [...editor.contentDOM.querySelectorAll(".cm-line")].find((candidate) => {
    const box = candidate.getBoundingClientRect();
    return box.top > rect.top + 60 && box.bottom < rect.bottom - 60 && (candidate.textContent ?? "").length > 20;
  });
  if (line) await input.click(line, 0.05, 0.5);
  await sleep(300);
  const stop = recordTexlabTraffic();
  const typing = await typeAndMeasure("the quick brown fox jumps over lazy dogs ", 110);
  await sleep(1500);
  const traffic = stop();
  await settle(1200);
  return { long, small, typing: { keydownToNextPaint: typing.keydownToNextPaint, sendToPaint: typing.sendToPaint, frames: typing.frames }, traffic };
}

const SCENARIOS = {
  coldSettings: () => coldTool("settings"),
  coldHistory: () => coldTool("history"),
  coldComments: () => coldTool("comments"),
  texlabTraffic,
  longMarkdownTwice,
  pdfGeometry,
  longTexBreakdown,
  hugePreview: () => zoomPreviewOnly("huge.pdf", 1930),
  referencePreview: () => zoomPreviewOnly("reference.pdf", 200),
  resizeBench,
  hugeStyleBisect: () => styleBisect("huge.pdf", 1930),
  cssVarBench,
  hugeScaleBench: () => scaleBench("huge.pdf", 1930),
  openVisual,
  dragLoop,
  dragLoopLight: dragLoop,
  hugeZoomLoop: () => zoomLoop("huge.pdf", 1930),
  imageZoomLoop: () => zoomLoop("images.pdf", 76),
  idle,
  idleEnd: idle,
  hugePdf: () => bigPdf("huge.pdf", 1930),
  imagePdf: () => bigPdf("images.pdf", 76),
  longTex,
  longMarkdown,
  dialogsEarly: () => dialogs(),
  panelsEarly: () => panels(),
  pdfScrollHeavy: () => pdfScroll(),
  pdfZoomCtrlWheelHeavy: () => pdfZoom("ctrl-wheel-synthetic"),
  agentOpen,
  latexTyping: () => sourceTyping("chapters/ch01.tex", null),
  markdownSourceTyping: () => sourceTyping("large.md", "Edit"),
  markdownVisualTyping: visualTyping,
  pdfOpen,
  pdfScroll,
  pdfZoomPinch: () => pdfZoom("native-pinch"),
  pdfZoomCtrlWheel: () => pdfZoom("ctrl-wheel-synthetic"),
  panels,
  dialogs,
  ipc,
  liveEdit,
};

export async function startLabHarness() {
  if (!config?.plan) return;
  const plan = JSON.parse(config.plan);
  const report = {
    label: plan.label,
    run: plan.run,
    engine: "webkit",
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    viewport: [innerWidth, innerHeight],
    t0: config.t0,
    scenarios: {},
    errors: [],
  };
  const startupMarks = () => {
    const t0 = config?.t0 ?? 0;
    const navigation = performance.getEntriesByType("navigation")[0];
    const since = (time) => (time && t0 ? Math.round(time - t0) : null);
    return {
      navigationStart: since(performance.timeOrigin),
      domContentLoaded: since(navigation ? performance.timeOrigin + navigation.domContentLoadedEventEnd : undefined),
      prepared: since(marks.prepared),
      appMounted: since(marks.appMounted),
      treeVisible: since(marks.treeVisible),
      editable: since(marks.editable),
      pdfPage: since(marks.pdfPage),
    };
  };
  const write = (name) => invoke("perf_write", { name, content: JSON.stringify({ ...report, marks: startupMarks(), visibilityLog, startupDebug, invokeLog: invokeLog.filter((entry) => entry.ms === null || entry.ms > 200) }, null, 1) }).catch(() => null);
  try {
    await waitFor(() => "editable" in marks, "editable editor", 90_000);
    await waitFor(() => "pdfPage" in marks, "PDF preview", 120_000).catch(() => report.errors.push("no PDF preview at startup"));
    report.focus = await input.focus().catch((error) => String(error));
    report.clock = await calibrateClock().catch((error) => String(error));
    await settle(1500, 60_000);
    report.layout = layout();
    await write(`${plan.label}-run${plan.run}.json`);
    if (plan.startupOnly) {
      await write(`${plan.label}-run${plan.run}.done`);
      return;
    }
    for (const name of plan.scenarios) {
      const scenario = SCENARIOS[name];
      if (!scenario) continue;
      const started = performance.now();
      try {
        report.scenarios[name] = await scenario();
      } catch (error) {
        report.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      (report.scenarios[name] ?? {}).wallMs = Math.round(performance.now() - started);
      (report.scenarios[name] ?? {}).domAfter = domSize();
      await write(`${plan.label}-run${plan.run}.json`);
    }
  } catch (error) {
    report.errors.push(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  }
  await write(`${plan.label}-run${plan.run}.json`);
  await write(`${plan.label}-run${plan.run}.done`);
}
