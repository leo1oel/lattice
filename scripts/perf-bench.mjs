#!/usr/bin/env node
/**
 * Deterministic performance benchmark for Lattice's hot interactions
 * (docs/performance.md, "Benchmark and CI gate").
 *
 * Builds tools/perf-bench/ (the real app against an in-memory backend holding
 * the fixture project) with the production config, opens it in headless
 * Chrome, and runs each scenario in scripts/perf-bench/scenarios.mjs on a
 * fresh page. For every scenario it reports, per interaction:
 *   commits   React commits
 *   renders   component renders (React DevTools' definition) and the hooks they ran
 *   recalcs   style recalculations, as Chromium counts them
 *   layouts   layouts, as Chromium counts them
 *   mutations DOM mutation records
 * plus long tasks, layout shifts and main-thread durations, which are
 * wall-clock facts: reported, never gated.
 *
 * `--engine webkit` runs the same scenarios in Playwright's WebKit
 * (perf-bench/webkit.mjs), the engine release builds render in, against its
 * own ceilings in scripts/perf-bench/budgets-webkit.json. WebKit has no style
 * or layout counters, so its recalcs and layouts are blank.
 *
 * Usage (pnpm perf:bench …):
 *   (no flag)   measure and print; scenarios without a ceiling get one
 *   --check     also exit 1 when a gated count exceeds its ceiling (CI); the
 *               frame-timing-dependent counts are reported only (budgets.mjs)
 *   --ratchet   lower the ceilings these counts beat; never raises one
 *   --update    set every ceiling from this run, up or down (review the diff)
 * Options:
 *   --only a,b      run only these scenarios
 *   --runs N        runs per scenario; the run with the fewest gated counts is kept (default 2)
 *   --json FILE     write every run, with the components that rendered and why
 *   --dev           use the Vite dev server: readable component names and
 *                   profiles, and counts equal to production's (not gated)
 *   --profile DIR   save a CPU profile of each scenario's first run
 *   --url URL       measure an already running app instead (no ceilings)
 *   --engine NAME   chromium (default) or webkit
 *   --headful, --keep-open   watch it run
 *
 * Serving the page for UI work, screenshots and QA (no benchmark):
 *   --serve         build the page, check that it answers, print its URL and stay
 *                   up until interrupted; with --dev, serve it from the dev server
 *                   with file watching and HMR on, so edits show without a
 *                   restart. Progress goes to stderr until the URL is printed,
 *                   and a failure exits 1 with the reason: a caller waiting for
 *                   the URL never waits on silence.
 *   --smoke         prove the app mounts: load the page in headless Chrome, exit 0
 *                   once the editor is up, or exit 1 with what the page reported
 *                   (uncaught and console errors, failed and unanswered requests,
 *                   its text, a screenshot). Alone it serves the page itself (or
 *                   checks --url) and exits; with --serve it checks before
 *                   printing the URL.
 *   --chrome        with --serve: keep a headless Chrome running and print the
 *                   CHROME_DEVTOOLS_AXI_BROWSER_URL that attaches
 *                   chrome-devtools-axi to it. The bridge otherwise launches an
 *                   installed Google Chrome, and without one it fails with
 *                   BRIDGE_NOT_READY; this Chrome falls back to Playwright's
 *                   Chrome for Testing (perf-bench/cdp.mjs).
 *   --port N        the port to serve on (default 18480; 0 picks a free one)
 * Layout checks (no benchmark):
 *   --layout        build the page and check the geometry in
 *                   scripts/perf-bench/layout-checks.mjs in the chosen engine;
 *                   exit 1 when one fails, with a screenshot of it
 * The page accepts `theme=system|light|dark` and `lang=en|zh-CN|system`
 * (tools/perf-bench/bench-page.ts); --serve prints a URL with both.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, URLSearchParams } from "node:url";
import { applyBudgets, bestOf, COUNTS } from "./perf-bench/budgets.mjs";
import { CdpPage, launchChrome } from "./perf-bench/cdp.mjs";
import { launchWebKit } from "./perf-bench/webkit.mjs";
import { LAYOUT_CHECKS } from "./perf-bench/layout-checks.mjs";
import { BenchDriver, SCENARIOS } from "./perf-bench/scenarios.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUDGETS = {
  chromium: path.join(repo, "scripts/perf-bench/budgets.json"),
  webkit: path.join(repo, "scripts/perf-bench/budgets-webkit.json"),
};
const PROBE = readFileSync(path.join(repo, "scripts/perf-bench/probe.js"), "utf8");
/**
 * Clear of the app's dev ports (1420, 1437) and of the ports the real and
 * test Lattice builds listen on (18452, 18462, 18472).
 */
