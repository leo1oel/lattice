#!/usr/bin/env node
/**
 * Before/after timings of a long PDF on the bench page: the driver behind
 * docs/performance.md's "A page window for long PDFs" tables.
 *
 * Builds two bench pages from this checkout, without a second one: "after",
 * as the checkout is, and "before", with every file under src/ and every file
 * of the PDF.js patch as they are at --before-ref (read with `git show`; the
 * patched PDF.js files are rebuilt by taking this checkout's patch off the
 * installed package and putting REF's on). Each size of PDF then gets --runs
 * pairs of runs, alternating which variant goes first, each on a fresh page:
 *
 *   open   click reference.pdf in the navigator; ms to the first animation
 *          frame with its page 1 drawn (a canvas not hidden)
 *   jump   type 70 % of the page count in the compiled preview's page field;
 *          ms from Enter to the first frame with that page drawn
 *   zoom   over that page, 20 Ctrl-wheel notches of 8 px, 16 ms apart, in and
 *          then out; every frame from the first notch to 300 ms after the last
 *          (the commit is 80 ms after it, pdf/use-pdf-zoom.ts)
 *   scroll 120 px a frame for 200 frames, counting frames with a page on
 *          screen not drawn yet, and with a spacer on screen
 *   elements  the document's element count once the second PDF is open
 * In WebKit a frame rate counts only the measurements paced at 60 Hz (fps
 * below). Chromium reports the style and layout thread time of the zoom and
 * the scroll instead (Performance.getMetrics): headless Chromium paces this
 * page's frames at 13–25 fps whatever it holds, so its frame rates say nothing.
 *
 * Usage:
 *   node scripts/perf-bench/pdf-window-timing.mjs --before-ref REF
 *     [--engine webkit|chromium] [--pages 1930,386] [--runs 5] [--json FILE]
 * --json writes every run with every frame interval. The browsers are
 * Playwright's (`pnpm exec playwright-core install webkit chromium`).
 */
/* global document, performance, requestAnimationFrame, window -- the callbacks passed to evaluate() run in the page. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, URLSearchParams } from "node:url";
import { chromium, webkit } from "playwright-core";
import { figures, median } from "./pdf-window-figures.mjs";
import { patchedAt } from "./pdfjs-patch-swap.mjs";
import { APP_READY } from "./selectors.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** perf-bench.mjs's fixture, but for the PDF's page count. */
const FIXTURE = { largeMarkdownBytes: 400_000, chapterBytes: 60_000, longTexBytes: 3_200_000, notes: 40, codeBlocks: 150, logLines: 4_000 };
const COMPILED = ".pdf-column > .pdf-preview";
const STANDALONE = ".canvas-body > .pdf-preview";
const VIEWPORT = ".pdf-scroll-area-viewport:not(.pdf-viewer-staging)";

function parseArgs(argv) {
  const options = { beforeRef: null, engine: "webkit", pages: [1930, 386], runs: 5, json: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--before-ref") options.beforeRef = argv[++index];
    else if (arg === "--engine") options.engine = argv[++index];
    else if (arg === "--pages") options.pages = argv[++index].split(",").map(Number);
    else if (arg === "--runs") options.runs = Number(argv[++index]);
    else if (arg === "--json") options.json = path.resolve(argv[++index]);
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!options.beforeRef) throw new Error("--before-ref names the commit to compare against");
  if (!["webkit", "chromium"].includes(options.engine)) throw new Error("--engine is webkit or chromium");
  return options;
}

const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 256 * 2 ** 20 });

/**
 * Where "before" differs: REF's text of each src/ file that differs from the
 * checkout, by absolute path, and of each patched PDF.js file, by its path in
 * the package.
 */
function beforeSources(ref) {
  const sources = new Map();
  for (const file of git("diff", "--name-only", ref, "--", "src").split("\n").filter(Boolean)) {
    sources.set(path.join(repo, file), existsAt(ref, file) ? git("show", `${ref}:${file}`) : null);
  }
  const patches = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")).pnpm.patchedDependencies;
  const patch = Object.entries(patches).find(([name]) => name.startsWith("pdfjs-dist@"))[1];
  const pdfjs = git("diff", "--name-only", ref, "--", patch).trim()
    ? patchedAt(realpathSync(path.join(repo, "node_modules/pdfjs-dist")), readFileSync(path.join(repo, patch), "utf8"), git("show", `${ref}:${patch}`))
    : new Map();
  return { sources, pdfjs };
}

