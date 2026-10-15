// Pruning shared by the runtime staging scripts (Synara and Open Slide).
//
// Both runtimes are npm production closures that Tauri copies into the app
// whole. Packages publish a great deal no runtime ever loads: source maps,
// typings, tests, docs, binaries for other platforms, npm's .bin links. This
// module removes only the categories named below — never "everything a keep
// list misses" — and it protects every file a package.json entry point names,
// then checks those files survived. LICENSE, NOTICE, and similar files are
// never candidates: the license obligations travel with the code.
import { chmodSync, closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { readJson, removePath, run, walkFiles } from "./util.mjs";

// Package-root files that only describe the package to people.
const PACKAGE_DOC_FILE = /^(?:readme|changelog|changes|history|upgrading|migrating|contributing|code_of_conduct|security)(?:\.(?:md|markdown|txt|rst))?$/i;

// Package-root directories that hold docs, examples, or tests. A package that
// names one of them as an entry point keeps it (see protectedEntryFiles).
const PACKAGE_DOC_DIRECTORIES = new Set([
  ".github",
  "__tests__",
  "benchmark",
  "benchmarks",
  "doc",
  "docs",
  "example",
  "examples",
  "test",
  "tests",
]);

const SOURCE_MAP = /\.map$/;
const DECLARATION = /(?:\.d\.(?:ts|mts|cts)|\.flow)$/;
const TYPESCRIPT_SOURCE = /\.(?:ts|mts|cts|tsx)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const BUILD_METADATA = /\.(?:pdb|tsbuildinfo)$/;

// Only these can be native code worth inspecting; reading the magic of every
// JavaScript file would cost the walk for nothing.
const NATIVE_CANDIDATE = /(?:^[^.]+$|\.(?:node|so|dylib|dll|exe)$|\.so\.\d+(?:\.\d+)*$)/;

const MACH_O_CPU_ARM64 = 0x0100000c;
const MACH_O_CPU_X86_64 = 0x01000007;

function readHeader(path) {
  const descriptor = openSync(path, "r");
  try {
    const header = Buffer.alloc(8);
    const length = readSync(descriptor, header, 0, header.length, 0);
    return header.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * True for a binary macOS on `platform` can never load: an ELF or PE file, or
 * a thin Mach-O Node addon for the other CPU (an arm64 Node cannot dlopen an
 * x86_64 addon). A thin x86_64 executable could still run under Rosetta, and
 * universal binaries cover both CPUs, so neither is foreign.
 */
export function isForeignBinary(path, platform) {
  if (!NATIVE_CANDIDATE.test(basename(path))) return false;
  const header = readHeader(path);
  if (header.length < 4) return false;
  if (header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return !platform.startsWith("linux-");
  if (header[0] === 0x4d && header[1] === 0x5a && /\.(?:node|dll|exe)$/i.test(path)) return !platform.startsWith("win32-");
  if (header.length === 8 && header.readUInt32LE(0) === 0xfeedfacf && path.endsWith(".node")) {
    const cpu = header.readUInt32LE(4);
    if (platform === "darwin-arm64") return cpu !== MACH_O_CPU_ARM64;
    if (platform === "darwin-x64") return cpu !== MACH_O_CPU_X86_64;
    return true;
  }
  return false;
}

/** Every installed package directory below `nodeModules`, nested installs included. */
function packageDirectories(nodeModules, found = []) {
  if (!existsSync(nodeModules)) return found;
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const path = join(nodeModules, entry.name);
    const candidates = entry.name.startsWith("@")
      ? readdirSync(path, { withFileTypes: true }).filter((child) => child.isDirectory()).map((child) => join(path, child.name))
      : [path];
    for (const directory of candidates) {
      if (!existsSync(join(directory, "package.json"))) continue;
      found.push(directory);
      packageDirectories(join(directory, "node_modules"), found);
    }
  }
  return found;
}

// Every string target in an `exports`/`imports` map except type-only
// conditions, which only an editor or a typechecker resolves.
function conditionalTargets(value, targets) {
  if (typeof value === "string") targets.push(value);
  else if (Array.isArray(value)) for (const item of value) conditionalTargets(item, targets);
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "types" || key === "typings" || key.startsWith("types@")) continue;
      conditionalTargets(child, targets);
    }
  }
  return targets;
}

/**
 * The files a package's manifest names as code to load: main, module,
 * browser, bin, and the non-type targets of exports and imports. Each target
 * resolves the way Node's legacy resolver would (extension, then index file);
 * targets with a `*` pattern protect nothing by themselves, so the categories
 * above must stay ones a pattern export cannot reasonably name.
 */
function protectedEntryFiles(packageDirectory) {
  const manifest = readJson(join(packageDirectory, "package.json"));
  const targets = [manifest.main ?? "index.js", manifest.module];
  if (typeof manifest.browser === "string") targets.push(manifest.browser);
  else if (manifest.browser && typeof manifest.browser === "object") {
    targets.push(...Object.values(manifest.browser).filter((value) => typeof value === "string"));
  }
  if (typeof manifest.bin === "string") targets.push(manifest.bin);
  else if (manifest.bin && typeof manifest.bin === "object") targets.push(...Object.values(manifest.bin));
  conditionalTargets(manifest.exports, targets);
  conditionalTargets(manifest.imports, targets);

  const files = new Set([join(packageDirectory, "package.json")]);
  for (const target of targets) {
    if (typeof target !== "string" || target.includes("*") || !target.startsWith(".") && target.includes(":")) continue;
    const base = join(packageDirectory, target);
    const candidates = [base, ...[".js", ".mjs", ".cjs", ".json", ".node"].map((extension) => base + extension)];
    candidates.push(...["index.js", "index.mjs", "index.cjs", "index.json"].map((index) => join(base, index)));
    const resolved = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
    if (resolved) files.add(resolved);
  }
  return files;
}

