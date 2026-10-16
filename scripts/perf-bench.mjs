#!/usr/bin/env node
/**
 * Deterministic performance benchmark for Lattice's hot interactions
 * (docs/performance.md, "Benchmark and CI gate").
 *
 * Builds tools/perf-bench/ (the real app against an in-memory backend holding
 * the fixture project) with the production config, opens it in headless
 * Chrome, and runs each scenario in scripts/perf-bench/scenarios.mjs on a
 * fresh page. For every scenario it reports, per interaction:
 *   commits   React commits that rendered a component (idle ones are reported apart)
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
 *   --only a,b      run only these scenarios (with --layout, these checks)
 *   --shard K/N     run every N-th scenario (then layout check), starting
 *                   at the K-th: CI splits one engine's run across N runners
 *   --runs N        runs per scenario; each gated count is its lowest across them (default 2)
 *   --against REF   A/B instead of ceilings: build REF (such as origin/main) beside
 *                   this checkout and run each scenario on both, alternating, in
 *                   one browser; print each count on both sides and the change.
 *                   Exits 0 whatever moved: a local red against a ceiling on a
 *                   busy machine is answered by whether REF measures the same.
 *   --json FILE     write every run, with the components that rendered and why
 *   --dev           use the Vite dev server: readable component names and
 *                   profiles, and counts equal to production's (not gated)
 *   --profile DIR   save a CPU profile of each scenario's first run
 *   --url URL       measure an already running app instead (no ceilings)
 *   --engine NAME   chromium (default) or webkit
 *   --dist DIR      measure (or serve) the page --build-only built in DIR
 *                   instead of building it: CI builds once and every shard,
 *                   in either engine, measures that one build
 *   --headful, --keep-open   watch it run
 *
 * Building the page alone:
 *   --build-only DIR  build the page into DIR (new or empty), print its
 *                   content hash and exit; --dist DIR then uses it
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
 *   --stop          SIGTERM the --serve processes started from this checkout
 *                   (listed in .tmp/perf-bench-serve.pid) and wait for their
 *                   cleanup; nothing else on the machine is touched
 *   --lang L        the interface language of the page --serve and --smoke
 *                   open: en (default), zh-CN or system
 *   --locale L      with --smoke: the browser language the checked page sees
 *                   (a BCP 47 tag, e.g. zh-CN), which lang=system resolves from
 * Layout checks (no benchmark):
 *   --layout        build the page and check the geometry in
 *                   scripts/perf-bench/layout-checks.mjs in the chosen engine;
 *                   exit 1 when one fails, with a screenshot of it. With
 *                   --check, the benchmark runs first and both share one build
 * The page accepts `theme=system|light|dark` and `lang=en|zh-CN|system`
 * (tools/perf-bench/bench-page.ts); --serve prints a URL with both.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, URLSearchParams } from "node:url";
import { applyBudgets, bestOf, COUNTS, gatedCounts } from "./perf-bench/budgets.mjs";
import { CdpPage, launchChrome } from "./perf-bench/cdp.mjs";
import { launchWebKit } from "./perf-bench/webkit.mjs";
import { LAYOUT_CHECKS } from "./perf-bench/layout-checks.mjs";
import { BenchDriver, SCENARIOS } from "./perf-bench/scenarios.mjs";
import { APP_READY } from "./perf-bench/selectors.mjs";
import { exitOnSignals, once, onShutdown, shuttingDown, withoutSigtermExit } from "./perf-bench/shutdown.mjs";

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
 * The --serve processes running from this checkout, one pid per line, so
 * --stop ends them and nothing else: a machine-wide `pkill -f` takes down
 * other lanes' servers too.
 */