function existsAt(ref, file) {
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}:${file}`], { cwd: repo, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** A production build of the bench page, served; `before` swaps in REF's files. */
async function servePage(before) {
  const { build, preview } = await import("vite");
  const outDir = mkdtempSync(path.join(os.tmpdir(), "lattice-pdf-window-dist-"));
  const shared = { root: repo, configFile: path.join(repo, "vite.config.ts"), logLevel: "warn", clearScreen: false };
  const swapped = new Set();
  const swap = before && {
    name: "pdf-window-timing-before",
    enforce: "pre",
    load(id) {
      const file = id.split("?")[0];
      if (before.sources.has(file)) {
        const text = before.sources.get(file);
        if (text === null) throw new Error(`${path.relative(repo, file)} is not in ${before.ref}, but the bench page loads it`);
        swapped.add(path.relative(repo, file));
        return text;
      }
      const inPdfjs = /\/node_modules\/pdfjs-dist\/(.+)$/.exec(file)?.[1];
      if (inPdfjs && before.pdfjs.has(inPdfjs)) {
        swapped.add(`pdfjs-dist/${inPdfjs}`);
        return before.pdfjs.get(inPdfjs);
      }
      return null;
    },
  };
  await build({
    ...shared,
    plugins: swap ? [swap] : [],
    build: {
      outDir,
      emptyOutDir: true,
      rolldownOptions: { input: { bench: path.join(repo, "tools/perf-bench/index.html") }, output: { strictExecutionOrder: true } },
    },
  });
  if (before) {
    // A patched PDF.js file the build never loaded (the worker, say) would
    // leave "before" running this checkout's.
    const missed = [...before.pdfjs.keys()].filter((file) => !swapped.has(`pdfjs-dist/${file}`));
    if (missed.length) throw new Error(`The build never loaded ${missed.join(", ")}, so it cannot be ${before.ref}'s`);
    console.error(`before: ${before.ref}'s ${[...swapped].sort().join(", ")}`);
  }
  const port = await freePort();
  const server = await preview({ ...shared, build: { outDir }, preview: { port, strictPort: true, host: "127.0.0.1" } });
  return {
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      await server.close();
      rmSync(outDir, { recursive: true, force: true });
    },
  };
}

const drawn = (scope, page) => `${scope} .page[data-page-number="${page}"] .canvasWrapper canvas:not([hidden])`;

