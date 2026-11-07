import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMain, projectRoot } from "./lib/util.mjs";

// Adds one more platform's updater archive to a published release's
// latest.json, leaving every entry already there exactly as it was. The macOS
// Intel workflow runs it after the Apple silicon release is public, so a
// mistake here reaches every installed copy: it refuses anything but a
// version-matched, uploaded, public asset whose signature verifies against the
// updater key the app itself pins.

const decode = (base64) => Buffer.from(base64.trim(), "base64");

/** The base64 key lines of a minisign text file (comment lines dropped). */
function minisignLines(text, kind) {
  const lines = text.split(/\r?\n/);
  if (!lines[0]?.startsWith("untrusted comment:")) throw new Error(`The ${kind} is not in minisign format`);
  return lines;
}

/**
 * Verify a Tauri updater signature (the `.sig` file's contents: base64 of a
 * minisign signature file) over `archive`, against `publicKey` (the
 * `plugins.updater.pubkey` string from tauri.conf.json: base64 of a minisign
 * public key file). Checks the key ID, the signature over the archive and the
 * global signature over its trusted comment, as minisign and the updater do.
 */
export function verifyUpdaterSignature(archive, signature, publicKey) {
  const keyBytes = decode(minisignLines(decode(publicKey).toString("utf8"), "public key")[1] ?? "");
  if (keyBytes.length !== 42 || keyBytes.subarray(0, 2).toString("latin1") !== "Ed") {
    throw new Error("The updater public key is not an Ed25519 minisign key");
  }
  const lines = minisignLines(decode(signature).toString("utf8"), "signature");
  const signatureBytes = decode(lines[1] ?? "");
  const trusted = lines[2] ?? "";
  const globalSignature = decode(lines[3] ?? "");
  if (signatureBytes.length !== 74 || !trusted.startsWith("trusted comment: ") || globalSignature.length !== 64) {
    throw new Error("The updater signature is incomplete");
  }
  const algorithm = signatureBytes.subarray(0, 2).toString("latin1");
  if (algorithm !== "Ed" && algorithm !== "ED") throw new Error(`Unknown minisign algorithm ${algorithm}`);
  if (!signatureBytes.subarray(2, 10).equals(keyBytes.subarray(2, 10))) {
    throw new Error("The updater signature was made with a different key");
  }
  // An Ed25519 public key as SPKI DER: a fixed 12-byte header and the key.
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), keyBytes.subarray(10)]),
    format: "der",
    type: "spki",
  });
  // "ED" signs the BLAKE2b-512 digest of the file (what Tauri's signer writes).
  const message = algorithm === "ED" ? createHash("blake2b512").update(archive).digest() : archive;
  const rawSignature = signatureBytes.subarray(10);
  if (!verify(null, message, key, rawSignature)) throw new Error("The updater signature does not match the archive");
  const comment = Buffer.from(trusted.slice("trusted comment: ".length), "utf8");
  if (!verify(null, Buffer.concat([rawSignature, comment]), key, globalSignature)) {
    throw new Error("The updater signature's trusted comment was altered");
  }
}

/**
 * `manifest` with `platforms` pointing at the release asset named `assetName`
 * and carrying `signature`. Existing entries are kept as they are; one of the
 * new platforms that is already listed must already say the same thing.
 */
export function addUpdaterPlatform(manifest, release, { assetName, signature, platforms }) {
  if (release.tag_name !== `v${manifest.version}`) throw new Error("Updater version does not match the release tag");
  if (release.draft !== false) throw new Error("The release is not published");
  if (!manifest.platforms || Object.keys(manifest.platforms).length === 0) {
    throw new Error("Updater manifest has no platforms");
  }
  if (platforms.length === 0) throw new Error("No platform to add");
  const asset = release.assets.find((candidate) => candidate.name === assetName);
  if (!asset || asset.state !== "uploaded") throw new Error(`The release has no uploaded ${assetName}`);
  const url = asset.browser_download_url;
  if (!url?.startsWith(`https://github.com/`) || !new URL(url).pathname.endsWith(`/releases/download/${release.tag_name}/${assetName}`)) {
    throw new Error(`Invalid public download URL for ${assetName}`);
  }
  const entry = { signature: signature.trim(), url };
  if (!entry.signature) throw new Error("Empty updater signature");
  const added = { ...manifest.platforms };
  for (const platform of platforms) {
    const existing = manifest.platforms[platform];
    if (existing && (existing.url !== entry.url || existing.signature !== entry.signature)) {
      throw new Error(`latest.json already lists a different ${platform}`);
    }
    added[platform] = entry;
  }
  return { ...manifest, platforms: added };
}

if (isMain(import.meta.url)) {
  const [, , manifestPath, releasePath, archivePath, signaturePath, assetName, ...platforms] = process.argv;
  if (!manifestPath || !releasePath || !archivePath || !signaturePath || !assetName || platforms.length === 0) {
    throw new Error(
      "Usage: node scripts/add-updater-platform.mjs <latest.json> <release.json> <archive> <archive.sig> <asset name> <platform>...",
    );
  }
  const config = JSON.parse(readFileSync(join(projectRoot, "src-tauri/tauri.conf.json"), "utf8"));
  const signature = readFileSync(signaturePath, "utf8");
  verifyUpdaterSignature(readFileSync(archivePath), signature, config.plugins.updater.pubkey);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const release = JSON.parse(readFileSync(releasePath, "utf8"));
  const result = addUpdaterPlatform(manifest, release, { assetName, signature, platforms });
  writeFileSync(manifestPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`latest.json ${manifest.version} now lists ${Object.keys(result.platforms).join(", ")}.`);
}