const SERVE_PIDFILE = path.join(repo, ".tmp/perf-bench-serve.pid");
/** The page's entry, relative to the repository and to a build of it alike. */
const BENCH_PAGE = "tools/perf-bench/index.html";

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
  const options = { runs: 2, against: null, only: null, shard: null, json: null, profile: null, check: false, ratchet: false, update: false, headful: false, keepOpen: false, url: null, dist: null, buildOnly: null, dev: false, serve: false, stop: false, smoke: false, chrome: false, layout: false, port: SERVE_PORT, engine: "chromium", lang: "en", locale: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") options.check = true;
    else if (arg === "--ratchet") options.ratchet = true;
    else if (arg === "--update") options.update = true;
    else if (arg === "--headful") options.headful = true;
    else if (arg === "--dev") options.dev = true;
    else if (arg === "--keep-open") options.keepOpen = true;
    else if (arg === "--runs") options.runs = Number(argv[++index]);
    else if (arg === "--against") options.against = argv[++index];
    else if (arg === "--only") options.only = argv[++index].split(",");
    else if (arg === "--shard") options.shard = parseShard(argv[++index]);
    else if (arg === "--json") options.json = argv[++index];
    else if (arg === "--url") options.url = argv[++index];
    else if (arg === "--dist") options.dist = path.resolve(argv[++index]);
    else if (arg === "--build-only") options.buildOnly = path.resolve(argv[++index]);
    else if (arg === "--profile") options.profile = argv[++index];
    else if (arg === "--serve") options.serve = true;
    else if (arg === "--stop") options.stop = true;
    else if (arg === "--smoke") options.smoke = true;
    else if (arg === "--chrome") options.chrome = true;
    else if (arg === "--layout") options.layout = true;
    else if (arg === "--port") options.port = Number(argv[++index]);
    else if (arg === "--engine") options.engine = argv[++index];
    else if (arg === "--lang") options.lang = argv[++index];
    else if (arg === "--locale") options.locale = argv[++index];
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) throw new Error("--port takes a port number");
  if (options.stop && argv.length !== 1) throw new Error("--stop ends this checkout's --serve processes; it takes no other option");
  if (options.buildOnly && argv.length !== 2) throw new Error("--build-only builds the page and exits; it takes no other option");
  if (options.dist && (options.dev || options.url)) throw new Error("--dist serves a production build; it cannot take --dev or --url");
  if (options.dist && !existsSync(path.join(options.dist, BENCH_PAGE))) throw new Error(`--dist: ${options.dist} holds no ${BENCH_PAGE}; build it with --build-only`);
  if (options.serve && options.url) throw new Error("--serve starts its own page; it cannot take --url");
  if (options.chrome && !options.serve) throw new Error("--chrome keeps a browser up beside --serve; add --serve");
  if (options.layout && (options.serve || options.smoke || options.url)) throw new Error("--layout serves its own page per check; it cannot take --serve, --smoke or --url");
  if (options.shard && (options.serve || options.smoke)) throw new Error("--shard splits a benchmark or layout run; it cannot take --serve or --smoke");
  if (options.smoke && options.engine !== "chromium") throw new Error("--smoke loads the page in Chrome only");
  if (!["en", "zh-CN", "system"].includes(options.lang)) throw new Error("--lang takes en, zh-CN or system");
  if (options.url && argv.includes("--lang")) throw new Error("--url names its own page; put lang= in it instead of --lang");
  if (options.locale && !options.smoke) throw new Error("--locale sets the browser language of --smoke's page; add --smoke");
  if (!(options.engine in BUDGETS)) throw new Error(`Unknown engine ${options.engine}: use chromium or webkit`);
  if (options.profile && options.engine !== "chromium") throw new Error("--profile records Chromium CPU profiles only");
  if (options.against !== null) {
    if (!options.against) throw new Error("--against takes a git ref, such as origin/main");
    const clash = ["--check", "--ratchet", "--update", "--layout", "--serve", "--smoke", "--url", "--dev", "--profile", "--json", "--keep-open", "--dist"].filter((flag) => argv.includes(flag));
    if (clash.length) throw new Error(`--against compares two production builds and holds no ceilings; it cannot take ${clash.join(", ")}`);
  }
  return options;
}

function parseShard(value) {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? "");
  const [index, count] = match ? [Number(match[1]), Number(match[2])] : [];
  if (!match || index < 1 || index > count) throw new Error("--shard takes K/N with 1 <= K <= N, such as 2/3");
  return { index, count };
}

