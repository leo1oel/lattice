#!/usr/bin/env node
/**
 * The real-app measurement lab (docs/driving-the-app.md): builds Lattice with
 * the `perf-lab` Cargo feature and VITE_PERF_LAB=1, then runs it in the real
 * WKWebView window, driven by native input, and collects JSON results.
 * src-tauri/src/perf_lab.rs and src/platform/perf-lab-harness.ts are its two
 * halves.
 *
 * Every lab lives in /Users/Shared/lattice-tests/<task>/ under its own bundle
 * identifier, app.latticetest.<task>, and only ever runs as the `latticetest`
 * account (`sudo -n -u latticetest`) on its own port: never as the console
 * user, never as the shipped app, never on 18452.
 *
 * Usage (node scripts/perf-lab.mjs …):
 *   build <task> [--reuse-runtimes] [--as SUFFIX]
 *       Build one bundle and stage it as LatticeLabWK<SUFFIX>.app.
 *       --reuse-runtimes skips `pnpm prepare:build`'s runtime staging (no
 *       Synara checkout needed when src-tauri/{synara,presentation}-runtime
 *       are already staged). --as stages a second build beside the first,
 *       e.g. main for a baseline.
 *   fixture <task> <project-dir> [--name NAME]
 *       Copy a project in as fixture NAME (default "base"). Every run starts
 *       from a fresh copy of it.
 *   state save <task>
 *       Snapshot the app state (settings, WebKit data, caches) after a
 *       warm-up run; every later run restores it first.
 *   run <task> <variant> <run-id> [--startup | --scenarios a,b | --plan JSON]
 *       [--fixture NAME] [--flags a,b] [--timeout S] [--port N]
 *       Launch the variant (wk, or wk<SUFFIX> for an --as build), run the plan,
 *       write results/<variant>-run<run-id>.json and .mem.txt, and quit it.
 *   host <task> [--variant V] [--fixture NAME] [--port N]
 *       Serve the real app (no window, fixture open) to a browser at
 *       http://127.0.0.1:<port>/ for driving with playwright-core, until Ctrl-C.
 *   compare <task> <variant-a> <variant-b> [--runs PREFIX] [--json FILE]
 *       Median of each metric per variant, with a parity verdict for A
 *       against B (A within 10% of B, latency within a 120 Hz frame).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capture, isMain, projectRoot, run } from "./lib/util.mjs";

const LAB_ROOT = "/Users/Shared/lattice-tests";
const LAB_USER = "latticetest";
const LAB_HOME = `/Users/${LAB_USER}`;
const LAB_NAME = "LatticeLab";
// The shipped app's fixed browser-host port; a lab must never take it.
const REAL_APP_PORT = 18452;

export function labFor(task) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(task ?? "")) {
    throw new Error(`task must be lowercase letters, digits and dashes, got ${JSON.stringify(task)}`);
  }
  const identifier = `app.latticetest.${task}`;
  return { task, identifier, dir: join(LAB_ROOT, task), port: defaultPort(task) };
}

// One stable port per task, clear of the real app (18452), the test builds
// (18462, 18472) and perf:bench --serve (18480), so two labs rarely collide;
// `run` still refuses a busy port.
export function defaultPort(task) {
  let hash = 2166136261;
  for (const character of task) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return 18500 + (hash % 400);
}

export function parseVariant(variant) {
  const match = /^wk([a-z0-9]*)$/.exec(variant ?? "");
  if (!match) throw new Error(`variant must be wk plus an optional --as suffix, got ${JSON.stringify(variant)}`);
  return { variant, suffix: match[1] };
}

const bundlePath = (lab, suffix = "") => join(lab.dir, `${LAB_NAME}WK${suffix}.app`);

/** The directories the lab app's state lives in, as the lab account sees them. */
export function statePaths(lab) {
  const library = `${LAB_HOME}/Library`;
  return [
    `${library}/Application Support/${lab.identifier}`,
    `${library}/WebKit/${lab.identifier}.wk`,
    `${library}/Caches/${lab.identifier}`,
    `${library}/Caches/${lab.identifier}.wk`,
  ];
}

