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
import { readJson, removePath, walkFiles } from "./util.mjs";

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
// ELF e_machine (a little-endian half-word at offset 18) per npm Linux CPU.
const ELF_MACHINE = { "linux-x64": 0x3e, "linux-arm64": 0xb7 };
// What a musl-linked binary needs and a glibc system lacks: musl's loader
// (`ld-musl-x86_64.so.1`) and its libc, whose soname is plain `libc.so`
// (Alpine's is `libc.musl-x86_64.so.1`); glibc's is `libc.so.6`.
const MUSL_LINKAGE = /^(?:ld-musl-.+|libc\.musl-.+|libc\.so)$/;

function readHeader(path) {
  const descriptor = openSync(path, "r");
  try {
    const header = Buffer.alloc(20);
    const length = readSync(descriptor, header, 0, header.length, 0);
    return header.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * The basenames of what a 64-bit little-endian ELF file links against: its
 * program interpreter (PT_INTERP) and its DT_NEEDED libraries. Read from the
 * headers rather than searched for, since a glibc build of Node or Bun can
 * carry these names as text in its own libc detection.
 */
function elfLinkage(contents) {
  if (contents.length < 64 || contents[4] !== 2 || contents[5] !== 1) return [];
  const u64 = (offset) => Number(contents.readBigUInt64LE(offset));
  const cString = (offset) => {
    const end = contents.indexOf(0, offset);
    return contents.toString("latin1", offset, end < 0 ? contents.length : end);
  };
  const segments = [];
  const [phoff, phentsize, phnum] = [u64(32), contents.readUInt16LE(54), contents.readUInt16LE(56)];
  for (let index = 0; index < phnum; index += 1) {
    const at = phoff + index * phentsize;
    if (at + 56 > contents.length) break;
    segments.push({ type: contents.readUInt32LE(at), offset: u64(at + 8), vaddr: u64(at + 16), size: u64(at + 32) });
  }
  const fileOffset = (vaddr) => {
    const load = segments.find((segment) => segment.type === 1 && vaddr >= segment.vaddr && vaddr < segment.vaddr + segment.size);
    return load ? vaddr - load.vaddr + load.offset : null;
  };
  const names = segments.filter((segment) => segment.type === 3).map((segment) => cString(segment.offset));
  const dynamic = segments.find((segment) => segment.type === 2);
  if (dynamic) {
    const needed = [];
    let strtab = null;
    for (let at = dynamic.offset; at + 16 <= Math.min(dynamic.offset + dynamic.size, contents.length); at += 16) {
      const tag = contents.readBigInt64LE(at);
      if (tag === 0n) break;
      if (tag === 1n) needed.push(u64(at + 8));
      if (tag === 5n) strtab = fileOffset(u64(at + 8));
    }
    if (strtab !== null) for (const name of needed) if (strtab + name < contents.length) names.push(cString(strtab + name));
  }
  return names.map((name) => basename(name));
}

/**
 * True for a binary `platform` can never load. On macOS: an ELF or PE file,
 * or a thin Mach-O Node addon for the other CPU (an arm64 Node cannot dlopen
 * an x86_64 addon); a thin x86_64 executable could still run under Rosetta,
 * and universal binaries cover both CPUs, so neither is foreign. On Linux: a
 * Mach-O or PE Node addon, an ELF file for the other CPU, or one linked
 * against musl. Lattice ships Linux as a glibc AppImage, and pnpm installs the
 * `-musl` builds of rolldown, lightningcss and the like beside the `-gnu`
 * ones because it cannot tell which libc the runtime will meet.
 */
export function isForeignBinary(path, platform) {
  if (!NATIVE_CANDIDATE.test(basename(path))) return false;
  const header = readHeader(path);
  if (header.length < 4) return false;
  if (header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    if (!platform.startsWith("linux-")) return true;
    if (header.length >= 20 && ELF_MACHINE[platform] !== undefined && header.readUInt16LE(18) !== ELF_MACHINE[platform]) return true;
    return elfLinkage(readFileSync(path)).some((name) => MUSL_LINKAGE.test(name));
  }
  if (header[0] === 0x4d && header[1] === 0x5a && /\.(?:node|dll|exe)$/i.test(path)) return !platform.startsWith("win32-");
  if (header.length >= 8 && header.readUInt32LE(0) === 0xfeedfacf && path.endsWith(".node")) {
    const cpu = header.readUInt32LE(4);
    if (platform === "darwin-arm64") return cpu !== MACH_O_CPU_ARM64;
    if (platform === "darwin-x64") return cpu !== MACH_O_CPU_X86_64;
    return true;
  }
  return false;
}

/**
 * True on Linux for a package whose npm `cpu` or `libc` field excludes the
 * target: npm would not install it there, and nothing on the target can
 * load it. pnpm installs both the `-gnu` and the `-musl` build of rolldown,
 * lightningcss, Tailwind's oxide and the like, each marked `"libc"`, and
 * Lattice ships Linux as a glibc AppImage. macOS runtimes are left to the
 * file checks above, as they always were.
 */
function isForeignLinuxPackage(manifest, platform) {
  if (!platform.startsWith("linux-")) return false;
  const cpu = platform.slice("linux-".length);
  const excludes = (field, value) => {
    const values = typeof field === "string" ? [field] : Array.isArray(field) ? field : [];
    if (values.includes(`!${value}`)) return true;
    const allowed = values.filter((entry) => !entry.startsWith("!"));
    return allowed.length > 0 && !allowed.includes(value);
  };
  return excludes(manifest.cpu, cpu) || excludes(manifest.libc, "glibc");
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
 *
 * @param {string} nodeModules
 * @param {{ platform: string, typeScriptSources: "keep" | "remove" }} options
 */
export function pruneNodeModules(nodeModules, { platform, typeScriptSources }) {
  if (typeScriptSources !== "keep" && typeScriptSources !== "remove") {
    throw new Error(`typeScriptSources must be "keep" or "remove", not ${typeScriptSources}`);
  }
  let removedBytes = 0;
  // A platform package's binary is its entry point, so the file checks below
  // protect it; on Linux the whole package goes when its manifest rules the
  // target out (see isForeignLinuxPackage).
  for (const directory of packageDirectories(nodeModules)) {
    // A nested package goes with a foreign parent removed before it.
    const manifest = join(directory, "package.json");
    if (existsSync(manifest) && isForeignLinuxPackage(readJson(manifest), platform)) removedBytes += removePath(directory);
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

  // Tauri's resource walker copies a link's target, so every npm .bin link
  // ships as a second full copy of the executable it names. Nothing in a
  // bundled runtime runs package scripts through .bin.
  removedBytes += removePath(join(nodeModules, ".bin"));
  for (const directory of packages) removedBytes += removePath(join(directory, "node_modules/.bin"));

  for (const directory of packages) {
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
