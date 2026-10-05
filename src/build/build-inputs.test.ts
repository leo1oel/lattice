import { describe, expect, it } from "vitest";
import { isBuildOutput } from "./build-inputs";

describe("isBuildOutput", () => {
  it("knows what a LaTeX run writes beside its sources", () => {
    for (const path of [
      "main.pdf", "main.aux", "main.log", "main.fls", "main.fdb_latexmk", "main.synctex.gz", "main.synctex.gz(busy)",
      "main.out", "main.toc", "main.bbl", "main.blg", "main-blx.bib", "main.run.xml", "chapters/intro.aux",
      "_minted-main/default.pygstyle", ".git/index", "paper/thesis.pdf",
      ".lattice-0b7e4c1a-9f3d-4e2b-8a6c-5d1f2e3a4b5c.tmp", "chapters/.lattice-0b7e4c1a-9f3d-4e2b-8a6c-5d1f2e3a4b5c.tmp",
    ]) {
      expect(isBuildOutput(path, ["main.tex", "paper/thesis.tex"]), path).toBe(true);
    }
  });

  it("treats every source, and anything unfamiliar, as an input", () => {
    for (const path of [
      "main.tex", "main.bib", "references.bib", "chapters/intro.tex", "figures/plot.pdf", "macros.sty",
      "data/table.csv", "notes.md", "thesis.pdf", "kept.bbl", "chapters", "../outside.aux", "draft.tmp", "lattice-notes.tmp",
    ]) {
      expect(isBuildOutput(path, ["main.tex", "paper/thesis.tex"]), path).toBe(false);
    }
  });
});