// esbuild's postinstall replaces its JavaScript `bin/esbuild` shim with a
// copy of the platform binary so the CLI skips Node's startup. Its JavaScript
// API never runs that copy — it resolves @esbuild/<platform> itself — so the
// copy only doubles a 10 MB binary. A launcher keeps the CLI working.
function restoreEsbuildLaunchers(packages, platform) {
  if (platform.startsWith("win32-")) return 0;
  let removedBytes = 0;
  for (const directory of packages) {
    if (basename(directory) !== "esbuild" || basename(dirname(directory)) !== "node_modules") continue;
    const copy = join(directory, "bin/esbuild");
    const binary = join(dirname(directory), "@esbuild", platform, "bin/esbuild");
    if (!existsSync(copy) || !existsSync(binary) || !readFileSync(copy).equals(readFileSync(binary))) continue;
    const launcher = `#!/bin/sh\nexec "$(dirname -- "$0")/../../@esbuild/${platform}/bin/esbuild" "$@"\n`;
    removedBytes += removePath(copy) - Buffer.byteLength(launcher);
    writeFileSync(copy, launcher);
    chmodSync(copy, 0o755);
  }
  return removedBytes;
}

/**
 * Remove what no runtime loads from the production install at `nodeModules`
 * and return the bytes removed.
 *
 * - `platform`: the npm platform the runtime ships for, e.g. "darwin-arm64".
 * - `typeScriptSources`: whether TypeScript sources go too. Node refuses to
 *   strip types under node_modules, so a Node-only runtime can never load
 *   them; a runtime that serves packages through Vite can.
 * - `keepDocsFor`: package names that read their own README or docs at runtime.
 *
 * @param {string} nodeModules
 * @param {{ platform: string, typeScriptSources: "keep" | "remove", keepDocsFor?: string[] }} options
 */
export function pruneNodeModules(nodeModules, { platform, typeScriptSources, keepDocsFor = [] }) {
  if (typeScriptSources !== "keep" && typeScriptSources !== "remove") {
    throw new Error(`typeScriptSources must be "keep" or "remove", not ${typeScriptSources}`);
  }
  const packages = packageDirectories(nodeModules);
  const entries = new Set();
  for (const directory of packages) for (const file of protectedEntryFiles(directory)) entries.add(file);
  const entryDirectories = new Set();
  for (const file of entries) {
    for (let directory = dirname(file); directory.startsWith(nodeModules); directory = dirname(directory)) {
      entryDirectories.add(directory);
    }
  }
  const protects = (path) => entries.has(path) || entryDirectories.has(path);
  let removedBytes = 0;

  // Tauri's resource walker copies a link's target, so every npm .bin link
  // ships as a second full copy of the executable it names. Nothing in a
  // bundled runtime runs package scripts through .bin.
  removedBytes += removePath(join(nodeModules, ".bin"));
  for (const directory of packages) removedBytes += removePath(join(directory, "node_modules/.bin"));

  const keepDocs = new Set(keepDocsFor);
  for (const directory of packages) {
    const name = relative(nodeModules, directory).split("node_modules/").at(-1);
    if (keepDocs.has(name)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const removable = entry.isDirectory() ? PACKAGE_DOC_DIRECTORIES.has(entry.name) : PACKAGE_DOC_FILE.test(entry.name);
      if (removable && !protects(path)) removedBytes += removePath(path);
    }
  }

  for (const path of walkFiles(nodeModules)) {
    if (entries.has(path)) continue;
    const name = basename(path);
    if (
      SOURCE_MAP.test(name) ||
      DECLARATION.test(name) ||
      BUILD_METADATA.test(name) ||
      TEST_FILE.test(name) ||
      (typeScriptSources === "remove" && TYPESCRIPT_SOURCE.test(name)) ||
      isForeignBinary(path, platform)
    ) {
      removedBytes += removePath(path);
    }
  }

  removedBytes += restoreEsbuildLaunchers(packages, platform);

  const missing = [...entries].filter((file) => !existsSync(file));
  if (missing.length > 0) {
    throw new Error(`Pruning removed package entry points:\n${missing.map((file) => `  ${relative(nodeModules, file)}`).join("\n")}`);
  }
  return removedBytes;
}

/**
 * Drop a Mach-O executable's local symbols (`strip -x`) and re-sign it ad hoc
 * so it still runs on Apple Silicon before the Developer ID pass. Global
 * symbols stay: native addons resolve Node's N-API exports from the executable
 * when they load. Returns the bytes saved.
 */
export function stripLocalSymbols(path) {
  const before = readFileSync(path).length;
  run("/usr/bin/strip", ["-x", path]);
  run("/usr/bin/codesign", ["--force", "--sign", "-", path]);
  return before - readFileSync(path).length;
}

