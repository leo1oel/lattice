import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkAssets, checkBundle, checkSite, timelessFontHashes } from "./check-font-leaks.mjs";

// Stand-in fonts: a container signature and some bytes. No real Timeless file
// may enter the repository.
const font = (tag: string, body: string) => Buffer.concat([Buffer.from(tag, "latin1"), Buffer.from(body)]);

let scratch: string | null = null;
function scratchDirectory() {
  scratch = mkdtempSync(path.join(os.tmpdir(), "lattice-font-leaks-test-"));
  return scratch;
}
function write(root: string, relative: string, data: Buffer | string) {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), data);
}
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

describe("release asset check", () => {
  it("allows only the signed artifacts, and never a font by extension or by signature", () => {
    const root = scratchDirectory();
    write(root, "Lattice_0.1.0_aarch64.dmg", "disk image");
    write(root, "Lattice.app.tar.gz", "archive");
    write(root, "Lattice.app.tar.gz.sig", "signature");
    write(root, "latest.json", "{\"timeless\": true}");
    write(root, "Lattice_0.1.0_amd64.AppImage", "AppImage");
    write(root, "Lattice_0.1.0_amd64.AppImage.tar.gz", "an updater archive Linux does not publish");
    write(root, "notes.txt", "release notes");
    write(root, "Sans.woff2", "not even a font inside");
    write(root, "renamed.bin", font("\0\x01\0\0", "glyphs"));
    write(root, "renamed.dmg", font("OTTO", "glyphs"));
    expect(checkAssets(root).sort()).toEqual([
      "Lattice_0.1.0_amd64.AppImage.tar.gz is not a signed release artifact",
      "Sans.woff2 is a font offered for download on its own",
      "Sans.woff2 is not a signed release artifact",
      "notes.txt is not a signed release artifact",
      "renamed.bin is a font offered for download on its own",
      "renamed.bin is not a signed release artifact",
      "renamed.dmg is a font offered for download on its own",
    ]);
  });
});

describe("built app check", () => {
  it("finds Timeless by name or by content anywhere, and other fonts only outside the bundled runtimes", () => {
    const root = scratchDirectory();
    const original = font("wOF2", "the sans face");
    const emitted = font("wOF2", "the serif face");
    write(root, "fonts/Sans/SansVF.woff2", original);
    write(root, "fonts/LICENSE.pdf", "%PDF stand-in");
    write(root, "dist/assets/TimelessSerif-TextRegular-abc123.woff2", emitted);
    write(root, "dist/assets/index-abc123.js", "code");
    const hashes = timelessFontHashes({ fontsDirectory: path.join(root, "fonts"), emittedDirectory: path.join(root, "dist/assets") });
    expect(hashes.size).toBe(2);

    const app = path.join(root, "Lattice.app");
    write(app, "Contents/MacOS/lattice", "binary");
    write(app, "Contents/Resources/synara-runtime/node_modules/katex/fonts/KaTeX_Main-Regular.woff2", font("wOF2", "katex"));
    write(app, "Contents/Resources/presentation-runtime/fonts/Inter.ttf", font("true", "inter"));
    write(app, "Contents/Resources/synara-runtime/vendor/copied.woff2", original);
    write(app, "Contents/Resources/presentation-runtime/TimelessNotes.txt", "named");
    write(app, "Contents/Resources/renamed.dat", emitted);
    write(app, "Contents/Resources/Inter.woff2", font("wOF2", "inter"));
    write(app, "Contents/Resources/unnamed.bin", font("ttcf", "collection"));
    expect(checkBundle(app, hashes, "app").sort()).toEqual([
      "Lattice.app/Contents/Resources/Inter.woff2 is a font outside the app's web assets and bundled runtimes",
      "Lattice.app/Contents/Resources/presentation-runtime/TimelessNotes.txt is named for Timeless",
      "Lattice.app/Contents/Resources/renamed.dat is a copy of a Timeless font",
      "Lattice.app/Contents/Resources/synara-runtime/vendor/copied.woff2 is a copy of a Timeless font",
      "Lattice.app/Contents/Resources/unnamed.bin is a font outside the app's web assets and bundled runtimes",
    ]);
  });

  it("checks names and fonts alone when the build had no Timeless fonts", () => {
    const root = scratchDirectory();
    const hashes = timelessFontHashes({ fontsDirectory: null, emittedDirectory: path.join(root, "dist/assets") });
    expect(hashes.size).toBe(0);
    const app = path.join(root, "Lattice.app");
    write(app, "Contents/MacOS/lattice", "binary");
    write(app, "Contents/Resources/synara-runtime/fonts/KaTeX_Main-Regular.woff2", font("wOF2", "katex"));
    expect(checkBundle(app, hashes, "app")).toEqual([]);
  });

  it("applies the same rules to an extracted AppImage, with the runtimes under usr/lib/Lattice", () => {
    const root = scratchDirectory();
    const original = font("wOF2", "the sans face");
    write(root, "fonts/Sans/SansVF.woff2", original);
    const hashes = timelessFontHashes({ fontsDirectory: path.join(root, "fonts"), emittedDirectory: path.join(root, "dist/assets") });
    const appdir = path.join(root, "squashfs-root");
    write(appdir, "usr/bin/research-writer", "binary");
    write(appdir, "usr/lib/Lattice/synara-runtime/node_modules/katex/fonts/KaTeX_Main-Regular.woff2", font("wOF2", "katex"));
    write(appdir, "usr/lib/Lattice/presentation-runtime/fonts/Inter.ttf", font("true", "inter"));
    write(appdir, "usr/lib/Lattice/synara-runtime/vendor/copied.woff2", original);
    write(appdir, "usr/share/fonts/Inter.ttf", font("true", "inter"));
    write(appdir, "Contents/Resources/synara-runtime/Inter.ttf", font("true", "a macOS path means nothing here"));
    expect(checkBundle(appdir, hashes, "appdir").sort()).toEqual([
      "squashfs-root/Contents/Resources/synara-runtime/Inter.ttf is a font outside the app's web assets and bundled runtimes",
      "squashfs-root/usr/lib/Lattice/synara-runtime/vendor/copied.woff2 is a copy of a Timeless font",
      "squashfs-root/usr/share/fonts/Inter.ttf is a font outside the app's web assets and bundled runtimes",
    ]);
  });

  it("fails with an I/O error, not a clean result, when the path is not a built app", () => {
    const root = scratchDirectory();
    write(root, "Empty.app/Contents/Info.plist", "plist");
    write(root, "file.app", "not a directory");
    for (const target of ["never-created.app", "Empty.app", "file.app"]) {
      const result = spawnSync(process.execPath, [path.join(__dirname, "check-font-leaks.mjs"), "app", path.join(root, target)], {
        encoding: "utf8",
        env: { ...process.env, LATTICE_PRIVATE_FONTS_DIR: "" },
      });
      expect(result.status, target).toBe(2);
      expect(result.stdout, target).toBe("");
      expect(result.stderr, target).toContain("is not a built .app");
    }
    const appdir = spawnSync(process.execPath, [path.join(__dirname, "check-font-leaks.mjs"), "appdir", path.join(root, "Empty.app")], {
      encoding: "utf8",
      env: { ...process.env, LATTICE_PRIVATE_FONTS_DIR: "" },
    });
    expect(appdir.status).toBe(2);
    expect(appdir.stderr).toContain("is not an extracted AppImage");
  });
});

