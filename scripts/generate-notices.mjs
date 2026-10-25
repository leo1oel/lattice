#!/usr/bin/env node
/**
 * Aggregate the third-party license notices for everything Lattice ships.
 *
 * Lattice is distributed as a single application bundle that contains four
 * independent dependency closures, and the MIT/BSD families — which is most of
 * all four — require their copyright notice to travel with the binary:
 *
 *   1. npm      the production closure of the root package.json, i.e. what can
 *               end up in the web assets.
 *   2. crates   the normal+build closure of src-tauri/Cargo.toml, i.e. what is
 *               linked into the Rust binary.
 *   3. sidecar  the surviving node_modules of the Synara agent runtime staged
 *               into src-tauri/synara-runtime/ and bundled as a Tauri resource.
 *   4. slides   the Open Slide/Vite runtime staged into
 *               src-tauri/presentation-runtime/ and bundled as a Tauri resource.
 *
 * Everything here is read off disk from the *installed* packages — the
 * `license` field of each package.json plus the LICENSE/COPYING/NOTICE files
 * sitting next to it. There is deliberately no built-in table of license texts:
 * a package that ships no notice is a finding a human has to see, and inventing
 * the text for it would hide exactly the thing this script exists to surface.
 * Where the published artifact omits a text that its Git repository has,
 * `--fetch-upstream` copies the verbatim file from the commit the package was
 * published from into licenses/upstream/ (scripts/lib/upstream-licenses.mjs),
 * and every later run reads it from there.
 *
 * Usage:
 *   node scripts/generate-notices.mjs                 rewrite the generated block
 *   node scripts/generate-notices.mjs --check         fail if the block is stale
 *   node scripts/generate-notices.mjs --allow-unresolved
 *                                                     do not exit non-zero on gaps
 *   node scripts/generate-notices.mjs --fetch-upstream
 *                                                     fetch missing texts from each
 *                                                     package's repository, then rewrite
 *
 * Exit codes: 0 ok · 1 drift (--check) · 2 unresolved attribution gaps.
 *
 * Determinism matters: --check has to give the same answer on every machine, so
 * platform-gated optional npm packages are recorded as *declared specs* rather
 * than resolved installs, and the crates closure spans all target platforms.
 * The staged runtimes are the exception — they can only be scanned where they
 * have been staged — so when one is absent, or staged from inputs other than the
 * current pin, its previously generated section is carried over verbatim rather
 * than clobbered. See STAGED_RUNTIMES.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { collectCrates, collectNestedPackageRoots, collectNpm } from "./lib/dependency-closures.mjs";
import { SEVERITY_ORDER, classifyLicense } from "./lib/license-classification.mjs";
import { compareIds, groupTexts, packageId, rankCounts } from "./lib/license-grouping.mjs";
import { declaredNpmLicense, isFile, makeEntry, readDirectory, readJson } from "./lib/package-notices.mjs";
import { fetchUpstream, listUpstream, readUpstream, registryOf } from "./lib/upstream-licenses.mjs";
import { projectRoot } from "./lib/util.mjs";

const noticesPath = join(projectRoot, "THIRD_PARTY_NOTICES.md");

const BEGIN = "<!-- BEGIN GENERATED NOTICES — do not edit below this line -->";
const END = "<!-- END GENERATED NOTICES -->";

const args = new Set(process.argv.slice(2));
if (args.has("--help") || args.has("-h")) {
  process.stdout.write(
    "Usage: node scripts/generate-notices.mjs [--check] [--allow-unresolved] [--fetch-upstream]\n",
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Closures 3 and 4 — the staged runtimes bundled as Tauri resources
// ---------------------------------------------------------------------------

/**
 * Unlike the first two closures these are directories of files we literally
 * copy into the app bundle, so they are scanned rather than graph-walked:
 * whatever is on disk under node_modules is what ships, including anything a
 * package vendored inside itself.
 *
 * Both directories are gitignored and normally hold only a placeholder, so
 * absence is the common case, not an error. The findings and gap lists are
 * rendered per runtime rather than aggregated with npm and crates: aggregating
 * would make every section of the file depend on what happens to be staged,
 * and --check would fail for everyone building without the runtimes.
 *
 * A staged directory also outlives the inputs it was staged from: a recycled
 * worktree can hold a runtime prepared weeks ago, and scanning it would make
 * --check red on a clean main that CI passes. So each runtime names a
 * `staleReason` that compares the stamp its prepare script leaves behind with
 * the current pin, and a stale runtime is treated exactly like an absent one.
 */
