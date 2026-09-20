import { describe, expect, it } from "vitest";
import { normalizeUpdaterManifest } from "./normalize-updater-manifest.mjs";

const apiUrl = "https://api.github.com/repos/owner/app/releases/assets/42";
const downloadUrl = "https://github.com/owner/app/releases/download/v1.2.3/App_arm64.app.tar.gz";
const release = {
  tag_name: "v1.2.3",
  assets: [{ url: apiUrl, browser_download_url: downloadUrl, state: "uploaded" }],
};
const manifest = {
  version: "1.2.3", notes: "Release notes", pub_date: "2026-09-20T00:00:00Z",
  platforms: {
    "darwin-aarch64": { url: apiUrl, signature: "original-signature" },
    "darwin-aarch64-app": { url: apiUrl, signature: "original-signature" },
  },
};

describe("public updater downloads", () => {
  it("rewrites both platform aliases without altering signatures or release metadata", () => {
    const result = normalizeUpdaterManifest(manifest, release);
    expect(result).toEqual({
      version: "1.2.3", notes: "Release notes", pub_date: "2026-09-20T00:00:00Z",
      platforms: {
        "darwin-aarch64": { url: downloadUrl, signature: "original-signature" },
        "darwin-aarch64-app": { url: downloadUrl, signature: "original-signature" },
      },
    });
    expect(manifest.platforms["darwin-aarch64"].url).toBe(apiUrl);
    expect(normalizeUpdaterManifest(result, release)).toEqual(result);
  });

  it("resolves a draft's temporary download tag to the tag that will be published", () => {
    const draft = {
      ...release,
      draft: true,
      html_url: "https://github.com/owner/app/releases/tag/untagged-abc123",
      assets: [{ ...release.assets[0], browser_download_url: downloadUrl.replace("v1.2.3", "untagged-abc123") }],
    };
    const result = normalizeUpdaterManifest(manifest, draft);
    expect(result.platforms).toEqual({
      "darwin-aarch64": { url: downloadUrl, signature: "original-signature" },
      "darwin-aarch64-app": { url: downloadUrl, signature: "original-signature" },
    });
    expect(() => normalizeUpdaterManifest(manifest, { ...draft, draft: false })).toThrow("Invalid public");
    expect(() => normalizeUpdaterManifest(manifest, {
      ...draft, html_url: "https://github.com/owner/app/releases/tag/untagged-other",
    })).toThrow("Invalid public");
  });

  it("rejects the wrong release and missing assets instead of publishing broken URLs", () => {
    expect(() => normalizeUpdaterManifest(manifest, { ...release, tag_name: "v1.2.4" })).toThrow("release tag");
    expect(() => normalizeUpdaterManifest(manifest, { ...release, assets: [] })).toThrow("Missing uploaded");
    expect(() => normalizeUpdaterManifest({ ...manifest, platforms: {} }, release)).toThrow("no platforms");
    expect(() => normalizeUpdaterManifest(manifest, {
      ...release, assets: [{ ...release.assets[0], browser_download_url: "https://api.github.com/download" }],
    })).toThrow("Invalid public");
  });
});
