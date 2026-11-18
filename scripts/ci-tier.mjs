#!/usr/bin/env node
/**
 * Which CI jobs a change needs, decided once for ci.yml, gpui.yml and the
 * local `pnpm ci:local` (scripts/ci-local.mjs), so a branch runs the same
 * tier on a runner and on a Mac.
 *
 * Each changed path turns on the jobs that read it:
 *
 *   vitest              the Vitest shards: anything not named below, and a
 *                       file under docs/, src-tauri/ or gpui/ that a test
 *                       names (a test reading a spec or a manifest)
 *   lint-build          lint, knip, perf evidence, `pnpm build`, notices and
 *                       i18n: what vitest takes, plus the notice inputs
 *                       (manifests, lockfiles, Cargo files) and
 *                       docs/performance*
 *   perf-bench          the bench page and both engines' benchmarks: what the
 *                       production bundle reads, and the bench harness
 *   rust                the Tauri crates on macOS, Linux and Windows:
 *                       src-tauri/, rust-toolchain.toml, and a file elsewhere
 *                       a Tauri .rs `include_str!`s
 *   gpui                gpui.yml's jobs (build, unit tests and the e2e
 *                       scenario on macOS and Windows): gpui/, lattice-core,
 *                       the design-system exports and the src/ modules its
 *                       islands are built from, and a file a GPUI .rs
 *                       `include_str!`s
 *   literature-worker, open-slide-runtime, research-env, synara-pin
 *                       their own directories (and, for synara-pin, the pin)
 *
 * Documentation alone (docs/, top-level and .github/ Markdown, gpui/docs/,
 * LICENSE) turns on nothing. A change to ci.yml turns on all of ci.yml's
 * jobs, one to gpui.yml all of gpui.yml's, and one to this file or to
 * .github/actions/ everything.
 *
 * `--github` is the workflows' `changes` step. It runs every job (full)
 * for a tag, the schedule, a dispatch on main or with `full`, a dispatch
 * whose branch changes nothing against its base (a baseline of main), a head
 * commit with a `CI: full` trailer, or an open pull request labelled
 * `ci:full`. A push to main is compared with the commit before it; any
 * other push or dispatch with its merge base with origin/main, or with the
 * dispatch's `base`. A head commit whose `CI-local: macos <tree>` trailer
 * names its own tree (printed by `pnpm ci:local` after a green local pass)
 * skips the macOS Rust and GPUI jobs; Linux, Windows and the WebKit benchmark
 * still run.
 *
 * Usage:
 *   node scripts/ci-tier.mjs [--base REF] [--full]   print the tier as JSON
 *   node scripts/ci-tier.mjs --github                 write $GITHUB_OUTPUT
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changedFiles, rustIncludes } from "./gate-changed.mjs";
import { isMain } from "./lib/util.mjs";
import { harnessInputs } from "./perf-bench/harness-inputs.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

export const JOBS = ["vitest", "lint-build", "perf-bench", "rust", "gpui", "literature-worker", "open-slide-runtime", "research-env", "synara-pin"];
const CI_JOBS = JOBS.filter((job) => job !== "gpui");

// What `pnpm build` reads besides the sources tsc already checked: a change
// to any of them can move the bundle the budgets measure.
export const BUNDLE_INPUTS = /^(src\/|public\/(?!pdfjs\/)|index\.html$|vite\.config\.ts$|package\.json$|pnpm-lock\.yaml$|tsconfig(\.node)?\.json$|scripts\/(app-size-report|app-size-report-selftest|check-webkit-compat|private-fonts|react-compiler-suppressions)\.)/;

// What gpui.yml's path filter used to list: the GPUI workspace, the backend
// crate it shares with the Tauri app, and the design-system exports it
// generates tokens and editor themes from. Then the Tauri app's modules its
// webview islands are built from (gpui/islands/vite.config.ts).
export const GPUI_INPUTS = /^(gpui\/|src-tauri\/lattice-core\/|design-system\/(tokens\.json|code-themes\.(json|mjs)|screens\/)|src\/settings\/(code-themes|theme-customization)\.ts$|src\/editor\/(spreadsheet|board|presentation|markdown)\/|src\/canvas\/markdown-preview-sync\.ts$|src\/editor\/latex\/latex-text\.ts$|src\/(index|App)\.css$|src\/app-utils\.ts$|src\/i18n\/|src\/agent\/|src\/app\/use-synara-host\.ts$|src\/settings\/synara-settings-pane\.tsx$|src\/trellis\/(trellis-agent-surface\.tsx|trellis\.css)$|src\/app\/(git-workspace-frames\.tsx|git-repository-url\.ts|use-app-commands\.ts|key-combos\.ts|app-synara-embed\.ts|annotation-rounds\.ts|use-agent-spreadsheet-resolver\.ts|use-editor-comments\.ts|notify\.ts)$|src\/hooks\/use-latest-ref\.ts$|src\/app-types\.ts$|src\/components\/icon-tip\.tsx$|src\/components\/ui\/(motion|scroll-area)\.(tsx|css)$)/;
export const CODE_THEME_INPUTS = /^(design-system\/code-themes\.(json|mjs)|src\/settings\/(code-themes|theme-customization)\.ts)$/;

// Read by nothing that builds or tests. THIRD_PARTY_NOTICES.md is not here:
// `pnpm notices:check` verifies it and the GPUI app compiles it in. Nested
// Markdown elsewhere (the skills under src-tauri/, public/licenses/) ships.
const DOCS = /^(docs\/|gpui\/docs\/|\.github\/ISSUE_TEMPLATE\/|\.github\/[^/]+\.md$|(?!THIRD_PARTY_NOTICES\.md$)[^/]+\.md$|LICENSE$|NOTICE$)/;
const NOTICE_INPUTS = /^(package\.json|pnpm-lock\.yaml|src-tauri\/(lattice-core\/)?Cargo\.(toml|lock)|scripts\/generate-notices\.mjs|scripts\/lib\/.*\.mjs|(public\/)?licenses\/.*|THIRD_PARTY_NOTICES\.md)$/;
const PERF_EVIDENCE_INPUTS = /^(docs\/performance(\.md|-history\.md|-data\/.*)|scripts\/check-perf-evidence\.mjs)$/;
const PERF_BENCH_INPUTS = /^(scripts\/perf-bench(\.mjs|\/)|tools\/(mock-backend|perf-bench)\/|\.github\/actions\/bench-page\/)/;
const RESEARCH_ENV_INPUTS = /^(research-env\/|src-tauri\/templates\/)/;

/**
 * The paths under docs/, src-tauri/ and gpui/ that a Vitest test names in a
 * string, each with the test: a test that reads a spec, a manifest or the
 * Rust sources (the host error catalog scans src-tauri/src) sees that file
 * change. A name is read as a prefix, so a directory covers its files.
 */
