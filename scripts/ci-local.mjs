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
 *   gpui                 rustfmt, the release build, the unit tests and the
 *                        whole e2e scenario, judged like CI's against
 *                        scripts/gpui-e2e-known-failures.json (and this
 *                        machine's main baseline, when it keeps one)
 *
 * The literature Worker, the Open Slide runtime, the research environment and
 * the Chromium and WebKit benchmarks, Linux and Windows run only in CI.
 *
 * Every Rust and GPUI stage waits while a perf measurement holds
 * /tmp/lattice-inapp-test.lock, and compiles in the machine's shared build
 * tree under its build lock (scripts/gpui-build.mjs).
 *
 * When every stage passes and the change needed the macOS Rust or GPUI jobs,
 * it prints a `CI-local: macos <tree>` trailer for the commit. Pushed on a
 * commit whose tree is that one, it lets CI skip those two macOS jobs; Linux,
 * Windows and the benchmarks still run.
 *
 * Options:
 *   --base REF   compare against REF instead of origin/main (its merge base)
 *   --full       every stage, whatever changed
 *   --plan       print the plan only
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { JOBS, ciTier } from "./ci-tier.mjs";
import { changedFiles, gateStages, runStages } from "./gate-changed.mjs";
import { readBaseline } from "./gpui-e2e-light.mjs";
import { isMain } from "./lib/util.mjs";
import { extraStages } from "./signoff.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const PERF_LOCK = "/tmp/lattice-inapp-test.lock";

const LOCAL = {
  vitest: "gate (vitest related + invariants)",
  "lint-build": "gate (lint, knip, tsc, i18n, notices, perf evidence)",
  "perf-bench": "bundle budgets (+ harness); benchmarks in CI only",
  rust: "rustfmt, clippy -D warnings, cargo test",
  gpui: "rustfmt, release build, unit tests, e2e with known failures",
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

/** The stages for this tier: the gate's, then signoff's, kept by the jobs they stand for. */
export function localStages(tier, files, mergeBase, { baselineFile = null } = {}) {
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
    const local = stage.name === "gpui-e2e" && !stage.skip
      ? {
          ...stage,
          why: "the whole e2e scenario, failing only on steps main passes",
          env: { ...stage.env, LATTICE_E2E_VERDICT: "1", ...(baselineFile ? { LATTICE_E2E_BASELINE: baselineFile } : {}) },
        }
      : stage;
    stages.push(heavy.has(stage.name) && !stage.skip ? { ...local, before: waitForPerfLock } : local);
  }
  return stages;
}

async function main() {
  const argv = process.argv.slice(2);
  const options = { base: "origin/main", full: false, plan: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--base") options.base = argv[++index];
    else if (argv[index] === "--full") options.full = true;
    else if (argv[index] === "--plan") options.plan = true;
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
  const baseline = tier.jobs.gpui ? readBaseline(mergeBase) : null;
  if (baseline) console.log(`ci:local: GPUI e2e steps this machine's main baseline fails count as known too (${path.basename(baseline.file)})`);
  const stages = localStages(tier, files, mergeBase, { baselineFile: baseline?.file ?? null });
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
  if (!tier.jobs.rust && !tier.jobs.gpui) return;
  if (git("status", "--porcelain")) {
    console.log("ci:local: commit the change and run this again for the CI-local trailer; it names the commit's tree");
    return;
  }
  const tree = git("rev-parse", "HEAD^{tree}").slice(0, 12);
  console.log(`ci:local: this tree stands for CI's macOS Rust and GPUI jobs. Add the trailer before pushing:`);
  console.log(`  git commit --amend --no-edit --trailer "CI-local: macos ${tree}"`);
}

if (isMain(import.meta.url)) {
  await main().catch((error) => {
    console.error(`ci:local: ${error.message}`);
    process.exit(1);
  });
}