/** `tauri build --config` overrides: an isolated identifier and no update traffic. */
export function buildConfig(lab, reuseRuntimes) {
  return {
    identifier: lab.identifier,
    productName: LAB_NAME,
    ...(reuseRuntimes ? { build: { beforeBuildCommand: "pnpm build" } } : {}),
    bundle: { createUpdaterArtifacts: false },
    plugins: { updater: { endpoints: ["https://127.0.0.1:9/latest.json"] } },
  };
}

function asLabUser(command, args, options = {}) {
  return run("sudo", ["-n", "-u", LAB_USER, command, ...args], options);
}

// The lab account's home need not be readable by the console user.
function existsForLabUser(path) {
  try {
    capture("sudo", ["-n", "-u", LAB_USER, "test", "-e", path]);
    return true;
  } catch {
    return false;
  }
}

function labDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o777 });
  // The lab account writes results, traces and working copies here.
  run("chmod", ["a+rwx", path]);
}

function build(lab, { reuseRuntimes, suffix = "" }) {
  const config = JSON.parse(readFileSync(join(projectRoot, "src-tauri/tauri.conf.json"), "utf8"));
  if (lab.identifier === config.identifier) throw new Error("a lab must not use the shipped identifier");
  run("pnpm", ["tauri", "build", "--bundles", "app", "--features", "perf-lab",
    "--config", JSON.stringify(buildConfig(lab, reuseRuntimes))], {
    cwd: projectRoot,
    env: { ...process.env, VITE_PERF_LAB: "1" },
  });
  const built = join(projectRoot, `src-tauri/target/release/bundle/macos/${LAB_NAME}.app`);
  for (const path of [lab.dir, join(lab.dir, "results"), join(lab.dir, "logs"), join(lab.dir, "work")]) labDirectory(path);
  const app = bundlePath(lab, suffix);
  run("rm", ["-rf", app]);
  run("ditto", [built, app]);
  // The WebKit data and caches keep the `.wk` suffix earlier labs used, so
  // a saved state still restores.
  run("/usr/libexec/PlistBuddy", ["-c", `Set :CFBundleIdentifier ${lab.identifier}.wk`, join(app, "Contents/Info.plist")]);
  run("codesign", ["--force", "--sign", "-", app]);
  run("chmod", ["-R", "a+rX", app]);
  console.log(`staged ${app}`);
}

function fixture(lab, source, name) {
  if (!existsSync(join(source, "main.tex"))) throw new Error(`${source} has no main.tex`);
  // The harness waits for the PDF preview at startup; a lab run never compiles.
  if (!existsSync(join(source, "main.pdf"))) console.warn(`warning: ${source} has no main.pdf; compile main.tex first`);
  labDirectory(join(lab.dir, "fixtures"));
  const target = join(lab.dir, "fixtures", name);
  run("rsync", ["-a", "--delete", `${source}/`, `${target}/`]);
  run("chmod", ["-R", "a+rX", target]);
  console.log(`fixture ${name}: ${target}`);
}

function saveState(lab) {
  statePaths(lab).forEach((path, index) => {
    const snapshot = join(lab.dir, "state", "wk", String(index));
    asLabUser("mkdir", ["-p", snapshot]);
    if (existsForLabUser(path)) asLabUser("/usr/bin/rsync", ["-a", "--delete", `${path}/`, `${snapshot}/`]);
  });
  console.log(`saved state under ${join(lab.dir, "state", "wk")}`);
}

