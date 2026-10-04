/**
 * Font files are licensed one by one, and this repository is public. The
 * Timeless family (timeless.co) may be embedded in a build
 * (scripts/private-fonts.ts) but its license forbids putting it on a public
 * repository, so no copy, subset or conversion of it may ever be committed.
 * Releases also run scripts/check-font-leaks.mjs on the built app and its
 * release assets.
 * Every other tracked font must be one whose license allows redistribution;
 * a new one is added to the list below only after that has been checked.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const FONT_FILE = /\.(?:woff2?|[ot]tf|ttc|eot|dfont|pfb|pfa)$/i;
const TIMELESS = /timeless/i;
const TIMELESS_DOWNLOAD = /timeless-type-family/i;

/** Redistributable fonts in the repository, with the license that allows it. */
const LICENSED_FONTS: Record<string, string> = {
  "src/assets/fonts/ioskeley-mono/IoskeleyMono-Regular.woff2": "OFL-1.1",
  "src/assets/fonts/ioskeley-mono/IoskeleyMono-Medium.woff2": "OFL-1.1",
  "src/assets/fonts/ioskeley-mono/IoskeleyMono-Bold.woff2": "OFL-1.1",
  "src/assets/fonts/ioskeley-mono/IoskeleyMono-Italic.woff2": "OFL-1.1",
  "src/assets/fonts/ioskeley-mono/IoskeleyMono-BoldItalic.woff2": "OFL-1.1",
};

/** Every path Git tracks or would add (untracked, not ignored). */
function repositoryPaths(): string[] {
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" });
  return output.split("\0").filter(Boolean);
}

describe("font license guard", () => {
  const paths = repositoryPaths();

  it("finds no Timeless file in the repository", () => {
    expect(paths.filter((path) => (TIMELESS.test(path) && FONT_FILE.test(path)) || TIMELESS_DOWNLOAD.test(path))).toEqual([]);
  });

  it("finds only fonts whose license allows a public repository", () => {
    expect(paths.filter((path) => FONT_FILE.test(path) && !(path in LICENSED_FONTS))).toEqual([]);
  });

  it("ignores Timeless files dropped into the checkout", () => {
    const probes = ["TimelessSansVF.woff2", "src/assets/fonts/TimelessSerif-TextRegular.woff2", "Timeless-Type-Family-1.094/README.txt"];
    const ignored = execFileSync("git", ["check-ignore", "--no-index", ...probes], { encoding: "utf8" }).trim().split("\n");
    expect(ignored).toEqual(probes);
  });
});
