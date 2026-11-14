#!/usr/bin/env node
/**
 * `node scripts/gpui-e2e-light.mjs`: the GPUI e2e check for one review round
 * of a branch, in place of the full scenario.
 *
 *   1. picks the scenario modules the branch's change touches
 *      (`scripts/gpui-e2e-modules.mjs`); a branch that changes nothing GPUI
 *      runs nothing;
 *   2. builds the release binary through `scripts/gpui-build.mjs` (seconds
 *      in the warm shared tree), unless `--no-build`;
 *   3. runs `gpui/script/e2e --only <modules>`: the smoke flow (open, build,
 *      SyncTeX, edits and ⌘S, autosave and outside edits, a second window,
 *      the quit that saves) and those modules;
 *   4. when every failing step is quarantined (`gpui-e2e-quarantine.json`,
 *      the few steps behind most red runs), runs it once more and keeps only
 *      the steps that failed both times;
 *   5. sorts what still fails against the main baseline
 *      (`scripts/gpui-main-baseline.mjs`): a step the baseline for the
 *      branch's merge base (or, without one, `latest.json`) also fails is
 *      pre-existing; anything else is the branch's.
 *
 * It exits 1 only for failures that are the branch's, and writes the verdict
 * to `.tmp/gpui-e2e-light/verdict.json` (or `--out FILE`), with each run's
 * result beside it.
 *
 * Options:
 *   --base REF     compare against REF's merge base (default origin/main)
 *   --only LIST    run these modules instead of the ones the diff picks
 *   --no-build     use the binary already in gpui/target/release
 *   --out FILE     where to write the verdict
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changedFiles, modulesFor } from "./gpui-e2e-modules.mjs";
import { baselineDir, parseE2e } from "./gpui-main-baseline.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function quarantined() {
  return JSON.parse(readFileSync(path.join(repo, "scripts", "gpui-e2e-quarantine.json"), "utf8")).steps;
}

/** The main baseline record for `sha`, else the newest one; null when there is none. */
export function readBaseline(sha, dir = baselineDir()) {
  for (const name of [sha && `known-failures@${sha}.json`, "latest.json"].filter(Boolean)) {
    try {
      return { file: path.join(dir, name), exact: name !== "latest.json", record: JSON.parse(readFileSync(path.join(dir, name), "utf8")) };
    } catch {
      // Not there; try the next.
    }
  }
  return null;
}

/**
 * Whether a failed first run is worth a second: only when every failing step
 * is quarantined. Then the steps that failed both times.
 */
export function shouldRetry(failing, quarantine) {
  return failing.length > 0 && failing.every((step) => quarantine.includes(step));
}

/** The failures, split into the branch's own and the ones main shares. */
export function classify(failing, baseline) {
  const known = new Set(baseline?.record?.e2e?.failing ?? []);
  return { own: failing.filter((step) => !known.has(step)), preExisting: failing.filter((step) => known.has(step)) };
}

function runE2e(only, out) {
  const status = spawnSync(path.join(repo, "gpui", "script", "e2e"), ["--only", only, out], { cwd: repo, stdio: "inherit" }).status;
  let result = null;
  try {
    result = JSON.parse(readFileSync(out, "utf8"));
  } catch {
    // parseE2e records a missing result.
  }
  const parsed = parseE2e(result);
  // script/e2e's own check after the quit fails the run with every step green.
  if (status !== 0 && parsed.failing.length === 0) parsed.failing.push(parsed.error ? `the scenario did not finish: ${parsed.error}` : "script/e2e's after-quit save check");
  return parsed;
}

function main() {
  const argv = process.argv.slice(2);
  const options = { base: "origin/main", only: null, build: true, out: path.join(repo, ".tmp", "gpui-e2e-light", "verdict.json") };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base") options.base = argv[++index];
    else if (arg === "--only") options.only = argv[++index];
    else if (arg === "--no-build") options.build = false;
    else if (arg === "--out") options.out = path.resolve(argv[++index]);
    else throw new Error(`unknown option ${arg}`);
  }
  const dir = path.dirname(options.out);
  mkdirSync(dir, { recursive: true });

  const picked = modulesFor(changedFiles(options.base));
  if (!options.only && !picked.gpui) {
    console.log("gpui-e2e-light: the branch changes nothing under gpui/ or lattice-core; no e2e to run");
    writeFileSync(options.out, `${JSON.stringify({ ran: false }, null, 2)}\n`);
    return;
  }
  const only = options.only ?? (picked.modules.length ? picked.modules.join(",") : "smoke");
  for (const [module, files] of Object.entries(picked.why)) console.log(`gpui-e2e-light: ${module} <- ${files.join(", ")}`);
  console.log(`gpui-e2e-light: smoke flow + ${only}`);

  if (options.build) {
    const built = spawnSync("node", [path.join(repo, "scripts", "gpui-build.mjs")], { cwd: repo, stdio: "inherit" }).status;
    if (built !== 0) {
      console.error("gpui-e2e-light: the release build failed");
      process.exit(1);
    }
  }

  const quarantine = quarantined();
  const runs = [runE2e(only, path.join(dir, "e2e-1.json"))];
  let failing = runs[0].failing;
  let retried = [];
  if (shouldRetry(failing, quarantine)) {
    console.log(`gpui-e2e-light: only quarantined steps failed (${failing.join("; ")}); running once more`);
    runs.push(runE2e(only, path.join(dir, "e2e-2.json")));
    retried = failing;
    // A quarantined step counts only if it failed both times; anything new
    // in the second run counts as it is.
    failing = runs[1].failing.filter((step) => retried.includes(step) || !quarantine.includes(step));
  }

  const mergeBase = execFileSync("git", ["merge-base", options.base, "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const baseline = readBaseline(mergeBase);
  const { own, preExisting } = classify(failing, baseline);
  const verdict = {
    ran: true,
    only,
    picked: picked.why,
    steps: runs.map((run) => run.total),
    retried,
    failing,
    pre_existing: preExisting,
    own,
    baseline: baseline ? { file: baseline.file, sha: baseline.record.sha, for_merge_base: baseline.exact } : null,
  };
  writeFileSync(options.out, `${JSON.stringify(verdict, null, 2)}\n`);
  if (retried.length && !failing.some((step) => retried.includes(step))) console.log(`gpui-e2e-light: passed on the retry (flaky: ${retried.join("; ")})`);
  for (const step of preExisting) console.log(`gpui-e2e-light: pre-existing on main (${path.basename(baseline.file)}): ${step}`);
  if (!baseline && failing.length) console.log(`gpui-e2e-light: no main baseline in ${baselineDir()}, so no failure could be matched against main`);
  for (const step of own) console.log(`gpui-e2e-light: FAILED: ${step}`);
  console.log(`gpui-e2e-light: ${own.length ? `${own.length} failure(s) of this branch` : "ok"}; ${options.out}`);
  process.exitCode = own.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`gpui-e2e-light: ${error.message}`);
    process.exit(1);
  }
}
