#!/usr/bin/env node
/**
 * Aggregate the third-party license notices for everything Lattice ships.
 *
 * Lattice is distributed as a single application bundle that contains three
 * independent dependency closures, and the MIT/BSD families — which is most of
 * all three — require their copyright notice to travel with the binary:
 *
 *   1. npm      the production closure of the root package.json, i.e. what can
 *               end up in the web assets.
 *   2. crates   the normal+build closure of src-tauri/Cargo.toml, i.e. what is
 *               linked into the Rust binary.
 *   3. sidecar  the surviving node_modules of the Synara agent runtime staged
 *               into src-tauri/synara-runtime/ and bundled as a Tauri resource.
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
 *   node scripts/generate-notices.mjs --stdout        print the block, write nothing
 *   node scripts/generate-notices.mjs --allow-unresolved
 *                                                     do not exit non-zero on gaps
 *
 * Exit codes: 0 ok · 1 drift (--check) · 2 unresolved attribution gaps.
 *
 * Determinism matters: --check has to give the same answer on every machine, so
 * platform-gated optional npm packages are recorded as *declared specs* rather
 * than resolved installs, and the crates closure spans all target platforms.
 * The sidecar closure is the one exception — it can only be scanned where it
 * has been staged — so when it is absent the previously generated section is
 * carried over verbatim rather than clobbered. See collectSidecar().
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const noticesPath = join(projectRoot, "THIRD_PARTY_NOTICES.md");

const BEGIN = "<!-- BEGIN GENERATED NOTICES — do not edit below this line -->";
const END = "<!-- END GENERATED NOTICES -->";
const SIDECAR_BEGIN = "<!-- notices:begin:sidecar -->";
const SIDECAR_END = "<!-- notices:end:sidecar -->";

const args = new Set(process.argv.slice(2));
const checkMode = args.has("--check");
const stdoutMode = args.has("--stdout");
const allowUnresolved = args.has("--allow-unresolved");
if (args.has("--help") || args.has("-h")) {
  process.stdout.write(
    "Usage: node scripts/generate-notices.mjs [--check] [--stdout] [--allow-unresolved]\n",
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

/** Every notice-shaped file in a package's own directory, sorted for stability. */
function findNoticeFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => !entry.isDirectory() && NOTICE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, path: join(dir, name) }));
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

