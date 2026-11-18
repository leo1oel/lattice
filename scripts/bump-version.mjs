#!/usr/bin/env node
// Bump the app version in lockstep across package.json, tauri.conf.json, and
// both crates' Cargo.toml (the Tauri shell and lattice-core, which reports
// its CARGO_PKG_VERSION as Lattice's own), so every release ships one
// coherent version number. lattice-core's entry in the GPUI preview app's
// lockfile (gpui/Cargo.lock) follows it.
//
// Usage:
//   node scripts/bump-version.mjs            # patch: 0.1.37 -> 0.1.38
//   node scripts/bump-version.mjs patch
//   node scripts/bump-version.mjs minor      # 0.1.37 -> 0.2.0
//   node scripts/bump-version.mjs major      # 0.1.37 -> 1.0.0
//   node scripts/bump-version.mjs 0.3.0      # set an explicit version
//   node scripts/bump-version.mjs patch --no-notes   # release without a lead
//
// It only edits files; it does not commit or tag. It prints the exact git
// commands to run next. It needs the release lead (.github/release-notes/vX.Y.Z.md)
// written first and writes the in-app What's new notes from it
// (src/release-notes/X.Y.Z.json, scripts/release-notes.mjs), whose Chinese
// the maintainer fills in before the release commit. Without a lead it stops
// before editing anything, since the release would ship with no What's new
// and only its raw commit list (v0.16.19 did); --no-notes allows that.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectRoot } from "./lib/util.mjs";
import { writeReleaseNotes } from "./release-notes.mjs";

const pkgPath = join(projectRoot, "package.json");
const confPath = join(projectRoot, "src-tauri/tauri.conf.json");
const cargoPaths = ["src-tauri/Cargo.toml", "src-tauri/lattice-core/Cargo.toml"].map((path) => join(projectRoot, path));
const lockPath = join(projectRoot, "src-tauri/Cargo.lock");
// The GPUI preview app builds on lattice-core too, and its CI builds with
// `--locked`, so its lockfile's lattice-core entry follows the version.
const gpuiLockPath = join(projectRoot, "gpui/Cargo.lock");

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const current = pkg.version;
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
if (!match) {
  throw new Error(`Current version "${current}" is not plain semver x.y.z.`);
}
const [major, minor, patch] = match.slice(1).map(Number);

const args = process.argv.slice(2);
const noNotes = args.includes("--no-notes");
const arg = (args.find((value) => value !== "--no-notes") ?? "patch").trim();
let next;
if (arg === "patch") next = `${major}.${minor}.${patch + 1}`;
else if (arg === "minor") next = `${major}.${minor + 1}.0`;
else if (arg === "major") next = `${major + 1}.0.0`;
else if (/^\d+\.\d+\.\d+$/.test(arg)) next = arg;
else {
  throw new Error(
    `Unknown argument "${arg}". Use patch | minor | major | an explicit x.y.z.`,
  );
}

if (next === current) {
  throw new Error(`New version equals current version (${current}).`);
}

const leadPath = `.github/release-notes/v${next}.md`;
if (!noNotes && !existsSync(join(projectRoot, leadPath))) {
  console.error(`No ${leadPath}: write the release's lead first (see the previous release's), or pass --no-notes to release without What's new notes.`);
  process.exit(1);
}

// package.json — rewrite the version field, keep the file's formatting.
pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// tauri.conf.json — replace only the top-level field. Parsing and stringifying
// the whole file would reformat deliberately compact nested arrays such as the
// CSP source lists, burying a one-line release bump in an unrelated diff.
const conf = readFileSync(confPath, "utf8");
let confVersionReplaced = false;
const nextConf = conf.replace(/^( {2}"version": )"[^"]*",$/m, (_, prefix) => {
  confVersionReplaced = true;
  return `${prefix}"${next}",`;
});
if (!confVersionReplaced) {
  throw new Error(`Could not find the top-level version field in ${confPath}.`);
}
writeFileSync(confPath, nextConf);

// Cargo.toml — replace the first `version = "..."` line (the [package] one).
for (const cargoPath of cargoPaths) {
  const cargo = readFileSync(cargoPath, "utf8");
  let replaced = false;
  const nextCargo = cargo.replace(/^version = "[^"]*"$/m, () => {
    replaced = true;
    return `version = "${next}"`;
  });
  if (!replaced) {
    throw new Error(`Could not find a [package] version line in ${cargoPath}.`);
  }
  writeFileSync(cargoPath, nextCargo);
}

// Cargo.lock — cargo would fix this on the next build, but leaving it stale
// means every release commit carries an unrelated lockfile diff.
let lock = readFileSync(lockPath, "utf8");
for (const crate of [pkg.name === "research-writer" ? "research-writer" : pkg.name, "lattice-core"]) {
  const lockEntry = new RegExp(`(\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = )"[^"]*"`);
  if (!lockEntry.test(lock)) {
    throw new Error(`Could not find the ${crate} package entry in ${lockPath}.`);
  }
  lock = lock.replace(lockEntry, `$1"${next}"`);
}
writeFileSync(lockPath, lock);

const gpuiLock = readFileSync(gpuiLockPath, "utf8");
const gpuiEntry = /(\[\[package\]\]\nname = "lattice-core"\nversion = )"[^"]*"/;
if (!gpuiEntry.test(gpuiLock)) {
  throw new Error(`Could not find the lattice-core package entry in ${gpuiLockPath}.`);
}
writeFileSync(gpuiLockPath, gpuiLock.replace(gpuiEntry, `$1"${next}"`));

const notes = writeReleaseNotes(next, new Date().toISOString().slice(0, 10), projectRoot);

console.log(`Bumped ${current} -> ${next}`);
console.log("");
if (notes) {
  console.log(`Wrote the What's new notes to ${notes.path}.`);
  if (notes.untranslated) console.log(`  Translate its ${notes.untranslated} empty "zh" text(s) before committing.`);
} else {
  console.log(`No ${leadPath} (--no-notes): What's new keeps showing the last release that had one.`);
}
console.log("");
console.log("Next steps:");
console.log(`  git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/lattice-core/Cargo.toml src-tauri/Cargo.lock gpui/Cargo.lock${notes ? ` src/release-notes/${next}.json` : ""}`);
console.log(`  git commit -m "Release v${next}"`);
console.log(`  git tag v${next}`);
console.log(`  git push origin main`);
console.log(`  git push origin refs/tags/v${next}`);
console.log("");
console.log("Pushing the tag triggers the Release workflow, which builds,");
console.log("signs, publishes the GitHub Release, and updates latest.json.");
