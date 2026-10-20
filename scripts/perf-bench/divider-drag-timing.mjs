#!/usr/bin/env node
/**
 * Before/after frame timings of dragging the workspace's boundaries on the
 * bench page: the driver behind docs/performance-history.md's "Divider drags" table.
 *
 * Builds two bench pages: "after" from this checkout as it is, and "before"
 * from --before-ref's tree, exported to a temporary directory (`git archive`)
 * with this checkout's node_modules linked in. It refuses a REF whose
 * packages or patches differ, which that link would not reproduce. Two scenes, each on a fresh page per run,
 * with 600 papers in the library:
 *
 *   tex    long.tex open beside the PDF: the left column's divider (Project
 *          and Papers | editor), Project | Papers, editor | PDF
 *   split  large.md in Split: its source | preview grip, then the same three
 *
 * Each drag presses the boundary's middle, moves the pointer every 4 ms for
 * 2 s (a 120 Hz mouse) in a sine of ±90 px a second, releases, and keeps
 * counting 800 ms more, so the press and the release frames are in it:
 *
 *   frames   every animation-frame interval from the press to the end
 *   work     per frame, the ms from its animation callbacks to a task posted
 *            from them: the frame's own scripts, style, layout and paint
 *   moves    pointer moves the page kept up with (Playwright waits for each)
 *   cursor   per frame, whether what is under the pointer shows the resize
 *            cursor (a shield drawn as an element's ::after counts as its own)
 *
 * Runs alternate which variant goes first. A drag Playwright's WebKit paced
 * at 30 Hz counts for its work, not its intervals (divider-drag-figures.mjs). Playwright's WebKit stands in for
 * the WKWebView release builds render in, and is slower than it.
 *
 * Usage:
 *   node scripts/perf-bench/divider-drag-timing.mjs --before-ref REF [--runs 3] [--json FILE]
 * The browser is Playwright's (`pnpm exec playwright-core install webkit`).
 */
/* global document, getComputedStyle, MessageChannel, performance, requestAnimationFrame, window -- the callbacks passed to evaluate() run in the page. */
import { rmSync, writeFileSync } from "node:fs";
import { URLSearchParams } from "node:url";
import { webkit } from "playwright-core";
import { exportTree, repo, servePage } from "./ab-pages.mjs";
import { FIGURES, median } from "./divider-drag-figures.mjs";
import { APP_READY } from "./selectors.mjs";

/** perf-bench.mjs's fixture, with a library large enough to window its rows. */
const FIXTURE = { largeMarkdownBytes: 400_000, chapterBytes: 60_000, longTexBytes: 3_200_000, notes: 40, codeBlocks: 150, pdfPages: 200, logLines: 4_000, paperCount: 600 };
const SCENES = ["tex", "split"];
const PREFIX = "lattice-divider-drag";

function parseArgs(argv) {
  const options = { beforeRef: null, runs: 3, json: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--before-ref") options.beforeRef = argv[++index];
    else if (arg === "--runs") options.runs = Number(argv[++index]);
    else if (arg === "--json") options.json = argv[++index];
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!options.beforeRef) throw new Error("--before-ref names the commit to compare against");
  return options;
}

