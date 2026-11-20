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
 *                        e2e scenario, judged like CI's against
 *                        scripts/gpui-e2e-known-failures.json and against a
 *                        run of the merge base on this Mac. The e2e is the
 *                        smoke flow plus the modules the diff picks
 *                        (scripts/ci-local-select.mjs, one table from paths
 *                        to modules), or the whole scenario when a changed
 *                        file maps to none; only the whole one records this
 *                        machine's main baseline for the merge base first
 *                        (scripts/gpui-main-baseline.mjs) when it has none,
 *                        in a scratch worktree of the merge base
 *
 * The literature Worker, the Open Slide runtime, the research environment, the
 * Chromium benchmark, Linux and Windows run only in CI.
 *
 * Every Rust and GPUI stage waits while a perf measurement holds
 * /tmp/lattice-inapp-test.lock, and compiles in the machine's shared build
 * tree under its build lock (scripts/gpui-build.mjs). The stages that open
 * windows (gpui-main, gpui-e2e, webkit-bench) hold that lock for their whole
 * run through scripts/inapp-lock, so no hand test or other run drives the
 * screen under them.
 *
 * When every stage passes and the change needed a macOS job, it prints a
 * `CI-local: macos <tree> rust gpui e2e=… webkit` trailer naming the stages
 * that ran. Pushed on a commit whose tree is that one, it lets CI skip each
 * macOS job (Rust, GPUI, the WebKit benchmark) those stages cover for the
 * diff; anything they do not cover still runs there, and Linux and Windows
 * always do.
 *
 * After a merge of main, when HEAD is a passing gate plus clean merges of
 * main that touch none of the branch's files (mainMergeRegate), it runs only
 * the headless stages (the gate, the Rust and GPUI builds and unit tests)
 * and prints the gate's stages again with `regate=<gate sha>`.
 *
 * A change to a release path (RELEASE_PATHS: release workflows, bundle and
 * signing configuration, the updater) always runs every stage and prints no
 * trailer: GitHub runs its macOS jobs for it.
 *
 * Options:
 *   --base REF   compare against REF instead of origin/main (its merge base)
 *   --full       every stage and the whole e2e, whatever changed, and no
 *                quick re-gate
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
import { FULL, RELEASE_PATHS, coveredJobs, formatTrailer, macosNeeds, mainMergeRegate } from "./ci-local-select.mjs";
import { JOBS, ciTier } from "./ci-tier.mjs";
import { changedFiles, gateStages, runStages } from "./gate-changed.mjs";
import { readBaseline } from "./gpui-e2e-light.mjs";
import { baselineDir } from "./gpui-main-baseline.mjs";
import { isMain } from "./lib/util.mjs";
import { extraStages } from "./signoff.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
// scripts/inapp-lock's file, which INAPP_LOCK_FILE moves for both.
const PERF_LOCK = process.env.INAPP_LOCK_FILE ?? "/tmp/lattice-inapp-test.lock";
const WINDOWED = new Set(["gpui-main", "gpui-e2e", "webkit-bench"]);
// How long a windowed stage waits for the in-app lock before it gives up.
const INAPP_WAIT_S = 3600;

/**
 * Runs a windowed stage under the in-app lock. Waiting for the lock to be free
 * was not enough: a hand test took it while an e2e was running and sent its
 * keys into that run's window (LATA-37 into LATA-16's, 2026-11-19).
 */
export function holdingInappLock(stage) {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  return {
    ...stage,
    command: path.join(repo, "scripts", "inapp-lock"),
    args: ["--thread", `ci:local ${branch} ${stage.name}`, "--wait", String(INAPP_WAIT_S), "--", stage.command, ...(stage.args ?? [])],
    timeout: stage.timeout + INAPP_WAIT_S * 1000,
  };
}

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
  // One per run: two threads' ci:local on the same Mac shared one path, and
  // the second's `git worktree remove` pulled the tree from under the first's
  // baseline (spawnSync git ENOENT once its e2e had finished).
  const worktree = path.join(baselineDir(), "..", `ci-local-main-${process.pid}`);
  return {
    name: "gpui-main",
    why: `the merge base's e2e on this Mac, for the baseline (${mergeBase.slice(0, 9)})`,
    command: "sh",
    args: ["-c", 'git worktree remove --force "$1" 2>/dev/null; git worktree add --detach "$1" "$2" && (cd "$1" && node scripts/gpui-main-baseline.mjs --sha "$2"); status=$?; git worktree remove --force "$1"; exit $status', "sh", worktree, mergeBase],
    timeout: 3_600_000,
    before: waitForPerfLock,
  };
}

/**
 * The stages for this tier: the gate's, then signoff's, kept by the jobs they
 * stand for. The GPUI e2e is the whole scenario, after this Mac's main
 * baseline for the merge base, when `e2e` (macosNeeds in
 * scripts/ci-local-select.mjs) needs it whole; otherwise the smoke flow and
 * the modules the diff picks, judged against the known failures and the
 * baseline when this Mac already has one for the merge base.
 */
