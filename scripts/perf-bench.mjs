#!/usr/bin/env node
/**
 * Deterministic performance benchmark for Lattice's hot interactions
 * (docs/performance.md, "Benchmark and CI gate").
 *
 * Starts the Vite dev server, opens tools/perf-bench/ (the real app against an
 * in-memory backend holding the fixture project) in headless Chrome, and runs
 * each scenario in scripts/perf-bench/scenarios.mjs on a fresh page. For every
 * scenario it reports, per interaction:
 *   commits   React commits
 *   renders   component renders (React DevTools' definition) and the hooks they ran
 *   recalcs   style recalculations, as Chromium counts them
 *   layouts   layouts, as Chromium counts them
 *   mutations DOM mutation records
 * plus long tasks, layout shifts and main-thread durations, which are
 * wall-clock facts: reported, never gated.
 *
 * Usage:
 *   node scripts/perf-bench.mjs                 measure and print
 *   node scripts/perf-bench.mjs --check         also fail when a count exceeds its ceiling (CI)
 *   node scripts/perf-bench.mjs --ratchet       lower ceilings the measurements now beat
 *   node scripts/perf-bench.mjs --update        set every ceiling from this run (review the diff)
 * Options: --only a,b  --runs N  --json FILE  --headful  --keep-open
 *          --profile DIR  save a CPU profile of each scenario's first run (open in DevTools)
 *          --prod     measure a production build (realistic durations, minified names)
 *          --url URL   measure an already running app instead (no ceilings)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CdpPage, launchChrome } from "./perf-bench/cdp.mjs";
import { BenchDriver, SCENARIOS } from "./perf-bench/scenarios.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUDGETS = path.join(repo, "scripts/perf-bench/budgets.json");
const PROBE = readFileSync(path.join(repo, "scripts/perf-bench/probe.js"), "utf8");

/**
 * Smaller than the playbook fixture so a CI run stays short, but large enough
 * that per-document work dominates: a 400 KB Markdown file (~1,000 blocks) and
 * 60 KB chapters.
 */
const BENCH_FIXTURE = {
  largeMarkdownBytes: 400_000,
  chapterBytes: 60_000,
  notes: 40,
  codeBlocks: 150,
  pdfPages: 200,
  logLines: 4_000,
};

/** The gated counts. Everything else in a result is informational. */
export const GATED = ["commits", "renders", "hooks", "recalcs", "layouts", "mutations"];

/**
 * Ceilings sit this far above the measurement that set them. Counts are
 * deterministic up to frame alignment (two DOM changes landing in one frame
 * share a style recalculation), so a small margin absorbs runner differences
 * while a real regression, which multiplies a count, still fails.
 */
const HEADROOM = 0.15;
const HEADROOM_MIN = 3;

