#!/usr/bin/env node
/**
 * `pnpm signoff`: an optional local check of a branch's changes, recorded on
 * the pull request as an informational green `signoff` commit status on the
 * exact commit it checked (docs/agent-validation.md). Pull requests run no CI
 * and nothing requires this status; ci.yml and gpui.yml run for a release
 * tag, weekly on main, and by hand.
 *
 * It runs `pnpm gate:changed`'s stages (lint, knip, tsc, i18n, perf evidence,
 * notices, rustfmt, `vitest related` plus the invariant tests), then, each
 * only when the branch changed its inputs against the merge base:
 *
 *   synara-pin  `check-synara-pin.mjs` against the merge base, when the
 *               Synara pin moved
 *   bundle      the production build's WebKit check and startup budgets
 *               (`app-size-report --check`, the eager-JS budget among them)
 *   harness     `pnpm test:e2e-harness`, when an input of the bench harness
 *               changed (bench-harness.yml no longer runs on its own)
 *   clippy      clippy with warnings denied over the Tauri crates
 *   cargo-test  the changed Tauri crates' tests (`research-writer` alone
 *               when lattice-core is untouched, both otherwise)
 *   gpui-*      the GPUI app, when gpui/ or what it reads changed: code
 *               themes, patches, rustfmt, the release build, the unit tests
 *               (TeX ones included), and the e2e scenario on a scratch
 *               fixture with a scratch HOME (gpui/script/e2e)
 *
 * The host has 16 GB of memory, so cargo gets CARGO_BUILD_JOBS=4 unless the
 * caller set it, and every stage that compiles Rust (clippy, cargo-test, the
 * GPUI release build and tests; several GB of rustc per job) runs in the
 * machine's shared build tree under its machine-wide lock
 * (scripts/gpui-build.mjs): two builds at once, from two worktrees, swapped
 * the machine to a crawl, and each worktree's own build started cold and left
 * a multi-GB target/ behind in it.
 *
 * Every stage runs, so one pass shows every red. When all pass, the working
 * tree is clean and HEAD is pushed, it signs off with basecamp/gh-signoff
 * (`gh extension install basecamp/gh-signoff`), or with the same commit status
 * through `gh api` when the extension is missing.
 *
 * Options:
 *   --base REF     compare against REF instead of origin/main (its merge base)
 *   --no-status    run the checks only; record nothing
 *   --gpui         run the GPUI stages even when nothing they read changed
 */
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changedFiles, gateStages, runStages, rustIncludes } from "./gate-changed.mjs";
import { harnessInputs } from "./perf-bench/harness-inputs.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

function parseArgs(argv) {
  const options = { base: "origin/main", status: true, gpui: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--base") options.base = argv[++index];
    else if (argv[index] === "--no-status") options.status = false;
    else if (argv[index] === "--gpui") options.gpui = true;
    else throw new Error(`Unknown option ${argv[index]}`);
  }
  return options;
}

// What `pnpm build` reads besides the sources tsc already checked: a change
// to any of them can move the bundle the budgets measure.
const BUNDLE_INPUTS = /^(src\/|public\/(?!pdfjs\/)|index\.html$|vite\.config\.ts$|package\.json$|pnpm-lock\.yaml$|tsconfig(\.node)?\.json$|scripts\/(app-size-report|app-size-report-selftest|check-webkit-compat|private-fonts|react-compiler-suppressions)\.)/;

// What gpui.yml's path filter used to list: the GPUI workspace, the backend
// crate it shares with the Tauri app, and the design-system exports it
// generates tokens and editor themes from. Then the Tauri app's modules its
// webview islands are built from (gpui/islands/vite.config.ts).
const GPUI_INPUTS = /^(gpui\/|src-tauri\/lattice-core\/|design-system\/(tokens\.json|code-themes\.(json|mjs)|screens\/)|src\/settings\/(code-themes|theme-customization)\.ts$|src\/editor\/(spreadsheet|board|presentation|markdown)\/|src\/canvas\/markdown-preview-sync\.ts$|src\/editor\/latex\/latex-text\.ts$|src\/(index|App)\.css$|src\/app-utils\.ts$|src\/i18n\/)/;
const CODE_THEME_INPUTS = /^(design-system\/code-themes\.(json|mjs)|src\/settings\/(code-themes|theme-customization)\.ts)$/;

