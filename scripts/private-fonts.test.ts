import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FACES, PRIVATE_FONTS_ENV, privateFontsDirectory, privateFontsStylesheet } from "./private-fonts.ts";

// Stand-in files named like the download's: the plugin only checks they exist.
let scratch: string | null = null;
function fakeDownload(files = FACES.map((face) => face.file)): string {
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