async function measureRun(browser, engine, origin, pages) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The ms from `start` (a performance.now()) to the first frame where `selector` matches.
  await page.addInitScript(() => {
    window.__pdfWindowFrameWhen = (selector, start) => new Promise((resolve) => {
      const check = (now) => {
        if (document.querySelector(selector)) resolve(now - start);
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
  });
  const query = new URLSearchParams(Object.entries({ ...FIXTURE, pdfPages: pages, theme: "light", lang: "en" }).map(([key, value]) => [key, String(value)]));
  await page.goto(`${origin}/tools/perf-bench/index.html?${query}`);
  await page.waitForFunction(APP_READY, null, { timeout: 120_000 });
  await page.waitForFunction(({ scope, total }) => document.querySelector(`${scope} .pdf-page-display`)?.textContent?.endsWith(`/ ${total}`), { scope: COMPILED, total: pages }, { timeout: 120_000 });
  await page.waitForSelector(drawn(COMPILED, 1), { timeout: 60_000 });
  await page.waitForTimeout(1_000);
  const session = engine === "chromium" ? await context.newCDPSession(page) : null;
  await session?.send("Performance.enable");
  const threadTime = async () => {
    if (!session) return null;
    const { metrics } = await session.send("Performance.getMetrics");
    const value = (name) => metrics.find((metric) => metric.name === name).value * 1000;
    return { style: value("RecalcStyleDuration"), layout: value("LayoutDuration") };
  };
  const spent = (before, after) => before && { styleMs: after.style - before.style, layoutMs: after.layout - before.layout };
  const run = { errors };

  // Open: the standalone PDF, beside the compiled preview.
  const opened = page.evaluate((selector) => new Promise((resolve) => {
    document.addEventListener("click", () => resolve(window.__pdfWindowFrameWhen(selector, performance.now())), { capture: true, once: true });
  }), drawn(STANDALONE, 1));
  await page.locator('[data-item-path="reference.pdf"]').click();
  run.openMs = await opened;
  await page.waitForTimeout(1_000);
  run.elements = await page.evaluate(() => document.getElementsByTagName("*").length);
  run.pageBoxes = await page.evaluate((selector) => document.querySelectorAll(`${selector} .pdfViewer > .page`).length, COMPILED);

  // Jump: the compiled preview's page field.
  const target = Math.floor(pages * 0.7);
  const input = page.locator(`${COMPILED} .pdf-page-value input`);
  await input.fill(String(target));
  const jumped = page.evaluate(([selector, field]) => new Promise((resolve) => {
    document.querySelector(field).addEventListener("keydown", (event) => {
      if (event.key === "Enter") resolve(window.__pdfWindowFrameWhen(selector, performance.now()));
    }, { capture: true });
  }), [drawn(COMPILED, target), `${COMPILED} .pdf-page-value input`]);
  await input.press("Enter");
  run.jumpMs = await jumped;
  await page.waitForTimeout(1_000);

  // Zoom, in and then out, over the middle of the compiled preview.
  const box = await page.locator(`${COMPILED} ${VIEWPORT}`).boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const pageUnder = () => page.evaluate(([px, py]) => Number(document.elementFromPoint(px, py)?.closest(".page")?.dataset.pageNumber ?? 0), [x, y]);
  await page.mouse.move(x, y);
  run.zoom = {};
  for (const [name, delta] of [["in", -8], ["out", 8]]) {
    const pageBefore = await pageUnder();
    const before = await threadTime();
    // Primed by one frame, so the frame the first notch lands in is timed.
    await page.evaluate(() => new Promise((resolve) => {
      const intervals = window.__pdfWindowFrames = [];
      window.__pdfWindowSampling = true;
      requestAnimationFrame((first) => {
        let last = first;
        const next = (now) => {
          if (!window.__pdfWindowSampling) return;
          intervals.push(now - last);
          last = now;
          requestAnimationFrame(next);
        };
        requestAnimationFrame(next);
        resolve();
      });
    }));
    await page.keyboard.down("Control");
    for (let notch = 0; notch < 20; notch += 1) {
      await page.mouse.wheel(0, delta);
      await page.waitForTimeout(16);
    }
    await page.keyboard.up("Control");
    await page.waitForTimeout(300);
    const frames = await page.evaluate(() => {
      window.__pdfWindowSampling = false;
      return window.__pdfWindowFrames;
    });
    run.zoom[name] = { frames, ...spent(before, await threadTime()), pageBefore, pageAfter: await pageUnder() };
    await page.waitForTimeout(1_000);
  }

  // Scroll.
  const before = await threadTime();
  run.scroll = await page.locator(`${COMPILED} ${VIEWPORT}`).evaluate(async (viewport) => {
    const frames = [];
    let blankFrames = 0;
    let spacerFrames = 0;
    let last = null;
    for (let frame = 0; frame < 200; frame += 1) {
      await new Promise((resolve) => requestAnimationFrame((now) => {
        if (last !== null) frames.push(now - last);
        last = now;
        resolve();
      }));
      viewport.scrollTop += 120;
      const view = viewport.getBoundingClientRect();
      let blank = false;
      let spacer = false;
      for (const child of viewport.querySelectorAll(".pdfViewer > *")) {
        const rect = child.getBoundingClientRect();
        if (rect.bottom <= view.top || rect.top >= view.bottom) continue;
        if (child.classList.contains("pageSpacer")) spacer = true;
        else if (!child.querySelector(".canvasWrapper canvas:not([hidden])")) blank = true;
      }
      blankFrames += blank;
      spacerFrames += spacer;
    }
    return { frames, blankFrames, spacerFrames };
  });
  Object.assign(run.scroll, spent(before, await threadTime()));
  await context.close();
  return run;
}

/** Each figure's median and range across a variant's runs, one row per figure. */
function summarize(engine, runs) {
  const rows = [];
  for (const [figure, read] of Object.entries(figures(engine))) {
    const row = { figure };
    for (const variant of ["before", "after"]) {
      const all = runs.filter((run) => run.variant === variant).map(read);
      const values = all.filter((value) => value !== null);
      const round = (value) => Math.round(value * 10) / 10;
      const of = values.length < all.length ? `, ${values.length} of ${all.length} runs at 60 Hz` : "";
      row[variant] = values.length ? `${round(median(values))} (${round(Math.min(...values))}–${round(Math.max(...values))}${of})` : "–";
    }
    rows.push(row);
  }
  return rows;
}

const options = parseArgs(process.argv.slice(2));
const before = { ref: options.beforeRef, ...beforeSources(options.beforeRef) };
const pagesBy = { before: await servePage(before), after: await servePage(null) };
const browser = await (options.engine === "webkit" ? webkit : chromium).launch({ headless: true });
const results = [];
try {
  for (const pages of options.pages) {
    for (let pair = 0; pair < options.runs; pair += 1) {
      for (const variant of pair % 2 ? ["after", "before"] : ["before", "after"]) {
        const run = { engine: options.engine, pages, pair, variant, ...(await measureRun(browser, options.engine, pagesBy[variant].origin, pages)) };
        results.push(run);
        console.error(`${pages} pages, pair ${pair + 1}/${options.runs}, ${variant}: open ${Math.round(run.openMs)} ms, jump ${Math.round(run.jumpMs)} ms, ${run.errors.length} page errors`);
        if (options.json) writeFileSync(options.json, JSON.stringify({ options, results }, null, 2));
      }
    }
    console.log(`\n${options.engine}, ${pages} pages: median (range) of ${options.runs} runs each, ${options.beforeRef} → this checkout`);
    console.table(summarize(options.engine, results.filter((run) => run.pages === pages)));
  }
} finally {
  await browser.close();
  await pagesBy.before.close();
  await pagesBy.after.close();
}
