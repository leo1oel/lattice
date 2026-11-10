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
 *   site DIRECTORY    a static build for the website (scripts/web-demo.mjs):
 *                     no file may be named for Timeless or be a byte copy of a
 *                     Timeless font. The open-licensed faces the app draws
 *                     with (Inter, KaTeX, …) may ship.
 *   app APP           the built .app, before it is packaged: no file may be
 *                     named for Timeless or be a byte copy of a Timeless font
 *                     (those under LATTICE_PRIVATE_FONTS_DIR and the ones the
 *                     build emitted into dist/assets). Outside the bundled
 *                     open-licensed runtimes, which ship their own KaTeX, Inter
 *                     and other fonts, no file may be a font at all.
 *   appdir DIRECTORY  the Linux AppImage's contents, extracted with
 *                     `--appimage-extract` (squashfs-root): the same rules as
 *                     an .app, with the runtimes where Tauri puts resources on
 *                     Linux (usr/lib/Lattice/).
 *   windows DIRECTORY an installed experimental Windows app (the directory
 *                     holding research-writer.exe): the same rules, with the
 *                     runtimes beside the executable.
 *
 * A font is recognized by its extension or its signature, so a renamed copy
 * is caught too. Output names paths only; it never prints file contents.
 * The repository itself is checked by src/platform/font-license-guard.test.ts.
 *
 * Usage: node scripts/check-font-leaks.mjs assets DIRECTORY | site DIRECTORY | app APP | appdir DIRECTORY | windows DIRECTORY
 * Exit codes: 0 clean · 1 a finding · 2 usage or I/O error.
 */

import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { isMain, projectRoot, sha256, walkFiles } from "./lib/util.mjs";

/**
 * The files a release may publish: what tauri-action uploads plus the stapled
 * image, and the Linux AppImage linux-appimage.yml attaches once its own checks pass
 * (it has no updater archive or signature: Linux copies update by hand).
 */
const RELEASE_ASSETS = [/\.dmg$/, /\.app\.tar\.gz$/, /\.app\.tar\.gz\.sig$/, /^latest\.json$/, /_amd64\.AppImage$/,
  /^Lattice_\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?_windows-x64-experimental(?:-setup\.exe|\.sha256|\.build-info\.json|\.README\.txt)$/];
const FONT_EXTENSION = /\.(?:woff2?|[ot]tf|ttc|eot|dfont|pfb|pfa)$/i;
const FONT_SIGNATURES = new Set(["wOF2", "wOFF", "OTTO", "true", "typ1", "ttcf", "\0\x01\0\0"]);
/**
 * Where each kind of built bundle keeps its executable (checked to exist, so
 * a mistyped path is not reported clean) and the bundled runtimes whose
 * open-licensed fonts may ship. Tauri puts Linux resources in usr/lib/<productName>/.
 */
const BUNDLES = {
  app: {
    what: "a built .app (no Contents/MacOS directory)",
    executable: "Contents/MacOS",
    openRuntimes: ["Contents/Resources/presentation-runtime/", "Contents/Resources/synara-runtime/"],
  },
  appdir: {
    what: "an extracted AppImage (no usr/bin directory)",
    executable: "usr/bin",
    openRuntimes: ["usr/lib/Lattice/presentation-runtime/", "usr/lib/Lattice/synara-runtime/"],
  },
  windows: {
    what: "an installed Windows app (no research-writer.exe)",
    executable: "research-writer.exe",
    openRuntimes: ["presentation-runtime/", "synara-runtime/"],
  },
};
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
 * Findings for every file inside a built bundle: an .app (`kind` "app") or an
 * extracted AppImage ("appdir"). Throws when `root` is not one: walkFiles
 * treats a missing root as empty, and an empty walk would otherwise pass a
 * mistyped release path as clean.
 */
export function checkBundle(root, timelessHashes, kind) {
  const { what, executable, openRuntimes } = BUNDLES[kind];
  const executableStat = statSync(path.join(root, executable), { throwIfNoEntry: false });
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()
    || !(kind === "windows" ? executableStat?.isFile() : executableStat?.isDirectory())) {
    throw new Error(`${root} is not ${what}`);
  }
  const findings = [];
  for (const file of walkFiles(root)) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const label = `${path.basename(root)}/${relative}`;
    if (/timeless/i.test(path.basename(file))) findings.push(`${label} is named for Timeless`);
    else if (timelessHashes.size > 0 && timelessHashes.has(sha256(readFileSync(file)))) findings.push(`${label} is a copy of a Timeless font`);
    else if (!openRuntimes.some((runtime) => relative.startsWith(runtime)) && isFont(file)) {
      findings.push(`${label} is a font outside the app's web assets and bundled runtimes`);
    }
  }
  return findings;
}


/**
 * Findings for every file of a static site build. Throws when `site` is not a
 * folder, for the reason checkBundle does.
 */
export function checkSite(site, timelessHashes) {
  if (!statSync(site, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${site} is not a folder`);
  const findings = [];
  for (const file of walkFiles(site)) {
    const label = path.relative(site, file).split(path.sep).join("/");
    if (/timeless/i.test(path.basename(file))) findings.push(`${label} is named for Timeless`);
    else if (timelessHashes.size > 0 && isFont(file) && timelessHashes.has(sha256(readFileSync(file)))) findings.push(`${label} is a copy of a Timeless font`);
  }
  return findings;
}

function main([mode, target, ...rest]) {
  if (!target || rest.length > 0 || !["assets", "site", "app", "appdir", "windows"].includes(mode)) {
    process.stderr.write("Usage: node scripts/check-font-leaks.mjs assets DIRECTORY | site DIRECTORY | app APP | appdir DIRECTORY | windows DIRECTORY\n");
    return 2;
  }
  const fontsDirectory = process.env.LATTICE_PRIVATE_FONTS_DIR || null;
  const findings = mode === "assets"
    ? checkAssets(target)
    : mode === "site"
      ? checkSite(target, timelessFontHashes({ fontsDirectory, emittedDirectory: target }))
      : checkBundle(target, timelessFontHashes({
      fontsDirectory,
      emittedDirectory: path.join(projectRoot, "dist", "assets"),
    }), mode);
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
