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
 *   --headful, --keep-open   watch it run
 *
 * Serving the page for UI work, screenshots and QA (no benchmark, no browser):
 *   --serve         build the page, print its URL and stay up until interrupted;
 *                   with --dev, serve it from the dev server with file watching
 *                   and HMR on, so edits show without a restart
 *   --port N        the port to serve on (default 18480; 0 picks a free one)
 * The page accepts `theme=system|light|dark` and `lang=en|zh-CN|system`
 * (tools/perf-bench/bench-page.ts); --serve prints a URL with both.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, URLSearchParams } from "node:url";
import { applyBudgets, bestOf, COUNTS } from "./perf-bench/budgets.mjs";
import { CdpPage, launchChrome } from "./perf-bench/cdp.mjs";
import { BenchDriver, SCENARIOS } from "./perf-bench/scenarios.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUDGETS = path.join(repo, "scripts/perf-bench/budgets.json");
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
  const options = { runs: 2, only: null, json: null, profile: null, check: false, ratchet: false, update: false, headful: false, keepOpen: false, url: null, dev: false, serve: false, port: SERVE_PORT };
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
    else if (arg === "--port") options.port = Number(argv[++index]);
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) throw new Error("--port takes a port number");
  if (options.serve && options.url) throw new Error("--serve starts its own page; it cannot take --url");
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
// A signal's default action skips the exit hook; exiting runs it.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => process.exit(128 + os.constants.signals[signal]));
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
 * signal, whose exit hook removes the build.
 */
async function serve(options) {
  const vite = await startVite(!options.dev, { port: options.port, live: options.dev });
  console.log(`Lattice bench page (${options.dev ? "dev server, live reload" : `production build in ${vite.outDir}`}):`);
  console.log(`  ${benchUrl(vite.origin, { theme: "system", lang: "en" })}`);
  console.log("Query parameters: theme=system|light|dark, lang=en|zh-CN|system, papers=1|fulltext, keepStorage=1,");
  console.log(`  and the fixture sizes (${Object.keys(BENCH_FIXTURE).join(", ")}, chapters).`);
  console.log("Press Ctrl-C to stop.");
  await new Promise(() => {});
}

/** Loads the page and waits for the root document in the editor with its first build settled. */
async function loadApp(page, url) {
  await page.navigate(url);
  const driver = new BenchDriver(page);
  await driver.install();
  await driver.waitFor(`document.querySelector(".cm-editor .cm-content") && document.querySelector('button[aria-label="Build"]')`, {
    timeout: 120_000,
    what: "the app to open the fixture project",
  });
  await driver.settle({ quietMs: 1_000, timeout: 60_000 });
  return driver;
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
  const delta = (name) => after[name] - before[name];
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
      recalcMs: Math.round(delta("RecalcStyleDuration") * 1000),
      layoutMs: Math.round(delta("LayoutDuration") * 1000),
      scriptMs: Math.round(delta("ScriptDuration") * 1000),
      taskMs: Math.round(delta("TaskDuration") * 1000),
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
      ...COUNTS.map((key) => (result[key] / scenario.steps).toFixed(1)),
      String(result.info.longTasks),
      String(result.info.taskMs),
    ]);
  }
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ")).join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.serve) return serve(options);
  const scenarios = options.only ? SCENARIOS.filter((scenario) => options.only.includes(scenario.name)) : SCENARIOS;
  if (!scenarios.length) throw new Error(`No scenario matches ${options.only}`);
  const vite = options.url ? null : await startVite(!options.dev);
  const chrome = await launchChrome({ headless: !options.headful });
  const results = [];
  try {
    const url = options.url ?? benchUrl(vite.origin);
    // The first load pays for Vite's dependency optimisation, which may reload
    // the page once; measuring starts on the next, warm load.
    {
      const warm = await CdpPage.open(chrome.connection);
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
        const page = await CdpPage.open(chrome.connection);
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
      console.error(`${scenario.name}: ${COUNTS.map((key) => `${key} ${result[key]}`).join(", ")} (${runs.map((run) => run.recalcs).join("/")} recalcs across runs)`);
    }
  } finally {
    if (!options.keepOpen) {
      await chrome.close();
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
  const { budgets, failures, slack, changed } = applyBudgets(
    JSON.parse(readFileSync(BUDGETS, "utf8")),
    results.map(({ scenario, result }) => ({ name: scenario.name, result })),
    mode,
  );
  if (changed && !options.dev && !options.only) {
    writeFileSync(BUDGETS, `${JSON.stringify(budgets, null, 2)}\n`);
    console.log(`\nWrote ${path.relative(repo, BUDGETS)}.`);
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
    console.log("work is intended, raise the ceiling in scripts/perf-bench/budgets.json and say why in the pull request.");
    if (options.check) process.exitCode = 1;
  }
}

await main();
