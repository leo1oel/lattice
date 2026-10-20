#!/usr/bin/env node
/**
 * Before/after frame timings of dragging workspace tabs on the bench page,
 * the evidence for the Trellis drag patch (patches/@danfessler__trellis*).
 *
 * Builds two bench pages: "after" from this checkout as it is, and "before"
 * from --before-ref's tree (ab-pages.mjs), with REF's own packages installed
 * when its patches differ. Each run loads a fresh page per variant with the
 * heavy tabs open: long.tex, code.md and large.md (in the visual editor)
 * beside the PDF, and the terminal across the foot. Then four drags, each
 * pressed on a tab and moved one step every 8 ms:
 *
 *   strip    large.md along its own tab strip and back (a reorder)
 *   between  code.md onto the PDF's tab strip and back where it came from
 *   targets  code.md past the PDF's split edge, the terminal's edge and the
 *            PDF's middle, never resting, and back where it came from
 *   drop     code.md beside the PDF, resting there before the drop, then
 *            that panel back into the documents' strip
 *
 * Recorded per drag, from the press to 700 ms after the release:
 *
 *   frames    every animation-frame interval
 *   work      per frame, the ms from its animation callbacks to a task
 *             posted from them: the frame's own scripts, style and layout
 *   long      frames over 50 ms
 *   tasks     long tasks (Chromium only: WebKit has no longtask entries)
 *
 * --engine webkit (the default) stands in for the WKWebView release builds
 * render in and is slower than it; --engine chromium throttles the CPU 4x, as
 * headless Chromium at full speed rarely misses a frame. Runs alternate which
 * variant goes first.
 *
 * Usage:
 *   node scripts/perf-bench/tab-drag-timing.mjs --before-ref REF [--runs 3] [--engine webkit|chromium] [--json FILE]
 * The browsers are Playwright's (`pnpm exec playwright-core install webkit`).
 */
/* global document, MessageChannel, KeyboardEvent, performance, PerformanceObserver, requestAnimationFrame, window -- the callbacks passed to evaluate() run in the page. */
import { rmSync, writeFileSync } from "node:fs";
import { URLSearchParams } from "node:url";
import { chromium, webkit } from "playwright-core";
import { exportTree, repo, servePage } from "./ab-pages.mjs";
import { APP_READY } from "./selectors.mjs";

/** perf-bench.mjs's fixture. */
const FIXTURE = { largeMarkdownBytes: 400_000, chapterBytes: 60_000, longTexBytes: 3_200_000, notes: 40, codeBlocks: 150, pdfPages: 200, logLines: 4_000 };
const PREFIX = "lattice-tab-drag";
const STEP_MS = 8;
/** Past Trellis's settle, its layout tween and the pointer's rest before the drop preview lays out. */
const REST_MS = 900;

function parseArgs(argv) {
  const options = { beforeRef: null, runs: 3, engine: "webkit", json: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--before-ref") options.beforeRef = argv[++index];
    else if (arg === "--runs") options.runs = Number(argv[++index]);
    else if (arg === "--engine") options.engine = argv[++index];
    else if (arg === "--json") options.json = argv[++index];
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!options.beforeRef) throw new Error("--before-ref names the commit to compare against");
  if (!["webkit", "chromium"].includes(options.engine)) throw new Error("--engine is webkit or chromium");
  return options;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(p * values.length))];

/** Each figure of a drag by name, in the order the driver prints them. */
const FIGURES = {
  "frame median ms": (run) => median(run.frames),
  "frame p95 ms": (run) => quantile(run.frames, 0.95),
  "longest frame ms": (run) => Math.max(...run.frames),
  "frames > 50 ms": (run) => run.frames.filter((frame) => frame > 50).length,
  "work p95 ms": (run) => quantile(run.work, 0.95),
  "long tasks": (run) => (run.longTasks ? run.longTasks.length : null),
  "long task ms": (run) => (run.longTasks ? run.longTasks.reduce((sum, ms) => sum + ms, 0) : null),
};

/** In the page: record frames, their work and long tasks until stopped. */
function startRecording() {
  const rec = { frames: [], work: [], longTasks: null };
  window.__tabDrag = rec;
  const channel = new MessageChannel();
  let frameStart = 0;
  // Hundredths of a ms: the clock's own resolution in WebKit is coarser.
  const round = (value) => Math.round(value * 100) / 100;
  channel.port1.onmessage = () => rec.work.push(round(performance.now() - frameStart));
  let last = 0;
  const tick = (now) => {
    frameStart = performance.now();
    channel.port2.postMessage(0);
    if (last) rec.frames.push(round(now - last));
    last = now;
    if (!rec.stop) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  if (PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
    rec.longTasks = [];
    rec.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) rec.longTasks.push(round(entry.duration));
    });
    rec.observer.observe({ type: "longtask" });
  }
}

function stopRecording() {
  const { frames, work, longTasks, observer } = window.__tabDrag;
  window.__tabDrag.stop = true;
  observer?.disconnect();
  return { frames, work, longTasks };
}

/** The middle of the tab titled `title`, and the box of its panel. */
function tabAndPanel(title) {
  const label = [...document.querySelectorAll('[data-trellis-part="tab-title"]')].find((element) => element.textContent.trim() === title);
  const tab = label.closest('[data-trellis-part="tab"]').getBoundingClientRect();
  const panel = label.closest('[data-trellis-part="panel"]').getBoundingClientRect();
  return { x: tab.left + tab.width / 2, y: tab.top + tab.height / 2, panel: { left: panel.left, top: panel.top, right: panel.right, bottom: panel.bottom, width: panel.width, height: panel.height } };
}

