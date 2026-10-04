import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { brotliCompressSync, deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { checkAsset, checkTree, fontFormat, fontNamesTimeless } from "./check-font-leaks.mjs";

// Minimal fonts in each container whose one table holds a family name, as a
// name record does (UTF-16BE). No real Timeless file may enter the repository.
const utf16be = (text: string) => Buffer.from(text, "utf16le").swap16();

function sfnt(family: string) {
  return Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(8), utf16be(family)]);
}

function woff(family: string) {
  // Padded so zlib shrinks it: WOFF stores a table compressed only then.
  const table = Buffer.concat([utf16be(family), Buffer.alloc(256)]);
  const compressed = deflateSync(table);
  const header = Buffer.alloc(64);
  header.write("wOFF", 0, "latin1");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt32BE(64 + compressed.length, 8);
  header.writeUInt16BE(1, 12);
  header.write("name", 44, "latin1");
  header.writeUInt32BE(64, 48);
  header.writeUInt32BE(compressed.length, 52);
  header.writeUInt32BE(table.length, 56);
  return Buffer.concat([header, compressed]);
}

function woff2(family: string) {
  const table = utf16be(family);
  const compressed = brotliCompressSync(table);
  const header = Buffer.alloc(48);
  header.write("wOF2", 0, "latin1");
  header.writeUInt32BE(0x00010000, 4);
  header.writeUInt16BE(1, 12);
  header.writeUInt32BE(table.length, 16);
  header.writeUInt32BE(compressed.length, 20);
  // One directory entry: the known-table index of `name` (5), untransformed,
  // and its original length as a one-byte UIntBase128.
  const directory = Buffer.from([5, table.length]);
  const font = Buffer.concat([header, directory, compressed]);
  font.writeUInt32BE(font.length, 8);
  return font;
}

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

describe("font leak guard", () => {
  it.each([["sfnt", sfnt], ["woff", woff], ["woff2", woff2]] as const)("reads the tables of a %s font", (format, make) => {
    expect(fontFormat(make("Timeless Sans"))).toBe(format);
    expect(fontNamesTimeless(make("Timeless Sans"))).toBe(true);
    expect(fontNamesTimeless(make("Inter Variable"))).toBe(false);
  });

  it("passes the repository's own open-licensed fonts and non-fonts", () => {
    const ioskeley = path.resolve("src/assets/fonts/ioskeley-mono/IoskeleyMono-Regular.woff2");
    expect(fontNamesTimeless(readFileSync(ioskeley))).toBe(false);
    expect(fontFormat(Buffer.from("{\"timeless\": true}"))).toBeNull();
  });

  it("finds a loose Timeless file in an app bundle by name or by content, and allows other fonts", () => {
    const root = scratchDirectory();
    write(root, "Lattice.app/Contents/Resources/runtime/fonts/KaTeX_Main-Regular.woff2", woff2("KaTeX_Main"));
    write(root, "Lattice.app/Contents/Resources/runtime/fonts/renamed.woff2", woff2("Timeless Serif Text"));
    write(root, "Lattice.app/Contents/Resources/TimelessSansVF.txt", "not even a font");
    write(root, "Lattice.app/Contents/Resources/broken.woff", Buffer.from("wOFF"));
    expect(checkTree(root, "Lattice.app.tar.gz").sort()).toEqual([
      "Lattice.app.tar.gz!/Lattice.app/Contents/Resources/TimelessSansVF.txt is named for Timeless",
      "Lattice.app.tar.gz!/Lattice.app/Contents/Resources/broken.woff is a font that could not be decoded to rule out Timeless",
      "Lattice.app.tar.gz!/Lattice.app/Contents/Resources/runtime/fonts/renamed.woff2 is a Timeless font",
    ]);
  });

  it("unpacks the updater archive and checks what is inside", () => {
    const root = scratchDirectory();
    write(root, "bundle/Lattice.app/Contents/Resources/planted.otf", sfnt("Timeless Sans"));
    const archive = path.join(root, "Lattice.app.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", path.join(root, "bundle"), "Lattice.app"]);
    expect(checkAsset(archive)).toEqual([
      "Lattice.app.tar.gz!/Lattice.app/Contents/Resources/planted.otf is a Timeless font",
    ]);
  });

  it("allows only the signed artifacts as release assets, and never a font", () => {
    const root = scratchDirectory();
    write(root, "latest.json", "{}");
    write(root, "Lattice.app.tar.gz.sig", "signature");
    write(root, "notes.txt", "release notes");
    write(root, "TimelessSans.woff2", woff2("Timeless Sans"));
    write(root, "Inter.woff2", woff2("Inter Variable"));
    copyFileSync(path.join(root, "Inter.woff2"), path.join(root, "Inter.bin"));
    expect(checkAsset(path.join(root, "latest.json"))).toEqual([]);
    expect(checkAsset(path.join(root, "Lattice.app.tar.gz.sig"))).toEqual([]);
    expect(checkAsset(path.join(root, "notes.txt"))).toEqual(["notes.txt is not a signed release artifact"]);
    expect(checkAsset(path.join(root, "TimelessSans.woff2"))).toEqual([
      "TimelessSans.woff2 is not a signed release artifact",
      "TimelessSans.woff2 is a font offered for download on its own",
      "TimelessSans.woff2 is named for Timeless",
    ]);
    expect(checkAsset(path.join(root, "Inter.bin"))).toEqual([
      "Inter.bin is not a signed release artifact",
      "Inter.bin is a font offered for download on its own",
    ]);
  });
});