const SERVE_PORT = 18480;

/**
 * Smaller than the playbook fixture so a CI run stays short, but large enough
 * that per-document work dominates: a 400 KB Markdown file (~1,000 blocks) and
 * 60 KB chapters.
 */
const BENCH_FIXTURE = {
  largeMarkdownBytes: 400_000,
  chapterBytes: 60_000,
  longTexBytes: 3_200_000,
  notes: 40,
  codeBlocks: 150,
  pdfPages: 200,
  logLines: 4_000,
};

function parseArgs(argv) {
  const options = { runs: 2, only: null, json: null, profile: null, check: false, ratchet: false, update: false, headful: false, keepOpen: false, url: null, dev: false, serve: false, smoke: false, chrome: false, layout: false, port: SERVE_PORT, engine: "chromium" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") options.check = true;
    else if (arg === "--ratchet") options.ratchet = true;
    else if (arg === "--update") options.update = true;
    else if (arg === "--headful") options.headful = true;
    else if (arg === "--dev") options.dev = true;
    else if (arg === "--keep-open") options.keepOpen = true;
    else if (arg === "--runs") options.runs = Number(argv[++index]);
    else if (arg === "--only") options.only = argv[++index].split(",");
    else if (arg === "--json") options.json = argv[++index];
    else if (arg === "--url") options.url = argv[++index];
    else if (arg === "--profile") options.profile = argv[++index];
    else if (arg === "--serve") options.serve = true;
    else if (arg === "--smoke") options.smoke = true;
    else if (arg === "--chrome") options.chrome = true;
    else if (arg === "--layout") options.layout = true;
    else if (arg === "--port") options.port = Number(argv[++index]);
    else if (arg === "--engine") options.engine = argv[++index];
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) throw new Error("--port takes a port number");
  if (options.serve && options.url) throw new Error("--serve starts its own page; it cannot take --url");
  if (options.chrome && !options.serve) throw new Error("--chrome keeps a browser up beside --serve; add --serve");
  if (options.layout && (options.serve || options.smoke || options.url)) throw new Error("--layout serves its own page per check; it cannot take --serve, --smoke or --url");
  if (options.smoke && options.engine !== "chromium") throw new Error("--smoke loads the page in Chrome only");
  if (!(options.engine in BUDGETS)) throw new Error(`Unknown engine ${options.engine}: use chromium or webkit`);
  if (options.profile && options.engine !== "chromium") throw new Error("--profile records Chromium CPU profiles only");
  return options;
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

/**
 * Build output directories this process made. Each run builds into its own,
 * so two runs on one machine (parallel agents, CI lanes) never serve or
 * measure each other's build. Closing the server removes its directory; the
 * exit hook catches the paths that skip that (a thrown error, --keep-open,
 * Ctrl-C), since a production build is tens of megabytes.
 */
const buildDirs = new Set();
function removeBuildDir(dir) {
  rmSync(dir, { recursive: true, force: true });
  buildDirs.delete(dir);
}
process.on("exit", () => {
  for (const dir of buildDirs) removeBuildDir(dir);
});

/**
 * Runs a slow step, saying on stderr what it is when it starts and every 15 s
 * until it ends. A production build takes about 15 s and prints nothing
 * itself (logLevel "warn"), so without this a caller waiting for --serve's URL
 * could not tell a slow build from a hung one, and a run killed by a timeout
 * left no trace of where it was.
 */
let currentStep = null;
async function step(label, work) {
  const started = Date.now();
  currentStep = label;
  console.error(`perf-bench: ${label}…`);
  const timer = setInterval(() => console.error(`perf-bench: still ${label} (${Math.round((Date.now() - started) / 1000)} s)`), 15_000);
  try {
    return await work();
  } catch (error) {
    throw new Error(`failed while ${label}: ${error.message}`, { cause: error });
  } finally {
    clearInterval(timer);
    currentStep = null;
  }
}

// A signal's default action skips the exit hook; exiting runs it.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    if (currentStep) console.error(`perf-bench: ${signal} while ${currentStep}`);
    process.exit(128 + os.constants.signals[signal]);
  });
}