function extraStages(files, mergeBase, options) {
  const cargoEnv = { CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "4" };
  const harness = new Set(harnessInputs());
  const included = rustIncludes().filter(({ target, prefix }) => files.some((file) => (prefix ? file.startsWith(target) : file === target)));
  const tauri = files.some((file) => file.startsWith("src-tauri/")) || included.length > 0;
  const core = files.some((file) => file.startsWith("src-tauri/lattice-core/"));
  const gpui = options.gpui || files.some((file) => GPUI_INPUTS.test(file));
  const gpuiStage = (stage) => (gpui ? { cwd: "gpui", env: cargoEnv, ...stage } : { name: stage.name, skip: "nothing the GPUI app reads changed" });
  const features = ["--features", "lattice-gpui/offscreen-shots"];

  return [
    files.includes("scripts/synara-runtime.json")
      ? { name: "synara-pin", why: "the pin is on its fork branch and descends from the base's", command: "node", args: ["scripts/check-synara-pin.mjs", mergeBase], timeout: 300_000 }
      : { name: "synara-pin", skip: "the Synara pin did not move" },
    files.some((file) => BUNDLE_INPUTS.test(file))
      ? {
          name: "bundle",
          why: "production build, WebKit compatibility and the startup budgets",
          command: "sh",
          args: ["-c", "pnpm exec vite build --logLevel warn && node scripts/check-webkit-compat.mjs && node scripts/app-size-report.mjs --check && pnpm size:test"],
          timeout: 600_000,
        }
      : { name: "bundle", skip: "nothing the production bundle reads changed" },
    files.some((file) => harness.has(file) || file.startsWith("tools/mock-backend/") || file.startsWith("tools/perf-bench/"))
      ? { name: "harness", why: "the bench page's serve, smoke and cleanup", command: "pnpm", args: ["test:e2e-harness"], timeout: 600_000 }
      : { name: "harness", skip: "no bench harness input changed" },
    tauri
      ? {
          name: "clippy",
          why: "Tauri crates, warnings denied",
          command: "node",
          args: ["scripts/gpui-build.mjs", "--", "clippy", "--manifest-path", "src-tauri/Cargo.toml", "--all-targets", "--all-features", "--", "-D", "warnings"],
          env: cargoEnv,
          timeout: 1_200_000,
        }
      : { name: "clippy", skip: "nothing the Tauri crates compile changed" },
    tauri
      ? {
          name: "cargo-test",
          why: core ? "research-writer and lattice-core" : "research-writer (lattice-core unchanged)",
          command: "node",
          args: ["scripts/gpui-build.mjs", "--", "test", "--manifest-path", "src-tauri/Cargo.toml", ...(core ? [] : ["--package", "research-writer"])],
          env: cargoEnv,
          timeout: 1_200_000,
        }
      : { name: "cargo-test", skip: "nothing the Tauri crates compile changed" },
    gpui && files.some((file) => CODE_THEME_INPUTS.test(file))
      ? { name: "gpui-theme", why: "code-themes.json against the app's themes", command: "node", args: ["design-system/code-themes.mjs", "--check"], timeout: 60_000 }
      : { name: "gpui-theme", skip: "no code theme input changed" },
    gpui && files.some((file) => file.startsWith("gpui/patches/") || file === "gpui/script/check-patches")
      ? gpuiStage({ name: "gpui-patch", why: "patched crates against their upstream pins", command: "script/check-patches", args: [], timeout: 600_000 })
      : { name: "gpui-patch", skip: "gpui/patches unchanged" },
    gpuiStage({ name: "gpui-fmt", why: "rustfmt over the GPUI workspace", command: "cargo", args: ["fmt", "--all", "--", "--check"], timeout: 120_000 }),
    // Both build in the machine's shared GPUI tree (scripts/gpui-build.mjs),
    // which takes the machine-wide lock itself.
    gpuiStage({
      name: "gpui-build",
      why: "release build with offscreen-shots, in the shared build tree",
      command: "node",
      args: ["../scripts/gpui-build.mjs", "--", "build", "--release", "--locked", ...features],
      timeout: 3_600_000,
    }),
    gpuiStage({
      name: "gpui-test",
      why: "unit tests in release, TeX ones included",
      command: "node",
      args: ["../scripts/gpui-build.mjs", "--", "test", "--release", "--locked", "--workspace", ...features, "--", "--include-ignored"],
      env: { ...cargoEnv, PATH: `${process.env.PATH}:/Library/TeX/texbin` },
      timeout: 1_800_000,
      needs: "gpui-build",
    }),
    gpuiStage({ name: "gpui-e2e", why: "e2e scenario, scratch fixture and HOME", command: "script/e2e", args: [], timeout: 900_000, needs: "gpui-build" }),
  ];
}

/**
 * Signs off on HEAD. A status names a commit, so the tree must be exactly that
 * commit (nothing uncommitted, nothing untracked that a stage could have read)
 * and the commit must be on GitHub for the status to attach to.
 */
function recordStatus(summary) {
  const dirty = git("status", "--porcelain");
  if (dirty) {
    console.log("signoff: not recorded; the working tree has uncommitted changes, so no commit is what was checked");
    return false;
  }
  const sha = git("rev-parse", "HEAD");
  const extension = spawnSync("gh", ["signoff", "--help"], { cwd: repo, stdio: "ignore" }).status === 0;
  const result = extension
    ? spawnSync("gh", ["signoff"], { cwd: repo, stdio: "inherit" })
    : spawnSync(
        "gh",
        ["api", "--method", "POST", `repos/{owner}/{repo}/statuses/${sha}`, "-f", "state=success", "-f", "context=signoff", "-f", `description=${summary}`],
        { cwd: repo, stdio: ["ignore", "ignore", "inherit"] },
      );
  if (result.status !== 0) {
    console.log(`signoff: recording the status on ${sha.slice(0, 9)} failed; push the branch, then run \`gh signoff\``);
    return false;
  }
  console.log(`signoff: recorded a green \`signoff\` status on ${sha.slice(0, 9)}${extension ? " (gh-signoff)" : ""}`);
  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const { mergeBase, files } = changedFiles(options.base);
  console.log(`signoff: ${files.length} changed file(s) against ${options.base} (${mergeBase.slice(0, 9)})`);
  const stages = [...gateStages(files), ...extraStages(files, mergeBase, options)];
  const failed = await runStages(stages);
  const minutes = ((Date.now() - started) / 60_000).toFixed(1);
  if (failed) {
    console.log(`signoff: ${failed} stage(s) failed in ${minutes} min; nothing recorded`);
    process.exitCode = 1;
    return;
  }
  const ran = stages.filter((stage) => !stage.skip).map((stage) => stage.name);
  console.log(`signoff: all ${ran.length} stages passed in ${minutes} min`);
  if (options.status && !recordStatus(`${ran.length} local stages passed in ${minutes} min`)) process.exitCode = 1;
}

await main().catch((error) => {
  console.error(`signoff: ${error.message}`);
  process.exit(1);
});