function testReadPaths() {
  let out = "";
  try {
    out = git("grep", "-oE", "(docs|src-tauri|gpui)/[A-Za-z0-9_./-]+", "--", "*.test.ts", "*.test.tsx", "*.test.mjs", ":!gpui/");
  } catch {
    // git grep exits 1 when nothing matches.
  }
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf(":");
      return { test: line.slice(0, at), read: line.slice(at + 1).replace(/[./]+$/, "") };
    });
}

/** Files outside gpui/ that a GPUI .rs compiles in (THIRD_PARTY_NOTICES.md among them). */
function gpuiIncludes() {
  const includes = [];
  for (const source of git("ls-files", "-z", "gpui/crates/*.rs").split("\0").filter(Boolean)) {
    const text = readFileSync(path.join(repo, source), "utf8");
    if (!text.includes("include_")) continue;
    for (const match of text.matchAll(/\binclude_(?:str|bytes)!\(\s*"([^"]+)"/g)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(source), match[1]));
      if (!target.startsWith("gpui/") && !target.startsWith("..")) includes.push(target);
    }
  }
  return includes;
}

/**
 * The tier for these changed files: each job's flag, and the first files
 * that turned each on. When the only Vitest inputs that changed are files
 * tests name (a Rust source, a spec), `vitestFiles` lists just those tests
 * and the shards run them alone. `scan` carries what the git scans find;
 * tests pass their own.
 */