/**
 * The scenarios and layout checks this run covers. --layout alone runs only
 * the checks; with --check they follow the benchmark on its build. --only
 * picks by name, and --shard deals the combined list out round-robin, so a
 * scenario or check added later lands in some shard without CI naming it.
 */
function selectWork(options) {
  const named = (items) => (options.only ? items.filter((item) => options.only.includes(item.name)) : items);
  const work = [
    ...(options.layout && !options.check ? [] : named(SCENARIOS).map((scenario) => ({ scenario }))),
    ...(options.layout ? named(LAYOUT_CHECKS).map((check) => ({ check })) : []),
  ];
  const kept = options.shard ? work.filter((_, index) => index % options.shard.count === options.shard.index - 1) : work;
  if (!kept.length) {
    const what = options.layout && !options.check ? "layout check" : options.layout ? "scenario or layout check" : "scenario";
    throw new Error(`No ${what} matches${options.only ? ` ${options.only}` : ""}${options.shard ? ` in shard ${options.shard.index}/${options.shard.count}` : ""}`);
  }
  return {
    scenarios: kept.flatMap((item) => item.scenario ?? []),
    checks: kept.flatMap((item) => item.check ?? []),
  };
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
 * exit hook catches the paths that skip that (a thrown error, --keep-open),
 * since a production build is tens of megabytes.
 */
const buildDirs = new Set();
function removeBuildDir(dir) {
  // --against's base tree links this checkout's node_modules; unlink that
  // first so removing the tree can never reach into the real one.
  const link = path.join(dir, "node_modules");
  if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(link);
  rmSync(dir, { recursive: true, force: true });
  buildDirs.delete(dir);
}
process.on("exit", () => {
  for (const dir of buildDirs) removeBuildDir(dir);
});

/**
 * Runs a slow step, saying on stderr what it is when it starts and every 15 s
 * until it ends. A production build takes about 40 s on a Linux CI runner and
 * 2 min on a macOS one, more on a busy laptop, and prints nothing itself
 * (logLevel "warn"), so without this a caller waiting for --serve's URL
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

// A signal closes the servers and browsers first (each registers with
// onShutdown), then exits with its status.
exitOnSignals({ describe: (signal) => currentStep && `perf-bench: ${signal} while ${currentStep}` });

/** A server whose close() runs once, whether its owner or a signal calls it first. */
function closedOnShutdown(close) {
  const closeOnce = once(async () => {
    unregister();
    await close();
  });
  const unregister = onShutdown(closeOnce);
  return { close: closeOnce };
}

function startPage(options, settings = {}) {
  if (options.dist) return step(`serving the bench page built in ${options.dist} (sha256 ${hashTree(options.dist)})`, () => startVite(true, { ...settings, dist: options.dist }));
  const what = settings.label ?? "the bench page";
  return step(options.dev ? "starting the dev server" : `building ${what} (a production build, 40 s to 2 min; --dev skips it)`, () => startVite(!options.dev, settings));
}

/**
 * A production build by default: it is what ships, its durations are
 * realistic, and its pages load in a fraction of the dev server's time. The
 * dev server (`--dev`) keeps component names readable for finding causes.
 * `live` (a dev server for --serve) turns file watching and HMR back on: a
 * benchmark must not reload under a measurement, but someone editing the UI
 * wants to see the edit. `dist`, a --build-only directory, is served as it
 * is and left in place.
 */
async function startVite(production, { port = 0, live = false, root = repo, dist = null } = {}) {
  const { createServer, preview } = await import("vite");
  if (!port) port = await freePort();
  const shared = viteShared(root);
  if (production) {
    const outDir = dist ?? mkdtempSync(path.join(os.tmpdir(), "lattice-perf-bench-dist-"));
    const removeOwnBuild = () => {
      if (!dist) removeBuildDir(outDir);
    };
    if (!dist) buildDirs.add(outDir);
    try {
      if (!dist) await buildPage(outDir, root);
      const server = await withoutSigtermExit(() => preview({ ...shared, build: { outDir }, preview: { port, strictPort: true, host: "127.0.0.1" } }));
      return {
        server: closedOnShutdown(async () => {
          await server.close();
          removeOwnBuild();
        }),
        origin: `http://127.0.0.1:${port}`,
        outDir,
      };
    } catch (error) {
      removeOwnBuild();
      throw error;
    }
  }
  const server = await withoutSigtermExit(() => createServer({
    ...shared,
    server: { port, strictPort: true, host: "127.0.0.1", ...(live ? {} : { hmr: false, watch: null }) },
  }));
  await server.listen();
  return { server: closedOnShutdown(() => server.close()), origin: `http://127.0.0.1:${port}`, outDir: null };
}

function viteShared(root = repo) {
  return { root, configFile: path.join(root, "vite.config.ts"), logLevel: "warn", clearScreen: false };
}

/** The production build of the bench page in `root` into `outDir`, which it empties. */
async function buildPage(outDir, root = repo) {
  const { build } = await import("vite");
  // Lingui finds its config, and matches catalogs to it, from the working
  // directory rather than Vite's root, so --against's base tree builds from
  // inside it. Builds run one at a time, so the switch is never shared.
  const cwd = process.cwd();
  process.chdir(root);
  try {
    await build({
      ...viteShared(root),
      build: {
        outDir,
        emptyOutDir: true,
        rolldownOptions: {
          input: { bench: path.join(root, BENCH_PAGE) },
          // The bench page must install its mock backend before the app's
          // modules run; the app config merges them into one chunk.
          output: { strictExecutionOrder: true },
        },
      },
    });
  } finally {
    process.chdir(cwd);
  }
}

/**
 * One hash over every file's path and bytes. --build-only prints it and
 * --dist repeats it, so a log shows which build a shard measured, and two
 * builds (another machine, another OS) can be compared byte for byte.
 */
function hashTree(dir) {
  const hash = createHash("sha256");
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
  for (const file of files) hash.update(`${file}\0`).update(readFileSync(path.join(dir, file))).update("\0");
  return hash.digest("hex");
}

/**
 * `--build-only`: the production build alone, into a directory that outlives
 * the process, for --dist runs elsewhere (CI builds once and hands the page
 * to every benchmark shard). It refuses a directory with files in it, since
 * the build empties its output directory first.
 */
async function buildOnly(outDir) {
  if (existsSync(outDir) && readdirSync(outDir).length) throw new Error(`--build-only writes into a new or empty directory; ${outDir} has files in it`);
  await step("building the bench page", () => buildPage(outDir));
  console.log(`Built the bench page into ${outDir} (sha256 ${hashTree(outDir)}).`);
  console.log(`Measure or serve it with --dist ${outDir}.`);
}

function benchUrl(origin, extra = {}) {
  const query = new URLSearchParams(Object.entries({ ...BENCH_FIXTURE, ...extra }).map(([key, value]) => [key, String(value)]));
  return `${origin}/${BENCH_PAGE}?${query}`;
}

/**
 * `--serve`: the benchmark's page without the benchmark, for driving the real
 * app (over the mock backend) from a browser of one's own. Stays up until a
 * signal, which closes the server and browser and removes the build and the
 * browser's profile. The URL is printed only once the page answers (and,
 * with --smoke, once the app mounted in it).
 */
async function serve(options) {
  recordServePid();
  const vite = await startPage(options, { port: options.port, live: options.dev });
  const url = benchUrl(vite.origin, { theme: "system", lang: options.lang });
  await step("checking that the page answers", () => assertAnswers(url));
  const chrome = options.chrome || options.smoke ? await step("starting headless Chrome", () => launchChrome({ headless: !options.headful })) : null;
  if (options.smoke && !(await smokeCheck(chrome, url, options.locale))) {
    await chrome.close();
    await vite.server.close();
    process.exit(1);
  }
  if (chrome && !options.chrome) await chrome.close();
  console.log(`Lattice bench page (${options.dev ? "dev server, live reload" : `production build in ${vite.outDir}`}):`);
  console.log(`  ${url}`);
  console.log("Query parameters: theme=system|light|dark, lang=en|zh-CN|system, papers=1|fulltext|library, build=clean|failed|running, keepStorage=1,");
  console.log(`  the fixture sizes (${Object.keys(BENCH_FIXTURE).join(", ")}, chapters),`);
  console.log("  and a large project's paperCount, bibEntries, historyEntries and gitVersions.");
  if (options.chrome) {
    console.log("Headless Chrome for chrome-devtools-axi:");
    console.log(`  export CHROME_DEVTOOLS_AXI_BROWSER_URL=${chrome.endpoint}`);
    console.log(`  chrome-devtools-axi open '${url}'`);
  }
  if (!options.smoke) console.log(`Check that the app mounts: pnpm perf:bench --smoke --url '${url}'`);
  console.log("Press Ctrl-C to stop.");
  await new Promise(() => {});
}

function servePids() {
  try {
    return readFileSync(SERVE_PIDFILE, "utf8").split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function writeServePids(pids) {
  if (pids.length) writeFileSync(SERVE_PIDFILE, pids.map((pid) => `${pid}\n`).join(""));
  else rmSync(SERVE_PIDFILE, { force: true });
}

/** Whether `pid` is still a perf-bench process, not a stale entry whose pid the system reused. */
function isPerfBench(pid) {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).includes("perf-bench");
  } catch {
    return false;
  }
}

/** Adds this process to the pidfile, and takes it out again however the process exits. */
function recordServePid() {
  mkdirSync(path.dirname(SERVE_PIDFILE), { recursive: true });
  writeServePids([...servePids().filter((pid) => pid !== process.pid && isPerfBench(pid)), process.pid]);
  process.on("exit", () => writeServePids(servePids().filter((pid) => pid !== process.pid)));
}

/** `--stop`: SIGTERM (which runs the cleanup) each live --serve from this checkout, then wait for it to exit. */
async function stopServers() {
  const pids = servePids().filter(isPerfBench);
  writeServePids(pids);
  if (!pids.length) {
    console.log("perf-bench: no --serve process from this checkout is running");
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // It exited since the check.
    }
  }
  // The shutdown grace (shutdown.mjs) is 15 s; allow a little more.
  const deadline = Date.now() + 20_000;
  let alive = pids;
  while (alive.length && Date.now() < deadline) {
    await sleep(250);
    alive = alive.filter(isPerfBench);
  }
  // Each server takes itself out on exit; this also drops one that could not.
  writeServePids(servePids().filter(isPerfBench));
  if (alive.length) throw new Error(`--serve ${alive.join(", ")} still running 20 s after SIGTERM`);
  console.log(`perf-bench: stopped --serve ${pids.join(", ")}`);
}

