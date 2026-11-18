#!/usr/bin/env node
/**
 * `pnpm ci:local`: the CI tier for this branch, run on this Mac before a push.
 *
 * It asks scripts/ci-tier.mjs which CI jobs the branch's change needs, against
 * its merge base with origin/main (committed, uncommitted and untracked files,
 * as `pnpm gate:changed` reads them), prints that plan, and runs the local
 * stages that stand for those jobs, built by `pnpm gate:changed` and
 * `pnpm signoff`:
 *
 *   vitest, lint-build   the gate: lint, knip, tsc, i18n, perf evidence,
 *                        notices, rustfmt and the related Vitest tests (or,
 *                        for a Rust-only change, just the tests that read the
 *                        changed Rust sources)
 *   perf-bench           the production build's WebKit check and startup
 *                        budgets, and the bench harness when it changed
 *   rust                 rustfmt, clippy with warnings denied and `cargo test`
 *                        on the changed Tauri crates
 *   perf-bench           also the WebKit benchmark against its ceilings, as
 *                        CI's macOS perf-bench-webkit shards run it
 *   gpui                 rustfmt, the release build, the unit tests and the
 *                        whole e2e scenario, judged like CI's against
 *                        scripts/gpui-e2e-known-failures.json and against a
 *                        run of the merge base on this Mac: when this
 *                        machine's main baseline has no record for it
 *                        (scripts/gpui-main-baseline.mjs), it records one
 *                        first, in a scratch worktree of the merge base
 *
 * The literature Worker, the Open Slide runtime, the research environment, the
 * Chromium benchmark, Linux and Windows run only in CI.
 *
 * Every Rust and GPUI stage waits while a perf measurement holds
 * /tmp/lattice-inapp-test.lock, and compiles in the machine's shared build
 * tree under its build lock (scripts/gpui-build.mjs).
 *
 * When every stage passes and the change needed the macOS Rust or GPUI jobs,
 * it prints a `CI-local: macos <tree>` trailer for the commit. Pushed on a
 * commit whose tree is that one, it lets CI skip its macOS jobs (Rust, GPUI and
 * the WebKit benchmark); Linux and Windows still run.
 *
 * Options:
 *   --base REF   compare against REF instead of origin/main (its merge base)
 *   --full       every stage, whatever changed
 *   --plan       print the plan only
 *   --headless   skip the stages that open windows (the GPUI e2e, its main
 *                baseline and the WebKit benchmark), for a Mac someone is
 *                using; it prints no trailer, so run it whole on a Mac that
 *                may open windows before pushing
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { JOBS, ciTier } from "./ci-tier.mjs";
import { changedFiles, gateStages, runStages } from "./gate-changed.mjs";
import { readBaseline } from "./gpui-e2e-light.mjs";
import { baselineDir } from "./gpui-main-baseline.mjs";
import { isMain } from "./lib/util.mjs";
import { extraStages } from "./signoff.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const PERF_LOCK = "/tmp/lattice-inapp-test.lock";
const WINDOWED = new Set(["gpui-main", "gpui-e2e", "webkit-bench"]);

const LOCAL = {
  vitest: "gate (vitest related + invariants)",
  "lint-build": "gate (lint, knip, tsc, i18n, notices, perf evidence)",
  "perf-bench": "bundle budgets, harness, WebKit benchmark; Chromium in CI only",
  rust: "rustfmt, clippy -D warnings, cargo test",
  gpui: "rustfmt, release build, unit tests, e2e against known failures and local main",
  "literature-worker": "CI only",
  "open-slide-runtime": "CI only",
  "research-env": "CI only",
  "synara-pin": "check-synara-pin",
};

/** Whether a perf measurement holds the lock: lockf takes it for an instant only when it is free. */
function perfLockHeld() {
  if (process.platform !== "darwin" || !existsSync(PERF_LOCK)) return false;
  return spawnSync("/usr/bin/lockf", ["-k", "-t", "0", PERF_LOCK, "true"], { stdio: "ignore" }).status !== 0;
}

async function waitForPerfLock() {
  for (let checks = 0; perfLockHeld(); checks += 1) {
    if (checks % 4 === 0) console.log(`  waiting: a perf measurement holds ${PERF_LOCK} (${checks / 4} min so far)`);
    await sleep(15_000);
  }
}

/**
 * Records the merge base's GPUI e2e on this Mac (scripts/gpui-main-baseline.mjs)
 * in a scratch worktree, unless the baseline directory already holds it.
 */
function mainBaselineStage(mergeBase) {
  if (readBaseline(mergeBase)?.exact) return { name: "gpui-main", skip: `this Mac's main baseline has ${mergeBase.slice(0, 9)}` };
  const worktree = path.join(baselineDir(), "..", "ci-local-main");
  return {
    name: "gpui-main",
    why: `the merge base's e2e on this Mac, for the baseline (${mergeBase.slice(0, 9)})`,
    command: "sh",
    args: ["-c", 'git worktree remove --force "$1" 2>/dev/null; git worktree add --detach "$1" "$2" && (cd "$1" && node scripts/gpui-main-baseline.mjs --sha "$2"); status=$?; git worktree remove --force "$1"; exit $status', "sh", worktree, mergeBase],
    timeout: 3_600_000,
    before: waitForPerfLock,
  };
}