function startPage(options, settings) {
  return step(options.dev ? "starting the dev server" : "building the bench page (a production build, about 15 s; --dev skips it)", () => startVite(!options.dev, settings));
}

/**
 * A production build by default: it is what ships, its durations are
 * realistic, and its pages load in a fraction of the dev server's time. The
 * dev server (`--dev`) keeps component names readable for finding causes.
 * `live` (a dev server for --serve) turns file watching and HMR back on: a
 * benchmark must not reload under a measurement, but someone editing the UI
 * wants to see the edit.
 */
async function startVite(production, { port = 0, live = false } = {}) {
  const { build, createServer, preview } = await import("vite");
  if (!port) port = await freePort();
  const shared = { root: repo, configFile: path.join(repo, "vite.config.ts"), logLevel: "warn", clearScreen: false };
  if (production) {
    const outDir = mkdtempSync(path.join(os.tmpdir(), "lattice-perf-bench-dist-"));
    buildDirs.add(outDir);
    try {
      await build({
        ...shared,
        build: {
          outDir,
          emptyOutDir: true,
          rolldownOptions: {
            input: { bench: path.join(repo, "tools/perf-bench/index.html") },
            // The bench page must install its mock backend before the app's
            // modules run; the app config merges them into one chunk.
            output: { strictExecutionOrder: true },
          },
        },
      });
      const server = await preview({ ...shared, build: { outDir }, preview: { port, strictPort: true, host: "127.0.0.1" } });
      return {
        server: {
          async close() {
            await server.close();
            removeBuildDir(outDir);
          },
        },
        origin: `http://127.0.0.1:${port}`,
        outDir,
      };
    } catch (error) {
      removeBuildDir(outDir);
      throw error;
    }
  }
  const server = await createServer({
    ...shared,
    server: { port, strictPort: true, host: "127.0.0.1", ...(live ? {} : { hmr: false, watch: null }) },
  });
  await server.listen();
  return { server, origin: `http://127.0.0.1:${port}`, outDir: null };
}

function benchUrl(origin, extra = {}) {
  const query = new URLSearchParams(Object.entries({ ...BENCH_FIXTURE, ...extra }).map(([key, value]) => [key, String(value)]));
  return `${origin}/tools/perf-bench/index.html?${query}`;
}

/**
 * `--serve`: the benchmark's page without the benchmark, for driving the real
 * app (over the mock backend) from a browser of one's own. Stays up until a
 * signal, whose exit hook removes the build. The URL is printed only once the
 * page answers (and, with --smoke, once the app mounted in it).
 */
async function serve(options) {
  const vite = await startPage(options, { port: options.port, live: options.dev });
  const url = benchUrl(vite.origin, { theme: "system", lang: "en" });
  await step("checking that the page answers", () => assertAnswers(url));
  const chrome = options.chrome || options.smoke ? await step("starting headless Chrome", () => launchChrome({ headless: !options.headful })) : null;
  if (options.smoke && !(await smokeCheck(chrome, url))) {
    await chrome.close();
    await vite.server.close();
    process.exit(1);
  }
  if (chrome && !options.chrome) await chrome.close();
  console.log(`Lattice bench page (${options.dev ? "dev server, live reload" : `production build in ${vite.outDir}`}):`);
  console.log(`  ${url}`);
  console.log("Query parameters: theme=system|light|dark, lang=en|zh-CN|system, papers=1|fulltext|library, build=clean|failed, keepStorage=1,");
  console.log(`  and the fixture sizes (${Object.keys(BENCH_FIXTURE).join(", ")}, chapters).`);
  if (options.chrome) {
    console.log("Headless Chrome for chrome-devtools-axi:");
    console.log(`  export CHROME_DEVTOOLS_AXI_BROWSER_URL=${chrome.endpoint}`);
    console.log(`  chrome-devtools-axi open '${url}'`);
  }
  if (!options.smoke) console.log(`Check that the app mounts: pnpm perf:bench --smoke --url '${url}'`);
  console.log("Press Ctrl-C to stop.");
  await new Promise(() => {});
}