function vendoredNoticeFor(name) {
  return VENDORED_NOTICES.find((entry) => entry.match.test(name));
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
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
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
  const files = findNoticeFiles(dir);
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
  let vendored = vendoredNoticeFor(name);
  if (vendored && texts.length > 0 && !texts.every((entry) => isStubNotice(entry.text))) {
    vendored = undefined;
  }
  const missingVendored = [];
  if (vendored) {
    const path = join(projectRoot, vendored.file);
    const text = readNoticeText(path);
    if (text) texts.unshift({ name: vendored.file, text });
    else missingVendored.push(vendored.file);
  }
  return {
    closure,
    name,
    version: version ?? "(unknown)",
    declared,
    texts,
    note,
    vendored,
    missingVendored,
  };
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
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (isFile(join(candidate, "package.json"))) {
      try {
        return realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
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
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const inNodeModules = basename(dir) === "node_modules";
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === ".bin") continue;
      const full = join(dir, entry.name);
      if (inNodeModules && entry.name.startsWith("@")) {
        let scoped;
        try {
          scoped = readdirSync(full, { withFileTypes: true });
        } catch {
          scoped = [];
        }
        for (const child of scoped) {
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
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    entries.push(
      makeEntry({
        closure: "npm",
        name: pkg.name,
        version: pkg.version,
        declared: declaredNpmLicense(pkg),
        dir,
        note,
      }),
    );
    return true;
  };

  while (queue.length > 0) {
    const item = queue.shift();
    const dir = resolveDependency(item.from, item.name);
    if (!dir) {
      // An optional dependency that is not installed is almost always a
      // platform-gated native binary; record the declared spec so the answer is
      // the same on macOS and on Linux CI.
      if (item.optional) platformOptional.add(`${item.parent} → ${item.name}@${item.range ?? "*"}`);
      else unresolvedRequired.push(`${item.parent} → ${item.name} (${item.range ?? "*"})`);
      continue;
    }
    const pkg = readJson(join(dir, "package.json"));
    if (!pkg?.name) continue;
    // Gated binaries differ per host. Treat them as declared specs, not installs.
    if (item.optional && (pkg.os || pkg.cpu)) {
      platformOptional.add(`${item.parent} → ${item.name}@${item.range ?? "*"}`);
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

    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
      queue.push({ name, range, from: dir, parent: `${pkg.name}@${pkg.version}`, optional: false });
    }
    for (const [name, range] of Object.entries(pkg.optionalDependencies ?? {})) {
      queue.push({ name, range, from: dir, parent: `${pkg.name}@${pkg.version}`, optional: true });
    }
    const peerMeta = pkg.peerDependenciesMeta ?? {};
    for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
      if (peerMeta[name]?.optional) continue;
      // A peer is supplied by whoever installed the tree; a missing one is a
      // resolution detail, not an attribution gap, so it is not reported.
      const peerDir = resolveDependency(dir, name);
      if (peerDir) {
        queue.push({ name, range, from: dir, parent: `${pkg.name}@${pkg.version}`, optional: false });
      }
    }
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
      [
        "metadata",
        "--manifest-path",
        join(projectRoot, "src-tauri/Cargo.toml"),
        "--format-version",
        "1",
        "--locked",
      ],
      { cwd: projectRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    throw new Error(
      `cargo metadata failed — the crates closure cannot be generated.\n${error.stderr || error.message}`,
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
      const linked = kinds.length === 0 || kinds.some((k) => k.kind === null || k.kind === "build");
      if (linked) stack.push(dep.pkg);
    }
  }

  const entries = [];
  for (const id of reachable) {
    if (members.has(id)) continue; // Lattice itself; its LICENSE is the repo root.
    const pkg = byId.get(id);
    if (!pkg) continue;
    const dir = dirname(pkg.manifest_path);
    const extraTextPaths = pkg.license_file ? [resolve(dir, pkg.license_file)] : [];
    entries.push(
      makeEntry({
        closure: "crates",
        name: pkg.name,
        version: pkg.version,
        declared: pkg.license ?? (pkg.license_file ? `see ${pkg.license_file}` : null),
        dir,
        extraTextPaths,
      }),
    );
  }
  return { entries };
}

// ---------------------------------------------------------------------------
// Closure 3 — the staged Synara sidecar
// ---------------------------------------------------------------------------

/**
 * Unlike the other two closures this one is a directory of files we literally
 * copy into the app bundle, so it is scanned rather than graph-walked: whatever
 * is on disk under server/node_modules is what ships, including anything a
 * package vendored inside itself.
 *
 * src-tauri/synara-runtime/ is gitignored and normally holds only
 * placeholder.txt, so absence is the common case, not an error.
 */
function collectSidecar() {
  const runtimeRoot = join(projectRoot, "src-tauri/synara-runtime");
  const serverRoot = join(runtimeRoot, "server");
  const modulesRoot = join(serverRoot, "node_modules");
  if (!isFile(join(serverRoot, "package.json"))) {
    return { available: false, entries: [], staged: [] };
  }

  const entries = [];
  const seen = new Set();
  for (const dir of collectNestedPackageRoots(modulesRoot).sort()) {
    const pkg = readJson(join(dir, "package.json"));
    if (!pkg?.name || !pkg?.version) continue;
    const id = `${pkg.name}@${pkg.version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push(
      makeEntry({
        closure: "sidecar",
        name: pkg.name,
        version: pkg.version,
        declared: declaredNpmLicense(pkg),
        dir,
      }),
    );
  }

  // The notices prepare-synara-sidecar.mjs already stages by hand. Everything in
  // that directory counts — the names it writes (`Node-LICENSE.txt`,
  // `Synara-MIT.txt`) do not match the LICENSE/COPYING shape used elsewhere.
  let staged = [];
  try {
    staged = readdirSync(join(runtimeRoot, "licenses"), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => `src-tauri/synara-runtime/licenses/${entry.name}`)
      .sort();
  } catch {
    staged = [];
  }
  return { available: true, entries, staged };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

const PERMISSIVE = new Set([
  "0bsd",
  "apache-2.0",
  "blueoak-1.0.0",
  "bsd-2-clause",
  "bsd-3-clause",
  "bsl-1.0",
  "cc0-1.0",
  "cdla-permissive-2.0",
  "isc",
  "mit",
  "mit-0",
  "mit/x11",
  "python-2.0",
  "unicode-3.0",
  "unlicense",
  "wtfpl",
  "zlib",
]);

/** Rough top-level split of an SPDX-ish expression into its alternatives. */
function licenseAlternatives(expression) {
  return expression
    .replace(/[()]/g, " ")
    .split(/\s+OR\s+|\s*\/\s*/i)
    .map((part) => part.trim().replace(/\s+WITH\s+.*$/i, "").toLowerCase())
    .filter(Boolean);
}

/**
 * Flag anything that is not plainly permissive. For a GPL-3.0-or-later project
 * an AGPL, an SSPL or a proprietary dependency is a real finding, and a
 * "SEE LICENSE IN ..." field means the terms are whatever that file says.
 */
function classify(entry) {
  const declared = entry.declared;
  if (!declared) return { severity: "unknown", label: "no license field" };
  const value = declared.toLowerCase();
  const combined = entry.texts.map((text) => text.text).join("\n").toLowerCase();

  const alternatives = licenseAlternatives(declared);
  const permissiveOption = alternatives.some((alt) => PERMISSIVE.has(alt));

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
  if (/\blgpl/.test(value)) {
    return {
      severity: permissiveOption ? "dual" : "weak-copyleft",
      label: permissiveOption ? "LGPL offered as one alternative" : "LGPL (weak copyleft)",
    };
  }
  if (/\bagpl/.test(value)) {
    return {
      severity: permissiveOption ? "dual" : "strong-copyleft",
      label: permissiveOption ? "AGPL offered as one alternative" : "AGPL (network copyleft)",
    };
  }
  if (/\bgpl/.test(value)) {
    return {
      severity: permissiveOption ? "dual" : "strong-copyleft",
      label: permissiveOption ? "GPL offered as one alternative" : "GPL (strong copyleft)",
    };
  }
  if (/\bmpl|\bepl-|\bcddl|\bcpl-|\bosl-|\beupl/.test(value)) {
    return {
      severity: permissiveOption ? "dual" : "weak-copyleft",
      label: permissiveOption ? "file-level copyleft offered as one alternative" : "file-level copyleft",
    };
  }
  if (/\bofl-|open font/.test(value)) {
    return { severity: "reciprocal", label: "SIL OFL (reserved-name and bundling terms)" };
  }
  return { severity: "permissive", label: declared };
}

const SEVERITY_ORDER = [
  "proprietary",
  "source-available",
  "strong-copyleft",
  "weak-copyleft",
  "reciprocal",
  "dual",
  "non-spdx",
  "unknown",
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

function isCopyrightLine(line) {
  return COPYRIGHT_LINE.test(undecorate(line));
}

function copyrightLines(text) {
  return text
    .split("\n")
    .map((line) => undecorate(line))
    .filter((line) => line.length > 0 && COPYRIGHT_LINE.test(line));
}

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
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

function groupTexts(entries) {
  const groups = new Map();
  for (const entry of entries) {
    for (const text of entry.texts) {
      const key = bodyKey(text.text);
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          text: text.text,
          fileName: text.name,
          packages: [],
          copyrights: new Set(),
          declared: new Map(),
        };
        groups.set(key, group);
      }
      const declared = entry.declared ?? "(no license field)";
      group.declared.set(declared, (group.declared.get(declared) ?? 0) + 1);
      // Keep the longest variant as the representative: shorter ones are
      // usually the same license with a line of front matter missing. Ties break
      // lexicographically so the choice does not depend on traversal order.
      const longer = text.text.length - group.text.length;
      if (longer > 0 || (longer === 0 && text.text < group.text)) {
        group.text = text.text;
        group.fileName = text.name;
      }
      const id = `${entry.name}@${entry.version}`;
      if (!group.packages.includes(id)) group.packages.push(id);
      for (const line of copyrightLines(text.text)) group.copyrights.add(line);
    }
  }
  return [...groups.values()]
    .map((group) => {
      const ranked = [...group.declared.entries()].sort(
        (a, b) => b[1] - a[1] || compareIds(a[0], b[0]),
      );
      const label =
        ranked.length === 1 ? ranked[0][0] : `${ranked[0][0]} (+${ranked.length - 1} other declarations)`;
      return {
        ...group,
        label,
        packages: group.packages.sort(compareIds),
        copyrights: [...group.copyrights].sort(),
      };
    })
    .sort((a, b) => b.packages.length - a.packages.length || a.key.localeCompare(b.key));
}

function compareIds(a, b) {
  return a.localeCompare(b, "en");
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fence(text) {
  let longest = 0;
  for (const line of text.split("\n")) {
    const match = /^\s*(`{3,})/.exec(line);
    if (match) longest = Math.max(longest, match[1].length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

function codeBlock(text) {
  const marker = fence(text);
  return `${marker}text\n${text}\n${marker}`;
}

function licenseTable(entries) {
  const counts = new Map();
  for (const entry of entries) {
    const key = entry.declared ?? "(no license field)";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || compareIds(a[0], b[0]));
  const lines = ["| Declared license | Packages |", "| --- | --- |"];
  for (const [license, count] of rows) {
    lines.push(`| \`${license.replace(/\|/g, "\\|")}\` | ${count} |`);
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
  let index = 0;
  for (const group of groups) {
    index += 1;
    out.push(
      `${heading}# ${index}. ${group.label} — ${group.packages.length} package(s), from \`${group.fileName}\``,
    );
    out.push("");
    out.push(`<details><summary>Packages sharing this text</summary>`);
    out.push("");
    out.push(group.packages.map((id) => `\`${id}\``).join(", "));
    out.push("");
    out.push("</details>");
    out.push("");
    if (group.copyrights.length > 0) {
      out.push(`Copyright notices (${group.copyrights.length}):`);
      out.push("");
      out.push(codeBlock(group.copyrights.join("\n")));
      out.push("");
    }
    out.push(codeBlock(group.text));
    out.push("");
  }
  return out.join("\n");
}

function unresolvedFor(entries) {
  const missingField = [];
  const missingText = [];
  for (const entry of entries) {
    if (!entry.declared) missingField.push(entry);
    else if (entry.texts.length === 0) missingText.push(entry);
  }
  return { missingField, missingText };
}

function renderUnresolved(all, { heading = "##", scope = "every closure" } = {}) {
  const { missingField, missingText } = unresolvedFor(all);
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
    for (const entry of missingField.sort(byClosureThenName)) {
      const texts = entry.texts.length > 0 ? ` — ships ${entry.texts.map((t) => `\`${t.name}\``).join(", ")}` : "";
      lines.push(`- \`${entry.name}@${entry.version}\` (${entry.closure})${texts}`);
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
    for (const entry of missingText.sort(byClosureThenName)) {
      lines.push(`- \`${entry.name}@${entry.version}\` (${entry.closure}) — declared \`${entry.declared}\``);
    }
    lines.push("");
  }
  return { markdown: lines.join("\n"), missingField, missingText };
}

function byClosureThenName(a, b) {
  return a.closure.localeCompare(b.closure) || compareIds(`${a.name}@${a.version}`, `${b.name}@${b.version}`);
}

function renderFindings(all, { heading = "##", scope = "all closures", note = "" } = {}) {
  const flagged = [];
  for (const entry of all) {
    const verdict = classify(entry);
    if (verdict.severity === "permissive") continue;
    if (verdict.severity === "unknown") continue; // already in the unresolved section
    flagged.push({ entry, verdict });
  }
  flagged.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.verdict.severity) - SEVERITY_ORDER.indexOf(b.verdict.severity) ||
      byClosureThenName(a.entry, b.entry),
  );

  const lines = [
    `${heading} Copyleft, reciprocal and source-available dependencies — ${scope}`,
    "",
    "Lattice ships under GPL-3.0-or-later. Everything below is a dependency whose",
    "terms are *not* plainly permissive, listed so the interaction with that",
    "license gets an answer rather than an assumption. A `dual` row offers a",
    "permissive alternative and is only listed for completeness; a `non-spdx` row",
    "has a misleading `license` field but a permissive license in the file it",
    "points at.",
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
      `| \`${entry.name}@${entry.version}\` | ${entry.closure} | \`${(entry.declared ?? "—").replace(/\|/g, "\\|")}\` | ${verdict.severity} — ${verdict.label} |`,
    );
  }
  lines.push("");

  const vendored = new Map();
  for (const entry of all) {
    if (!entry.vendored) continue;
    const record = vendored.get(entry.vendored.file) ?? { ...entry.vendored, packages: [] };
    record.packages.push(`${entry.name}@${entry.version}`);
    vendored.set(entry.vendored.file, record);
  }
  if (vendored.size > 0) {
    lines.push(`${heading}# Vendored license texts`, "");
    lines.push(
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

function buildBlock({ npm, crates, sidecar }) {
  const all = [...npm.entries, ...crates.entries, ...sidecar.entries];

  // The findings and gap lists are split per scope rather than aggregated
  // across all three closures, because the sidecar can only be scanned where it
  // has been staged. Aggregating would make every section of this file depend
  // on that, and --check would fail for everyone building without the runtime.
  // The most serious sidecar finding is written up by hand above the generated
  // boundary anyway, which is the more prominent place for it.
  const lockedScope = [...npm.entries, ...crates.entries];
  const findings = renderFindings(lockedScope, {
    scope: "npm and crates",
    note:
      "The Synara sidecar has its own findings block further down; it is kept separate because that closure only exists once `pnpm prepare:synara` has staged it.",
  });
  const unresolved = renderUnresolved(lockedScope, { scope: "npm and crates" });
  const sidecarFindings = sidecar.available
    ? renderFindings(sidecar.entries, { heading: "###", scope: "Synara sidecar" })
    : { markdown: "", flagged: [] };
  const sidecarUnresolved = sidecar.available
    ? renderUnresolved(sidecar.entries, { heading: "###", scope: "the Synara sidecar" })
    : { markdown: "", missingField: [], missingText: [] };

  const npmExtras = [];
  if (npm.platformOptional.length > 0) {
    npmExtras.push(
      [
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
      ].join("\n"),
    );
  }
  if (npm.unresolvedRequired.length > 0) {
    npmExtras.push(
      [
        `> **${npm.unresolvedRequired.length} required dependencies could not be resolved on disk.**`,
        "> Run a fresh `pnpm install` before trusting this section.",
        "",
        ...npm.unresolvedRequired.map((spec) => `- \`${spec}\``),
      ].join("\n"),
    );
  }

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
    findings.markdown,
    unresolved.markdown,
    renderClosure({
      title: "npm packages (web assets)",
      blurb:
        "The production dependency closure of the root `package.json` — the superset of what Vite can bundle into the shipped web assets. Dev dependencies (Vite, ESLint, Vitest, Tauri CLI) are excluded: they build the app, they are not distributed in it.",
      entries: npm.entries,
      extras: npmExtras,
    }),
    renderClosure({
      title: "Rust crates (`src-tauri`)",
      blurb:
        "The normal and build dependency closure of `src-tauri/Cargo.toml`, from `cargo metadata`. `dev-dependencies` are excluded — they compile for `cargo test` and are never linked into a shipped binary. Target platforms are *not* filtered, so this covers the macOS, Linux and Windows builds alike.",
      entries: crates.entries,
    }),
    SIDECAR_BEGIN,
    sidecar.available
      ? renderClosure({
          title: "Synara agent sidecar (bundled Tauri resource)",
          blurb: [
            "`scripts/prepare-synara-sidecar.mjs` stages the pinned Synara server into",
            "`src-tauri/synara-runtime/`, and `tauri.conf.json` bundles that directory whole.",
            "Everything below therefore ships inside the application bundle. This closure is",
            "scanned from disk rather than resolved from a lockfile: what is in the directory",
            "is what is distributed, including packages that vendor dependencies inside",
            "themselves. It is staged on macOS, so platform-specific packages reflect that host.",
            sidecar.staged.length > 0
              ? `\n\nThe prepare script additionally stages these notices by hand: ${sidecar.staged.map((path) => `\`${path}\``).join(", ")}.`
              : "",
          ].join(" "),
          entries: sidecar.entries,
          extras: [sidecarFindings.markdown, sidecarUnresolved.markdown],
        })
      : [
          "## Synara agent sidecar (bundled Tauri resource)",
          "",
          "> **INCOMPLETE — this section has never been generated.**",
          ">",
          "> `src-tauri/synara-runtime/` was not staged when this file was written, so the",
          "> hundreds of npm packages bundled into the application as a Tauri resource are",
          "> **not attributed here**. Run `pnpm prepare:synara` and then `pnpm notices` to",
          "> fill this in. Do not ship a release built from this state.",
          "",
        ].join("\n"),
    SIDECAR_END,
    "",
    END,
  ];

  return {
    block: parts.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n",
    findings: { flagged: [...findings.flagged, ...sidecarFindings.flagged] },
    unresolved: {
      missingField: [...unresolved.missingField, ...sidecarUnresolved.missingField],
      missingText: [...unresolved.missingText, ...sidecarUnresolved.missingText],
    },
    all,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const started = Date.now();
const npm = collectNpm();
const crates = collectCrates();
const sidecar = collectSidecar();

const existing = readFileSync(noticesPath, "utf8");
let { block, findings, unresolved, all } = buildBlock({ npm, crates, sidecar });

// A vendored notice exists precisely because the package does not ship it. If
// the file has gone missing the app is distributing that dependency with no
// license text at all, which is the one failure mode that must never be a
// warning.
const missingVendored = new Set(all.flatMap((entry) => entry.missingVendored ?? []));
if (missingVendored.size > 0) {
  for (const file of missingVendored) {
    process.stderr.write(
      `MISSING VENDORED LICENSE: ${file} — the packages that need it ship no license text.\n`,
    );
  }
  process.exit(2);
}

// The sidecar can only be scanned where it has been staged. Rather than let a
// contributor without the runtime wipe a section someone else generated,
// carry the previous one over verbatim; the console still says it was skipped.
let sidecarCarriedOver = false;
if (!sidecar.available) {
  const previous = sliceSection(existing, SIDECAR_BEGIN, SIDECAR_END);
  if (previous && !previous.includes("INCOMPLETE — this section has never been generated")) {
    // Spliced by index, not String.replace: license texts contain `$` and
    // `replace` would interpret `$&` and friends as substitution patterns.
    const start = block.indexOf(SIDECAR_BEGIN);
    const stop = block.indexOf(SIDECAR_END);
    if (start !== -1 && stop > start) {
      block = block.slice(0, start) + previous + block.slice(stop + SIDECAR_END.length);
      sidecarCarriedOver = true;
    }
  }
}

const existingBlock = sliceSection(existing, BEGIN, END);
const preamble = existingBlock ? existing.slice(0, existing.indexOf(BEGIN)) : `${existing.trimEnd()}\n\n`;
const nextContent = `${preamble.trimEnd()}\n\n${block}`;

const log = (message) => process.stderr.write(`${message}\n`);
log(`npm (web assets)       ${String(npm.entries.length).padStart(4)} packages`);
log(`crates (src-tauri)     ${String(crates.entries.length).padStart(4)} packages`);
log(
  sidecar.available
    ? `synara sidecar         ${String(sidecar.entries.length).padStart(4)} packages`
    : `synara sidecar          n/a  — src-tauri/synara-runtime/ is not staged${sidecarCarriedOver ? " (previous section kept)" : ""}`,
);
log(`total                  ${String(all.length).padStart(4)} packages, ${Date.now() - started} ms`);

if (findings.flagged.length > 0) {
  log("");
  log(`Non-permissive dependencies (${findings.flagged.length}):`);
  for (const { entry, verdict } of findings.flagged) {
    log(`  [${verdict.severity}] ${entry.name}@${entry.version} (${entry.closure}) — ${entry.declared}`);
  }
}

const gapCount = unresolved.missingField.length + unresolved.missingText.length;
if (gapCount > 0) {
  log("");
  log(`UNRESOLVED ATTRIBUTION (${gapCount}):`);
  for (const entry of unresolved.missingField) {
    log(`  no license field   ${entry.name}@${entry.version} (${entry.closure})`);
  }
  for (const entry of unresolved.missingText) {
    log(`  no license text    ${entry.name}@${entry.version} (${entry.closure}) — declared ${entry.declared}`);
  }
}

if (stdoutMode) {
  process.stdout.write(block);
} else if (checkMode) {
  if (nextContent !== existing) {
    log("");
    log("THIRD_PARTY_NOTICES.md is out of date. Run `pnpm notices` and commit the result.");
    if (!sidecar.available) {
      log("(The sidecar section was not verified — src-tauri/synara-runtime/ is not staged.)");
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

if (gapCount > 0 && !allowUnresolved) {
  log(`Exiting non-zero: ${gapCount} packages could not be attributed from disk.`);
  process.exit(2);
}