async function assertAnswers(url) {
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`nothing answered at ${url}: ${error.cause?.message ?? error.message}`, { cause: error });
  }
  if (!response.ok) throw new Error(`${url} answered ${response.status} ${response.statusText}`);
}

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
 * the page blank without a single error. `locale`, when given, is the browser
 * language the page sees.
 */
async function smokeCheck(chrome, url, locale) {
  const page = await CdpPage.open(chrome.connection);
  if (locale) {
    await page.send("Emulation.setLocaleOverride", { locale });
    const { userAgent } = await page.send("Browser.getVersion");
    await page.send("Emulation.setUserAgentOverride", { userAgent, acceptLanguage: locale });
  }
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
      const ready = await bounded(page.evaluate(APP_READY).catch(() => false), APP_READY_TIMEOUT - (Date.now() - started));
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
    const lang = await bounded(page.evaluate("document.documentElement.lang").catch(() => null), 5_000);
    console.log(`Smoke check passed: the app opened the fixture project in ${seconds} s (interface language: ${typeof lang === "string" && lang ? lang : "unknown"}).`);
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
    if (!(await smokeCheck(chrome, options.url ?? benchUrl(vite.origin, { theme: "system", lang: options.lang }), options.locale))) process.exitCode = 1;
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

/** `--layout`: runs each layout check on a fresh page and exits 1 when one fails. */
async function layout(options, checks, vite) {
  const browser = await step(`starting ${options.engine}`, () => launchBrowser(options));
  try {
    for (const check of checks) {
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
    if (!options.keepOpen) await browser.close();
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
      idleCommits: probe.idleCommits,
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
  if (options.buildOnly) return buildOnly(options.buildOnly);
  if (options.stop) return stopServers();
  if (options.serve) return serve(options);
  if (options.smoke) return smoke(options);
  const { scenarios, checks } = selectWork(options);
  if (options.against) return against(options, scenarios);
  const vite = options.url ? null : await startPage(options);
  try {
    if (scenarios.length) await benchmark(options, scenarios, vite);
    if (checks.length) await layout(options, checks, vite);
  } finally {
    if (!options.keepOpen) await vite?.server.close();
  }
}

/**
 * The first load pays for Vite's dependency optimisation, which may reload
 * the page once; measuring starts on the next, warm load.
 */
async function warmUp(browser, url) {
  const warm = await browser.open();
  await warm.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE });
  await loadApp(warm, url).catch((error) => {
    console.error(warm.console.slice(-30).join("\n"));
    throw error;
  });
  await warm.close();
}

/** One run of one scenario on a fresh page of `url`. */
async function runScenario(browser, url, scenario, options, run, tag = "") {
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
    return await measure(page, driver, scenario, profileTo);
  } catch (error) {
    const shot = await page.send("Page.captureScreenshot", { format: "png" }).catch(() => null);
    const file = path.join(os.tmpdir(), `lattice-perf-bench-${scenario.name}${tag}.png`);
    if (shot) {
      writeFileSync(file, Buffer.from(shot.data, "base64"));
      console.error(`Screenshot of the failure: ${file}`);
    }
    console.error(page.console.slice(-30).join("\n"));
    throw new Error(`${scenario.name}${tag}: ${error.message}`, { cause: error });
  } finally {
    if (!options.keepOpen) await page.close();
  }
}

