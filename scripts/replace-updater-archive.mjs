import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyUpdaterSignature } from "./add-updater-platform.mjs";
import { isMain, projectRoot } from "./lib/util.mjs";

// Points latest.json's Apple silicon entries at another updater archive
// uploaded under the same name: the release workflow replaces the Tauri
// app's Lattice_<version>_aarch64.app.tar.gz with the GPUI app's (Lattice
// in the Tauri app's place, scripts/gpui-bundle.mjs --flavor main), and only
// the signature in latest.json still describes the Tauri archive. Every
// installed Apple silicon copy reads these entries, so it refuses anything
// but the version's own release, an uploaded asset the entries already name,
// and a signature that verifies against the updater key the apps pin.

/**
 * `manifest` with each of `platforms` carrying `signature`. Each must
 * already point at the public download URL of the release asset named
 * `assetName` (as normalize-updater-manifest.mjs writes it, before the
 * asset is replaced); every other entry is kept as it was.
 */
export function replaceUpdaterArchive(manifest, release, { assetName, signature, platforms }) {
  if (release.tag_name !== `v${manifest.version}`) throw new Error("Updater version does not match the release tag");
  if (platforms.length === 0) throw new Error("No platform to replace");
  const asset = release.assets.find((candidate) => candidate.name === assetName);
  if (!asset || asset.state !== "uploaded") throw new Error(`The release has no uploaded ${assetName}`);
  const trimmed = signature.trim();
  if (!trimmed) throw new Error("Empty updater signature");
  const replaced = { ...manifest.platforms };
  for (const platform of platforms) {
    const entry = manifest.platforms?.[platform];
    if (!entry) throw new Error(`latest.json lists no ${platform}`);
    const url = new URL(entry.url);
    if (url.origin !== "https://github.com" || !url.pathname.endsWith(`/releases/download/${release.tag_name}/${assetName}`)) {
      throw new Error(`latest.json's ${platform} is not ${assetName}`);
    }
    replaced[platform] = { ...entry, signature: trimmed };
  }
  return { ...manifest, platforms: replaced };
}

if (isMain(import.meta.url)) {
  const [, , manifestPath, releasePath, archivePath, signaturePath, assetName, ...platforms] = process.argv;
  if (!manifestPath || !releasePath || !archivePath || !signaturePath || !assetName || platforms.length === 0) {
    throw new Error(
      "Usage: node scripts/replace-updater-archive.mjs <latest.json> <release.json> <archive> <archive.sig> <asset name> <platform>...",
    );
  }
  const config = JSON.parse(readFileSync(join(projectRoot, "src-tauri/tauri.conf.json"), "utf8"));
  const signature = readFileSync(signaturePath, "utf8");
  verifyUpdaterSignature(readFileSync(archivePath), signature, config.plugins.updater.pubkey);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const release = JSON.parse(readFileSync(releasePath, "utf8"));
  writeFileSync(manifestPath, `${JSON.stringify(replaceUpdaterArchive(manifest, release, { assetName, signature, platforms }), null, 2)}\n`);
  console.log(`latest.json ${manifest.version}: ${platforms.join(", ")} now carry ${assetName}'s signature.`);
}