describe("experimental Windows downloads", () => {
  it("permits only the namespaced installer, checksum, metadata and instructions", () => {
    const root = scratchDirectory();
    for (const suffix of ["-setup.exe", ".sha256", ".build-info.json", ".README.txt"]) {
      write(root, `Lattice_1.2.3_windows-x64-experimental${suffix}`, "not a font");
    }
    expect(checkAssets(root)).toEqual([]);
    write(root, "Lattice_1.2.3_windows-x64-experimental.ttf", font("true", "font"));
    expect(checkAssets(root)).toHaveLength(2);
  });
  it("checks installed files and does not allow loose fonts outside the runtimes", () => {
    const root = scratchDirectory();
    const installed = path.join(root, "Lattice");
    write(installed, "research-writer.exe", "MZ executable");
    write(installed, "presentation-runtime/fonts/Inter.ttf", font("true", "inter"));
    expect(checkBundle(installed, new Set(), "windows")).toEqual([]);
    write(installed, "loose.ttf", font("true", "loose"));
    expect(checkBundle(installed, new Set(), "windows")).toHaveLength(1);
    expect(() => checkBundle(root, new Set(), "windows")).toThrow(/no research-writer.exe/);
  });
});

describe("website build check", () => {
  it("finds Timeless by name or by content, and lets the open-licensed faces ship", () => {
    const root = scratchDirectory();
    const original = font("wOF2", "the sans face");
    write(root, "fonts/Sans/SansVF.woff2", original);
    const site = path.join(root, "demo");
    write(site, "index.html", "<!doctype html>");
    write(site, "assets/Inter-abc123.woff2", font("wOF2", "inter"));
    write(site, "assets/KaTeX_Main-Regular-abc123.woff2", font("wOF2", "katex"));
    write(site, "assets/TimelessSans-Regular-abc123.woff2", font("wOF2", "renamed by the build"));
    write(site, "assets/face-abc123.woff2", original);
    const hashes = timelessFontHashes({ fontsDirectory: path.join(root, "fonts"), emittedDirectory: site });
    expect(checkSite(site, hashes).sort()).toEqual([
      "assets/TimelessSans-Regular-abc123.woff2 is named for Timeless",
      "assets/face-abc123.woff2 is a copy of a Timeless font",
    ]);
  });

  it("fails with an I/O error when the path is not a folder", () => {
    const root = scratchDirectory();
    const result = spawnSync(process.execPath, [path.join(__dirname, "check-font-leaks.mjs"), "site", path.join(root, "never-created")], {
      encoding: "utf8",
      env: { ...process.env, LATTICE_PRIVATE_FONTS_DIR: "" },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("is not a folder");
  });
});