/** The stages for this tier: the gate's, then signoff's, kept by the jobs they stand for. */
export function localStages(tier, files, mergeBase) {
  const { jobs, vitestFiles } = tier;
  const stages = [];
  if (jobs["lint-build"] || (jobs.vitest && !vitestFiles.length)) stages.push(...gateStages(files));
  else if (vitestFiles.length) {
    stages.push({ name: "vitest", why: `${vitestFiles.length} test(s) that read the changed files`, command: "pnpm", args: ["exec", "vitest", "run", ...vitestFiles], timeout: 900_000 });
  }
  if (jobs.rust && !stages.some((stage) => stage.name === "rustfmt" && !stage.skip)) {
    stages.push({ name: "rustfmt", why: "the Tauri crates", command: "cargo", args: ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--all", "--", "--check"], timeout: 120_000 });
  }
  const keep = {
    "synara-pin": jobs["synara-pin"],
    bundle: jobs["perf-bench"],
    harness: jobs["perf-bench"],
    clippy: jobs.rust,
    "cargo-test": jobs.rust,
  };
  const heavy = new Set(["clippy", "cargo-test", "gpui-patch", "gpui-build", "gpui-test", "gpui-e2e"]);
  for (const stage of extraStages(files, mergeBase, { gpui: jobs.gpui, tauri: jobs.rust })) {
    if (stage.name.startsWith("gpui-") ? !jobs.gpui : !keep[stage.name]) continue;
    if (stage.name !== "gpui-e2e" || stage.skip) {
      stages.push(heavy.has(stage.name) && !stage.skip ? { ...stage, before: waitForPerfLock } : stage);
      continue;
    }
    stages.push(mainBaselineStage(mergeBase));
    // The baseline is read when the stage starts, after gpui-main wrote it.
    const e2e = { ...stage, why: "the whole e2e scenario, failing only on steps main fails too", env: { ...stage.env, LATTICE_E2E_VERDICT: "1" } };
    e2e.before = async () => {
      await waitForPerfLock();
      const baseline = readBaseline(mergeBase);
      if (baseline?.exact) e2e.env.LATTICE_E2E_BASELINE = baseline.file;
      else console.log("  gpui-e2e: no main baseline for the merge base; judging against the known failures alone");
    };
    stages.push(e2e);
  }
  if (jobs["perf-bench"]) {
    stages.push({
      name: "webkit-bench",
      why: "the WebKit benchmark and layout checks against their ceilings, as CI's macOS shards",
      command: "sh",
      args: ["-c", "pnpm exec playwright-core install webkit >/dev/null && pnpm perf:bench --check --layout --engine webkit"],
      timeout: 2_400_000,
      before: waitForPerfLock,
    });
  }
  return stages;
}

async function main() {
  const argv = process.argv.slice(2);
  const options = { base: "origin/main", full: false, plan: false, headless: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--base") options.base = argv[++index];
    else if (argv[index] === "--full") options.full = true;
    else if (argv[index] === "--plan") options.plan = true;
    else if (argv[index] === "--headless") options.headless = true;
    else throw new Error(`Unknown option ${argv[index]}`);
  }
  const started = Date.now();
  const { mergeBase, files } = changedFiles(options.base);
  const tier = ciTier(files, { full: options.full });
  console.log(`ci:local: ${files.length} changed file(s) against ${options.base} (${mergeBase.slice(0, 9)})`);
  for (const job of JOBS) {
    const runs = tier.jobs[job];
    console.log(`  ${job.padEnd(19)} ${runs ? "CI runs" : "CI skips"}${runs ? `; here: ${LOCAL[job]}` : ""}${runs && tier.why[job].length ? `  (${tier.why[job].slice(0, 3).join(", ")})` : ""}`);
  }
  if (!JOBS.some((job) => tier.jobs[job])) {
    console.log("ci:local: nothing CI checks changed; CI skips every job");
    return;
  }
  const stages = localStages(tier, files, mergeBase).map((stage) =>
    options.headless && WINDOWED.has(stage.name) && !stage.skip ? { name: stage.name, skip: "opens windows; --headless" } : stage,
  );
  if (options.plan) {
    for (const stage of stages) console.log(`  ${stage.name.padEnd(12)} ${stage.skip ? `skip (${stage.skip})` : stage.why}`);
    return;
  }
  const failed = await runStages(stages);
  const minutes = ((Date.now() - started) / 60_000).toFixed(1);
  if (failed) {
    console.log(`ci:local: ${failed} stage(s) failed in ${minutes} min`);
    process.exitCode = 1;
    return;
  }
  console.log(`ci:local: every stage passed in ${minutes} min`);
  if (!tier.jobs.rust && !tier.jobs.gpui && !tier.jobs["perf-bench"]) return;
  if (stages.some((stage) => stage.skip === "opens windows; --headless")) {
    console.log("ci:local: --headless skipped the stages that open windows; run it whole on a Mac that may open windows for the CI-local trailer");
    return;
  }
  if (git("status", "--porcelain")) {
    console.log("ci:local: commit the change and run this again for the CI-local trailer; it names the commit's tree");
    return;
  }
  const tree = git("rev-parse", "HEAD^{tree}").slice(0, 12);
  console.log(`ci:local: local macOS gate passed at ${git("rev-parse", "HEAD").slice(0, 9)}; this tree stands for CI's macOS jobs. Add the trailer before pushing:`);
  console.log(`  git commit --amend --no-edit --trailer "CI-local: macos ${tree}"`);
}

if (isMain(import.meta.url)) {
  await main().catch((error) => {
    console.error(`ci:local: ${error.message}`);
    process.exit(1);
  });
}
