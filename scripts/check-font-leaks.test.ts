import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkApp, checkAssets, timelessFontHashes } from "./check-font-leaks.mjs";

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
    write(root, "notes.txt", "release notes");
    write(root, "Sans.woff2", "not even a font inside");
    write(root, "renamed.bin", font("\0\x01\0\0", "glyphs"));
    write(root, "renamed.dmg", font("OTTO", "glyphs"));
    expect(checkAssets(root).sort()).toEqual([
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
    expect(checkApp(app, hashes).sort()).toEqual([
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
    expect(checkApp(app, hashes)).toEqual([]);
  });
});