function parseArgs(argv) {
  const options = { runs: 2, only: null, json: null, profile: null, check: false, ratchet: false, update: false, headful: false, keepOpen: false, url: null, prod: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") options.check = true;
    else if (arg === "--ratchet") options.ratchet = true;
    else if (arg === "--update") options.update = true;
    else if (arg === "--headful") options.headful = true;
    else if (arg === "--prod") options.prod = true;
    else if (arg === "--keep-open") options.keepOpen = true;
    else if (arg === "--runs") options.runs = Number(argv[++index]);
    else if (arg === "--only") options.only = argv[++index].split(",");
    else if (arg === "--json") options.json = argv[++index];
    else if (arg === "--url") options.url = argv[++index];
    else if (arg === "--profile") options.profile = argv[++index];
    else throw new Error(`Unknown option ${arg}`);
  }
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
 * The dev server by default: component names stay readable in the report, and
 * the counts are the same as in production. `--prod` builds the bench page
 * with the production config instead, for realistic durations.
 */
async function startVite(production) {
  const { build, createServer, preview } = await import("vite");
  const port = await freePort();
  const shared = { root: repo, configFile: path.join(repo, "vite.config.ts"), logLevel: "warn", clearScreen: false };
  if (production) {
    const outDir = path.join(os.tmpdir(), "lattice-perf-bench-dist");
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
    return { server: { close: () => server.close() }, origin: `http://127.0.0.1:${port}` };
  }
  const server = await createServer({
    ...shared,
    server: { port, strictPort: true, host: "127.0.0.1", hmr: false, watch: null },
  });
  await server.listen();
  return { server, origin: `http://127.0.0.1:${port}` };
}

function benchUrl(origin) {
  const query = new URLSearchParams(Object.entries(BENCH_FIXTURE).map(([key, value]) => [key, String(value)]));
  return `${origin}/tools/perf-bench/index.html?${query}`;
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

/** The run with the fewest total counts: noise only ever adds work. */
function bestOf(runs) {
  return runs.reduce((best, run) => (
    GATED.reduce((sum, key) => sum + run[key], 0) < GATED.reduce((sum, key) => sum + best[key], 0) ? run : best
  ));
}

const ceilingFor = (value) => Math.ceil(value + Math.max(HEADROOM_MIN, value * HEADROOM));

function formatTable(results) {
  const rows = [["scenario", "unit", ...GATED.map((key) => `${key}/unit`), "long tasks", "task ms"]];
  for (const { scenario, result } of results) {
    rows.push([
      scenario.name,
      `${scenario.steps} ${scenario.unit}`,
      ...GATED.map((key) => (result[key] / scenario.steps).toFixed(1)),
      String(result.info.longTasks),
      String(result.info.taskMs),
    ]);
  }
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ")).join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const scenarios = options.only ? SCENARIOS.filter((scenario) => options.only.includes(scenario.name)) : SCENARIOS;
  if (!scenarios.length) throw new Error(`No scenario matches ${options.only}`);
  const vite = options.url ? null : await startVite(options.prod);
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
          throw new Error(`${scenario.name}: ${error.message}`);
        } finally {
          if (!options.keepOpen) await page.close();
        }
      }
      const result = bestOf(runs);
      results.push({ scenario, result, runs });
      console.error(`${scenario.name}: ${GATED.map((key) => `${key} ${result[key]}`).join(", ")} (${runs.map((run) => run.recalcs).join("/")} recalcs across runs)`);
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

  const budgets = JSON.parse(readFileSync(BUDGETS, "utf8"));
  const failures = [];
  const slack = [];
  for (const { scenario, result } of results) {
    const ceilings = budgets.scenarios[scenario.name] ??= {};
    for (const key of GATED) {
      const value = result[key];
      const ceiling = ceilings[key];
      if (options.update || ceiling === undefined) ceilings[key] = ceilingFor(value);
      else if (options.ratchet && ceilingFor(value) < ceiling) ceilings[key] = ceilingFor(value);
      else if (value > ceiling) failures.push(`${scenario.name} ${key}: ${value} exceeds ceiling ${ceiling}`);
      else if (ceilingFor(value) < ceiling * 0.8) slack.push(`${scenario.name} ${key}: ${value} is well under ceiling ${ceiling}`);
    }
  }
  if (options.update || options.ratchet) {
    writeFileSync(BUDGETS, `${JSON.stringify(budgets, null, 2)}\n`);
    console.log(`\nWrote ${path.relative(repo, BUDGETS)}.`);
  }
  if (slack.length && !options.ratchet && !options.update) {
    console.log(`\nRoom to ratchet (run with --ratchet to lower these ceilings):\n  ${slack.join("\n  ")}`);
  }
  if (failures.length) {
    console.log(`\nOver budget:\n  ${failures.join("\n  ")}`);
    console.log("\nFind the cause with the per-scenario component table (--json), fix it, or, if the extra work is");
    console.log("intended, raise the ceiling in scripts/perf-bench/budgets.json and say why in the pull request.");
    if (options.check) process.exitCode = 1;
  }
}

await main();
