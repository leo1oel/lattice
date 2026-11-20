/**
 * What `pnpm ci:local` (scripts/ci-local.mjs) must run on a Mac for a
 * change, what its `CI-local` trailer then certifies, and whether GitHub's
 * macOS jobs may stand down for it (scripts/ci-tier.mjs `--github`). Both
 * sides read the same tables here, so a trailer is accepted exactly when the
 * stages it records cover what the diff touches.
 *
 * The macOS job groups a trailer can stand for:
 *
 *   rust     ci.yml's macOS `rust` job: clippy -D warnings and cargo test
 *   gpui     gpui.yml's `macos` job: the release build, the unit tests and
 *            the e2e scenario, which a trailer records as `e2e=full` or as
 *            `e2e=smoke+<module>+…` (the smoke flow and those modules)
 *   webkit   ci.yml's perf-bench-webkit shards
 *
 * The e2e a change needs is the smoke flow (open, build, SyncTeX both ways,
 * edits and ⌘S, autosave, a second window, the quit that saves; every
 * `--only` pass runs it) plus, for each GPUI input the branch changes:
 *
 *   1. the module whose scenario file it is (scenario/e2e/<module>.rs or a
 *      file under scenario/e2e/<module>/);
 *   2. else the whole scenario, when an E2E_TABLE row says FULL for it:
 *      what every window is built from stays FULL even where a module's
 *      `covers` names it (gpui/patches/ for overlay_exits, lattice-ui's
 *      fonts.rs for open_failure), since a module's own run cannot show the
 *      rest of the app is unharmed;
 *   3. else the modules whose `covers` list names it
 *      (scripts/gpui-e2e-modules.mjs reads them from the scenario);
 *   4. else what the first matching E2E_TABLE row says;
 *   5. else the whole scenario. A shared file nothing maps (shell.rs)
 *      can break any module, and the trailer tells GitHub its macOS job
 *      need not run, so it runs everything.
 *
 * Release paths (RELEASE_PATHS) always take the full gate, and no trailer
 * stands for them: GitHub runs its macOS jobs whatever the commit says.
 */
import { execFileSync } from "node:child_process";
import { readModules } from "./gpui-e2e-modules.mjs";

export const FULL = "full";

// What ships or signs a release: the release workflows, the bundle
// configuration, entitlements, Info.plist and icons, the updater in both
// apps, and the scripts that fetch, sign, package, prune or publish what a
// release bundles.
export const RELEASE_PATHS =
  /^(\.github\/workflows\/(release|release-cache|gpui-package|windows-installer|macos-intel|macos-intel-retry|linux-appimage)\.yml$|src-tauri\/tauri[^/]*\.conf\.json$|src-tauri\/(Entitlements|Info)\.plist$|src-tauri\/(icons|macos)\/|gpui\/script\/fetch-pdfium$|gpui\/crates\/lattice-gpui\/src\/updater(\.rs$|\/)|src\/telemetry\/app-updater\.tsx$|scripts\/release-[^/]+\.sh$|scripts\/(add-updater-platform|normalize-updater-manifest|gpui-bundle|publish-windows-installer|bump-version|windows-package|release-notes)\.mjs$|scripts\/lib\/(codesign|windows-package|node-runtime|runtime-prune)\.mjs$)/;

const MODULE_COVERS = readModules();
// The modules that open a webview island: what a change to the Tauri
// modules the islands are built from can reach.
const ISLAND_MODULES = [...MODULE_COVERS].filter(([, covers]) => covers.some((prefix) => prefix.startsWith("gpui/islands/") || prefix.startsWith("gpui/crates/lattice-webview/"))).map(([name]) => name);
const AGENT_MODULES = [...new Set([...ISLAND_MODULES, ...[...MODULE_COVERS.keys()].filter((name) => name.startsWith("agent"))])];

/**
 * The one table from crates and paths to e2e modules: a list of modules
 * ([] for the smoke flow alone) or FULL. A FULL row wins over a module's
 * `covers`; the others apply to files no `covers` names. The first
 * matching row wins; a file no row and no `covers` matches needs FULL.
 */
