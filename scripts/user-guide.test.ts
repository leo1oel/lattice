// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkGuide, renderGuide } from "./user-guide.mjs";

describe("the user guide", () => {
  it("has every page in both languages, and every link and image it names", () => {
    expect(checkGuide()).toEqual([]);
  });

  it("renders the website's pages with links between them", () => {
    const out = mkdtempSync(join(tmpdir(), "lattice-guide-"));
    try {
      renderGuide(out);
      const index = readFileSync(join(out, "index.html"), "utf8");
      expect(index).toContain('href="getting-started.html"');
      expect(index).toContain('href="zh-CN/index.html"');
      expect(readFileSync(join(out, "zh-CN/index.html"), "utf8")).toContain('lang="zh-CN"');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
