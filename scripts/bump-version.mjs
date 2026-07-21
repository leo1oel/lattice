#!/usr/bin/env node
// Bump the app version in lockstep across package.json, tauri.conf.json, and
// Cargo.toml, so every release ships one coherent version number.
//
// Usage:
//   node scripts/bump-version.mjs            # patch: 0.1.37 -> 0.1.38
//   node scripts/bump-version.mjs patch
//   node scripts/bump-version.mjs minor      # 0.1.37 -> 0.2.0
//   node scripts/bump-version.mjs major      # 0.1.37 -> 1.0.0
//   node scripts/bump-version.mjs 0.3.0      # set an explicit version
//
// It only edits files; it does not commit or tag. It prints the exact git
// commands to run next.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(projectRoot, "package.json");
const confPath = join(projectRoot, "src-tauri/tauri.conf.json");
const cargoPath = join(projectRoot, "src-tauri/Cargo.toml");
const lockPath = join(projectRoot, "src-tauri/Cargo.lock");

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const current = pkg.version;
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
if (!match) {
  throw new Error(`Current version "${current}" is not plain semver x.y.z.`);
}
const [major, minor, patch] = match.slice(1).map(Number);

const arg = (process.argv[2] ?? "patch").trim();
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

// package.json — rewrite the version field, keep the file's formatting.
pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// tauri.conf.json — same, targeting the top-level "version".
const conf = JSON.parse(readFileSync(confPath, "utf8"));
conf.version = next;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");

// Cargo.toml — replace the first `version = "..."` line (the [package] one).
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

// Cargo.lock — cargo would fix this on the next build, but leaving it stale
// means every release commit carries an unrelated lockfile diff.
const lock = readFileSync(lockPath, "utf8");
const lockEntry = new RegExp(
  `(\\[\\[package\\]\\]\\nname = "${pkg.name === "research-writer" ? "research-writer" : pkg.name}"\\nversion = )"[^"]*"`,
);
if (!lockEntry.test(lock)) {
  throw new Error(`Could not find the research-writer package entry in ${lockPath}.`);
}
writeFileSync(lockPath, lock.replace(lockEntry, `$1"${next}"`));

console.log(`Bumped ${current} -> ${next}`);
console.log("");
console.log("Next steps:");
console.log(`  git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock`);
console.log(`  git commit -m "Release v${next}"`);
console.log(`  git tag v${next}`);
console.log(`  git push origin main --tags`);
console.log("");
console.log("Pushing the tag triggers the Release workflow, which builds,");
console.log("signs, publishes the GitHub Release, and updates latest.json.");
