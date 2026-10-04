#!/usr/bin/env node
/**
 * Fail a release that would hand out the Timeless fonts on their own.
 *
 * Release builds embed the Timeless type family (docs/design-system.md,
 * "Private interface fonts"). Its license allows that only while the fonts
 * are "delivered only as part of the work and are not offered for download on
 * their own", and forbids putting them in a public repository. The build puts
 * them in exactly one place, the web assets compiled into the app binary, so
 * this checks every other place a release could carry them:
 *
 *   - every release asset must be one of the signed artifacts (the disk
 *     image, the updater archive and its signature, latest.json), and none
 *     may be a font;
 *   - nothing inside the disk image or the updater archive may be a loose
 *     Timeless file: named for it, or a font whose tables name it. The bundled
 *     runtimes' own open-licensed fonts (KaTeX, Inter, …) are allowed there;
 *   - with --repo, nothing Git tracks or would add may be a Timeless file
 *     (src/platform/font-license-guard.test.ts also checks names on every
 *     test run; this adds the content check).
 *
 * A font is recognized by its signature, not its extension, and its tables
 * are decompressed (WOFF's zlib, WOFF2's Brotli) before they are searched, so
 * a renamed or converted copy is caught too. Output names paths only; it never
 * prints file contents.
 *
 * Usage:
 *   node scripts/check-font-leaks.mjs [--repo] [ASSET | DIRECTORY ...]
 *
 * A DIRECTORY stands for the files directly inside it (`gh release download
 * --dir`). Disk images are mounted read-only with hdiutil, so they can only be
 * checked on macOS. Exit codes: 0 clean · 1 a finding · 2 usage or I/O error.
 */

import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, openSync, readFileSync, readSync, closeSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { brotliDecompressSync, inflateSync } from "node:zlib";
import { capture, isMain, projectRoot } from "./lib/util.mjs";

/** The files a release may publish: what tauri-action uploads plus the stapled image. */
const RELEASE_ASSETS = [/\.dmg$/, /\.app\.tar\.gz$/, /\.app\.tar\.gz\.sig$/, /^latest\.json$/];
const FONT_EXTENSION = /\.(?:woff2?|[ot]tf|ttc|eot|dfont|pfb|pfa)$/i;
const TIMELESS = /timeless/i;

/** The font container a file's first bytes announce, or null. */
export function fontFormat(head) {
  if (head.length < 4) return null;
  const tag = head.subarray(0, 4).toString("latin1");
  if (tag === "wOF2") return "woff2";
  if (tag === "wOFF") return "woff";
  if (tag === "ttcf" || tag === "OTTO" || tag === "true" || tag === "typ1" || head.readUInt32BE(0) === 0x00010000) return "sfnt";
  return null;
}

/** WOFF2's variable-length integers (UIntBase128 and 255UInt16), each returning [value, next offset]. */
function base128(bytes, offset) {
  let value = 0;
  for (let index = 0; index < 5; index += 1) {
    const byte = bytes[offset + index];
    if (byte === undefined) break;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return [value, offset + index + 1];
  }
  throw new Error("malformed WOFF2 table directory");
}
function uint255(bytes, offset) {
  const code = bytes[offset];
  if (code === 253) return [bytes.readUInt16BE(offset + 1), offset + 3];
  if (code === 254) return [253 * 2 + bytes[offset + 1], offset + 2];
  if (code === 255) return [253 + bytes[offset + 1], offset + 2];
  return [code, offset + 1];
}

/** The decompressed table data of a font file, as one or more buffers. */
function fontTables(bytes, format) {
  if (format === "sfnt") return [bytes];
  if (format === "woff") {
    const tables = [];
    for (let index = 0; index < bytes.readUInt16BE(12); index += 1) {
      const entry = 44 + 20 * index;
      const offset = bytes.readUInt32BE(entry + 4);
      const compressed = bytes.readUInt32BE(entry + 8);
      const original = bytes.readUInt32BE(entry + 12);
      const data = bytes.subarray(offset, offset + compressed);
      tables.push(compressed < original ? inflateSync(data) : data);
    }
    return tables;
  }
  // WOFF2: a variable-length table directory, an optional collection
  // directory, then every table in a single Brotli stream.
  let offset = 48;
  const tableCount = bytes.readUInt16BE(12);
  for (let index = 0; index < tableCount; index += 1) {
    const flags = bytes[offset];
    offset += (flags & 0x3f) === 0x3f ? 5 : 1;
    [, offset] = base128(bytes, offset);
    const transformed = (flags & 0x3f) === 10 || (flags & 0x3f) === 11 ? flags >> 6 === 0 : flags >> 6 !== 0;
    if (transformed) [, offset] = base128(bytes, offset);
  }
  if (bytes.subarray(4, 8).toString("latin1") === "ttcf") {
    offset += 4;
    let fonts;
    [fonts, offset] = uint255(bytes, offset);
    for (let font = 0; font < fonts; font += 1) {
      let tables;
      [tables, offset] = uint255(bytes, offset);
      offset += 4;
      for (let table = 0; table < tables; table += 1) [, offset] = uint255(bytes, offset);
    }
  }
  return [brotliDecompressSync(bytes.subarray(offset, offset + bytes.readUInt32BE(20)))];
}

