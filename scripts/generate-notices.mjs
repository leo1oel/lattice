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
 *
 * Usage:
 *   node scripts/generate-notices.mjs                 rewrite the generated block
 *   node scripts/generate-notices.mjs --check         fail if the block is stale
 *   node scripts/generate-notices.mjs --allow-unresolved
 *                                                     do not exit non-zero on gaps
 *
 * Exit codes: 0 ok · 1 drift (--check) · 2 unresolved attribution gaps.
 *
 * Determinism matters: --check has to give the same answer on every machine, so
 * platform-gated optional npm packages are recorded as *declared specs* rather
 * than resolved installs, and the crates closure spans all target platforms.
 * The staged runtimes are the exception — they can only be scanned where they
 * have been staged — so when one is absent its previously generated section is
 * carried over verbatim rather than clobbered. See STAGED_RUNTIMES.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { projectRoot, sha256 } from "./lib/util.mjs";

const noticesPath = join(projectRoot, "THIRD_PARTY_NOTICES.md");

const BEGIN = "<!-- BEGIN GENERATED NOTICES — do not edit below this line -->";
const END = "<!-- END GENERATED NOTICES -->";

const args = new Set(process.argv.slice(2));
if (args.has("--help") || args.has("-h")) {
  process.stdout.write(
    "Usage: node scripts/generate-notices.mjs [--check] [--allow-unresolved]\n",
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Reading licenses off disk
// ---------------------------------------------------------------------------

// A package's notice can be called any of these. NOTICE is not a license, but
// Apache-2.0 §4(d) requires it to be redistributed too, so it counts as text.
const NOTICE_FILE = /^(licen[cs]e|copying|copyright|notice|unlicen[cs]e)([-._ ].*)?$/i;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readDirectory(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Packages whose published artifact does not actually contain the license it
 * claims, so the verbatim text has to be vendored into this repository for
 * Lattice to distribute it.
 *
 * This is not a table of license texts — the text lives on disk at `file` and
 * is read from there like every other notice. All that is recorded here is
 * which package a vendored file belongs to and why it was needed. A missing
 * `file` is a hard error: silently dropping it would put us back in breach.
 *
 * `public/` is copied verbatim into `dist/` by Vite, and `tauri.conf.json` sets
 * `frontendDist: "../dist"`, so a file placed there is embedded in the shipped
 * application binary as well as in the source tree.
 */
const VENDORED_NOTICES = [
  {
    match: /^(tldraw|@tldraw\/)/,
    file: "public/licenses/tldraw-LICENSE.md",
    reason:
      "the published package ships a 104-byte LICENSE.md containing only a link, while the license it links to requires \"a verbatim copy of this License in any distribution of the Software\"",
  },
];

/**
 * True when a package's "license file" is a signpost rather than a license —
 * a line or two of prose with a URL in it. This is what decides whether a
 * vendored copy is substituted, and it has to be decided from the text rather
 * than the package name: several @tldraw/* packages declare
 * `SEE LICENSE IN LICENSE.md` but the file they point at is a real MIT license,
 * so attaching tldraw's source-available terms to them would be wrong.
 */
function isStubNotice(text) {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length > 3 || text.length > 500) return false;
  if (!/https?:\/\//.test(text)) return false;
  return !/permission is hereby granted|redistribution and use|licensed under the apache/i.test(text);
}

function readNoticeText(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  // Strip BOM and normalise line endings so the same license checked out on
  // Windows and macOS lands in the same group.
  const text = raw
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
  // A few packages ship an empty LICENSE placeholder; that is not a notice.
  return text.length > 0 ? text : null;
}

/** npm allows a string, the legacy {type,url} object, and the legacy array. */
function declaredNpmLicense(pkg) {
  if (typeof pkg.license === "string" && pkg.license.trim()) return pkg.license.trim();
  if (pkg.license && typeof pkg.license === "object" && typeof pkg.license.type === "string") {
    return pkg.license.type.trim();
  }
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses
      .map((entry) => (typeof entry === "string" ? entry : entry?.type))
      .filter((value) => typeof value === "string" && value.trim());
    if (types.length > 0) return types.join(" OR ");
  }
  return null;
}

/**
 * Build the record this script aggregates over.
 *
 * `texts` empty with a `declared` license is the interesting failure: we know
 * which license was claimed but the copyright notice the license requires us to
 * reproduce did not ship, so there is nothing to reproduce.
 */
function makeEntry({ closure, name, version, declared, dir, extraTextPaths = [], note }) {
  // Every notice-shaped file in the package's own directory, sorted for stability.
  const files = readDirectory(dir)
    .filter((entry) => !entry.isDirectory() && NOTICE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((fileName) => ({ name: fileName, path: join(dir, fileName) }));
  for (const path of extraTextPaths) {
    if (isFile(path) && !files.some((file) => file.path === path)) {
      files.unshift({ name: basename(path), path });
    }
  }
  const texts = [];
  for (const file of files) {
    const text = readNoticeText(file.path);
    if (text) texts.push({ name: file.name, text });
  }
  // Only substitute a vendored copy where the package genuinely failed to ship
  // the license — never over the top of a real one it did ship.
  let vendored = VENDORED_NOTICES.find((entry) => entry.match.test(name));
  if (vendored && texts.length > 0 && !texts.every((entry) => isStubNotice(entry.text))) {
    vendored = undefined;
  }
  const missingVendored = [];
  if (vendored) {
    const text = readNoticeText(join(projectRoot, vendored.file));
    if (text) texts.unshift({ name: vendored.file, text });
    else missingVendored.push(vendored.file);
  }
  return { closure, name, version: version ?? "(unknown)", declared, texts, note, vendored, missingVendored };
}

// ---------------------------------------------------------------------------
// Closure 1 — npm production dependencies (the web assets)
// ---------------------------------------------------------------------------

/**
 * Node's own resolution, minus the loader: look for node_modules/<name> beside
 * the requiring package and then in every parent. Works for pnpm's symlinked
 * store, npm's flat tree, and yarn alike, which is why this walks the tree
 * rather than parsing pnpm-lock.yaml.
 */
function resolveDependency(fromDir, name) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (isFile(join(candidate, "package.json"))) {
      try {
        return realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
    if (dirname(dir) === dir) return null;
  }
}

/**
 * Package roots physically nested inside `rootDir`.
 *
 * Some packages vendor their own node_modules into what they publish —
 * @pierre/diffs ships an entire pnpm store under dist/ — and those files are
 * distributed just like the package that contains them. Symlinks are skipped
 * on purpose: in a pnpm store they are the dependency edges, which the graph
 * walk already covers, and following them would drag the whole tree in.
 */
function collectNestedPackageRoots(rootDir) {
  const roots = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    const inNodeModules = basename(dir) === "node_modules";
    for (const entry of readDirectory(dir)) {
      if (!entry.isDirectory() || entry.name === ".bin") continue;
      const full = join(dir, entry.name);
      if (inNodeModules && entry.name.startsWith("@")) {
        for (const child of readDirectory(full)) {
          if (child.isDirectory()) roots.push(join(full, child.name));
        }
      } else if (inNodeModules && entry.name !== ".pnpm") {
        roots.push(full);
      }
      stack.push(full);
    }
  }
  // readdirSync order is filesystem-dependent; sort so callers see the same
  // tree on every machine.
  return roots.sort();
}

function collectNpm() {
  const rootPkg = readJson(join(projectRoot, "package.json"));
  if (!rootPkg) throw new Error("Cannot read the root package.json.");

  const entries = [];
  const visited = new Set();
  const seenIds = new Set();
  // parent -> spec pairs for optional deps we deliberately do not resolve.
  const platformOptional = new Set();
  const unresolvedRequired = [];
  const queue = Object.keys(rootPkg.dependencies ?? {}).map((name) => ({
    name,
    from: projectRoot,
    parent: rootPkg.name ?? "(root)",
    optional: false,
  }));

  const addPackage = (dir, pkg, note) => {
    const id = `${pkg.name}@${pkg.version}`;
    if (seenIds.has(id)) return;
    seenIds.add(id);
    entries.push(makeEntry({ closure: "npm", name: pkg.name, version: pkg.version, declared: declaredNpmLicense(pkg), dir, note }));
  };

  while (queue.length > 0) {
    const item = queue.shift();
    const spec = `${item.parent} → ${item.name}@${item.range ?? "*"}`;
    const dir = resolveDependency(item.from, item.name);
    if (!dir) {
      // An optional dependency that is not installed is almost always a
      // platform-gated native binary; record the declared spec so the answer is
      // the same on macOS and on Linux CI.
      if (item.optional) platformOptional.add(spec);
      else unresolvedRequired.push(`${item.parent} → ${item.name} (${item.range ?? "*"})`);
      continue;
    }
    const pkg = readJson(join(dir, "package.json"));
    if (!pkg?.name) continue;
    // Gated binaries differ per host. Treat them as declared specs, not installs.
    if (item.optional && (pkg.os || pkg.cpu)) {
      platformOptional.add(spec);
      continue;
    }
    if (visited.has(dir)) continue;
    visited.add(dir);
    addPackage(dir, pkg);

    for (const nested of collectNestedPackageRoots(dir)) {
      const nestedPkg = readJson(join(nested, "package.json"));
      if (nestedPkg?.name && nestedPkg?.version) {
        addPackage(nested, nestedPkg, `bundled inside ${pkg.name}@${pkg.version}`);
      }
    }

    const parent = `${pkg.name}@${pkg.version}`;
    const enqueue = (dependencies, optional, include = () => true) => {
      for (const [name, range] of Object.entries(dependencies ?? {})) {
        if (include(name)) queue.push({ name, range, from: dir, parent, optional });
      }
    };
    enqueue(pkg.dependencies, false);
    enqueue(pkg.optionalDependencies, true);
    // A peer is supplied by whoever installed the tree; a missing one is a
    // resolution detail, not an attribution gap, so it is not reported.
    enqueue(pkg.peerDependencies, false, (name) =>
      !pkg.peerDependenciesMeta?.[name]?.optional && resolveDependency(dir, name) !== null);
  }

  return {
    entries,
    platformOptional: [...platformOptional].sort(),
    unresolvedRequired: [...new Set(unresolvedRequired)].sort(),
  };
}

// ---------------------------------------------------------------------------
// Closure 2 — crates linked into the Rust binary
// ---------------------------------------------------------------------------

/**
 * `cargo metadata` only reads manifests — it never compiles anything — but it
 * does need each crate's source in the registry cache, so a cold run may
 * download .crate archives. That is the only network this script does.
 */
function collectCrates() {
  let raw;
  try {
    raw = execFileSync(
      "cargo",
      ["metadata", "--manifest-path", join(projectRoot, "src-tauri/Cargo.toml"), "--format-version", "1", "--locked"],
      { cwd: projectRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    throw new Error(
      `cargo metadata failed — the crates closure cannot be generated.\n${error.stderr || error.message}`,
      { cause: error },
    );
  }
  const metadata = JSON.parse(raw);
  const byId = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map((metadata.resolve?.nodes ?? []).map((node) => [node.id, node]));

  // Walk normal and build edges only. dev-dependencies are compiled for `cargo
  // test`, never linked into a shipped binary, so attributing them would
  // overstate what we distribute. Target platforms are NOT filtered: Lattice
  // ships macOS, Linux and Windows builds, and a per-host closure would make
  // --check host-dependent.
  const members = new Set(metadata.workspace_members ?? []);
  const reachable = new Set();
  const stack = [...members];
  while (stack.length > 0) {
    const id = stack.pop();
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      const kinds = dep.dep_kinds ?? [];
      if (kinds.length === 0 || kinds.some((k) => k.kind === null || k.kind === "build")) stack.push(dep.pkg);
    }
  }

  const entries = [];
  for (const id of reachable) {
    if (members.has(id)) continue; // Lattice itself; its LICENSE is the repo root.
    const pkg = byId.get(id);
    if (!pkg) continue;
    const dir = dirname(pkg.manifest_path);
    entries.push(makeEntry({
      closure: "crates",
      name: pkg.name,
      version: pkg.version,
      declared: pkg.license ?? (pkg.license_file ? `see ${pkg.license_file}` : null),
      dir,
      extraTextPaths: pkg.license_file ? [resolve(dir, pkg.license_file)] : [],
    }));
  }
  return { entries };
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
    begin: "<!-- notices:begin:presentation-runtime -->",
    end: "<!-- notices:end:presentation-runtime -->",
  },
];

function collectStaged(runtime) {
  const packageRoot = join(projectRoot, runtime.root, runtime.packageRoot);
  if (!isFile(join(packageRoot, "package.json"))) return { ...runtime, available: false, entries: [] };

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
// Classification
// ---------------------------------------------------------------------------

const PERMISSIVE = new Set([
  "0bsd", "apache-2.0", "blueoak-1.0.0", "bsd-2-clause", "bsd-3-clause", "bsl-1.0",
  "cc0-1.0", "cdla-permissive-2.0", "isc", "mit", "mit-0", "mit/x11", "python-2.0",
  "unicode-3.0", "unlicense", "wtfpl", "zlib",
]);

// Copyleft families in match order (LGPL and AGPL before the `gpl` they
// contain). A permissive alternative in the same expression makes any of them
// `dual` instead.
const COPYLEFT = [
  [/\blgpl/, "weak-copyleft", "LGPL (weak copyleft)", "LGPL offered as one alternative"],
  [/\bagpl/, "strong-copyleft", "AGPL (network copyleft)", "AGPL offered as one alternative"],
  [/\bgpl/, "strong-copyleft", "GPL (strong copyleft)", "GPL offered as one alternative"],
  [
    /\bmpl|\bepl-|\bcddl|\bcpl-|\bosl-|\beupl/,
    "weak-copyleft",
    "file-level copyleft",
    "file-level copyleft offered as one alternative",
  ],
];

/**
 * The alternative Lattice takes from a dual-licensed dependency: Apache-2.0,
 * Lattice's own license, when it is offered, else the first permissive one.
 */
function electedLicense(expression) {
  const offered = expression.replace(/[()]/g, " ").split(/\s+OR\s+|\s*\/\s*/i).map((part) => part.trim()).filter(Boolean);
  return offered.find((alt) => alt.toLowerCase() === "apache-2.0")
    ?? offered.find((alt) => PERMISSIVE.has(alt.toLowerCase()))
    ?? offered[0];
}

/** Rough top-level split of an SPDX-ish expression into its alternatives. */
function licenseAlternatives(expression) {
  return expression
    .replace(/[()]/g, " ")
    .split(/\s+OR\s+|\s*\/\s*/i)
    .map((part) => part.trim().replace(/\s+WITH\s+.*$/i, "").toLowerCase())
    .filter(Boolean);
}

/**
 * Flag anything that is not plainly permissive. For an Apache-2.0 project a
 * copyleft, an SSPL or a proprietary dependency is a real finding, and a
 * "SEE LICENSE IN ..." field means the terms are whatever that file says.
 */
function classify(entry) {
  const declared = entry.declared;
  if (!declared) return { severity: "unknown", label: "no license field" };
  const value = declared.toLowerCase();
  const combined = entry.texts.map((text) => text.text).join("\n").toLowerCase();

  if (/\bsee licen[cs]e in\b|\bunlicensed\b|\bproprietary\b|\bcustom\b/.test(value)) {
    if (/all rights reserved|no license is granted/.test(combined)) {
      return { severity: "proprietary", label: "proprietary / all rights reserved" };
    }
    // The field is non-SPDX but the file it points at turns out to be an
    // ordinary permissive license. Worth listing — the declaration is
    // misleading — but it is not a source-available dependency.
    if (/permission is hereby granted, free of charge|redistribution and use in source/.test(combined)) {
      return {
        severity: "non-spdx",
        label: "non-SPDX `license` field; the file it points at is a permissive license",
      };
    }
    return { severity: "source-available", label: "non-SPDX license reference" };
  }
  if (/\bbusl|\bbsl-1\.1|\belastic-|polyform|commons clause|\bssp?l-/.test(value)) {
    return { severity: "source-available", label: "source-available license" };
  }
  const permissiveOption = licenseAlternatives(declared).some((alt) => PERMISSIVE.has(alt));
  for (const [pattern, severity, label, dualLabel] of COPYLEFT) {
    if (pattern.test(value)) {
      return permissiveOption ? { severity: "dual", label: `${dualLabel}; Lattice elects ${electedLicense(declared)}` } : { severity, label };
    }
  }
  if (/\bofl-|open font/.test(value)) {
    return { severity: "reciprocal", label: "SIL OFL (reserved-name and bundling terms)" };
  }
  return { severity: "permissive", label: declared };
}

const SEVERITY_ORDER = [
  "proprietary", "source-available", "strong-copyleft", "weak-copyleft", "reciprocal", "dual", "non-spdx", "unknown",
];

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

// Only a line that *is* a copyright notice, not any line that mentions the
// word. Prose like "Not to remove any copyright notices from the Software"
// is part of the license body and has to stay there.
const COPYRIGHT_LINE = /^(portions\s+)?(copyright\b|\(c\)|©)/i;

/** Strip comment/markdown decoration so " * Copyright (c) X" still matches. */
function undecorate(line) {
  return line.replace(/^[\s*#>|/-]+/, "").trim();
}

const isCopyrightLine = (line) => COPYRIGHT_LINE.test(undecorate(line));

/**
 * Two hundred MIT licenses differ only in one copyright line. Grouping on the
 * license *body* with the copyright lines removed collapses them to a single
 * reproduction of the text plus the list of notices — which is what the license
 * actually requires and roughly a tenth of the bytes.
 */
function bodyKey(text) {
  const stripped = text
    .split("\n")
    .filter((line) => !isCopyrightLine(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  // A notice that is *only* a copyright line (a proprietary one-liner, say)
  // would otherwise group with every other one-liner.
  const basis = stripped.length > 40 ? stripped : text.replace(/\s+/g, " ").trim().toLowerCase();
  return sha256(basis).slice(0, 16);
}

const compareIds = (a, b) => a.localeCompare(b, "en");
const packageId = (entry) => `${entry.name}@${entry.version}`;

/** Count occurrences per key, most frequent first, ties by key. */
function rankCounts(keys) {
  const counts = new Map();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || compareIds(a[0], b[0]));
}

function groupTexts(entries) {
  const groups = new Map();
  for (const entry of entries) {
    for (const text of entry.texts) {
      const key = bodyKey(text.text);
      let group = groups.get(key);
      if (!group) {
        group = { key, text: text.text, fileName: text.name, packages: [], copyrights: new Set(), declared: [] };
        groups.set(key, group);
      }
      group.declared.push(entry.declared ?? "(no license field)");
      // Keep the longest variant as the representative: shorter ones are
      // usually the same license with a line of front matter missing. Ties break
      // lexicographically so the choice does not depend on traversal order.
      const longer = text.text.length - group.text.length;
      if (longer > 0 || (longer === 0 && text.text < group.text)) {
        group.text = text.text;
        group.fileName = text.name;
      }
      const id = packageId(entry);
      if (!group.packages.includes(id)) group.packages.push(id);
      for (const line of text.text.split("\n").map(undecorate)) {
        if (line.length > 0 && COPYRIGHT_LINE.test(line)) group.copyrights.add(line);
      }
    }
  }
  return [...groups.values()]
    .map((group) => {
      const ranked = rankCounts(group.declared);
      const label =
        ranked.length === 1 ? ranked[0][0] : `${ranked[0][0]} (+${ranked.length - 1} other declarations)`;
      return { ...group, label, packages: group.packages.sort(compareIds), copyrights: [...group.copyrights].sort() };
    })
    .sort((a, b) => b.packages.length - a.packages.length || a.key.localeCompare(b.key));
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
      group.packages.map((id) => `\`${id}\``).join(", "),
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
      "to reproduce is not available from the artifact we distribute.",
      "",
    );
    for (const entry of missingText) {
      lines.push(`- \`${packageId(entry)}\` (${entry.closure}) — declared \`${entry.declared}\``);
    }
    lines.push("");
  }
  return { markdown: lines.join("\n"), missingField, missingText };
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
    .map((entry) => ({ entry, verdict: classify(entry) }))
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
    extras: [runtimeFindings.markdown, runtimeUnresolved.markdown],
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

const started = Date.now();
const npm = collectNpm();
const crates = collectCrates();
const staged = STAGED_RUNTIMES.map(collectStaged);
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

const existing = readFileSync(noticesPath, "utf8");
const { block, flagged, missingField, missingText } = buildBlock({ npm, crates, staged, existing });
const preamble = sliceSection(existing, BEGIN, END) ? existing.slice(0, existing.indexOf(BEGIN)) : `${existing.trimEnd()}\n\n`;
const nextContent = `${preamble.trimEnd()}\n\n${block}`;

const log = (message) => process.stderr.write(`${message}\n`);
const row = (label, value, rest) => log(`${label.padEnd(23)}${String(value).padStart(4)}${rest}`);
row("npm (web assets)", npm.entries.length, " packages");
row("crates (src-tauri)", crates.entries.length, " packages");
for (const runtime of staged) {
  if (runtime.available) row(runtime.logLabel, runtime.entries.length, " packages");
  else row(runtime.logLabel, "n/a", `  — ${runtime.root}/ is not staged${runtime.carriedOver ? " (previous section kept)" : ""}`);
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