/** Press at the first point and move through the rest, a step every STEP_MS; `rest` holds still there. */
async function drag(page, points) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let [at] = points;
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  for (const point of points.slice(1)) {
    const steps = Math.max(1, Math.round(Math.hypot(point.x - at.x, point.y - at.y) / 4));
    for (let step = 1; step <= steps; step += 1) {
      await page.mouse.move(at.x + ((point.x - at.x) * step) / steps, at.y + ((point.y - at.y) * step) / steps);
      await sleep(STEP_MS);
    }
    at = point;
    if (point.rest) await sleep(point.rest);
  }
  await page.mouse.up();
}

const DRAGS = {
  async strip(page) {
    const tab = await page.evaluate(tabAndPanel, "large.md");
    const along = { x: tab.panel.left + 40, y: tab.y };
    await drag(page, [tab, along, tab]);
  },
  async between(page) {
    const tab = await page.evaluate(tabAndPanel, "code.md");
    const { panel: pdf } = await page.evaluate(tabAndPanel, "PDF");
    const strip = { x: pdf.left + pdf.width * 0.6, y: pdf.top + 18 };
    await drag(page, [tab, strip, { x: strip.x + 60, y: strip.y }, tab]);
  },
  async targets(page) {
    const tab = await page.evaluate(tabAndPanel, "code.md");
    const { panel: pdf } = await page.evaluate(tabAndPanel, "PDF");
    const { panel: terminal } = await page.evaluate(tabAndPanel, "Terminal");
    const edge = { x: pdf.right - 30, y: pdf.top + pdf.height / 2 };
    await drag(page, [
      tab,
      edge,
      { x: edge.x, y: edge.y + 60 },
      { x: pdf.left + pdf.width / 2, y: terminal.top - 3 },
      { x: pdf.left + pdf.width / 2, y: pdf.top + pdf.height / 2 },
      tab,
    ]);
  },
  async drop(page) {
    const tab = await page.evaluate(tabAndPanel, "code.md");
    const { panel: pdf } = await page.evaluate(tabAndPanel, "PDF");
    await drag(page, [tab, { x: pdf.right - 30, y: pdf.top + pdf.height / 2, rest: REST_MS }]);
    await page.waitForTimeout(1200);
    const back = await page.evaluate(tabAndPanel, "code.md");
    const { panel: documents } = await page.evaluate(tabAndPanel, "large.md");
    await drag(page, [back, { x: documents.right - 40, y: documents.top + 18, rest: REST_MS }]);
  },
};

async function measure(browser, origin, engine) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (engine === "chromium") await (await context.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const query = new URLSearchParams(Object.entries({ ...FIXTURE, theme: "light", lang: "en" }).map(([key, value]) => [key, String(value)]));
  await page.goto(`${origin}/tools/perf-bench/index.html?${query}`);
  await page.waitForFunction(APP_READY, null, { timeout: 120_000 });
  await page.waitForTimeout(3000);
  for (const file of ["long.tex", "code.md", "large.md"]) {
    await page.locator(`file-tree-container.lattice-file-tree [data-item-path="${file}"]`).first().dblclick();
    await page.waitForTimeout(1500);
  }
  await page.locator('[role="tablist"][aria-label="Document view"] [role="tab"]', { hasText: "Preview" }).first().click();
  await page.waitForTimeout(2000);
  await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "`", code: "Backquote", ctrlKey: true, bubbles: true, cancelable: true })));
  await page.waitForSelector(".terminal-slot");
  await page.waitForTimeout(4000);
  const drags = [];
  for (const [name, run] of Object.entries(DRAGS)) {
    await page.evaluate(startRecording);
    await run(page);
    await page.waitForTimeout(700);
    drags.push({ drag: name, ...(await page.evaluate(stopRecording)) });
    await page.waitForTimeout(800);
  }
  await context.close();
  return { drags, errors };
}

const options = parseArgs(process.argv.slice(2));
const beforeRoot = exportTree(options.beforeRef, { prefix: PREFIX, install: true });
const pagesBy = { before: await servePage(beforeRoot, { prefix: PREFIX }), after: await servePage(repo, { prefix: PREFIX }) };
const browser = await (options.engine === "chromium" ? chromium : webkit).launch({ headless: true });
const results = [];
try {
  for (let pair = 0; pair < options.runs; pair += 1) {
    for (const variant of pair % 2 ? ["after", "before"] : ["before", "after"]) {
      const { drags, errors } = await measure(browser, pagesBy[variant].origin, options.engine);
      for (const drag of drags) results.push({ engine: options.engine, pair, variant, errors: errors.length, ...drag });
      console.error(`pair ${pair + 1}/${options.runs}, ${variant}: ${drags.length} drags, ${errors.length} page errors`);
      if (options.json) writeFileSync(options.json, JSON.stringify({ options, results }));
    }
  }
  const rows = [];
  for (const name of Object.keys(DRAGS)) {
    for (const variant of ["before", "after"]) {
      const runs = results.filter((run) => run.drag === name && run.variant === variant);
      const row = { drag: name, variant };
      for (const [figure, read] of Object.entries(FIGURES)) {
        const values = runs.map(read).filter((value) => value !== null);
        row[figure] = values.length ? Math.round(median(values) * 10) / 10 : "–";
      }
      rows.push(row);
    }
  }
  console.log(`\n${options.engine === "chromium" ? "Chromium at 4x CPU throttling" : "WebKit"}: median of ${options.runs} runs each, ${options.beforeRef} → this checkout`);
  console.table(rows);
} finally {
  await browser.close();
  await pagesBy.before.close();
  await pagesBy.after.close();
  rmSync(beforeRoot, { recursive: true, force: true });
}
