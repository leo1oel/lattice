#!/usr/bin/env node
/**
 * `node scripts/gpui-main-baseline.mjs`: records what is already red on a main
 * commit, so a validation run on a branch can tell a failure it caused from
 * one it inherited, without building and running main itself.
 *
 * Every lane's test step re-proved the same red main: knip's unused exports
 * and two Settings e2e steps failed for every branch at once, and three lanes
 * each spent a test round and a needs-decision on them while a fourth re-ran
 * the whole e2e on main to show they were pre-existing. This runs those
 * checks once per merge instead, in a checkout of main:
 *
 *   1. `pnpm gate:changed --base <sha>`, which on main itself runs the stages
 *      that always run (lint with the warning cap, knip, typecheck and the
 *      invariant tests);
 *   2. the release build with `offscreen-shots` through
 *      `scripts/gpui-build.mjs`, under the machine-wide build lock;
 *   3. the full `e2e` scenario through `gpui/script/e2e`, on a scratch copy of
 *      `gpui/fixtures/e2e` with a scratch HOME, taking the machine-wide input
 *      lock around its foreground steps as every run does.
 *
 * and writes, into the shared baseline directory
 * (`$LATTICE_GPUI_BUILD_DIR/main-baseline`, by default
 * ~/Library/Caches/lattice-gpui-build/main-baseline on macOS):
 *
 *   known-failures@<sha>.json  the failing gate stages and e2e step names
 *                              (the quarantined ones among them listed again), the
 *                              build's outcome, and how long each part took;
 *   e2e@<sha>.json             the scenario's whole result;
 *   logs@<sha>/                each part's full output;
 *   latest.json                the newest commit's known-failures record, with
 *                              `file` naming it; it moves only forward, to a
 *                              commit that descends from the one it names.
 *
 * A step whose name is in `e2e.failing` (or a gate stage in `gate.failing`)
 * for the merge base of a branch is pre-existing on main.
 *
 * It refuses a checkout with uncommitted or untracked files, since the build
 * mirrors them and the record would no longer be of the commit. With
 * `--sha REF` it first checks REF out (detached) and installs the frontend's
 * dependencies; without it, it records HEAD.
 *
 * Options:
 *   --sha REF    record REF instead of HEAD (fetches origin first)
 *   --out DIR    write into DIR instead of the shared baseline directory
 *   --skip-e2e   record the gate and the build only
 */
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

function parseArgs(argv) {
  const options = { sha: null, out: null, e2e: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--sha") options.sha = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--skip-e2e") options.e2e = false;
    else throw new Error(`unknown option ${arg}`);
  }
  return options;
}

export function baselineDir(env = process.env) {
  const root = env.LATTICE_GPUI_BUILD_DIR || (process.platform === "darwin" ? path.join(os.homedir(), "Library", "Caches", "lattice-gpui-build") : path.join(os.homedir(), ".cache", "lattice-gpui-build"));
  return path.join(root, "main-baseline");
}

/** The gate's stage lines: `  <name>  <verdict>  ...`, as gate-changed.mjs prints them. */
export function parseGate(output) {
  const stages = [];
  for (const line of output.split("\n")) {
    const match = /^ {2}(\S+)\s+(ok|FAILED|TIMED OUT after \d+ s|skipped)\s+(?:(\d+(?:\.\d+)?) s)?/.exec(line);
    if (!match) continue;
    stages.push({ name: match[1], verdict: match[2] === "ok" || match[2] === "skipped" ? match[2] : "failed", detail: match[2], seconds: match[3] ? Number(match[3]) : null });
  }
  return stages;
}

/** The failing steps of an e2e result, by name. */
export function parseE2e(result) {
  if (!result) return { passed: false, total: 0, failing: [], error: "no result was written" };
  if (result.error) return { passed: false, total: 0, failing: [], error: String(result.error) };
  const steps = Array.isArray(result.steps) ? result.steps : [];
  return {
    passed: result.passed === true,
    total: steps.length,
    failing: steps.filter((step) => step.passed !== true).map((step) => step.step),
  };
}

/** Runs a command, teeing its output to the terminal and to `log`; resolves with its status and output. */
function run(command, args, { log, cwd = repo, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const file = createWriteStream(log);
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    for (const stream of [child.stdout, child.stderr]) {
      stream.on("data", (chunk) => {
        (stream === child.stdout ? process.stdout : process.stderr).write(chunk);
        file.write(chunk);
        output += chunk.toString("utf8");
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      file.end();
      resolve({ status: timedOut ? "timed out" : code === 0 ? "ok" : "failed", code, seconds: Math.round((Date.now() - started) / 1000), output });
    });
  });
}

function writeJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

function isAncestor(older, newer) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", older, newer], { cwd: repo, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dirty = git("status", "--porcelain", "--untracked-files=normal");
  if (dirty) throw new Error(`${repo} has uncommitted or untracked files; run this in a clean checkout of main`);
  if (options.sha) {
    execFileSync("git", ["fetch", "--quiet", "origin"], { cwd: repo, stdio: "inherit" });
    execFileSync("git", ["checkout", "--quiet", "--detach", options.sha], { cwd: repo, stdio: "inherit" });
    execFileSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], { cwd: repo, stdio: "inherit" });
  }
  const sha = git("rev-parse", "HEAD");
  const out = options.out ? path.resolve(options.out) : baselineDir();
  const logs = path.join(out, `logs@${sha}`);
  mkdirSync(logs, { recursive: true });
  const started = new Date();
  console.log(`gpui-main-baseline: ${sha.slice(0, 9)} ${git("log", "-1", "--format=%s", sha)} -> ${out}`);

  const gateRun = await run("pnpm", ["gate:changed", "--base", sha], { log: path.join(logs, "gate.log"), timeoutMs: 45 * 60_000 });
  const stages = parseGate(gateRun.output);
  const gate = { status: gateRun.status, seconds: gateRun.seconds, failing: stages.filter((stage) => stage.verdict === "failed").map((stage) => stage.name), stages };

  const buildRun = await run("node", ["scripts/gpui-build.mjs"], { log: path.join(logs, "build.log"), timeoutMs: 90 * 60_000 });
  const build = { status: buildRun.status, seconds: buildRun.seconds };

  let e2e = { status: "not run", reason: options.e2e ? "the build failed" : "--skip-e2e" };
  if (options.e2e && buildRun.status === "ok") {
    const resultFile = path.join(out, `e2e@${sha}.json`);
    const e2eRun = await run(path.join(repo, "gpui", "script", "e2e"), [resultFile], { log: path.join(logs, "e2e.log"), timeoutMs: 60 * 60_000 });
    let result = null;
    try {
      result = JSON.parse(readFileSync(resultFile, "utf8"));
    } catch {
      // Missing or cut short; parseE2e records that.
    }
    const parsed = parseE2e(result);
    // The quarantined steps (gpui-e2e-quarantine.json) main fails too, which
    // a branch's light pass then counts as pre-existing.
    let quarantine = [];
    try {
      quarantine = JSON.parse(readFileSync(path.join(repo, "scripts", "gpui-e2e-quarantine.json"), "utf8")).steps;
    } catch {
      // A commit from before the quarantine list.
    }
    parsed.quarantined_failing = parsed.failing.filter((step) => quarantine.includes(step));
    e2e = { status: e2eRun.status, seconds: e2eRun.seconds, ...parsed, result: existsSync(resultFile) ? path.basename(resultFile) : null };
    // script/e2e also checks after the app quits that the typed text was saved.
    if (e2eRun.status !== "ok" && parsed.passed) e2e.after_quit = e2eRun.output.split("\n").filter((line) => line.startsWith("e2e:")).join("\n");
  }

  const record = {
    sha,
    subject: git("log", "-1", "--format=%s", sha),
    committed: git("log", "-1", "--format=%cI", sha),
    started: started.toISOString(),
    finished: new Date().toISOString(),
    host: os.hostname(),
    green: gate.status === "ok" && build.status === "ok" && (e2e.status === "ok" || !options.e2e),
    gate,
    build,
    e2e,
    logs: path.basename(logs),
  };
  const file = path.join(out, `known-failures@${sha}.json`);
  writeJson(file, record);

  const latestFile = path.join(out, "latest.json");
  let latest = null;
  try {
    latest = JSON.parse(readFileSync(latestFile, "utf8"));
  } catch {
    // None yet.
  }
  if (!latest?.sha || latest.sha === sha || isAncestor(latest.sha, sha)) writeJson(latestFile, { ...record, file: path.basename(file) });
  else console.log(`gpui-main-baseline: latest.json stays at ${latest.sha.slice(0, 9)}, which ${sha.slice(0, 9)} does not descend from`);

  console.log(`gpui-main-baseline: ${record.green ? "green" : "red"}: gate failing [${gate.failing.join(", ")}], build ${build.status}, e2e ${e2e.status}${e2e.failing?.length ? ` failing ${e2e.failing.length}/${e2e.total}` : ""}`);
  console.log(`gpui-main-baseline: ${file}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(`gpui-main-baseline: ${error.message}`);
    process.exit(1);
  });
}