const STAGED_RUNTIMES = [
  {
    closure: "sidecar",
    root: "src-tauri/synara-runtime",
    packageRoot: "server",
    logLabel: "synara sidecar",
    title: "Synara agent sidecar (bundled Tauri resource)",
    findingsScope: "Synara sidecar",
    unresolvedScope: "the Synara sidecar",
    blurb: (runtime) => [
      "`scripts/prepare-synara-sidecar.mjs` stages the pinned Synara server into",
      "`src-tauri/synara-runtime/`, and `tauri.conf.json` bundles that directory whole.",
      "Everything below therefore ships inside the application bundle. This closure is",
      "scanned from disk rather than resolved from a lockfile: what is in the directory",
      "is what is distributed, including packages that vendor dependencies inside",
      "themselves. It is staged on macOS, so platform-specific packages reflect that host.",
    ].join(" ") + (runtime.stagedLicenses.length > 0
      ? `\n\nThe prepare script additionally stages these notices by hand: ${runtime.stagedLicenses.map((path) => `\`${path}\``).join(", ")}.`
      : ""),
    incomplete: [
      "> **INCOMPLETE — this section has never been generated.**",
      ">",
      "> `src-tauri/synara-runtime/` was not staged when this file was written, so the",
      "> hundreds of npm packages bundled into the application as a Tauri resource are",
      "> **not attributed here**. Run `pnpm prepare:synara` and then `pnpm notices` to",
      "> fill this in. Do not ship a release built from this state.",
    ],
    // prepare-synara-sidecar.mjs records the source revision it built from,
    // suffixed `+dirty` for a development build off an uncommitted tree.
    staleReason: (runtimeRoot) => {
      const staged = readJson(join(runtimeRoot, "manifest.json"))?.synaraRevision;
      const pinned = readJson(join(projectRoot, "scripts/synara-runtime.json"))?.revision;
      return staged === pinned ? null : `staged from ${staged ?? "an unknown revision"}, pinned ${pinned}`;
    },
    begin: "<!-- notices:begin:sidecar -->",
    end: "<!-- notices:end:sidecar -->",
  },
  {
    closure: "presentation-runtime",
    root: "src-tauri/presentation-runtime",
    packageRoot: "",
    logLabel: "presentation runtime",
    title: "Open Slide presentation runtime (bundled Tauri resource)",
    findingsScope: "Open Slide runtime",
    unresolvedScope: "the Open Slide runtime",
    blurb: () =>
      "`scripts/prepare-presentation-runtime.mjs` installs the pinned Open Slide and Vite production closure into `src-tauri/presentation-runtime/`, which `tauri.conf.json` bundles whole. The staged directory is scanned directly, so this section describes exactly what is distributed.",
    incomplete: [
      "> **INCOMPLETE — stage the presentation runtime before release.**",
      ">",
      "> Run `pnpm prepare:presentation` and then `pnpm notices` to attribute the",
      "> Open Slide and Vite packages bundled with the application.",
    ],
    // prepare-presentation-runtime.mjs installs from copies of these files, so
    // the copies are the stamp.
    staleReason: (runtimeRoot) => {
      const source = join(projectRoot, "tools/open-slide-runtime");
      const changed = ["package.json", "pnpm-lock.yaml"].filter((file) => {
        try {
          return !readFileSync(join(runtimeRoot, file)).equals(readFileSync(join(source, file)));
        } catch {
          return true;
        }
      });
      return changed.length === 0 ? null : `${changed.join(" and ")} differ from tools/open-slide-runtime/`;
    },
    begin: "<!-- notices:begin:presentation-runtime -->",
    end: "<!-- notices:end:presentation-runtime -->",
  },
];

function collectStaged(runtime) {
  const packageRoot = join(projectRoot, runtime.root, runtime.packageRoot);
  if (!isFile(join(packageRoot, "package.json"))) return { ...runtime, available: false, entries: [] };
  const stale = runtime.staleReason(join(projectRoot, runtime.root));
  if (stale) return { ...runtime, available: false, stale, entries: [] };

  const entries = [];
  const seen = new Set();
  for (const dir of collectNestedPackageRoots(join(packageRoot, "node_modules"))) {
    const pkg = readJson(join(dir, "package.json"));
    if (!pkg?.name || !pkg?.version) continue;
    const id = `${pkg.name}@${pkg.version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push(makeEntry({ closure: runtime.closure, name: pkg.name, version: pkg.version, declared: declaredNpmLicense(pkg), dir }));
  }
  // The notices prepare-synara-sidecar.mjs already stages by hand. Everything in
  // that directory counts — the names it writes (`Node-LICENSE.txt`,
  // `Synara-MIT.txt`) do not match the LICENSE/COPYING shape used elsewhere.
  const stagedLicenses = readDirectory(join(projectRoot, runtime.root, "licenses"))
    .filter((entry) => entry.isFile())
    .map((entry) => `${runtime.root}/licenses/${entry.name}`)
    .sort();
  return { ...runtime, available: true, entries, stagedLicenses };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function codeBlock(text) {
  let longest = 0;
  for (const line of text.split("\n")) {
    const match = /^\s*(`{3,})/.exec(line);
    if (match) longest = Math.max(longest, match[1].length);
  }
  const marker = "`".repeat(Math.max(3, longest + 1));
  return `${marker}text\n${text}\n${marker}`;
}

const escapeCell = (value) => value.replace(/\|/g, "\\|");

function licenseTable(entries) {
  const lines = ["| Declared license | Packages |", "| --- | --- |"];
  for (const [license, count] of rankCounts(entries.map((entry) => entry.declared ?? "(no license field)"))) {
    lines.push(`| \`${escapeCell(license)}\` | ${count} |`);
  }
  return lines.join("\n");
}

function renderGroups(entries, heading) {
  const groups = groupTexts(entries);
  if (groups.length === 0) return `_No license texts were found in this closure._`;
  const out = [
    `${heading} License texts (${groups.length} distinct texts across ${entries.length} packages)`,
    "",
  ];
  groups.forEach((group, index) => {
    out.push(
      `${heading}# ${index + 1}. ${group.label} — ${group.packages.length} package(s), from \`${group.fileName}\``,
      "",
      `<details><summary>Packages sharing this text</summary>`,
      "",
      // A package that declares something other than the group's leading
      // declaration says so beside its name, so each package's own `license`
      // field stays readable here — Settings › About › Acknowledgements lists
      // packages from this file (src/settings/third-party-notices.ts).
      group.packages.map((id) => {
        const declared = group.declaredBy.get(id);
        return declared === group.primary ? `\`${id}\`` : `\`${id}\` (\`${declared}\`)`;
      }).join(", "),
      "",
      "</details>",
      "",
    );
    if (group.copyrights.length > 0) {
      out.push(`Copyright notices (${group.copyrights.length}):`, "", codeBlock(group.copyrights.join("\n")), "");
    }
    out.push(codeBlock(group.text), "");
  });
  return out.join("\n");
}

function byClosureThenName(a, b) {
  return a.closure.localeCompare(b.closure) || compareIds(packageId(a), packageId(b));
}

function renderUnresolved(all, { heading = "##", scope = "every closure" } = {}) {
  const missingField = all.filter((entry) => !entry.declared).sort(byClosureThenName);
  const missingText = all.filter((entry) => entry.declared && entry.texts.length === 0).sort(byClosureThenName);
  const lines = [`${heading} Unresolved attribution — ${scope}`, ""];
  if (missingField.length === 0 && missingText.length === 0) {
    lines.push(`Every package in ${scope} declared a license and shipped its text.`, "");
    return { markdown: lines.join("\n"), missingField, missingText };
  }
  lines.push(
    "These are the packages this generator could **not** attribute from what is",
    "installed on disk. They are listed rather than omitted: an unattributed",
    "dependency in a shipped binary is a gap, not a rounding error.",
    "",
  );
  if (missingField.length > 0) {
    lines.push(
      `${heading}# No \`license\` field at all (${missingField.length})`,
      "",
      "Nothing on disk says what the terms are. Each needs to be looked up upstream.",
      "",
    );
    for (const entry of missingField) {
      const texts = entry.texts.length > 0 ? ` — ships ${entry.texts.map((t) => `\`${t.name}\``).join(", ")}` : "";
      lines.push(`- \`${packageId(entry)}\` (${entry.closure})${texts}`);
    }
    lines.push("");
  }
  if (missingText.length > 0) {
    lines.push(
      `${heading}# Declared a license but shipped no license text (${missingText.length})`,
      "",
      "The SPDX identifier is known, but the package contains no `LICENSE`,",
      "`COPYING` or `NOTICE` file, so the copyright line those licenses require us",
      "to reproduce is not available from the artifact we distribute. Where",
      "`pnpm notices --fetch-upstream` looked for the text in the package's",
      "repository and found none, the line says what it found instead.",
      "",
    );
    for (const entry of missingText) {
      const why = entry.upstreamUnresolved ? ` — upstream: ${entry.upstreamUnresolved}` : "";
      lines.push(`- \`${packageId(entry)}\` (${entry.closure}) — declared \`${entry.declared}\`${why}`);
    }
    lines.push("");
  }
  return { markdown: lines.join("\n"), missingField, missingText };
}