async function assertAnswers(url) {
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`nothing answered at ${url}: ${error.cause?.message ?? error.message}`);
  }
  if (!response.ok) throw new Error(`${url} answered ${response.status} ${response.statusText}`);
}

/** The fixture's root document open in the editor, with the toolbar up. */
const APP_READY = `document.querySelector(".cm-editor .cm-content") && document.querySelector('button[aria-label="Build"]')`;
const APP_READY_TIMEOUT = 120_000;

/** Loads the page and waits for the root document in the editor with its first build settled. */
async function loadApp(page, url) {
  await page.navigate(url);
  const driver = new BenchDriver(page);
  await driver.install();
  await driver.waitFor(APP_READY, { timeout: APP_READY_TIMEOUT, what: "the app to open the fixture project" });
  await driver.settle({ quietMs: 1_000, timeout: 60_000 });
  return driver;
}

/**
 * Requests that failed or got an error status, and those not answered yet,
 * by request id. A request keeps its first failure: Chrome follows a script's
 * 404 with an ERR_ABORTED that says less.
 */
async function trackRequests(page) {
  const pending = new Map();
  const failed = new Map();
  const fail = (id, reason) => failed.has(id) || failed.set(id, reason);
  page.connection.on(({ sessionId, method, params }) => {
    if (sessionId !== page.sessionId) return;
    if (method === "Network.requestWillBeSent") pending.set(params.requestId, params.request.url);
    else if (method === "Network.responseReceived" && params.response.status >= 400) fail(params.requestId, `${params.response.status} ${params.response.url}`);
    else if (method === "Network.loadingFinished") pending.delete(params.requestId);
    else if (method === "Network.loadingFailed") {
      fail(params.requestId, `${params.errorText} ${pending.get(params.requestId) ?? ""}`);
      pending.delete(params.requestId);
    }
  });
  await page.send("Network.enable");
  return { pending, failed };
}

/**
 * `--smoke`: loads the page in a new tab of `chrome` and waits for the app to
 * open the fixture project. Prints the verdict and, on a failure, everything
 * the page can say about why, then returns whether the app mounted. Requests
 * still unanswered matter as much as errors: a dev server that stalls leaves
 * the page blank without a single error.
 */
