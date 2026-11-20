import { describe, expect, it } from "vitest";
import { checkNativeManifest, nativeFiles } from "./check-native-feed.mjs";
import { FLAVORS, updaterManifest } from "./gpui-bundle.mjs";

// The manifest gpui-bundle.mjs writes for the native app is the one
// release.yml checks before it publishes it as latest-native.json.
const tag = "v1.2.3";
const files = nativeFiles("1.2.3");
const manifest = updaterManifest({
  version: "1.2.3",
  signature: "native",
  url: `${FLAVORS.main.feed("1.2.3", "leo1oel/lattice")}/${files.archive}`,
  pubDate: "2026-11-20T00:00:00Z",
});
const check = { tag, version: "1.2.3", signature: "native\n" };

describe("the native feed", () => {
  it("names the native app's files apart from tauri-action's, with its own manifest", () => {
    expect(files).toEqual({
      dmg: "Lattice-native_1.2.3_aarch64.dmg",
      archive: "Lattice-native_1.2.3_aarch64.app.tar.gz",
      signature: "Lattice-native_1.2.3_aarch64.app.tar.gz.sig",
      manifest: "latest-native.json",
    });
  });

  it("accepts the manifest gpui-bundle writes for this tag's archive", () => {
    expect(() => checkNativeManifest(manifest, check)).not.toThrow();
    expect(manifest.platforms["darwin-aarch64-app"].url).toBe(
      "https://github.com/leo1oel/lattice/releases/download/v1.2.3/Lattice-native_1.2.3_aarch64.app.tar.gz",
    );
  });

  it("accepts a rehearsal tag for the version's own files", () => {
    expect(() => checkNativeManifest(manifest, { ...check, tag: "v1.2.3-rc.1" })).not.toThrow();
  });

  it("refuses another version or tag, a missing key, another archive and another signature", () => {
    expect(() => checkNativeManifest({ ...manifest, version: "1.2.4" }, check)).toThrow(/not v1.2.3/);
    expect(() => checkNativeManifest(manifest, { ...check, tag: "v1.2.4" })).toThrow(/not v1.2.4/);
    expect(() => checkNativeManifest(manifest, { ...check, tag: "v1.2.30" })).toThrow(/not v1.2.30/);
    const only = { ...manifest, platforms: { "darwin-aarch64": manifest.platforms["darwin-aarch64"] } };
    expect(() => checkNativeManifest(only, check)).toThrow(/lists no darwin-aarch64-app/);
    const tauri = updaterManifest({ version: "1.2.3", signature: "native", url: `${FLAVORS.main.feed("1.2.3")}/Lattice_1.2.3_aarch64.app.tar.gz` });
    expect(() => checkNativeManifest(tauri, check)).toThrow(/is not v1.2.3's/);
    const elsewhere = updaterManifest({ version: "1.2.3", signature: "native", url: `https://example.com/releases/download/v1.2.3/${files.archive}` });
    expect(() => checkNativeManifest(elsewhere, check)).toThrow(/is not v1.2.3's/);
    expect(() => checkNativeManifest(manifest, { ...check, signature: "other" })).toThrow(/another signature/);
    expect(() => checkNativeManifest(manifest, { ...check, signature: " " })).toThrow(/Empty/);
  });
});