/** Mark the scene's boundaries `data-drag-divider="<name>"`; return them in drag order. */
function markDividers() {
  const trellis = [...document.querySelectorAll('[data-trellis-part="divider"]')].filter((el) => getComputedStyle(el).display !== "none");
  const columns = trellis.filter((el) => el.getAttribute("data-axis") === "x").sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  const named = [
    ["split", document.querySelector(".split-resizer")],
    ["left", columns[0]],
    ["papers", trellis.find((el) => el.getAttribute("data-axis") === "y")],
    ["pdf", columns.at(-1)],
  ];
  return named.filter(([, el]) => el).map(([name, el]) => {
    el.setAttribute("data-drag-divider", name);
    const r = el.getBoundingClientRect();
    return { name, axis: name === "papers" ? "y" : "x", x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

/** In the page: record frames, work, and the cursor under the pointer until stopped. */
function startRecording(axis) {
  const rec = { frames: [], work: [], cursorFrames: 0, resizeCursorFrames: 0 };
  window.__dividerDrag = rec;
  let point = null;
  window.addEventListener("pointermove", (event) => { point = [event.clientX, event.clientY]; }, { capture: true });
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
    if (point) {
      const under = document.elementFromPoint(point[0], point[1]);
      const after = under && getComputedStyle(under, "::after");
      const cursor = !under ? "" : after && after.content !== "none" && after.position !== "static" ? after.cursor : getComputedStyle(under).cursor;
      rec.cursorFrames += 1;
      if (cursor === (axis === "y" ? "row-resize" : "col-resize")) rec.resizeCursorFrames += 1;
    }
    if (!rec.stop) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function measureScene(browser, origin, scene) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const query = new URLSearchParams(Object.entries({ ...FIXTURE, theme: "light", lang: "en" }).map(([key, value]) => [key, String(value)]));
  await page.goto(`${origin}/tools/perf-bench/index.html?${query}`);
  await page.waitForFunction(APP_READY, null, { timeout: 120_000 });
  await page.waitForTimeout(4000);
  if (scene === "tex") await page.locator('[data-item-path="long.tex"]').first().click();
  else {
    await page.locator('[data-item-path="large.md"]').first().click();
    await page.waitForTimeout(2500);
    await page.locator(".trellis-mode-name", { hasText: "Split" }).first().click();
  }
  await page.waitForTimeout(2500);
  const drags = [];
  for (const divider of await page.evaluate(markDividers)) {
    await page.mouse.move(divider.x, divider.y);
    await page.waitForTimeout(400);
    await page.evaluate(startRecording, divider.axis);
    await page.mouse.down();
    const start = Date.now();
    let moves = 0;
    while (Date.now() - start < 2000) {
      const offset = -90 * Math.sin((2 * Math.PI * (Date.now() - start)) / 1000);
      await page.mouse.move(divider.axis === "x" ? divider.x + offset : divider.x, divider.axis === "y" ? divider.y + offset : divider.y);
      moves += 1;
      await new Promise((resolve) => setTimeout(resolve, 4));
    }
    await page.mouse.up();
    await page.waitForTimeout(800);
    const rec = await page.evaluate(() => {
      window.__dividerDrag.stop = true;
      return window.__dividerDrag;
    });
    drags.push({ divider: divider.name, moves, ...rec });
    await page.waitForTimeout(600);
  }
  await context.close();
  return { drags, errors };
}

const options = parseArgs(process.argv.slice(2));
const beforeRoot = exportTree(options.beforeRef, { prefix: PREFIX });
const pagesBy = { before: await servePage(beforeRoot, { prefix: PREFIX }), after: await servePage(repo, { prefix: PREFIX }) };
const browser = await webkit.launch({ headless: true });
const results = [];
try {
  for (let pair = 0; pair < options.runs; pair += 1) {
    for (const scene of SCENES) {
      for (const variant of pair % 2 ? ["after", "before"] : ["before", "after"]) {
        const { drags, errors } = await measureScene(browser, pagesBy[variant].origin, scene);
        for (const drag of drags) results.push({ engine: "webkit", scene, pair, variant, errors: errors.length, ...drag });
        console.error(`${scene}, pair ${pair + 1}/${options.runs}, ${variant}: ${drags.length} drags, ${errors.length} page errors`);
        if (options.json) writeFileSync(options.json, JSON.stringify({ options, results }));
      }
    }
  }
  const rows = [];
  for (const scene of SCENES) {
    for (const divider of [...new Set(results.filter((run) => run.scene === scene).map((run) => run.divider))]) {
      for (const variant of ["before", "after"]) {
        const runs = results.filter((run) => run.scene === scene && run.divider === divider && run.variant === variant);
        const row = { scene, divider, variant };
        for (const [name, read] of Object.entries(FIGURES)) {
          const values = runs.map(read).filter((value) => value !== null);
          row[name] = values.length ? Math.round(median(values) * 10) / 10 : "–";
        }
        rows.push(row);
      }
    }
  }
  console.log(`\nWebKit: median of ${options.runs} runs each, ${options.beforeRef} → this checkout`);
  console.table(rows);
} finally {
  await browser.close();
  await pagesBy.before.close();
  await pagesBy.after.close();
  rmSync(beforeRoot, { recursive: true, force: true });
}
