import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { build, type Rolldown } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import {
  FACES,
  LICENSE_FILE,
  PRIVATE_FONTS_ENV,
  PRIVATE_FONTS_REQUIRED_ENV,
  privateFontsDirectory,
  privateFontsPlugin,
  privateFontsStylesheet,
} from "./private-fonts.ts";

// Stand-in files named like the download's: the plugin only checks they exist.
// The license stand-in has bytes of its own, so its emitted copy can be compared.
const LICENSE_STAND_IN = "%PDF-1.4 stand-in license\n";
let scratch: string | null = null;
function fakeDownload(files = [LICENSE_FILE, ...FACES.map((face) => face.file)]): string {
  scratch = mkdtempSync(path.join(os.tmpdir(), "lattice-private-fonts-"));
  for (const file of files) {
    mkdirSync(path.dirname(path.join(scratch, file)), { recursive: true });
    writeFileSync(path.join(scratch, file), file === LICENSE_FILE ? LICENSE_STAND_IN : "");
  }
  return scratch;
}

/** Build an entry that exports the license module's URL; returns that URL and the emitted assets. */
async function buildLicenseEntry(directory: string | null) {
  const root = mkdtempSync(path.join(os.tmpdir(), "lattice-private-fonts-build-"));
  try {
    writeFileSync(path.join(root, "entry.js"), 'export { fontLicenseUrl } from "virtual:lattice-private-fonts-license";\n');
    const result = await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [privateFontsPlugin({ directory })],
      build: {
        write: false,
        rollupOptions: { input: path.join(root, "entry.js"), preserveEntrySignatures: "strict" },
      },
    }) as Rolldown.RolldownOutput;
    const entry = result.output.find((file) => file.type === "chunk" && file.isEntry) as Rolldown.OutputChunk;
    const module = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(entry.code).toString("base64")}`);
    const assets = result.output.filter((file): file is Rolldown.OutputAsset => file.type === "asset");
    return { url: module.fontLicenseUrl as string | null, assets };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = null;
});

describe("private fonts", () => {
  it("embeds from the configured folder when every face is there", () => {
    const directory = fakeDownload();
    expect(privateFontsDirectory({ [PRIVATE_FONTS_ENV]: directory })).toBe(directory);
  });

  it("builds without them when a face is missing, the folder is absent, or the variable is empty", () => {
    const partial = fakeDownload(FACES.slice(1).map((face) => face.file));
    expect(privateFontsDirectory({ [PRIVATE_FONTS_ENV]: partial })).toBeNull();
    expect(privateFontsDirectory({ [PRIVATE_FONTS_ENV]: path.join(partial, "missing") })).toBeNull();
    expect(privateFontsDirectory({ [PRIVATE_FONTS_ENV]: "" })).toBeNull();
  });

  it("never embeds the fonts without their license", () => {
    const unlicensed = fakeDownload(FACES.map((face) => face.file));
    expect(privateFontsDirectory({ [PRIVATE_FONTS_ENV]: unlicensed })).toBeNull();
  });

  it("fails a build that requires them instead of falling back", () => {
    const partial = fakeDownload(FACES.slice(1).map((face) => face.file));
    expect(() => privateFontsDirectory({ [PRIVATE_FONTS_ENV]: partial, [PRIVATE_FONTS_REQUIRED_ENV]: "1" })).toThrow(PRIVATE_FONTS_REQUIRED_ENV);
    expect(() => privateFontsDirectory({ [PRIVATE_FONTS_ENV]: "", [PRIVATE_FONTS_REQUIRED_ENV]: "1" })).toThrow(PRIVATE_FONTS_REQUIRED_ENV);
    const complete = fakeDownload();
    expect(privateFontsDirectory({ [PRIVATE_FONTS_ENV]: complete, [PRIVATE_FONTS_REQUIRED_ENV]: "1" })).toBe(complete);
  });

  it("emits the license unmodified as a hashed asset beside the fonts, and nothing without them", async () => {
    const directory = fakeDownload();
    const embedded = await buildLicenseEntry(directory);
    const license = embedded.assets.find((asset) => /^assets\/LICENSE-[\w-]+\.pdf$/.test(asset.fileName));
    expect(license).toBeDefined();
    expect(embedded.url).toBe(`/${license!.fileName}`);
    expect(Buffer.from(license!.source).toString()).toBe(LICENSE_STAND_IN);

    const without = await buildLicenseEntry(null);
    expect(without.url).toBeNull();
    expect(without.assets).toEqual([]);
  });

  it("emits nothing at all without the fonts, so theme.css's stacks stand", () => {
    expect(privateFontsStylesheet(false)).toBe("");
  });

  it("puts Timeless first in each font role and leaves code on the editor font", () => {
    const css = privateFontsStylesheet(true);
    expect(css).toContain('--ui-font: "Timeless Sans", var(--ui-font-fallback);');
    expect(css).toContain('--reading-font: "Timeless Serif Text", var(--ui-font-fallback);');
    expect(css).toContain('--display-font: "Timeless Serif", var(--display-font-fallback);');
    expect(css).not.toContain("--editor-font");
  });

  it("scales the faces to Inter's widths and keeps Inter's line metrics", () => {
    const css = privateFontsStylesheet(true);
    expect(css).toContain('url("@lattice-private-fonts/Sans-Grotesk/TimelessSansVF.woff2")');
    expect(css).toMatch(/TimelessSansVF\.woff2"\) format\("woff2"\); font-weight: 300 800; font-style: normal; font-display: swap; size-adjust: 104%; ascent-override: 93\.17%; descent-override: 23\.17%; line-gap-override: 0%;/);
    expect(css).toMatch(/TimelessSerif-TextRegular\.woff2.*size-adjust: 105%; ascent-override: 92\.29%; descent-override: 22\.95%/);
  });
});