/**
 * Whether a font's tables name Timeless. Name records are Latin-1 or UTF-16BE;
 * dropping NULs reads both as ASCII.
 */
export function fontNamesTimeless(bytes, format = fontFormat(bytes)) {
  if (!format) return false;
  return fontTables(bytes, format).some((table) => TIMELESS.test(table.toString("latin1").replaceAll("\0", "")));
}

function readHead(file) {
  const handle = openSync(file, "r");
  try {
    const head = Buffer.alloc(4);
    return head.subarray(0, readSync(handle, head, 0, 4, 0));
  } finally {
    closeSync(handle);
  }
}

/**
 * Why `file` (shown as `label`) leaks Timeless, or null. A font that cannot be
 * decoded counts as a leak: the check fails closed.
 */
export function timelessReason(file, label) {
  if (TIMELESS.test(label)) return "is named for Timeless";
  const stats = lstatSync(file);
  if (!stats.isFile() || stats.size === 0) return null;
  const format = fontFormat(readHead(file));
  if (!format) return null;
  try {
    return fontNamesTimeless(readFileSync(file), format) ? "is a Timeless font" : null;
  } catch {
    return "is a font that could not be decoded to rule out Timeless";
  }
}

/** Every path under `root`, relative to it, without following symlinks. */
function walk(root, relative = "") {
  const entries = [];
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    entries.push(child);
    if (entry.isDirectory()) entries.push(...walk(root, child));
  }
  return entries;
}

/** Findings for the loose files of an unpacked artifact. */
export function checkTree(root, label) {
  const findings = [];
  for (const relative of walk(root)) {
    const reason = timelessReason(path.join(root, relative), relative);
    if (reason) findings.push(`${label}!/${relative} ${reason}`);
  }
  return findings;
}

/** Unpack `asset` into a scratch directory, run `check` on it, and clean up. */
function withUnpacked(asset, check) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "lattice-font-leaks-"));
  const name = path.basename(asset);
  try {
    if (name.endsWith(".dmg")) {
      if (process.platform !== "darwin") throw new Error(`${name}: disk images can only be checked on macOS`);
      execFileSync("hdiutil", ["attach", asset, "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", scratch], { stdio: "ignore" });
      try {
        return check(scratch);
      } finally {
        execFileSync("hdiutil", ["detach", scratch, "-force"], { stdio: "ignore" });
      }
    }
    execFileSync("tar", ["-xzf", asset, "-C", scratch], { stdio: "ignore" });
    return check(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Findings for one release asset: its kind, its own bytes, and what it unpacks to. */
export function checkAsset(asset) {
  const name = path.basename(asset);
  const findings = [];
  if (!RELEASE_ASSETS.some((pattern) => pattern.test(name))) findings.push(`${name} is not a signed release artifact`);
  if (FONT_EXTENSION.test(name) || fontFormat(readHead(asset))) findings.push(`${name} is a font offered for download on its own`);
  const reason = timelessReason(asset, name);
  if (reason) findings.push(`${name} ${reason}`);
  if (name.endsWith(".dmg") || name.endsWith(".tar.gz")) findings.push(...withUnpacked(asset, (root) => checkTree(root, name)));
  return findings;
}

/** Findings for every file Git tracks or would add. */
export function checkRepository(root = projectRoot) {
  const paths = capture("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root })
    .split("\0")
    .filter(Boolean);
  const findings = [];
  for (const relative of paths) {
    let reason;
    try {
      reason = timelessReason(path.join(root, relative), relative);
    } catch (error) {
      // Tracked but deleted in the working tree: nothing to ship.
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (reason) findings.push(`repository: ${relative} ${reason}`);
  }
  return findings;
}

function main(args) {
  const repo = args.includes("--repo");
  const targets = args.filter((arg) => arg !== "--repo");
  if (args.includes("--help") || args.includes("-h") || targets.some((arg) => arg.startsWith("-")) || (!repo && targets.length === 0)) {
    process.stderr.write("Usage: node scripts/check-font-leaks.mjs [--repo] [ASSET | DIRECTORY ...]\n");
    return 2;
  }
  const assets = targets.flatMap((target) => (statSync(target).isDirectory()
    ? readdirSync(target).map((name) => path.join(target, name))
    : [target]));
  const findings = [...(repo ? checkRepository() : []), ...assets.flatMap(checkAsset)];
  for (const finding of findings) process.stderr.write(`font leak: ${finding}\n`);
  if (findings.length > 0) return 1;
  process.stdout.write(`No font leaks in ${[repo ? "the repository" : null, assets.length ? `${assets.length} release asset(s)` : null].filter(Boolean).join(" or ")}.\n`);
  return 0;
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`check-font-leaks: ${error.message}\n`);
    process.exitCode = 2;
  }
}
