#!/usr/bin/env node
/**
 * Runs test files several times in a row under CPU load, to show a new or
 * changed test is stable before it lands, or to measure how flaky one is.
 *
 * One passing run says little about a flake: a test that fails one run in
 * five passes its own pull request four times in five. The reopen-from-tree
 * test did, then failed a fifth of main's runs; five runs let such a test
 * through a third of the time, ten about a tenth. Every flake recorded so far
 * is timing-dependent (an App integration suite or a perf-bench layout check),
 * so each run shares the machine with busy-looping sibling processes, the
 * contention a loaded laptop or a CI neighbour adds.
 *
 *   node scripts/burn-in.mjs [options] [file …] [-- <vitest args>]
 *
 *   --runs N        runs in all (default 5); every run happens even after one
 *                   fails, so the count of failures is a rate
 *   --burn N        busy-looping sibling processes (default 1)
 *   --budget S      stop after the first run when it took so long that all N
 *                   would exceed S seconds (CI); a big suite a pull request
 *                   touched is left to the test shards' single run
 *   --base REF      with no files: take the test files the diff from REF adds
 *                   or modifies, uncommitted and untracked ones included
 *                   (default: the merge base with origin/main)
 *   --list          print those files and exit
 *
 * ci.yml's `new-tests` job runs it on a pull request's own test files. To
 * deflake one test locally: `node scripts/burn-in.mjs --runs 20 --burn 4
 * src/app/app-documents.test.tsx -- -t "reopens"`.
 *
 * Vitest's own `retry` stays off: it would turn exactly these failures green.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The Vitest files among changed paths. Which of them the root config
 * collects is left to Vitest: one it excludes (literature-worker/, say)
 * matches nothing and the run passes with no tests.
 */
export function testFilesIn(paths) {
  return [...new Set(paths)].filter((file) => /\.test\.[cm]?[jt]sx?$/.test(file)).sort();
}

/** Whether `runs` runs at the first run's `seconds` overrun `budget` seconds. */
export function overBudget(seconds, runs, budget) {
  return budget !== undefined && seconds * runs > budget;
}

function git(...args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout.split("\n").filter(Boolean);
}

function changedTestFiles(base) {
  const from = base ?? git("merge-base", "origin/main", "HEAD")[0];
  // --no-renames lists a moved test as added, so it is burned in too.
  return testFilesIn([
    ...git("-c", "core.quotePath=false", "diff", "--no-renames", "--name-only", "--diff-filter=AM", from),
    ...git("-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard"),
  ]);
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      runs: { type: "string", default: "5" },
      burn: { type: "string", default: "1" },
      budget: { type: "string" },
      base: { type: "string" },
      list: { type: "boolean", default: false },
    },
  });
  // parseArgs keeps what follows `--` as positionals too, after the files.
  const dashes = process.argv.indexOf("--");
  const vitestArgs = dashes === -1 ? [] : process.argv.slice(dashes + 1);
  const named = positionals.slice(0, positionals.length - vitestArgs.length);
  const files = named.length > 0 ? named : changedTestFiles(values.base);
  if (values.list) {
    for (const file of files) console.log(file);
    return 0;
  }
  if (files.length === 0) {
    console.log("burn-in: no added or modified test files");
    return 0;
  }
  const runs = Number(values.runs);
  const budget = values.budget === undefined ? undefined : Number(values.budget);

  const burners = Array.from({ length: Number(values.burn) }, () =>
    spawn(process.execPath, ["-e", "for (;;) {}"], { stdio: "ignore" }));
  const stopBurners = () => burners.forEach((burner) => burner.kill("SIGKILL"));
  process.on("exit", stopBurners);

  const vitest = path.join(repo, "node_modules/.bin/vitest");
  const results = [];
  for (let run = 1; run <= runs; run += 1) {
    console.log(`\nburn-in: run ${run} of ${runs}, beside ${burners.length} busy process(es): ${files.join(" ")}`);
    const started = performance.now();
    const { status } = spawnSync(vitest, ["run", "--passWithNoTests", ...files, ...vitestArgs], { cwd: repo, stdio: "inherit" });
    const seconds = (performance.now() - started) / 1000;
    results.push({ passed: status === 0, seconds });
    if (run === 1 && overBudget(seconds, runs, budget)) {
      console.log(`burn-in: one run took ${seconds.toFixed(0)} s, so ${runs} would exceed the ${budget} s budget; not repeating`);
      break;
    }
  }
  stopBurners();

  const failed = results.filter((result) => !result.passed).length;
  const summary = `burn-in: ${failed} of ${results.length} run(s) failed (${results.map((result) => `${result.passed ? "pass" : "FAIL"} ${result.seconds.toFixed(0)} s`).join(", ")})`;
  console.log(`\n${summary}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n\n${files.map((file) => `- \`${file}\``).join("\n")}\n`);
  }
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
