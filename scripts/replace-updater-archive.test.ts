import { describe, expect, it } from "vitest";
import { replaceUpdaterArchive } from "./replace-updater-archive.mjs";

const name = "Lattice_1.2.3_aarch64.app.tar.gz";
const arm = `https://github.com/owner/app/releases/download/v1.2.3/${name}`;
const intel = "https://github.com/owner/app/releases/download/v1.2.3/Lattice_1.2.3_x64.app.tar.gz";
const release = {
  tag_name: "v1.2.3",
  draft: true,
  assets: [{ name, browser_download_url: "https://github.com/owner/app/releases/download/untagged-1/" + name, state: "uploaded" }],
};
const manifest = {
  version: "1.2.3", notes: "Notes", pub_date: "2026-11-20T00:00:00Z",
  platforms: {
    "darwin-aarch64": { signature: "tauri", url: arm },
    "darwin-aarch64-app": { signature: "tauri", url: arm },
    "darwin-x86_64": { signature: "intel", url: intel },
  },
};
const replace = { assetName: name, signature: "gpui\n", platforms: ["darwin-aarch64", "darwin-aarch64-app"] };

describe("replacing the Apple silicon updater archive in latest.json", () => {
  it("swaps only the signature of the entries that name the asset", () => {
    const result = replaceUpdaterArchive(manifest, release, replace);
    expect(result).toEqual({
      ...manifest,
      platforms: {
        "darwin-aarch64": { signature: "gpui", url: arm },
        "darwin-aarch64-app": { signature: "gpui", url: arm },
        "darwin-x86_64": manifest.platforms["darwin-x86_64"],
      },
    });
    expect(manifest.platforms["darwin-aarch64"].signature).toBe("tauri");
  });

  it("refuses another version, a missing asset or entry, and an entry naming another file", () => {
    expect(() => replaceUpdaterArchive({ ...manifest, version: "1.2.4" }, release, replace)).toThrow(/tag/);
    expect(() => replaceUpdaterArchive(manifest, { ...release, assets: [] }, replace)).toThrow(/no uploaded/);
    expect(() => replaceUpdaterArchive(manifest, release, { ...replace, platforms: ["windows-x86_64"] })).toThrow(/lists no/);
    expect(() => replaceUpdaterArchive(manifest, release, { ...replace, platforms: ["darwin-x86_64"] })).toThrow(/is not/);
    expect(() => replaceUpdaterArchive(manifest, release, { ...replace, signature: " " })).toThrow(/Empty/);
    const elsewhere = { ...manifest, platforms: { "darwin-aarch64": { signature: "tauri", url: `https://example.com/releases/download/v1.2.3/${name}` } } };
    expect(() => replaceUpdaterArchive(elsewhere, release, { ...replace, platforms: ["darwin-aarch64"] })).toThrow(/is not/);
  });
});