export function localStages(tier, files, mergeBase, e2eNeed = macosNeeds(tier, files).e2e) {
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
    const only = e2eNeed.modules.length ? e2eNeed.modules.join(",") : "smoke";
    if (e2eNeed.full) stages.push(mainBaselineStage(mergeBase));
    const e2e = e2eNeed.full
      ? { ...stage, why: "the whole e2e scenario, failing only on steps main fails too" }
      : { ...stage, why: `the smoke flow${e2eNeed.modules.length ? ` and ${e2eNeed.modules.length} module(s) the diff picks` : ""}, failing only on steps main fails too`, args: ["--only", only] };
    e2e.env = { ...stage.env, LATTICE_E2E_VERDICT: "1" };
    // The baseline is read when the stage starts, after gpui-main wrote it.
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
      args: ["-c", "pnpm exec playwright-core install webkit >/dev/null && pnpm perf:bench --check --machine-allowance --layout --engine webkit"],
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
  const release = files.filter((file) => RELEASE_PATHS.test(file));
  const tier = ciTier(files, { full: options.full || release.length > 0 });
  const needs = macosNeeds(tier, files);
  console.log(`ci:local: ${files.length} changed file(s) against ${options.base} (${mergeBase.slice(0, 9)})`);
  if (release.length) console.log(`ci:local: release paths changed (${release.slice(0, 3).join(", ")}): the full gate runs, and GitHub runs its macOS jobs whatever the trailer says`);
  for (const job of JOBS) {
    const runs = tier.jobs[job];
    console.log(`  ${job.padEnd(19)} ${runs ? "CI runs" : "CI skips"}${runs ? `; here: ${LOCAL[job]}` : ""}${runs && tier.why[job].length ? `  (${tier.why[job].slice(0, 3).join(", ")})` : ""}`);
  }
  if (!JOBS.some((job) => tier.jobs[job])) {
    console.log("ci:local: nothing CI checks changed; CI skips every job");
    return;
  }
  if (needs.e2e?.full) console.log(`  gpui e2e: the whole scenario (${needs.e2e.fullBecause.slice(0, 3).join(", ")})`);
  else if (needs.e2e) console.log(`  gpui e2e: the smoke flow${needs.e2e.modules.length ? ` and ${needs.e2e.modules.join(", ")}` : " alone"} (scripts/ci-local-select.mjs)`);

  // A passing gate followed only by clean merges of main that touch none of
  // the branch's files is re-certified by the headless build and unit
  // tests: what the windowed stages checked is the branch's own code, which
  // the merge did not change, and main's side was checked on main.
  let regate = null;
  if (!tier.full && !git("status", "--porcelain")) {
    const check = mainMergeRegate({ base: options.base, cwd: repo });
    const covered = check.ok && coveredJobs(check.cover, needs);
    if (check.ok && Object.values(covered).every((group) => group.covered)) regate = check;
    else if (check.ok) console.log(`ci:local: no quick re-gate: the gate at ${check.gate.slice(0, 9)} does not cover this diff (${Object.values(covered).find((group) => !group.covered).reason})`);
    else if (check.reason !== "HEAD is not a merge") console.log(`ci:local: no quick re-gate: ${check.reason}`);
  }
  if (regate) console.log(`ci:local: quick re-gate: HEAD is the gate at ${regate.gate.slice(0, 9)} plus a clean merge of main (${regate.mainCommit.slice(0, 9)}) that touches none of the branch's ${regate.branchFiles.length} file(s); the build and unit tests re-certify it, without the windowed stages`);

  // A worktree that moved to a newer main keeps the packages it installed
  // before, and tsc and vitest then fail on modules main added since. CI
  // installs from the lockfile first; so does this, which is quick when
  // nothing changed.
  const install = { name: "install", why: "pnpm install --frozen-lockfile, as CI's setup does", command: "pnpm", args: ["install", "--frozen-lockfile", "--prefer-offline"], timeout: 600_000 };
  const stages = [install, ...localStages(tier, files, mergeBase, needs.e2e)]
    .filter((stage) => !regate || !WINDOWED.has(stage.name))
    .map((stage) => {
      if (!WINDOWED.has(stage.name) || stage.skip) return stage;
      return options.headless ? { name: stage.name, skip: "opens windows; --headless" } : holdingInappLock(stage);
    });
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
  if (release.length) {
    console.log("ci:local: no CI-local trailer for release paths; push without one and let GitHub's macOS jobs run");
    return;
  }
  const tree = git("rev-parse", "HEAD^{tree}").slice(0, 12);
  const cover = regate
    ? { ...regate.cover, regate: regate.gate.slice(0, 9) }
    : { rust: tier.jobs.rust, gpui: tier.jobs.gpui, e2e: needs.e2e && (needs.e2e.full ? FULL : needs.e2e.modules), webkit: tier.jobs["perf-bench"] };
  const head = git("rev-parse", "HEAD").slice(0, 9);
  console.log(
    regate
      ? `ci:local: local macOS gate re-certified at ${head} by the quick pass after a main merge (gate ${regate.gate.slice(0, 9)}). Add the trailer before pushing:`
      : `ci:local: local macOS gate passed at ${head}; the trailer records the stages that ran, and CI skips the macOS jobs they cover. Add it before pushing:`,
  );
  console.log(`  git commit --amend --no-edit --trailer "${formatTrailer(tree, cover)}"`);
}

if (isMain(import.meta.url)) {
  await main().catch((error) => {
    console.error(`ci:local: ${error.message}`);
    process.exit(1);
  });
}