async function smokeCheck(chrome, url) {
  const page = await CdpPage.open(chrome.connection);
  const requests = await trackRequests(page);
  const started = Date.now();
  // Not awaited, and not page.navigate(): a server that never answers holds
  // the navigation, and the load event never fires while a module never
  // arrives. The wait below has the deadline, and stops early when the page
  // itself could not be opened.
  let unreachable = null;
  page.send("Page.navigate", { url }).then(({ errorText }) => {
    unreachable = errorText ?? null;
  }, () => {});
  // Every in-page read races a timer: a blocked main thread never answers
  // Runtime.evaluate, and the verdict must still arrive at the deadline.
  const BLOCKED = Symbol("blocked");
  const bounded = (promise, ms) => Promise.race([promise, sleep(Math.max(0, ms), BLOCKED, { ref: false })]);
  let blocked = false;
  const mounted = await step("waiting for the app to open the fixture project", async () => {
    while (!unreachable && Date.now() - started < APP_READY_TIMEOUT) {
      const ready = await bounded(page.evaluate(`Boolean(${APP_READY})`).catch(() => false), APP_READY_TIMEOUT - (Date.now() - started));
      if (ready === BLOCKED) {
        blocked = true;
        return false;
      }
      if (ready) return true;
      await sleep(100);
    }
    return false;
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const errors = page.console.filter((line) => /^\[(error|exception|assert)\]/.test(line));
  const list = (lines) => (lines.length ? lines.map((line) => `    ${line.slice(0, 1_000).replaceAll("\n", "\n      ")}`).join("\n") : "    (none)");
  if (mounted) {
    console.log(`Smoke check passed: the app opened the fixture project in ${seconds} s.`);
    if (errors.length) console.log(`  The page reported errors on the way:\n${list(errors)}`);
  } else {
    const read = await bounded(page.evaluate("document.body ? document.body.innerText : ''").catch((error) => `(could not read: ${error.message})`), 5_000);
    const text = read === BLOCKED ? "(could not read: the main thread did not answer)" : read;
    const captured = await bounded(page.send("Page.captureScreenshot", { format: "png" }).catch(() => null), 5_000);
    const shot = captured === BLOCKED ? null : captured;
    const file = path.join(os.tmpdir(), `lattice-perf-bench-smoke-${process.pid}.png`);
    if (shot) writeFileSync(file, Buffer.from(shot.data, "base64"));
    const pending = [...requests.pending.values()];
    console.log(unreachable
      ? `Smoke check FAILED: the page could not be opened (${unreachable}).`
      : `Smoke check FAILED: the app did not open the fixture project within ${seconds} s.`);
    console.log(`  Page: ${url}`);
    if (blocked) console.log("  The page's main thread was blocked: it stopped answering in-page reads (a busy loop or a hung synchronous module evaluation).");
    console.log(`  Uncaught and console errors:\n${list(errors)}`);
    console.log(`  Failed requests:\n${list([...requests.failed.values()].slice(0, 20))}`);
    console.log(`  Requests still unanswered (${pending.length}; any means the server stalled or is still compiling):\n${list(pending.slice(0, 20))}`);
    console.log(`  Page text: ${text.trim() ? JSON.stringify(text.trim().slice(0, 600)) : "(empty: nothing rendered)"}`);
    if (shot) console.log(`  Screenshot: ${file}`);
  }
  await page.close();
  return mounted;
}

/** `--smoke` without --serve: serves the page (or uses --url), checks it once and exits. */
async function smoke(options) {
  const vite = options.url ? null : await startPage(options);
  const chrome = await step("starting headless Chrome", () => launchChrome({ headless: !options.headful }));
  try {
    if (!(await smokeCheck(chrome, options.url ?? benchUrl(vite.origin, { theme: "system", lang: "en" })))) process.exitCode = 1;
  } finally {
    await chrome.close();
    await vite?.server.close();
  }
}

function launchBrowser(options) {
  return options.engine === "webkit"
    ? launchWebKit({ headless: !options.headful })
    : launchChrome({ headless: !options.headful }).then((chrome) => ({
      open: () => CdpPage.open(chrome.connection),
      close: () => chrome.close(),
    }));
}

/** `--layout`: runs every layout check on a fresh page and exits 1 when one fails. */
async function layout(options) {
  const vite = await startPage(options);
  const browser = await step(`starting ${options.engine}`, () => launchBrowser(options));
  try {
    for (const check of LAYOUT_CHECKS) {
      const page = await browser.open();
      try {
        await page.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE });
        await page.resize(check.width, check.height);
        await check.run(await loadApp(page, benchUrl(vite.origin, { theme: "light", lang: "en", ...check.query })));
        console.log(`${check.name}: ok`);
      } catch (error) {
        process.exitCode = 1;
        console.log(`${check.name}: FAILED, ${error.message}\n  ${check.description}`);
        const shot = await page.send("Page.captureScreenshot", { format: "png" }).catch(() => null);
        if (shot) {
          const file = path.join(os.tmpdir(), `lattice-perf-bench-layout-${check.name}.png`);
          writeFileSync(file, Buffer.from(shot.data, "base64"));
          console.log(`  Screenshot: ${file}`);
        }
      } finally {
        if (!options.keepOpen) await page.close();
      }
    }
  } finally {
    if (!options.keepOpen) {
      await browser.close();
      await vite.server.close();
    }
  }
}