export const E2E_TABLE = [
  // The scenario's own harness, runner and fixture: every module runs on them.
  [/^gpui\/crates\/lattice-gpui\/src\/scenario(\.rs$|\/)/, FULL],
  [/^gpui\/(script\/e2e|fixtures\/)/, FULL],
  // Read by no scenario step: documentation, unit tests, benches, the
  // parity report and the compatibility notes.
  [/^gpui\/.*\.md$/, []],
  [/^gpui\/crates\/[^/]+\/(tests|benches)\//, []],
  [/^gpui\/crates\/[^/]+\/src\/(.*\/)?tests?(\.rs$|\/)/, []],
  [/^gpui\/(parity|compat)\//, []],
  [/^THIRD_PARTY_NOTICES\.md$/, []],
  // What every window is built from.
  [/^gpui\/patches\//, FULL],
  [/^gpui\/(Cargo\.(toml|lock)|rust-toolchain\.toml|\.cargo\/)/, FULL],
  [/^gpui\/crates\/[^/]+\/(Cargo\.toml|build\.rs|src\/(main|lib)\.rs)$/, FULL],
  [/^gpui\/crates\/lattice-gpui\/src\/app\.rs$/, FULL],
  [/^gpui\/crates\/(lattice-ui|lattice-i18n)\//, FULL],
  [/^src-tauri\/lattice-(core|theme)\//, FULL],
  [/^design-system\//, FULL],
  [/^\.github\/workflows\/gpui\.yml$/, FULL],
  // Crates one part of the scenario exercises.
  [/^gpui\/crates\/lattice-board(-core)?\//, ["drawing_drop", "structured"]],
  [/^gpui\/crates\/lattice-webview\//, ISLAND_MODULES],
  // The Tauri app's modules the webview islands are built from
  // (gpui/islands/vite.config.ts; GPUI_INPUTS in ci-tier.mjs lists them).
  [/^src\/agent\//, AGENT_MODULES],
  [/^src\//, ISLAND_MODULES],
];

/**
 * The e2e these GPUI inputs need: `full`, or the modules beyond the smoke
 * flow, with the files behind each choice.
 */
export function e2eNeeds(gpuiFiles, covers = MODULE_COVERS) {
  const scenario = "gpui/crates/lattice-gpui/src/scenario/e2e/";
  const why = {};
  const fullBecause = [];
  for (const file of gpuiFiles) {
    const picked = new Set();
    const stem = file.startsWith(scenario) ? file.slice(scenario.length).split("/")[0].replace(/\.rs$/, "") : null;
    if (stem && covers.has(stem)) picked.add(stem);
    else if (E2E_TABLE.some(([pattern, need]) => need === FULL && pattern.test(file))) {
      fullBecause.push(file);
      continue;
    }
    if (!picked.size) {
      for (const [module, prefixes] of covers) {
        if (prefixes.some((prefix) => file.startsWith(prefix))) picked.add(module);
      }
    }
    if (!picked.size) {
      const row = E2E_TABLE.find(([pattern]) => pattern.test(file));
      if (!row || row[1] === FULL) {
        fullBecause.push(file);
        continue;
      }
      for (const module of row[1]) picked.add(module);
    }
    for (const module of picked) (why[module] ??= []).push(file);
  }
  return { full: fullBecause.length > 0, modules: Object.keys(why).sort(), why, fullBecause };
}

/** What each macOS job group needs for this tier (`ciTier` in scripts/ci-tier.mjs) and its files. */
export function macosNeeds(tier, files) {
  return {
    rust: tier.jobs.rust,
    gpui: tier.jobs.gpui,
    e2e: !tier.jobs.gpui ? null : tier.full ? { full: true, modules: [], why: {}, fullBecause: ["full run"] } : e2eNeeds(tier.gpuiFiles),
    webkit: tier.jobs["perf-bench"],
    release: files.filter((file) => RELEASE_PATHS.test(file)),
  };
}

/** The trailer for a pass that ran these groups: `CI-local: macos <tree> rust gpui e2e=… webkit [regate=<sha>]`. */
export function formatTrailer(tree, cover) {
  const e2e = cover.e2e === FULL ? "e2e=full" : cover.e2e ? `e2e=${["smoke", ...cover.e2e].join("+")}` : null;
  const tokens = [cover.rust && "rust", cover.gpui && "gpui", cover.gpui && e2e, cover.webkit && "webkit", cover.regate && `regate=${cover.regate}`].filter(Boolean);
  return `CI-local: macos ${tree}${tokens.length ? ` ${tokens.join(" ")}` : ""}`;
}

/**
 * The last `CI-local: macos` trailer in a commit message (`line` is the
 * trailer itself), or null. One that
 * names only the tree, as ci:local printed before it recorded its stages,
 * stands for every macOS job, as it did then.
 */
export function parseTrailer(message) {
  const lines = [...message.matchAll(/^CI-local:[ \t]*macos[ \t]+([0-9a-f]{7,40})((?:[ \t]+[a-z0-9=+_-]+)*)[ \t]*$/gim)];
  if (!lines.length) return null;
  const [line, tree, rest] = lines.at(-1);
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { line, tree, rust: true, gpui: true, e2e: FULL, webkit: true, regate: null, legacy: true };
  const cover = { line, tree, rust: false, gpui: false, e2e: null, webkit: false, regate: null, legacy: false };
  for (const token of tokens) {
    if (token === "rust" || token === "gpui" || token === "webkit") cover[token] = true;
    else if (token === "e2e=full") cover.e2e = FULL;
    else if (token.startsWith("e2e=")) cover.e2e = token.slice(4).split("+").filter((module) => module && module !== "smoke");
    else if (token.startsWith("regate=")) cover.regate = token.slice(7);
  }
  return cover;
}

/** Whether a recorded e2e stands for the one a change needs. */
export function e2eCovered(recorded, needed) {
  if (!needed || recorded === FULL) return true;
  if (!recorded || needed.full) return false;
  return needed.modules.every((module) => recorded.includes(module));
}

/**
 * Which macOS job groups a trailer lets GitHub skip, each with the reason
 * when it cannot. A group the change does not need counts as covered.
 */
export function coveredJobs(cover, needs) {
  const result = {};
  for (const group of ["rust", "gpui", "webkit"]) {
    let reason = null;
    if (!needs[group]) reason = null;
    else if (!cover) reason = "no CI-local trailer names this tree";
    else if (needs.release.length) reason = `release paths changed (${needs.release.slice(0, 3).join(", ")})`;
    else if (!cover[group]) reason = `the trailer records no ${group} stage`;
    else if (group === "gpui" && !e2eCovered(cover.e2e, needs.e2e)) {
      reason = needs.e2e.full ? `the change needs the whole e2e (${needs.e2e.fullBecause.slice(0, 3).join(", ")})` : `the trailer's e2e lacks ${needs.e2e.modules.filter((module) => !cover.e2e?.includes(module)).join(", ")}`;
    }
    result[group] = reason ? { covered: false, reason } : { covered: true };
  }
  return result;
}

const gitIn = (cwd) => (...args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).trim();

/**
 * Whether HEAD is a passing gate plus merges of main and nothing else, so a
 * build-and-unit-test pass can re-certify it. Walks HEAD's first parents
 * back to the newest commit whose CI-local trailer names its own tree (the
 * gate), and holds when:
 *
 *   - HEAD and every commit after the gate is a merge whose second parent
 *     is on `base` (origin/main);
 *   - no file the branch changes (the gate against its merge base with the
 *     newest merged main commit) is one main changed in between;
 *   - HEAD's tree is the clean merge of the gate and that main commit
 *     (`git merge-tree`), so nothing was edited by hand in the merge.
 *
 * Returns `{ ok: true, gate, cover, mainCommit, branchFiles }`, or
 * `{ ok: false, reason }`.
 */
export function mainMergeRegate({ base = "origin/main", cwd = process.cwd(), maxMerges = 20 } = {}) {
  const git = gitIn(cwd);
  const parents = (sha) => git("rev-list", "--parents", "-n", "1", sha).split(/\s+/).slice(1);
  const head = git("rev-parse", "HEAD");
  let commit = head;
  let mainCommit = null;
  for (let merges = 0; merges <= maxMerges; merges += 1) {
    const cover = parseTrailer(git("log", "-1", "--format=%B", commit));
    if (cover && git("rev-parse", `${commit}^{tree}`).startsWith(cover.tree)) {
      if (commit === head) return { ok: false, reason: "HEAD carries a trailer for its own tree already" };
      const branchBase = git("merge-base", commit, mainCommit);
      const list = (from, to) => git("-c", "core.quotePath=false", "diff", "--no-renames", "--name-only", from, to).split("\n").filter(Boolean);
      const branchFiles = list(branchBase, commit);
      const mainFiles = new Set(list(branchBase, mainCommit));
      const overlap = branchFiles.filter((file) => mainFiles.has(file));
      if (overlap.length) return { ok: false, reason: `main changed ${overlap.length} file(s) the branch changes too (${overlap.slice(0, 3).join(", ")})` };
      let merged;
      try {
        merged = git("merge-tree", "--write-tree", commit, mainCommit).split("\n")[0];
      } catch {
        return { ok: false, reason: "the gate and main do not merge cleanly" };
      }
      if (merged !== git("rev-parse", "HEAD^{tree}")) return { ok: false, reason: "HEAD's tree is not the clean merge of the gate and main" };
      return { ok: true, gate: commit, cover, mainCommit, branchFiles };
    }
    const [first, second, ...more] = parents(commit);
    if (!second || more.length) return { ok: false, reason: commit === head ? "HEAD is not a merge" : `${commit.slice(0, 9)} is neither a passing gate nor a merge of main` };
    try {
      git("merge-base", "--is-ancestor", second, base);
    } catch {
      return { ok: false, reason: `${commit.slice(0, 9)} merges ${second.slice(0, 9)}, which is not on ${base}` };
    }
    mainCommit ??= second;
    commit = first;
  }
  return { ok: false, reason: `no passing gate within ${maxMerges} merges of HEAD` };
}
