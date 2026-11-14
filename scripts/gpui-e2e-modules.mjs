#!/usr/bin/env node
/**
 * `node scripts/gpui-e2e-modules.mjs`: which feature modules of the GPUI
 * `e2e` scenario a branch's change touches, for the no-mistakes test step's
 * light pass (`scripts/gpui-e2e-light.mjs`, which runs
 * `gpui/script/e2e --only <list>`: the smoke flow and those modules; see
 * `MODULES` in `gpui/crates/lattice-gpui/src/scenario/e2e/steps.rs`).
 *
 * The full scenario had grown to over 200 steps and the test step re-ran it
 * whole on every round, under the machine-wide input lock, after the worker
 * had already run it on the same head; the full run now happens once per
 * merge, in the main baseline (`scripts/gpui-main-baseline.mjs`).
 *
 * A changed path picks a module when it is the module's own scenario file
 * (`scenario/e2e/<module>.rs` or a file under `scenario/e2e/<module>/`), or
 * when it is app source the table below ties to one. Anything else, a shared
 * file such as `shell.rs` or a dependency bump among them, picks no module:
 * the smoke flow covers what every module runs on, and the baseline covers
 * the rest after the merge.
 *
 * Options:
 *   --base REF   compare against REF's merge base (default origin/main)
 *   --json       print {gpui, modules, why} instead of the --only list
 *   FILE...      classify these paths instead of the branch's diff
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCENARIO = "gpui/crates/lattice-gpui/src/scenario/e2e/";
const APP = "gpui/crates/lattice-gpui/src/";

/** Scenario files that belong to another module's run. */
const SCENARIO_ALIASES = { markdown_pages: "markdown", markdown_scroll: "markdown" };
const DOCK_STEPS = "gpui/crates/lattice-gpui/src/scenario/shell_steps.rs";

/** The scenario's modules (files under scenario/e2e/, and `dock` for scenario/shell_steps.rs). */
export const MODULES = [
  "assets",
  "build_flow",
  "design_calls",
  "dock",
  "documents",
  "editor_adapter",
  "fluid",
  "help",
  "history",
  "islands",
  "live_controls",
  "live_preview",
  "markdown",
  "narrow_window",
  "overleaf",
  "pdf",
  "saves",
  "settings",
  "source_chrome",
  "status_bar",
  "structured",
  "submission",
  "submission_checklist",
  "tab_strip",
  "tree",
];

/** App source (a prefix of its path) and the modules that exercise it. */
const SOURCE = [
  [`${APP}pdf`, ["pdf"]],
  [`${APP}live_preview`, ["live_preview"]],
  ["gpui/crates/lattice-gpui/src/shell/pdfs.rs", ["pdf"]],
  [`${APP}file_tree`, ["tree"]],
  [`${APP}assets.rs`, ["assets"]],
  [`${APP}asset_preview.rs`, ["assets"]],
  ["gpui/crates/lattice-gpui/src/shell/assets.rs", ["assets"]],
  [`${APP}history`, ["history"]],
  ["gpui/crates/lattice-gpui/src/shell/history_flow.rs", ["history"]],
  [`${APP}submission`, ["submission", "submission_checklist"]],
  [`${APP}settings`, ["settings"]],
  [`${APP}help`, ["help"]],
  [`${APP}app_log`, ["help"]],
  ["gpui/crates/lattice-settings/", ["settings"]],
  [`${APP}overleaf`, ["overleaf"]],
  ["gpui/crates/lattice-gpui/src/shell/overleaf_flow.rs", ["overleaf"]],
  [`${APP}structured`, ["structured"]],
  ["gpui/crates/lattice-gpui/src/editor_panel/structured_view.rs", ["structured"]],
  ["gpui/crates/lattice-gpui/src/editor_panel/markdown_view.rs", ["markdown"]],
  ["gpui/crates/lattice-gpui/src/editor_panel/source_chrome.rs", ["source_chrome"]],
  ["gpui/crates/lattice-gpui/src/editor_panel/strip.rs", ["tab_strip"]],
  ["gpui/crates/lattice-gpui/src/editor_panel/save.rs", ["saves"]],
  ["gpui/crates/lattice-gpui/src/editor_panel/disk_sync.rs", ["saves"]],
  ["gpui/crates/lattice-gpui/src/shell/saving.rs", ["saves"]],
  ["gpui/crates/lattice-editor/", ["editor_adapter"]],
  [`${APP}editor_status.rs`, ["status_bar"]],
  [`${APP}status_counters.rs`, ["status_bar"]],
  [`${APP}build`, ["build_flow"]],
  ["gpui/crates/lattice-gpui/src/shell/build", ["build_flow"]],
  [`${APP}titlebar`, ["narrow_window"]],
  ["gpui/crates/lattice-gpui/src/shell/documents.rs", ["documents"]],
  ["gpui/crates/lattice-webview/", ["islands", "markdown", "structured"]],
  ["gpui/islands/", ["islands", "markdown", "structured"]],
  [DOCK_STEPS, ["dock"]],
  ["gpui/crates/trellis/", ["dock"]],
  ["gpui/crates/lattice-gpui/src/shell/arrange.rs", ["dock"]],
  ["gpui/crates/lattice-gpui/src/shell/trellis_layout", ["dock"]],
];

/** The modules `files` touch, with the paths that picked each. */
export function modulesFor(files) {
  const why = new Map();
  const pick = (module, file) => {
    if (!why.has(module)) why.set(module, []);
    why.get(module).push(file);
  };
  for (const file of files) {
    if (file.startsWith(SCENARIO)) {
      const stem = file.slice(SCENARIO.length).split("/")[0].replace(/\.rs$/, "");
      const module = SCENARIO_ALIASES[stem] ?? stem;
      if (MODULES.includes(module)) pick(module, file);
      continue;
    }
    for (const [prefix, modules] of SOURCE) {
      if (file.startsWith(prefix)) for (const module of modules) pick(module, file);
    }
  }
  const modules = MODULES.filter((module) => why.has(module));
  return { gpui: files.some((file) => file.startsWith("gpui/") || file.startsWith("src-tauri/lattice-core/")), modules, why: Object.fromEntries(modules.map((module) => [module, why.get(module)])) };
}

/** Files the branch changed against `base`'s merge base, committed or not. */
export function changedFiles(base) {
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  const mergeBase = git("merge-base", base, "HEAD").trim();
  const lists = [git("diff", "--name-only", mergeBase), git("ls-files", "--others", "--exclude-standard")];
  return [...new Set(lists.join("\n").split("\n").filter(Boolean))];
}

function main() {
  const argv = process.argv.slice(2);
  let base = "origin/main";
  let json = false;
  const given = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--base") base = argv[++index];
    else if (argv[index] === "--json") json = true;
    else given.push(argv[index]);
  }
  const result = modulesFor(given.length ? given : changedFiles(base));
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  for (const [module, files] of Object.entries(result.why)) console.error(`# ${module}: ${files.join(", ")}`);
  if (!result.gpui) console.error("# no GPUI change: the e2e scenario need not run");
  console.log(result.modules.length ? result.modules.join(",") : "smoke");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