function restoreState(lab) {
  statePaths(lab).forEach((path, index) => {
    const snapshot = join(lab.dir, "state", "wk", String(index));
    if (!existsSync(snapshot)) return;
    asLabUser("mkdir", ["-p", path]);
    asLabUser("/usr/bin/rsync", ["-a", "--delete", `${snapshot}/`, `${path}/`]);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quiet = (command, args) => {
  try {
    return capture(command, args);
  } catch {
    return "";
  }
};

function portBusy(port) {
  return quiet("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]).trim() !== "";
}

// Lab apps under `root`: one task's directory, or LAB_ROOT for every task's.
const labProcesses = (root) => quiet("pgrep", ["-U", LAB_USER, "-f", `${root}/.*${LAB_NAME}`]).trim();
const labUserPids = () => new Set(quiet("ps", ["-U", LAB_USER, "-o", "pid="]).split("\n").map((pid) => pid.trim()).filter(Boolean));

export function runPlan(options, runId, label) {
  if (options.plan) return { ...JSON.parse(options.plan), run: runId, label };
  if (options.startup) return { scenarios: [], run: runId, label, startupOnly: true };
  const scenarios = (options.scenarios ?? "").split(",").filter(Boolean);
  if (!scenarios.length) throw new Error("run needs --startup, --scenarios a,b or --plan JSON");
  return { scenarios, run: runId, label };
}

// Checks shared by `run` and `host`, then a fresh working copy of the fixture
// and the variant's saved state. Returns what the launch needs.
function prepareLaunch(lab, variantName, options) {
  const { variant, suffix } = parseVariant(variantName);
  const port = Number(options.port ?? lab.port);
  if (port === REAL_APP_PORT) throw new Error(`port ${REAL_APP_PORT} belongs to the real Lattice`);
  const app = bundlePath(lab, suffix);
  const binary = join(app, "Contents/MacOS/research-writer");
  if (!existsSync(binary)) throw new Error(`${app} is missing; run build first`);
  const fixtureName = options.fixture ?? "base";
  const fixtureSource = join(lab.dir, "fixtures", fixtureName);
  if (!existsSync(fixtureSource)) throw new Error(`no fixture ${fixtureName}; run fixture first`);
  if (portBusy(port)) throw new Error(`port ${port} is busy`);
  // Two labs at once would measure each other, whichever task they belong to.
  if (labProcesses(LAB_ROOT)) throw new Error(`a lab app is already running as ${LAB_USER}`);

  restoreState(lab);
  const project = join(lab.dir, "work", "wk");
  asLabUser("/usr/bin/rsync", ["-a", "--delete", `${fixtureSource}/`, `${project}/`]);
  const environment = {
    HOME: LAB_HOME, USER: LAB_USER, LOGNAME: LAB_USER, LANG: "en_US.UTF-8",
    PATH: "/Library/TeX/texbin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
    LATTICE_LAB_ID: lab.identifier,
    LATTICE_PERF_PROJECT: project,
    LATTICE_PERF_PORT: String(port),
  };
  return { variant, binary, port, environment };
}

/** Start `binary` as the lab account with exactly `environment`, output to `log`. */
function launch(binary, environment, args, log) {
  // LATTICE_PERF_T0 is stamped inside the lab account's shell right before
  // exec, so startup marks exclude sudo's own start-up.
  const launcher = 'LATTICE_PERF_T0=$(/usr/bin/perl -MTime::HiRes=time -e "printf q(%.1f), time*1000"); export LATTICE_PERF_T0; log=$1; shift; exec "$0" "$@" >"$log" 2>&1';
  const child = spawn("sudo", ["-n", "-u", LAB_USER, "-H", "env", "-i",
    ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
    "/bin/sh", "-c", launcher, binary, log, ...args], { stdio: "ignore", detached: true });
  child.unref();
}

async function runOnce(lab, variantName, runId, options) {
  const { variant, binary, environment } = prepareLaunch(lab, variantName, options);
  const results = join(lab.dir, "results");
  const stem = `${variant}-run${runId}`;
  run("rm", ["-f", join(results, `${stem}.done`), join(results, `${stem}.json`)]);
  const plan = runPlan(options, runId, variant);
  const before = labUserPids();
  const log = join(lab.dir, "logs", `${stem}.log`);
  launch(binary, {
    ...environment,
    LATTICE_PERF_PLAN: JSON.stringify(plan),
    LATTICE_PERF_LABEL: variant,
    LATTICE_PERF_OUT: results,
    // The lab account's windows are never composited on the console user's
    // screen; without these WebKit throttles as if hidden.
    LATTICE_WK_NOOCC: "1",
    LATTICE_WK_FEATURES_OFF: "PageVisibilityBasedProcessSuppressionEnabled,BackgroundWebContentRunningBoardThrottlingEnabled",
    ...(options.flags ? { LATTICE_LAB_FLAGS: options.flags } : {}),
  }, [], log);

  const timeout = Number(options.timeout ?? (plan.startupOnly ? 200 : 600)) * 1000;
  const started = Date.now();
  let status = "timeout";
  while (Date.now() - started < timeout) {
    if (existsSync(join(results, `${stem}.done`))) {
      status = "done";
      break;
    }
    if (Date.now() - started > 8000 && !quiet("pgrep", ["-U", LAB_USER, "-f", binary]).trim()) {
      status = "exited";
      break;
    }
    await sleep(1000);
  }
  await sleep(3000);
  writeFileSync(join(results, `${stem}.mem.txt`), memoryReport(before));
  console.log(`${stem}: status=${status} elapsed=${Math.round((Date.now() - started) / 1000)}s log=${log}`);
  await stopLab(lab);
  return status;
}

// The real app with no window of its own, serving its workspace to any browser
// on the lab port, the fixture already open. For driving with playwright-core.
async function host(lab, options) {
  const { binary, port, environment } = prepareLaunch(lab, options.variant ?? "wk", options);
  const log = join(lab.dir, "logs", "host.log");
  launch(binary, environment, ["--browser-host"], log);
  const url = `http://127.0.0.1:${port}/`;
  for (let waited = 0; !portBusy(port); waited += 1) {
    if (waited > 60) {
      await stopLab(lab);
      throw new Error(`the host never listened on ${port}; see ${log}`);
    }
    await sleep(1000);
  }
  console.log(`serving ${url} (log ${log}); Ctrl-C stops it`);
  await new Promise((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, resolve);
  });
  await stopLab(lab);
}

// Every lab-account process the launch created: pid, RSS (KiB), physical
// footprint and its peak, then parent pid and command line.
function memoryReport(before) {
  const lines = [];
  for (const pid of labUserPids()) {
    if (before.has(pid)) continue;
    const rss = quiet("ps", ["-o", "rss=", "-p", pid]).trim();
    const command = quiet("ps", ["-o", "ppid=,args=", "-p", pid]).trim().slice(0, 300);
    const footprint = quiet("sudo", ["-n", "-u", LAB_USER, "/usr/bin/footprint", "-p", pid]);
    const field = (name) => new RegExp(`${name}:\\s+(\\S+)\\s+(\\S+)`).exec(footprint)?.slice(1).join("") ?? "";
    lines.push([pid, rss, field("phys_footprint"), field("phys_footprint_peak"), command].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

async function stopLab(lab) {
  const pattern = join(lab.dir, LAB_NAME);
  quiet("sudo", ["-n", "-u", LAB_USER, "/usr/bin/pkill", "-TERM", "-U", LAB_USER, "-f", pattern]);
  for (let attempt = 0; attempt < 6 && labProcesses(lab.dir); attempt += 1) await sleep(1000);
  quiet("sudo", ["-n", "-u", LAB_USER, "/usr/bin/pkill", "-KILL", "-U", LAB_USER, "-f", pattern]);
  await sleep(1000);
}

// The comparison rows: [label, scenario (or @startup mark), path into its result, kind].
// Kinds: fps (higher is better), lat (latency ms), dur (duration ms), count
// (lower is better), share (fraction of frames). Scenario names and result
// shapes are src/platform/perf-lab-harness.ts's.
const ROWS = [
  ["Rendering rate when idle (fps)", "idle", ["fps"], "fps"],
  ["Startup → editable main.tex (ms)", "@editable", null, "dur"],
  ["Startup → first PDF page painted (ms)", "@pdfPage", null, "dur"],
  ["LaTeX typing keydown→paint p50 (ms)", "latexTyping", ["keydownToNextPaint", "p50"], "lat"],
  ["LaTeX typing keydown→paint p95 (ms)", "latexTyping", ["keydownToNextPaint", "p95"], "lat"],
  ["LaTeX typing + 20 Hz remote edits p50 (ms)", "liveEdit", ["keydownToNextPaint", "p50"], "lat"],
  ["LaTeX typing + 20 Hz remote edits p95 (ms)", "liveEdit", ["keydownToNextPaint", "p95"], "lat"],
  ["Remote-edit event delivery Rust→page p50 (ms)", "liveEdit", ["remoteDelivery", "p50"], "lat"],
  ["Markdown source 2 MB typing p50 (ms)", "markdownSourceTyping", ["keydownToNextPaint", "p50"], "lat"],
  ["Markdown source 2 MB typing p95 (ms)", "markdownSourceTyping", ["keydownToNextPaint", "p95"], "lat"],
  ["Markdown visual 2 MB typing p50 (ms)", "markdownVisualTyping", ["keydownToNextPaint", "p50"], "lat"],
  ["Markdown visual 2 MB typing p95 (ms)", "markdownVisualTyping", ["keydownToNextPaint", "p95"], "lat"],
  ["Scroll the main PDF (fps)", "pdfScroll", ["frames", "fps"], "fps"],
  ["Scroll the main PDF longest frame (ms)", "pdfScroll", ["frames", "longestMs"], "lat"],
  ["Scroll the main PDF blank frames", "pdfScroll", ["blankFrames"], "count"],
  ["Pinch-zoom the PDF (fps)", "pdfZoomPinch", ["in", "frames", "fps"], "fps"],
  ["Pinch-zoom settle after gesture (ms)", "pdfZoomPinch", ["in", "settledAfterInputMs"], "dur"],
  ["Ctrl-wheel zoom the PDF (fps)", "pdfZoomCtrlWheel", ["in", "frames", "fps"], "fps"],
  ["Ctrl-wheel zoom longest frame (ms)", "pdfZoomCtrlWheel", ["in", "frames", "longestMs"], "lat"],
  ["Open reference.pdf → first page (ms)", "pdfOpen", ["firstCanvasMs"], "dur"],
  ["Hide a panel (fps)", "panelsEarly", ["Papers", "hide", "frames", "fps"], "fps"],
  ["Hide a panel longest frame (ms)", "panelsEarly", ["Papers", "hide", "frames", "longestMs"], "lat"],
  ["Show a panel (fps)", "panelsEarly", ["Papers", "show", "frames", "fps"], "fps"],
  ["Drag a panel divider (fps)", "panelsEarly", ["resize", "frames", "fps"], "fps"],
  ["Drag a panel divider longest frame (ms)", "panelsEarly", ["resize", "frames", "longestMs"], "lat"],
  ["Command palette ⌘⇧P open→painted (ms)", "dialogsEarly", ["palette", "shownMs"], "lat"],
  ["Command palette entrance (fps)", "dialogsEarly", ["palette", "frames", "fps"], "fps"],
  ["Settings ⌘, open→painted (ms)", "dialogsEarly", ["settings", "shownMs"], "lat"],
  ["Agent panel open (fps)", "agentOpen", ["frames", "fps"], "fps"],
  ["long.tex open→editable (ms)", "longTex", ["openMs"], "dur"],
  ["long.tex fast scroll (fps)", "longTex", ["fling", "frames", "fps"], "fps"],
  ["long.tex fast scroll longest frame (ms)", "longTex", ["fling", "frames", "longestMs"], "lat"],
  ["long.tex typing p50 (ms)", "longTex", ["typing", "keydownToNextPaint", "p50"], "lat"],
  ["long.tex typing p95 (ms)", "longTex", ["typing", "keydownToNextPaint", "p95"], "lat"],
  ["large.md visual open→filled (ms)", "longMarkdown", ["openMs"], "dur"],
  ["large.md visual fast scroll (fps)", "longMarkdown", ["fling", "frames", "fps"], "fps"],
  ["large.md visual fast scroll frames >50 ms", "longMarkdown", ["fling", "frames", "over50ms"], "count"],
  ["large.md visual fast scroll longest frame (ms)", "longMarkdown", ["fling", "frames", "longestMs"], "lat"],
  ["huge.pdf open→first page (ms)", "hugePdf", ["firstCanvasMs"], "dur"],
  ["huge.pdf fast scroll (fps)", "hugePdf", ["fling", "frames", "fps"], "fps"],
  ["huge.pdf fast scroll blank-frame share", "hugePdf", ["fling", "blankFrameShare"], "share"],
  ["huge.pdf jump to 70% → painted (ms)", "hugePdf", ["jumpPaintedMs"], "dur"],
  ["huge.pdf ctrl-wheel zoom (fps)", "hugePdf", ["zoom", "frames", "fps"], "fps"],
  ["huge.pdf ctrl-wheel zoom longest frame (ms)", "hugePdf", ["zoom", "frames", "longestMs"], "lat"],
  ["images.pdf open→first page (ms)", "imagePdf", ["firstCanvasMs"], "dur"],
  ["images.pdf fast scroll (fps)", "imagePdf", ["fling", "frames", "fps"], "fps"],
  ["images.pdf fast scroll blank-frame share", "imagePdf", ["fling", "blankFrameShare"], "share"],
  ["images.pdf fast scroll longest blank run (frames)", "imagePdf", ["fling", "longestBlankRun"], "count"],
  ["images.pdf zoom (fps)", "imagePdf", ["zoom", "frames", "fps"], "fps"],
  ["images.pdf zoom repaint after input (ms)", "imagePdf", ["zoom", "paintedAfterInputMs"], "dur"],
  ["Command palette, long Markdown open (ms)", "dialogs", ["palette", "shownMs"], "lat"],
  ["Settings, long Markdown open (ms)", "dialogs", ["settings", "shownMs"], "lat"],
  ["Hide a panel, long Markdown open (fps)", "panels", ["Papers", "hide", "frames", "fps"], "fps"],
  ["Drag a panel divider, long Markdown open (fps)", "panels", ["resize", "frames", "fps"], "fps"],
  ["Scroll the main PDF, long Markdown open (fps)", "pdfScrollHeavy", ["frames", "fps"], "fps"],
  ["Ctrl-wheel zoom the PDF, long Markdown open (fps)", "pdfZoomCtrlWheelHeavy", ["in", "frames", "fps"], "fps"],
];
const FRAME_MS = 1000 / 120;

const dig = (value, path) => path.reduce((current, key) => (current && typeof current === "object" ? current[key] : undefined), value);
const median = (values) => {
  const numbers = values.filter((value) => typeof value === "number").sort((a, b) => a - b);
  if (!numbers.length) return null;
  const middle = numbers.length >> 1;
  const result = numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
  return Math.round(result * 10) / 10;
};

function loadRuns(lab, variant, prefix) {
  const results = join(lab.dir, "results");
  const pattern = new RegExp(`^${variant}-run(${prefix}[\\w]*)\\.json$`);
  return readdirSync(results).flatMap((name) => {
    const runId = pattern.exec(name)?.[1];
    if (!runId || !existsSync(join(results, `${variant}-run${runId}.done`))) return [];
    const result = JSON.parse(readFileSync(join(results, name), "utf8"));
    return [{ ...result, runId }];
  });
}

export function metric(result, [, scenario, path]) {
  if (scenario.startsWith("@")) return result.marks?.[scenario.slice(1)] ?? null;
  const data = result.scenarios?.[scenario];
  // A drag that did not move the divider measured nothing.
  if (path[0] === "resize" && (data?.resizeMaxShiftPx ?? 0) < 200) return null;
  return dig(data, path) ?? null;
}

export function verdict(kind, a, b, frames) {
  if (a === null || b === null) return "n/a";
  const pass = {
    fps: () => a >= 0.9 * b,
    lat: () => a - b <= Math.max(2, 0.1 * b) && a - b <= FRAME_MS,
    dur: () => a <= 1.1 * b,
    count: () => a <= b + 1,
    share: () => frames === null || (a - b) * frames <= 1,
  }[kind]();
  return pass ? "pass" : "FAIL";
}

function compare(lab, variantA, variantB, { runs: prefix = "", json }) {
  const sides = [variantA, variantB].map((variant) => ({
    variant, runs: loadRuns(lab, parseVariant(variant).variant, prefix),
  }));
  const rows = ROWS.map((row) => {
    const [label, scenario, , kind] = row;
    const [a, b] = sides.map((side) => {
      const values = side.runs.map((result) => metric(result, row));
      return { median: median(values), n: values.filter((value) => value !== null).length };
    });
    const frames = kind === "share"
      ? median(sides[0].runs.map((result) => dig(result.scenarios?.[scenario], ["fling", "frames", "frames"])))
      : null;
    return { row: label, kind, [variantA]: a.median, [variantB]: b.median, n: [a.n, b.n], verdict: verdict(kind, a.median, b.median, frames) };
  }).filter((row) => row.n[0] || row.n[1]);
  const errors = Object.fromEntries(sides.map((side) => [side.variant, side.runs.flatMap((result) => (result.errors ?? []).map((error) => `${result.runId}: ${error}`))]));
  for (const row of rows) {
    console.log(`${row.verdict.padEnd(4)}  ${row.row.padEnd(52)} ${variantA} ${String(row[variantA]).padStart(8)}  ${variantB} ${String(row[variantB]).padStart(8)}  n=${row.n.join("/")}`);
  }
  console.log(`runs: ${sides.map((side) => `${side.variant} ${side.runs.length}`).join(", ")}`);
  for (const [variant, list] of Object.entries(errors)) if (list.length) console.log(`${variant} errors:\n  ${list.join("\n  ")}`);
  const failing = rows.filter((row) => row.verdict === "FAIL").map((row) => row.row);
  console.log(`failing: ${failing.length ? failing.join("; ") : "none"}`);
  if (json) writeFileSync(json, `${JSON.stringify({ rows, errors, failing }, null, 1)}\n`);
}

function parseArguments(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const name = argument.slice(2).replace(/-(\w)/g, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (["reuseRuntimes", "startup"].includes(name) || next === undefined || next.startsWith("--")) options[name] = true;
    else options[name] = argv[(index += 1)];
  }
  return { positional, options };
}

async function main() {
  const { positional: [command, ...rest], options } = parseArguments(process.argv.slice(2));
  const usage = () => {
    console.error(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].split("Usage")[1]);
    process.exit(2);
  };
  if (command === "build") build(labFor(rest[0]), { reuseRuntimes: options.reuseRuntimes, suffix: options.as ?? "" });
  else if (command === "fixture" && rest[1]) fixture(labFor(rest[0]), rest[1], options.name ?? "base");
  else if (command === "state" && rest[0] === "save") saveState(labFor(rest[1]));
  else if (command === "run" && rest[2]) {
    const status = await runOnce(labFor(rest[0]), rest[1], rest[2], options);
    process.exitCode = status === "done" ? 0 : 1;
  } else if (command === "host" && rest[0]) await host(labFor(rest[0]), options);
  else if (command === "compare" && rest[2]) compare(labFor(rest[0]), rest[1], rest[2], options);
  else usage();
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
