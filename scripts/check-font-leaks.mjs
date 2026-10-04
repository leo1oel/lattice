#!/usr/bin/env node
/**
 * Fail a release that would hand out the Timeless fonts on their own.
 *
 * Release builds embed the Timeless type family (docs/design-system.md,
 * "Private interface fonts"). Its license allows that only while the fonts
 * are "delivered only as part of the work and are not offered for download on
 * their own". The build puts them in exactly one place, the web assets
 * compiled into the app binary, so two checks cover everywhere else:
 *
 *   assets DIRECTORY  the release's assets (`gh release download --dir`): each
 *                     must be one of the signed artifacts (the disk image, the
 *                     updater archive and its signature, latest.json), and
 *                     none may be a font.
 *   app APP           the built .app, before it is packaged: no file may be
 *                     named for Timeless or be a byte copy of a Timeless font
 *                     (those under LATTICE_PRIVATE_FONTS_DIR and the ones the
 *                     build emitted into dist/assets). Outside the bundled
 *                     open-licensed runtimes, which ship their own KaTeX, Inter
 *                     and other fonts, no file may be a font at all.
 *
 * A font is recognized by its extension or its signature, so a renamed copy
 * is caught too. Output names paths only; it never prints file contents.
 * The repository itself is checked by src/platform/font-license-guard.test.ts.
 *
 * Usage: node scripts/check-font-leaks.mjs assets DIRECTORY | app APP
 * Exit codes: 0 clean · 1 a finding · 2 usage or I/O error.
 */

import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { isMain, projectRoot, sha256, walkFiles } from "./lib/util.mjs";

/** The files a release may publish: what tauri-action uploads plus the stapled image. */
const RELEASE_ASSETS = [/\.dmg$/, /\.app\.tar\.gz$/, /\.app\.tar\.gz\.sig$/, /^latest\.json$/];
const FONT_EXTENSION = /\.(?:woff2?|[ot]tf|ttc|eot|dfont|pfb|pfa)$/i;
const FONT_SIGNATURES = new Set(["wOF2", "wOFF", "OTTO", "true", "typ1", "ttcf", "\0\x01\0\0"]);
/** The bundled runtimes, relative to the .app, whose open-licensed fonts may ship. */
const OPEN_RUNTIMES = ["Contents/Resources/presentation-runtime/", "Contents/Resources/synara-runtime/"];
const EMITTED_TIMELESS = /^Timeless.*\.woff2$/;

function signature(file) {
  const handle = openSync(file, "r");
  try {
    const head = Buffer.alloc(4);
    return head.subarray(0, readSync(handle, head, 0, 4, 0)).toString("latin1");
  } finally {
    closeSync(handle);
  }
}

const isFont = (file) => FONT_EXTENSION.test(file) || FONT_SIGNATURES.has(signature(file));

/** Findings for the files directly inside a release's asset directory. */
export function checkAssets(directory) {
  const findings = [];
  for (const name of readdirSync(directory)) {
    if (!RELEASE_ASSETS.some((pattern) => pattern.test(name))) findings.push(`${name} is not a signed release artifact`);
    if (isFont(path.join(directory, name))) findings.push(`${name} is a font offered for download on its own`);
  }
  return findings;
}

/**
 * The SHA-256 of every Timeless font file: each font in the private fonts
 * folder, and each Timeless face the build emitted. Empty without either.
 */
export function timelessFontHashes({ fontsDirectory, emittedDirectory }) {
  const emitted = walkFiles(emittedDirectory).filter((file) => EMITTED_TIMELESS.test(path.basename(file)));
  const originals = fontsDirectory ? walkFiles(fontsDirectory).filter(isFont) : [];
  return new Set([...originals, ...emitted].map((file) => sha256(readFileSync(file))));
}

/**
 * Findings for every file inside a built .app. Throws when `app` is not one:
 * walkFiles treats a missing root as empty, and an empty walk would otherwise
 * pass a mistyped release path as clean.
 */
export function checkApp(app, timelessHashes) {
  const macos = path.join(app, "Contents", "MacOS");
  if (!statSync(app, { throwIfNoEntry: false })?.isDirectory() || !statSync(macos, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${app} is not a built .app (no Contents/MacOS directory)`);
  }
  const findings = [];
  for (const file of walkFiles(app)) {
    const relative = path.relative(app, file).split(path.sep).join("/");
    const label = `${path.basename(app)}/${relative}`;
    if (/timeless/i.test(path.basename(file))) findings.push(`${label} is named for Timeless`);
    else if (timelessHashes.size > 0 && timelessHashes.has(sha256(readFileSync(file)))) findings.push(`${label} is a copy of a Timeless font`);
    else if (!OPEN_RUNTIMES.some((runtime) => relative.startsWith(runtime)) && isFont(file)) {
      findings.push(`${label} is a font outside the app's web assets and bundled runtimes`);
    }
  }
  return findings;
}

function main([mode, target, ...rest]) {
  if (!target || rest.length > 0 || (mode !== "assets" && mode !== "app")) {
    process.stderr.write("Usage: node scripts/check-font-leaks.mjs assets DIRECTORY | app APP\n");
    return 2;
  }
  const findings = mode === "assets"
    ? checkAssets(target)
    : checkApp(target, timelessFontHashes({
      fontsDirectory: process.env.LATTICE_PRIVATE_FONTS_DIR || null,
      emittedDirectory: path.join(projectRoot, "dist", "assets"),
    }));
  for (const finding of findings) process.stderr.write(`font leak: ${finding}\n`);
  if (findings.length > 0) return 1;
  process.stdout.write(`No font leaks in ${target}.\n`);
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
