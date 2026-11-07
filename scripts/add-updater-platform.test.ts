import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addUpdaterPlatform, verifyUpdaterSignature } from "./add-updater-platform.mjs";

const tag = "v1.2.3";
const arm = "https://github.com/owner/app/releases/download/v1.2.3/App_1.2.3_aarch64.app.tar.gz";
const intel = "https://github.com/owner/app/releases/download/v1.2.3/App_1.2.3_x64.app.tar.gz";
const release = {
  tag_name: tag,
  draft: false,
  assets: [
    { name: "App_1.2.3_aarch64.app.tar.gz", browser_download_url: arm, state: "uploaded" },
    { name: "App_1.2.3_x64.app.tar.gz", browser_download_url: intel, state: "uploaded" },
  ],
};
const manifest = {
  version: "1.2.3", notes: "Release notes", pub_date: "2026-09-20T00:00:00Z",
  platforms: {
    "darwin-aarch64": { signature: "arm-signature", url: arm },
    "darwin-aarch64-app": { signature: "arm-signature", url: arm },
  },
};
const add = { assetName: "App_1.2.3_x64.app.tar.gz", signature: "intel-signature\n", platforms: ["darwin-x86_64", "darwin-x86_64-app"] };

describe("adding the Intel updater archive to latest.json", () => {
  it("adds both platform keys and leaves the Apple silicon entries untouched", () => {
    const result = addUpdaterPlatform(manifest, release, add);
    expect(result).toEqual({
      ...manifest,
      platforms: {
        ...manifest.platforms,
        "darwin-x86_64": { signature: "intel-signature", url: intel },
        "darwin-x86_64-app": { signature: "intel-signature", url: intel },
      },
    });
    expect(result.platforms["darwin-aarch64"]).toBe(manifest.platforms["darwin-aarch64"]);
    expect(Object.keys(manifest.platforms)).toHaveLength(2);
    // A re-run of the workflow adds the same entries again.
    expect(addUpdaterPlatform(result, release, add)).toEqual(result);
  });

  it.each([
    ["another version's manifest", { ...manifest, version: "1.2.2" }, release, add, /version/],
    ["a draft release", manifest, { ...release, draft: true }, add, /not published/],
    ["a release without the asset", manifest, { ...release, assets: release.assets.slice(0, 1) }, add, /no uploaded/],
    ["an asset still uploading", manifest, { ...release, assets: [release.assets[0], { ...release.assets[1], state: "starter" }] }, add, /no uploaded/],
    ["an asset of another tag", manifest, { ...release, assets: [release.assets[0], { ...release.assets[1], browser_download_url: intel.replace("v1.2.3", "v1.2.2") }] }, add, /public download URL/],
    ["an empty signature", manifest, release, { ...add, signature: " \n" }, /Empty/],
    ["a manifest with no platforms", { ...manifest, platforms: {} }, release, add, /no platforms/],
    ["a platform that already points elsewhere", manifest, release, { ...add, platforms: ["darwin-aarch64"] }, /different darwin-aarch64/],
  ])("refuses %s", (_, inputManifest, inputRelease, options, error) => {
    expect(() => addUpdaterPlatform(inputManifest, inputRelease, options)).toThrow(error);
  });
});

/** A minisign key pair and signer in the format Tauri's updater signer writes. */
function minisign(keyId = Buffer.from("0123456789abcdef", "hex")) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const keyFile = `untrusted comment: minisign public key: X\n${Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64")}\n`;
  const signFile = (archive: Buffer, comment = "timestamp:1\tfile:App.app.tar.gz") => {
    const signature = sign(null, createHash("blake2b512").update(archive).digest(), privateKey);
    const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
    const text = [
      "untrusted comment: signature from tauri secret key",
      Buffer.concat([Buffer.from("ED"), keyId, signature]).toString("base64"),
      `trusted comment: ${comment}`,
      global.toString("base64"),
      "",
    ].join("\n");
    return Buffer.from(text).toString("base64");
  };
  return { publicKey: Buffer.from(keyFile).toString("base64"), signFile };
}

describe("updater signature verification", () => {
  const archive = Buffer.from("an updater archive");
  const key = minisign();

  it("accepts the archive the key signed", () => {
    expect(() => verifyUpdaterSignature(archive, key.signFile(archive), key.publicKey)).not.toThrow();
  });

  it("refuses another archive, another key, and an edited trusted comment", () => {
    expect(() => verifyUpdaterSignature(Buffer.from("another archive"), key.signFile(archive), key.publicKey)).toThrow(/does not match/);
    const other = minisign(Buffer.from("fedcba9876543210", "hex"));
    expect(() => verifyUpdaterSignature(archive, other.signFile(archive), key.publicKey)).toThrow(/different key/);
    const sameId = minisign();
    expect(() => verifyUpdaterSignature(archive, sameId.signFile(archive), key.publicKey)).toThrow(/does not match/);
    const text = Buffer.from(key.signFile(archive), "base64").toString().replace("timestamp:1", "timestamp:2");
    expect(() => verifyUpdaterSignature(archive, Buffer.from(text).toString("base64"), key.publicKey)).toThrow(/trusted comment/);
  });

  it("refuses text that is not a minisign signature", () => {
    expect(() => verifyUpdaterSignature(archive, Buffer.from("hello").toString("base64"), key.publicKey)).toThrow(/minisign/);
  });
});