/** The per-run spread of the counts that move most, so noise shows next to a result. */
function acrossRuns(options, runs) {
  const across = [["commits", (run) => run.commits], ["idle commits", (run) => run.info.idleCommits]];
  if (options.engine === "chromium") across.push(["recalcs", (run) => run.recalcs]);
  return across.map(([name, of]) => `${name} ${runs.map(of).join("/")}`).join(", ");
}

/** Measures each scenario, prints the table and holds the counts to their ceilings. */
async function benchmark(options, scenarios, vite) {
  const browser = await launchBrowser(options);
  const results = [];
  try {
    const url = options.url ?? benchUrl(vite.origin);
    await warmUp(browser, url);
    for (const scenario of scenarios) {
      const runs = [];
      for (let run = 0; run < options.runs; run += 1) runs.push(await runScenario(browser, url, scenario, options, run));
      const result = bestOf(scenario.name, runs);
      results.push({ scenario, result, runs });
      console.error(`${scenario.name}: ${COUNTS.map((key) => `${key} ${result[key] ?? "–"}`).join(", ")} (across runs: ${acrossRuns(options, runs)})`);
    }
  } finally {
    if (!options.keepOpen) await browser.close();
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
  if (changed && !options.dev && !options.only && !options.shard) {
    writeFileSync(budgetsFile, `${JSON.stringify(budgets, null, 2)}\n`);
    console.log(`\nWrote ${path.relative(repo, budgetsFile)}.`);
  } else if (changed) {
    console.log("\nCeilings are only written from a full production run (no --dev, --only or --shard).");
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

/**
 * `--against REF`: the A/B a local red calls for. A ceiling was set on a CI
 * runner, and a laptop running other builds measures some counts well above
 * it (long-tex-typing's mutations read 165 in one run and 214 in another on
 * main, against a ceiling of 195), so a red here says little until the base
 * measures the same. This builds REF from `git archive` into a temporary
 * directory that borrows this checkout's node_modules (no worktree is
 * registered), serves both builds, and runs every scenario on each in one
 * browser, alternating which goes first, so load and order fall on both
 * sides alike. The scenarios and their driver are this checkout's.
 */
async function against(options, scenarios) {
  const sha = execFileSync("git", ["rev-parse", "--verify", `${options.against}^{commit}`], { cwd: repo, encoding: "utf8" }).trim();
  const label = `${options.against} (${sha.slice(0, 9)})`;
  const baseRoot = mkdtempSync(path.join(os.tmpdir(), "lattice-perf-bench-base-"));
  buildDirs.add(baseRoot);
  await step(`extracting ${label}`, async () => {
    execFileSync("sh", ["-c", 'git archive "$1" | tar -x -C "$2"', "sh", sha, baseRoot], { cwd: repo });
    symlinkSync(path.join(repo, "node_modules"), path.join(baseRoot, "node_modules"), "dir");
  });
  const sameLockfile = (() => {
    try {
      execFileSync("git", ["diff", "--quiet", sha, "--", "pnpm-lock.yaml"], { cwd: repo });
      return true;
    } catch {
      return false;
    }
  })();
  if (!sameLockfile) console.error(`perf-bench: pnpm-lock.yaml differs from ${label}; its build uses this checkout's dependencies`);

  const head = await startPage(options, { label: "this checkout's bench page" });
  const base = await startPage(options, { label: `the bench page of ${label}`, root: baseRoot });
  const browser = await step(`starting ${options.engine}`, () => launchBrowser(options));
  const sides = [
    { name: "base", url: benchUrl(base.origin) },
    { name: "head", url: benchUrl(head.origin) },
  ];
  const rows = [];
  try {
    for (const side of sides) await warmUp(browser, side.url);
    for (const scenario of scenarios) {
      const runs = { base: [], head: [] };
      for (let run = 0; run < options.runs; run += 1) {
        for (const side of run % 2 ? [...sides].reverse() : sides) {
          runs[side.name].push(await runScenario(browser, side.url, scenario, options, run, ` (${side.name})`));
        }
      }
      const best = { base: bestOf(scenario.name, runs.base), head: bestOf(scenario.name, runs.head) };
      rows.push({ scenario, best, runs });
      console.error(`${scenario.name}: base ${acrossRuns(options, runs.base)}; head ${acrossRuns(options, runs.head)}`);
    }
  } finally {
    await browser.close();
    await head.server.close();
    await base.server.close();
    removeBuildDir(baseRoot);
  }

  console.log(`\nA/B per ${options.runs} run(s) each, base ${label} vs head (this checkout); each count is its fewest across runs.`);
  // Every run's value beside the fewest, so a count that moves this much
  // between runs of one side reads as noise, not as the change.
  const table = [["scenario", "count", "base", "head", "change", "base runs", "head runs"]];
  for (const { scenario, best, runs } of rows) {
    const gated = gatedCounts(scenario.name);
    for (const key of COUNTS) {
      const [a, b] = [best.base[key], best.head[key]];
      if (a === null || b === null) continue;
      const change = a === b ? "=" : `${b > a ? "+" : ""}${b - a}${a ? ` (${b > a ? "+" : ""}${Math.round(((b - a) / a) * 100)}%)` : ""}`;
      const each = (side) => runs[side].map((run) => run[key]).join("/");
      table.push([scenario.name, gated.includes(key) ? key : `${key} (report-only)`, String(a), String(b), change, each("base"), each("head")]);
    }
  }
  const widths = table[0].map((_, column) => Math.max(...table.map((row) => row[column].length)));
  console.log(table.map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ")).join("\n"));
  console.log("\nCeilings are not checked here; CI holds them. A change within either side's own spread across runs");
  console.log("is noise; a regression worth a look multiplies a count, on every run. Add --runs to narrow a close call.");
}

await main().catch((error) => {
  // A signal tore the page or server out from under the run; its own exit
  // (with the signal's status) follows once the cleanup is done.
  if (shuttingDown()) return;
  console.error(`perf-bench: ${error.message}`);
  console.error(error.cause?.stack ?? error.stack);
  process.exit(1);
});