export function ciTier(files, { full = false, scan = null } = {}) {
  const jobs = Object.fromEntries(JOBS.map((job) => [job, full]));
  const why = Object.fromEntries(JOBS.map((job) => [job, full ? ["full run"] : []]));
  if (full) return { full, jobs, why, vitestFiles: [], docsOnly: false };
  const { testReads, rustTargets, gpuiTargets, harness } = scan ?? {
    testReads: testReadPaths(),
    rustTargets: rustIncludes().map(({ target, prefix }) => ({ target, prefix })),
    gpuiTargets: gpuiIncludes(),
    harness: harnessInputs(),
  };
  const harnessSet = new Set(harness);
  const vitestFiles = new Set();
  let vitestAll = false;
  const on = (job, file) => {
    jobs[job] = true;
    if (why[job].length < 5 && !why[job].includes(file)) why[job].push(file);
  };
  for (const file of files) {
    if (file === "scripts/ci-tier.mjs" || file.startsWith(".github/actions/")) {
      vitestAll = true;
      for (const job of JOBS) on(job, file);
      continue;
    }
    if (file === ".github/workflows/ci.yml") {
      vitestAll = true;
      for (const job of CI_JOBS) on(job, file);
      continue;
    }
    if (file === ".github/workflows/gpui.yml") {
      on("gpui", file);
      continue;
    }
    for (const { read, test } of testReads) {
      if (file !== read && !file.startsWith(`${read}/`)) continue;
      vitestFiles.add(test);
      on("vitest", file);
    }
    if (PERF_EVIDENCE_INPUTS.test(file) || NOTICE_INPUTS.test(file)) on("lint-build", file);
    if (DOCS.test(file)) continue;
    if (BUNDLE_INPUTS.test(file) || harnessSet.has(file) || PERF_BENCH_INPUTS.test(file)) on("perf-bench", file);
    if (GPUI_INPUTS.test(file) || gpuiTargets.includes(file)) on("gpui", file);
    if (file === "scripts/synara-runtime.json") on("synara-pin", file);
    if (RESEARCH_ENV_INPUTS.test(file)) on("research-env", file);
    if (file === "rust-toolchain.toml" || file.startsWith("src-tauri/") || rustTargets.some(({ target, prefix }) => (prefix ? file.startsWith(target) : file === target))) on("rust", file);
    if (file.startsWith("tools/open-slide-runtime/") || file === "scripts/prepare-presentation-runtime.mjs") on("open-slide-runtime", file);
    if (file.startsWith("literature-worker/")) {
      on("literature-worker", file);
      continue;
    }
    // Read by their own jobs above and by nothing the Vitest shards or the
    // lint-and-build job run, unless a test names the file.
    if (file.startsWith("gpui/") || file.startsWith("src-tauri/") || file.startsWith("research-env/") || file === "rust-toolchain.toml") continue;
    vitestAll = true;
    on("vitest", file);
    on("lint-build", file);
  }
  return { full, jobs, why, vitestFiles: vitestAll ? [] : [...vitestFiles].sort(), docsOnly: files.length > 0 && JOBS.every((job) => !jobs[job]) };
}

/** Whether a `CI-local: macos <tree>` trailer in the commit message names `tree`. */
export function localMacosPass(message, tree) {
  const match = /^CI-local:\s*macos\s+([0-9a-f]{7,40})\s*$/im.exec(message);
  return Boolean(match && tree.startsWith(match[1]));
}