/**
 * What the generator supplied from outside the package itself: texts fetched
 * from the upstream repository, and license fields recorded in
 * UNDECLARED_LICENSES. Listed with their source so each one can be checked.
 */
function renderRecovered(all, { heading = "##", scope = "npm and crates" } = {}) {
  const recovered = all.filter((entry) => entry.upstream).sort(byClosureThenName);
  const undeclared = all.filter((entry) => entry.undeclared).sort(byClosureThenName);
  if (recovered.length === 0 && undeclared.length === 0) return "";
  const lines = [];
  if (recovered.length > 0) {
    lines.push(
      `${heading} License texts recovered from upstream — ${scope} (${recovered.length})`,
      "",
      "These packages declare a license but their published artifact omits the",
      "text — usually a crate in a workspace whose LICENSE sits at the repository",
      "root, which `cargo package` does not include. The verbatim file was taken",
      "from the package's Git repository at the commit it was published from and",
      `is kept in \`licenses/upstream/\`; it is reproduced in the license texts`,
      "below like any other notice. An entry marked *default branch* was taken",
      "from the repository's current default branch instead, because no commit or",
      "tag identifies the release or the release commit had no license file; the",
      "`source.json` beside the file says which.",
      "",
    );
    for (const entry of recovered) {
      const { source } = entry.upstream;
      const files = source.files.map((file) => `[\`${file}\`](${source.repository}/blob/${source.commit}/${file})`).join(", ");
      const where = source.pinned ? `at \`${source.commit.slice(0, 12)}\`` : "— *default branch*";
      lines.push(`- \`${packageId(entry)}\` — ${files} ${where}`);
    }
    lines.push("");
  }
  if (undeclared.length > 0) {
    lines.push(
      `${heading} License fields recorded by hand — ${scope} (${undeclared.length})`,
      "",
      "These packages ship a license file but declare no `license` field. The",
      "license named here is the one their upstream states:",
      "",
    );
    for (const entry of undeclared) {
      lines.push(`- \`${packageId(entry)}\` — \`${entry.undeclared.license}\`: ${entry.undeclared.reason}.`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

const FINDINGS_INTRO = [
  "Lattice ships under Apache-2.0. Everything below is a dependency whose",
  "terms are *not* plainly permissive, listed so the interaction with that",
  "license gets an answer rather than an assumption. A `dual` row offers a",
  "permissive alternative, which Lattice elects (Apache-2.0 where offered) and",
  "names in the row; a `non-spdx` row",
  "has a misleading `license` field but a permissive license in the file it",
  "points at.",
];

function renderFindings(all, { heading = "##", scope = "all closures", note = "" } = {}) {
  const flagged = all
    .map((entry) => ({ entry, verdict: classifyLicense(entry) }))
    // `unknown` is already in the unresolved section.
    .filter(({ verdict }) => verdict.severity !== "permissive" && verdict.severity !== "unknown")
    .sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.verdict.severity) - SEVERITY_ORDER.indexOf(b.verdict.severity) ||
        byClosureThenName(a.entry, b.entry),
    );

  const lines = [
    `${heading} Copyleft, reciprocal and source-available dependencies — ${scope}`,
    "",
    ...FINDINGS_INTRO,
    "",
  ];
  if (note) lines.push(note, "");
  if (flagged.length === 0) {
    lines.push("_None found._", "");
    return { markdown: lines.join("\n"), flagged };
  }
  lines.push("| Package | Closure | Declared | Finding |", "| --- | --- | --- | --- |");
  for (const { entry, verdict } of flagged) {
    lines.push(
      `| \`${packageId(entry)}\` | ${entry.closure} | \`${escapeCell(entry.declared ?? "—")}\` | ${verdict.severity} — ${verdict.label} |`,
    );
  }
  lines.push("");

  const vendored = new Map();
  for (const entry of all) {
    if (!entry.vendored) continue;
    const record = vendored.get(entry.vendored.file) ?? { ...entry.vendored, packages: [] };
    record.packages.push(packageId(entry));
    vendored.set(entry.vendored.file, record);
  }
  if (vendored.size > 0) {
    lines.push(
      `${heading}# Vendored license texts`,
      "",
      "Some packages point at a license they do not actually ship. The text is",
      "vendored into this repository so that it is distributed with both the source",
      "and the binary (`public/` is copied into `dist/`, which `tauri.conf.json`",
      "embeds via `frontendDist`). It is reproduced below like any other notice.",
      "",
    );
    for (const record of [...vendored.values()].sort((a, b) => a.file.localeCompare(b.file))) {
      lines.push(
        `- [\`${record.file}\`](${record.file}) — for ${record.packages.sort(compareIds).map((id) => `\`${id}\``).join(", ")}, because ${record.reason}.`,
      );
    }
    lines.push("");
  }
  return { markdown: lines.join("\n"), flagged };
}

function renderClosure({ title, blurb, entries, extras = [] }) {
  const out = [
    `## ${title}`,
    "",
    blurb.replace(/[ \t]+$/gm, "").trim(),
    "",
    `**${entries.length} packages.**`,
    "",
    licenseTable(entries),
    "",
  ];
  for (const extra of extras) out.push(extra, "");
  out.push(renderGroups(entries, "###"));
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function sliceSection(content, begin, end) {
  const start = content.indexOf(begin);
  const stop = content.indexOf(end);
  if (start === -1 || stop === -1 || stop < start) return null;
  return content.slice(start, stop + end.length);
}

function npmExtras(npm) {
  const extras = [];
  if (npm.platformOptional.length > 0) {
    extras.push([
      `<details><summary>Platform-gated optional packages not resolved here (${npm.platformOptional.length})</summary>`,
      "",
      "These are `optionalDependencies` whose install is gated on `os`/`cpu` —",
      "prebuilt native binaries. Only the host's copy is ever installed, so",
      "resolving them would make this file differ per machine. They are recorded",
      "as declared specs; each is published by, and carries the license of, the",
      "parent package listed beside it.",
      "",
      ...npm.platformOptional.map((spec) => `- \`${spec}\``),
      "",
      "</details>",
    ].join("\n"));
  }
  if (npm.unresolvedRequired.length > 0) {
    extras.push([
      `> **${npm.unresolvedRequired.length} required dependencies could not be resolved on disk.**`,
      "> Run a fresh `pnpm install` before trusting this section.",
      "",
      ...npm.unresolvedRequired.map((spec) => `- \`${spec}\``),
    ].join("\n"));
  }
  return extras;
}

/**
 * The section for one staged runtime, markers included. A runtime that is not
 * staged here keeps the section someone else generated, verbatim, rather than
 * letting a contributor without it wipe that section; only a file that never
 * had one gets the INCOMPLETE stub.
 */
function stagedSection(runtime, existing, findings, unresolved) {
  if (!runtime.available) {
    const previous = sliceSection(existing, runtime.begin, runtime.end);
    if (previous && !previous.includes(runtime.incomplete[0])) {
      runtime.carriedOver = true;
      return [previous.replace(/^Lattice ships under [^\n]*\n(?:[^\n]+\n)*?points at\.$/gm, FINDINGS_INTRO.join("\n"))];
    }
    return [runtime.begin, [`## ${runtime.title}`, "", ...runtime.incomplete, ""].join("\n"), runtime.end];
  }
  const runtimeFindings = renderFindings(runtime.entries, { heading: "###", scope: runtime.findingsScope });
  const runtimeUnresolved = renderUnresolved(runtime.entries, { heading: "###", scope: runtime.unresolvedScope });
  findings.push(runtimeFindings);
  unresolved.push(runtimeUnresolved);
  const section = renderClosure({
    title: runtime.title,
    blurb: runtime.blurb(runtime),
    entries: runtime.entries,
    extras: [
      runtimeFindings.markdown,
      runtimeUnresolved.markdown,
      renderRecovered(runtime.entries, { heading: "###", scope: runtime.unresolvedScope }),
    ].filter(Boolean),
  });
  return [runtime.begin, section, runtime.end];
}

function buildBlock({ npm, crates, staged, existing }) {
  const lockedScope = [...npm.entries, ...crates.entries];
  const findings = [renderFindings(lockedScope, {
    scope: "npm and crates",
    note:
      "The Synara sidecar has its own findings block further down; it is kept separate because that closure only exists once `pnpm prepare:synara` has staged it.",
  })];
  const unresolved = [renderUnresolved(lockedScope, { scope: "npm and crates" })];
  // Rendered before the parts below read findings[0]/unresolved[0], which is
  // fine: stagedSection only appends the per-runtime results after them.
  const stagedParts = staged.flatMap((runtime) => [...stagedSection(runtime, existing, findings, unresolved), ""]);

  const parts = [
    BEGIN,
    "",
    "# Generated third-party notices",
    "",
    "Everything below this line is produced by `node scripts/generate-notices.mjs`",
    "from the packages installed on disk. **Do not edit it by hand** — run",
    "`pnpm notices` instead. `pnpm notices:check` fails if it has drifted.",
    "",
    "Each closure lists its packages by declared license, then reproduces every",
    "distinct license text once, together with all the copyright notices that",
    "share it. Grouping is by license body with the copyright lines removed and",
    "whitespace normalised, so the hundreds of MIT packages that differ only in",
    "their copyright line collapse to one reproduction of the text plus every one",
    "of their notices. Wording variants — `MIT License` versus `(The MIT License)`,",
    "or different quote characters — stay in separate groups on purpose; each",
    "group reproduces one member's file verbatim.",
    "",
    findings[0].markdown,
    unresolved[0].markdown,
    renderRecovered(lockedScope),
    renderClosure({
      title: "npm packages (web assets)",
      blurb:
        "The production dependency closure of the root `package.json` — the superset of what Vite can bundle into the shipped web assets. Dev dependencies (Vite, ESLint, Vitest, Tauri CLI) are excluded: they build the app, they are not distributed in it.",
      entries: npm.entries,
      extras: npmExtras(npm),
    }),
    renderClosure({
      title: "Rust crates (`src-tauri`)",
      blurb:
        "The normal and build dependency closure of `src-tauri/Cargo.toml`, from `cargo metadata`. `dev-dependencies` are excluded — they compile for `cargo test` and are never linked into a shipped binary. Target platforms are *not* filtered, so this covers the macOS, Linux and Windows builds alike.",
      entries: crates.entries,
    }),
    ...stagedParts,
    END,
  ];

  return {
    // A carried-over section was produced by this same collapse, so running it
    // again leaves it byte-for-byte unchanged.
    block: parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n",
    flagged: findings.flatMap((result) => result.flagged),
    missingField: unresolved.flatMap((result) => result.missingField),
    missingText: unresolved.flatMap((result) => result.missingText),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const log = (message) => process.stderr.write(`${message}\n`);
const started = Date.now();
const existing = readFileSync(noticesPath, "utf8");

/**
 * The packages --fetch-upstream should look up: every gap in the closures
 * scanned now, plus the gaps a carried-over runtime section still lists, so a
 * runtime staged elsewhere gets its texts before it is next regenerated.
 */
function upstreamTasks(entries) {
  const tasks = new Map();
  const add = (task) => tasks.set(`${task.registry}/${task.name}@${task.version}`, task);
  for (const entry of entries) {
    if (entry.declared && entry.texts.length === 0) {
      add({ registry: registryOf(entry.closure), name: entry.name, version: entry.version, dir: entry.dir, repository: entry.repository });
    }
  }
  for (const runtime of STAGED_RUNTIMES) {
    const section = sliceSection(existing, runtime.begin, runtime.end) ?? "";
    const gaps = section.slice(section.indexOf("# Declared a license but shipped no license text"));
    for (const match of gaps.matchAll(/^- `([^`]+)@([^@`]+)` \([a-z-]+\) — declared/gm)) {
      add({ registry: registryOf(runtime.closure), name: match[1], version: match[2] });
    }
  }
  return [...tasks.values()].filter((task) => !readUpstream(projectRoot, task.registry, task.name, task.version));
}

let npm = collectNpm();
let crates = collectCrates();
let staged = STAGED_RUNTIMES.map(collectStaged);
if (args.has("--fetch-upstream")) {
  const tasks = upstreamTasks([...npm.entries, ...crates.entries, ...staged.flatMap((runtime) => runtime.entries)]);
  log(`Fetching license texts from upstream for ${tasks.length} packages:`);
  const failures = await fetchUpstream(projectRoot, tasks, { log });
  log(`${tasks.length - failures.length} fetched, ${failures.length} not found.\n`);
  npm = collectNpm();
  crates = collectCrates();
  staged = STAGED_RUNTIMES.map(collectStaged);
}
const all = [...npm.entries, ...crates.entries, ...staged.flatMap((runtime) => runtime.entries)];

// A vendored notice exists precisely because the package does not ship it. If
// the file has gone missing the app is distributing that dependency with no
// license text at all, which is the one failure mode that must never be a
// warning.
const missingVendored = new Set(all.flatMap((entry) => entry.missingVendored));
if (missingVendored.size > 0) {
  for (const file of missingVendored) {
    process.stderr.write(
      `MISSING VENDORED LICENSE: ${file} — the packages that need it ship no license text.\n`,
    );
  }
  process.exit(2);
}

const { block, flagged, missingField, missingText } = buildBlock({ npm, crates, staged, existing });
const preamble = sliceSection(existing, BEGIN, END) ? existing.slice(0, existing.indexOf(BEGIN)) : `${existing.trimEnd()}\n\n`;
const nextContent = `${preamble.trimEnd()}\n\n${block}`;

const row = (label, value, rest) => log(`${label.padEnd(23)}${String(value).padStart(4)}${rest}`);
row("npm (web assets)", npm.entries.length, " packages");
row("crates (src-tauri)", crates.entries.length, " packages");
for (const runtime of staged) {
  if (runtime.available) row(runtime.logLabel, runtime.entries.length, " packages");
  else {
    const why = runtime.stale ? ` (stale: ${runtime.stale})` : "";
    row(runtime.logLabel, "n/a", `  — ${runtime.root}/ is not staged${why}${runtime.carriedOver ? " (previous section kept)" : ""}`);
  }
}
row("total", all.length, ` packages, ${Date.now() - started} ms`);

if (flagged.length > 0) {
  log("");
  log(`Non-permissive dependencies (${flagged.length}):`);
  for (const { entry, verdict } of flagged) {
    log(`  [${verdict.severity}] ${packageId(entry)} (${entry.closure}) — ${entry.declared}`);
  }
}

const gapCount = missingField.length + missingText.length;
if (gapCount > 0) {
  log("");
  log(`UNRESOLVED ATTRIBUTION (${gapCount}):`);
  for (const entry of missingField) log(`  no license field   ${packageId(entry)} (${entry.closure})`);
  for (const entry of missingText) {
    log(`  no license text    ${packageId(entry)} (${entry.closure}) — declared ${entry.declared}`);
  }
}

// A recovered text outlives the version it was fetched for; once no package
// uses it, it is only clutter. A carried-over runtime section still counts as
// a user, since that runtime may be staged again at the same versions.
const usedUpstream = new Set(all.filter((entry) => entry.upstream || entry.upstreamUnresolved).map((entry) => `${registryOf(entry.closure)}/${packageId(entry)}`));
const carriedOver = staged.filter((runtime) => !runtime.available).map((runtime) => sliceSection(existing, runtime.begin, runtime.end) ?? "").join("\n");
const unusedUpstream = listUpstream(projectRoot).filter((id) =>
  !usedUpstream.has(id) && !(id.startsWith("npm/") && carriedOver.includes(`\`${id.slice(4)}\``)));
if (unusedUpstream.length > 0) {
  log("");
  log(`Recovered license texts no package uses any more — delete them from licenses/upstream/ (${unusedUpstream.length}):`);
  for (const id of unusedUpstream) log(`  ${id}`);
}

if (args.has("--check")) {
  if (nextContent !== existing) {
    log("");
    log("THIRD_PARTY_NOTICES.md is out of date. Run `pnpm notices` and commit the result.");
    for (const runtime of staged.filter((candidate) => !candidate.available)) {
      log(`(The ${runtime.closure} section was not verified — ${runtime.root}/ is not staged.)`);
    }
    process.exit(1);
  }
  log("");
  log("THIRD_PARTY_NOTICES.md is up to date.");
} else {
  writeFileSync(noticesPath, nextContent);
  log("");
  log(`Wrote ${relative(projectRoot, noticesPath)}.`);
}

if (gapCount > 0 && !args.has("--allow-unresolved")) {
  log(`Exiting non-zero: ${gapCount} packages could not be attributed from disk.`);
  process.exit(2);
}
