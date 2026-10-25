/**
 * One installed package, read off disk: its declared license and the notice
 * files beside it, as the record scripts/generate-notices.mjs aggregates over.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { projectRoot } from "./util.mjs";

// A package's notice can be called any of these. NOTICE is not a license, but
// Apache-2.0 §4(d) requires it to be redistributed too, so it counts as text.
const NOTICE_FILE = /^(licen[cs]e|copying|copyright|notice|unlicen[cs]e)([-._ ].*)?$/i;

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function readDirectory(dir) {
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
export function declaredNpmLicense(pkg) {
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
export function makeEntry({ closure, name, version, declared, dir, extraTextPaths = [], note }) {
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
