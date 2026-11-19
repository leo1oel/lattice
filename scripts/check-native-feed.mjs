import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { verifyUpdaterSignature } from "./add-updater-platform.mjs";
import { FLAVORS } from "./gpui-bundle.mjs";
import { isMain, projectRoot } from "./lib/util.mjs";

// Checks the native app's files (scripts/gpui-bundle.mjs --flavor main, as
// gpui-package.yml keeps them) before release.yml uploads them beside the
// Tauri app's. latest-native.json is the feed every Tauri copy on Apple
// silicon reads to offer the switch and every native copy reads to update,
// so this refuses a manifest for another version or tag, one whose archive
// is not this release's Lattice-native archive, and a signature that does
// not verify against the updater key both apps pin (tauri.conf.json).

/** The native app's file names for `version`, from gpui-bundle's FLAVORS.main. */
export function nativeFiles(version) {
  const base = `${FLAVORS.main.artifact}_${version}_aarch64`;
  return { dmg: `${base}.dmg`, archive: `${base}.app.tar.gz`, signature: `${base}.app.tar.gz.sig`, manifest: FLAVORS.main.manifest };
}

/**
 * Throws unless `manifest` offers `version` as `tag`'s own Lattice-native
 * archive, under both Apple silicon keys, with `signature` (the .sig file's
 * contents).
 */
export function checkNativeManifest(manifest, { tag, version, signature }) {
  const name = FLAVORS.main.manifest;
  if (tag !== `v${version}` || manifest.version !== version) throw new Error(`${name} is for ${manifest.version}, not ${tag}`);
  const { archive } = nativeFiles(version);
  const trimmed = signature.trim();
  if (!trimmed) throw new Error("Empty updater signature");
  for (const platform of ["darwin-aarch64", "darwin-aarch64-app"]) {
    const entry = manifest.platforms?.[platform];
    if (!entry) throw new Error(`${name} lists no ${platform}`);
    const url = new URL(entry.url);
    if (url.origin !== "https://github.com" || !url.pathname.endsWith(`/releases/download/${tag}/${archive}`)) {
      throw new Error(`${name}'s ${platform} is not ${tag}'s ${archive}`);
    }
    if (entry.signature?.trim() !== trimmed) throw new Error(`${name}'s ${platform} carries another signature`);
  }
}

if (isMain(import.meta.url)) {
  const [, , tag, directory] = process.argv;
  if (!tag || !directory) throw new Error("Usage: node scripts/check-native-feed.mjs <tag> <directory>");
  const config = JSON.parse(readFileSync(join(projectRoot, "src-tauri/tauri.conf.json"), "utf8"));
  const paths = Object.fromEntries(Object.entries(nativeFiles(config.version)).map(([kind, name]) => [kind, join(directory, name)]));
  for (const file of Object.values(paths)) {
    if (!existsSync(file) || statSync(file).size === 0) throw new Error(`The native app's ${file} is missing or empty`);
  }
  const signature = readFileSync(paths.signature, "utf8");
  verifyUpdaterSignature(readFileSync(paths.archive), signature, config.plugins.updater.pubkey);
  checkNativeManifest(JSON.parse(readFileSync(paths.manifest, "utf8")), { tag, version: config.version, signature });
  // The files to upload, the manifest last, so a check never reads a
  // manifest whose archive is not there yet.
  process.stdout.write(`${[paths.dmg, paths.archive, paths.signature, paths.manifest].join("\n")}\n`);
}