/** Self time per function, heaviest first, from a CDP CPU profile. */
function profileSummary(profile, top = 25) {
  const self = new Map();
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const interval = new Map();
  for (let index = 0; index < profile.samples.length; index += 1) {
    const id = profile.samples[index];
    interval.set(id, (interval.get(id) ?? 0) + (profile.timeDeltas[index + 1] ?? 0));
  }
  for (const [id, micros] of interval) {
    const { callFrame } = byId.get(id);
    const where = callFrame.url ? `${callFrame.url.replace(/^https?:\/\/[^/]+\//, "").replace(/\?.*$/, "")}:${callFrame.lineNumber + 1}` : "";
    const key = `${callFrame.functionName || "(anonymous)"} ${where}`.trim();
    self.set(key, (self.get(key) ?? 0) + micros / 1000);
  }
  return [...self].sort((a, b) => b[1] - a[1]).slice(0, top).map(([name, ms]) => `${ms.toFixed(1).padStart(8)} ms  ${name}`);
}

async function measure(page, driver, scenario, profileTo) {
  if (!scenario.startup) await driver.evaluate("window.__latticeProbe.reset()");
  if (profileTo) {
    await page.send("Profiler.enable");
    await page.send("Profiler.setSamplingInterval", { interval: 200 });
    await page.send("Profiler.start");
  }
  const before = await page.metrics();
  const started = Date.now();
  if (scenario.startup) await loadApp(page, driver.url);
  else await scenario.run(driver);
  await driver.settle();
  const after = await page.metrics();
  if (profileTo) {
    const { profile } = await page.send("Profiler.stop");
    writeFileSync(profileTo, JSON.stringify(profile));
    console.error(`CPU profile: ${profileTo}\n${profileSummary(profile).join("\n")}`);
  }
  const probe = await driver.evaluate("window.__latticeProbe.snapshot(400)");
  // Absent in WebKit, which has no such counters.
  const delta = (name) => (name in after ? after[name] - before[name] : null);
  const milliseconds = (name) => (name in after ? Math.round(delta(name) * 1000) : null);
  return {
    commits: probe.commits,
    renders: probe.renders + probe.mounts,
    hooks: probe.hooks,
    recalcs: delta("RecalcStyleCount"),
    layouts: delta("LayoutCount"),
    mutations: probe.mutations,
    info: {
      mounts: probe.mounts,
      addedNodes: probe.addedNodes,
      removedNodes: probe.removedNodes,
      attributeMutations: probe.attributes,
      textMutations: probe.characterData,
      longTasks: probe.longTasks,
      longTaskMs: probe.longTaskMs,
      layoutShift: probe.layoutShift,
      shiftRegions: probe.shiftRegions,
      recalcMs: milliseconds("RecalcStyleDuration"),
      layoutMs: milliseconds("LayoutDuration"),
      scriptMs: milliseconds("ScriptDuration"),
      taskMs: milliseconds("TaskDuration"),
      wallMs: Date.now() - started,
      domNodes: after.Nodes,
      updateOrigins: probe.origins,
      topComponents: probe.components,
    },
  };
}

