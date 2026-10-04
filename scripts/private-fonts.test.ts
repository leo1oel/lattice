import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FACES,
  LICENSE_FILE,
  PRIVATE_FONTS_ENV,
  PRIVATE_FONTS_REQUIRED_ENV,
  licenseParagraphs,
  privateFontsDirectory,
  privateFontsLicenseModule,
  privateFontsStylesheet,
  type LicenseTextItem,
} from "./private-fonts.ts";

// Stand-in files named like the download's: the plugin only checks they exist.
let scratch: string | null = null;
function fakeDownload(files = [LICENSE_FILE, ...FACES.map((face) => face.file)]): string {
  scratch = mkdtempSync(path.join(os.tmpdir(), "lattice-private-fonts-"));
  for (const file of files) {
    mkdirSync(path.dirname(path.join(scratch, file)), { recursive: true });
    writeFileSync(path.join(scratch, file), "");
  }
  return scratch;
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

  it("exports no license without the fonts", () => {
    expect(privateFontsLicenseModule(null)).toBe("export const fontLicense = null;\n");
    expect(privateFontsLicenseModule({ title: "T 1", text: "a\n\nb" })).toBe('export const fontLicense = {"title":"T 1","text":"a\\n\\nb"};\n');
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

describe("license text", () => {
  // Runs as PDF.js reports them: y grows upward, and the page's headings come
  // after its body, the way the license's printed web page draws them.
  const run = (str: string, x: number, y: number, height = 10, width = str.length * 5): LicenseTextItem => ({ str, x, y, width, height });

  it("puts runs back in reading order and joins the lines of a paragraph", () => {
    expect(licenseParagraphs([[
      run("First body line of the", 140, 700),
      run("section, and its second.", 140, 685),
      run("Another paragraph.", 140, 657),
      run("1", 128, 730),
      run("Heading", 140, 730),
    ]])).toEqual(["1 Heading", "First body line of the section, and its second.", "Another paragraph."]);
  });

  it("keeps a wrapped heading whole but apart from the body under it", () => {
    expect(licenseParagraphs([[
      run("2", 128, 730),
      run("A heading that", 140, 730, 18),
      run("wraps", 140, 708, 18),
      run("Body.", 140, 681),
    ]])).toEqual(["2 A heading that wraps", "Body."]);
  });

  it("marks indented paragraphs as list items and keeps hyphenated breaks and touching runs", () => {
    expect(licenseParagraphs([[
      run("Intro line one.", 140, 700),
      run("Intro line two.", 140, 685),
      run("Item one, which", 157, 657),
      run("wraps", 157, 642),
      run("Item two", 157, 620),
      run("Body at example.co/custom-", 140, 592),
      run("business, write to a@b.co", 140, 577, 10, 125),
      run(".", 265, 577, 10, 2),
    ]])).toEqual([
      "Intro line one. Intro line two.",
      "• Item one, which wraps",
      "• Item two",
      "Body at example.co/custom-business, write to a@b.co.",
    ]);
  });

  it("ends a paragraph at a page break and ignores empty runs", () => {
    expect(licenseParagraphs([
      [run("Page one.", 140, 700), run(" ", 140, 690)],
      [run("Page two.", 140, 800)],
    ])).toEqual(["Page one.", "Page two."]);
  });
});