/** Whether the head commit or the branch's open pull request asks for every job. */
export function wantsFull(message, labels = []) {
  return /^CI:\s*full\s*$/im.test(message) || labels.includes("ci:full");
}

function pullRequestLabels(branch) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository || !branch || !process.env.GH_TOKEN) return [];
  try {
    const owner = repository.split("/")[0];
    const out = execFileSync("gh", ["api", `repos/${repository}/pulls?state=open&head=${owner}:${branch}`, "--jq", "[.[].labels[].name]"], { encoding: "utf8" });
    return JSON.parse(out || "[]");
  } catch (error) {
    console.log(`ci-tier: could not read the branch's pull request labels (${error.message.split("\n")[0]}); going on without them`);
    return [];
  }
}

function github() {
  const event = process.env.GITHUB_EVENT_NAME;
  const ref = process.env.GITHUB_REF ?? "";
  const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "";
  const message = git("log", "-1", "--format=%B", "HEAD");
  let reason = null;
  if (ref.startsWith("refs/tags/")) reason = "a tag";
  else if (event === "schedule") reason = "the weekly run";
  else if (event === "workflow_dispatch" && process.env.INPUT_FULL === "true") reason = "a dispatch with full";
  else if (event === "workflow_dispatch" && branch === "main") reason = "a dispatch on main";
  else if (wantsFull(message, pullRequestLabels(branch))) reason = "a `CI: full` trailer or the `ci:full` label";

  let base = null;
  if (!reason && process.env.INPUT_BASE) base = git("rev-parse", "--verify", `${process.env.INPUT_BASE}^{commit}`);
  else if (!reason && event === "push" && branch === "main") {
    const before = process.env.BEFORE ?? "";
    try {
      if (!before || /^0+$/.test(before)) throw new Error("no previous commit");
      git("merge-base", "--is-ancestor", before, "HEAD");
      base = before;
    } catch {
      reason = "a push to main whose previous commit is unknown";
    }
  } else if (!reason) base = git("merge-base", "origin/main", "HEAD");

  const files = base ? git("-c", "core.quotePath=false", "diff", "--no-renames", "--name-only", base, "HEAD").split("\n").filter(Boolean) : [];
  if (!reason && event === "workflow_dispatch" && files.length === 0) reason = "a dispatch of a branch that changes nothing (a baseline)";
  const tier = ciTier(files, { full: Boolean(reason) });
  const macosLocal = !tier.full && localMacosPass(message, git("rev-parse", "HEAD^{tree}"));
  const lines = [
    reason ? `Every job: ${reason}.` : `Compared with ${base.slice(0, 9)}: ${files.length} changed file(s).`,
    ...(macosLocal ? ["The head commit's CI-local trailer names this tree, so the macOS Rust and GPUI jobs skip."] : []),
    "",
    "| jobs | run | first inputs |",
    "| --- | --- | --- |",
    ...(tier.vitestFiles.length ? [`Vitest runs only the tests that name a changed file: ${tier.vitestFiles.join(", ")}.`, ""] : []),
    ...JOBS.map((job) => `| ${job} | ${tier.jobs[job] ? "yes" : "no"} | ${tier.why[job].map((file) => `\`${file}\``).join(", ")} |`),
  ];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## CI tier\n\n${lines.join("\n")}\n`);
  const outputs = { ...tier.jobs, "vitest-files": tier.vitestFiles.join(" "), "macos-local": macosLocal, full: tier.full };
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""));
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--github")) return github();
  const base = argv.includes("--base") ? argv[argv.indexOf("--base") + 1] : "origin/main";
  const { mergeBase, files } = changedFiles(base);
  console.log(JSON.stringify({ base, mergeBase, files: files.length, ...ciTier(files, { full: argv.includes("--full") }) }, null, 2));
}

if (isMain(import.meta.url)) main();