function formatTable(results) {
  const rows = [["scenario", "unit", ...COUNTS.map((key) => `${key}/unit`), "long tasks", "task ms"]];
  for (const { scenario, result } of results) {
    rows.push([
      scenario.name,
      `${scenario.steps} ${scenario.unit}`,
      ...COUNTS.map((key) => (result[key] === null ? "–" : (result[key] / scenario.steps).toFixed(1))),
      String(result.info.longTasks),
      String(result.info.taskMs ?? "–"),
    ]);
  }
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ")).join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.serve) return serve(options);
  if (options.smoke) return smoke(options);
  if (options.layout) return layout(options);
  const scenarios = options.only ? SCENARIOS.filter((scenario) => options.only.includes(scenario.name)) : SCENARIOS;
  if (!scenarios.length) throw new Error(`No scenario matches ${options.only}`);
  const vite = options.url ? null : await startPage(options);
  const browser = await launchBrowser(options);
  const results = [];
  try {
    const url = options.url ?? benchUrl(vite.origin);
    // The first load pays for Vite's dependency optimisation, which may reload
    // the page once; measuring starts on the next, warm load.
    {
      const warm = await browser.open();
      await warm.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE });
      await loadApp(warm, url).catch((error) => {
        console.error(warm.console.slice(-30).join("\n"));
        throw error;
      });
      await warm.close();
    }
    for (const scenario of scenarios) {
      const runs = [];
      for (let run = 0; run < options.runs; run += 1) {
        const page = await browser.open();
        await page.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE });
        try {
          let driver;
          if (scenario.startup) {
            await page.navigate("about:blank");
            driver = Object.assign(new BenchDriver(page), { url });
          } else {
            driver = await loadApp(page, url);
            await scenario.setup(driver);
            await driver.settle({ quietMs: 1_000, timeout: 60_000 });
          }
          const profileTo = options.profile && run === 0 ? path.join(options.profile, `${scenario.name}.cpuprofile`) : null;
          runs.push(await measure(page, driver, scenario, profileTo));
        } catch (error) {
          const shot = await page.send("Page.captureScreenshot", { format: "png" }).catch(() => null);
          const file = path.join(os.tmpdir(), `lattice-perf-bench-${scenario.name}.png`);
          if (shot) {
            writeFileSync(file, Buffer.from(shot.data, "base64"));
            console.error(`Screenshot of the failure: ${file}`);
          }
          console.error(page.console.slice(-30).join("\n"));
          throw new Error(`${scenario.name}: ${error.message}`, { cause: error });
        } finally {
          if (!options.keepOpen) await page.close();
        }
      }
      const result = bestOf(scenario.name, runs);
      results.push({ scenario, result, runs });
      const recalcs = options.engine === "chromium" ? ` (${runs.map((run) => run.recalcs).join("/")} recalcs across runs)` : "";
      console.error(`${scenario.name}: ${COUNTS.map((key) => `${key} ${result[key] ?? "–"}`).join(", ")}${recalcs}`);
    }
  } finally {
    if (!options.keepOpen) {
      await browser.close();
      await vite?.server.close();
    }
  }

  console.log(formatTable(results));
  if (options.json) {
    writeFileSync(options.json, JSON.stringify(results.map(({ scenario, result, runs }) => ({
      scenario: scenario.name, description: scenario.description, unit: scenario.unit, steps: scenario.steps, result, runs,
    })), null, 2));
  }
  if (options.url) return;

  const mode = options.update ? "update" : options.ratchet ? "ratchet" : "check";
  const budgetsFile = BUDGETS[options.engine];
  const { budgets, failures, slack, changed } = applyBudgets(
    JSON.parse(readFileSync(budgetsFile, "utf8")),
    results.map(({ scenario, result }) => ({ name: scenario.name, result })),
    mode,
  );
  if (changed && !options.dev && !options.only) {
    writeFileSync(budgetsFile, `${JSON.stringify(budgets, null, 2)}\n`);
    console.log(`\nWrote ${path.relative(repo, budgetsFile)}.`);
  } else if (changed) {
    console.log("\nCeilings are only written from a full production run (no --dev or --only).");
  }
  if (slack.length) {
    console.log(`\nRoom to ratchet (pnpm perf:bench --ratchet lowers these ceilings):`);
    for (const { scenario, key, value, ceiling } of slack) console.log(`  ${scenario} ${key}: ${value}, ceiling ${ceiling}`);
  }
  if (failures.length) {
    console.log("\nOver budget:");
    for (const { scenario, key, value, ceiling } of failures) console.log(`  ${scenario} ${key}: ${value} exceeds ceiling ${ceiling}`);
    console.log("\nFind the cause with `pnpm perf:bench --dev --only <scenario> --json out.json`: each run lists the");
    console.log("components that rendered and the state hooks that started each update. Fix it, or, if the extra");
    console.log(`work is intended, raise the ceiling in ${path.relative(repo, budgetsFile)} and say why in the pull request.`);
    if (options.check) process.exitCode = 1;
  }
}

await main().catch((error) => {
  console.error(`perf-bench: ${error.message}`);
  console.error(error.cause?.stack ?? error.stack);
  process.exit(1);
});
