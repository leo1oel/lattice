#!/usr/bin/env node
/**
 * `pnpm gate:changed`: the local check before pushing a change to src/
 * (docs/agent-validation.md). CI stays the full suite; this runs the stages
 * whose failures a change most often sends to CI, scoped to what the branch
 * changed against `origin/main`:
 *
 *   lint       oxlint over src and tools with the warning cap, as `pnpm lint`
 *              runs it: a new warning anywhere breaks the cap
 *   typecheck  tsc over the app and the Node config, as `pnpm build` runs it
 *   i18n       `pnpm i18n:check`, when a source or catalog changed
 *   vitest     the tests `vitest related` finds from the changed files, plus
 *              every test in src/platform/invariant-tests.json, which read
 *              stylesheets and fixtures no import graph leads to
 *
 * Without it, agents assembled their own lists of test files, took 9–20
 * minutes a run, and still missed both real CI failures of a round: each was
 * an invariant test reading a stylesheet the change had edited.
 *
 * Every stage runs, so one pass shows every red. Each prints one line, and a
 * failed one prints a bounded excerpt of its log, which is kept whole under
 * .tmp/gate-changed/. A stage that outlives its timeout is killed and fails.
 * Nothing here opens a browser or builds Rust; when src-tauri/ changed it says
 * so, and CI's `rust` job is the check.
 *
 * Options:
 *   --base REF   compare against REF instead of origin/main (its merge base)
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { invariantTests } from "./test-invariants.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logDir = path.join(repo, ".tmp/gate-changed");

function parseArgs(argv) {
  const options = { base: "origin/main" };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--base") options.base = argv[++index];
    else throw new Error(`Unknown option ${argv[index]}`);
  }
  return options;
}

const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

/**
 * Files the branch adds or modifies against the merge base, committed or not,
 * plus untracked ones. A deleted file has nothing to check by itself; the
 * tests that imported it fail in `vitest related` through their own edits, or
 * in CI.
 */
function changedFiles(base) {
  const mergeBase = git("merge-base", "HEAD", base).trim();
  const lines = [
    ...git("-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", mergeBase).split("\n"),
    ...git("-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard").split("\n"),
  ];
  return { mergeBase, files: [...new Set(lines.filter(Boolean))].filter((file) => existsSync(path.join(repo, file))) };
}

/**
 * Runs one stage in its own process group, so a timeout kills everything it
 * started (pnpm, then Vitest's workers), and resolves with its status and log.
 */
function run(name, command, args, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd: repo, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "0" } });
    running.add(child);
    let log = "";
    child.stdout.on("data", (chunk) => (log += chunk));
    child.stderr.on("data", (chunk) => (log += chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      setTimeout(() => killGroup(child, "SIGKILL"), 5_000).unref();
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      running.delete(child);
      const file = path.join(logDir, `${name}.log`);
      writeFileSync(file, log);
      resolve({ ok: code === 0 && !timedOut, timedOut, seconds: (Date.now() - started) / 1000, log, file });
    });
  });
}

const running = new Set();
function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const child of running) killGroup(child, "SIGTERM");
    process.exit(130);
  });
}

/**
 * The head and tail of a long log: compilers report first, test runners last.
 * Oxlint's standing warnings (under the cap) would bury the one error, so a
 * warning line is dropped, and any line is cut to a readable length.
 */
function excerpt(log) {
  const lines = log
    .trimEnd()
    .split("\n")
    .filter((line) => !/^\S+:\d+:\d+: warning /.test(line))
    .map((line) => (line.length > 400 ? `${line.slice(0, 400)}…` : line));
  if (lines.length <= 60) return lines;
  return [...lines.slice(0, 30), `… ${lines.length - 60} lines omitted …`, ...lines.slice(-30)];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { mergeBase, files } = changedFiles(options.base);
  mkdirSync(logDir, { recursive: true });
  console.log(`gate:changed: ${files.length} changed file(s) against ${options.base} (${mergeBase.slice(0, 9)})`);

  const code = files.filter((file) => /^(src|tools|scripts)\/.*\.(ts|tsx|mts|js|jsx|mjs|css|json)$/.test(file));
  const sources = files.filter((file) => /^src\/.*\.tsx?$/.test(file) || file.startsWith("src/locales/"));
  const stages = [
    { name: "lint", why: "oxlint, src and tools", command: "pnpm", args: ["lint"], timeout: 180_000 },
    {
      name: "typecheck",
      why: "tsc, app and Node config",
      command: "sh",
      args: ["-c", "pnpm exec tsc && pnpm exec tsc -p tsconfig.node.json --noEmit"],
      timeout: 300_000,
    },
    sources.length
      ? { name: "i18n", why: "catalog extraction and coverage", command: "pnpm", args: ["i18n:check"], timeout: 300_000 }
      : { name: "i18n", skip: "no source or catalog changed" },
    {
      name: "vitest",
      why: `related to ${code.length} changed file(s), plus ${invariantTests().length} invariant tests`,
      command: "pnpm",
      args: ["exec", "vitest", "related", "--run", "--passWithNoTests", ...code, ...invariantTests()],
      timeout: 900_000,
    },
  ];

  let failed = 0;
  for (const stage of stages) {
    if (stage.skip) {
      console.log(`  ${stage.name.padEnd(10)} skipped  (${stage.skip})`);
      continue;
    }
    const result = await run(stage.name, stage.command, stage.args, stage.timeout);
    const verdict = result.ok ? "ok" : result.timedOut ? `TIMED OUT after ${stage.timeout / 1000} s` : "FAILED";
    console.log(`  ${stage.name.padEnd(10)} ${verdict.padEnd(8)} ${result.seconds.toFixed(1).padStart(6)} s  (${stage.why})`);
    if (!result.ok) {
      failed += 1;
      console.log(excerpt(result.log).map((line) => `    | ${line}`).join("\n"));
      console.log(`    full log: ${path.relative(repo, result.file)}`);
    }
  }
  if (files.some((file) => file.startsWith("src-tauri/"))) {
    console.log("  rust       not run  (src-tauri/ changed: run the touched module's `cargo test` through pueue; CI's `rust` job runs the rest)");
  }
  console.log(failed ? `gate:changed: ${failed} stage(s) failed` : "gate:changed: ok; CI runs everything else");
  process.exitCode = failed ? 1 : 0;
}

await main().catch((error) => {
  console.error(`gate:changed: ${error.message}`);
  process.exit(1);
});
