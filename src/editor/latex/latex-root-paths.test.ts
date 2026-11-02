import { describe, expect, it } from "vitest";
import { pathDiagnostics } from "./latex-diagnostics";
import { flattenOutline, includedPathsIn, parseProjectOutline } from "./latex-outline";
import { definitionTargetAt } from "./latex-symbols";
import { normalizeProjectPath, resolveTexPath } from "./latex-text";

// latexmk `-cd` typesets in the root document's folder, so TeX reads every
// `\input` path from there, whichever file holds the command. Before, a root
// in `paper/` picked the first project file ending in the path (an old copy
// in `arxiv-v1/`), and a `../` path never matched anything.
const projectPaths = [
  "arxiv-v1/main.tex", "arxiv-v1/sections/intro.tex",
  "paper/main.tex", "paper/sections/intro.tex", "paper/sections/method.tex",
  "common/macros.tex",
];
const paperMain = "\\documentclass{article}\n\\input{../common/macros}\n\\begin{document}\n\\input{sections/intro}\n\\end{document}\n";

describe("include paths read from the root document's folder", () => {
  it("follows the root's own copy and its ../ paths, with no missing-file warning", () => {
    expect(includedPathsIn(paperMain, projectPaths, "paper/main.tex")).toEqual([
      "common/macros.tex", "paper/sections/intro.tex",
    ]);
    expect(pathDiagnostics(paperMain, projectPaths, [], undefined, "paper/main.tex")).toEqual([]);
  });

  it("reads a chapter's includes from the root's folder, not the chapter's", () => {
    // TeX's working folder is the root's: `sections/method` from
    // paper/sections/intro.tex is paper/sections/method.tex.
    const intro = "\\section{Intro}\n\\input{sections/method}\n";
    expect(includedPathsIn(intro, projectPaths, "paper/main.tex")).toEqual(["paper/sections/method.tex"]);
  });

  it("builds the outline from the files the root really includes", () => {
    const sources = {
      "paper/main.tex": paperMain,
      "paper/sections/intro.tex": "\\section{Current intro}\n",
      "arxiv-v1/sections/intro.tex": "\\section{Old intro}\n",
      "common/macros.tex": "\\newcommand{\\R}{\\mathbb{R}}\n",
    };
    const outline = flattenOutline(parseProjectOutline("paper/main.tex", sources, projectPaths));
    expect(outline.map(({ title, path }) => [title, path])).toEqual([["Current intro", "paper/sections/intro.tex"]]);
  });

  it("goes to the included file the build reads, and offers to create a missing one beside the root", () => {
    const at = paperMain.indexOf("sections/intro") + 2;
    expect(definitionTargetAt(paperMain, at, [], projectPaths, [], "paper/main.tex"))
      .toEqual({ kind: "include", path: "paper/sections/intro.tex" });
    const created: string[] = [];
    const [missing] = pathDiagnostics("\\input{sections/new}", projectPaths, [], (path) => created.push(path), "paper/main.tex");
    expect(missing?.message).toBe("Missing file “sections/new”.");
    missing?.actions?.[0]?.apply(null as never, 0, 0);
    expect(created).toEqual(["paper/sections/new.tex"]);
  });

  it("takes a project-folder path next, and a path's one namesake only when there is exactly one", () => {
    expect(resolveTexPath("common/macros", projectPaths, "paper/main.tex")).toBe("common/macros.tex");
    // Unique namesake: the leniency that finds `method` in a subfolder stays.
    expect(resolveTexPath("method", projectPaths)).toBe("paper/sections/method.tex");
    // Two copies end with it and neither is beside the root: none is guessed.
    expect(resolveTexPath("sections/intro", projectPaths)).toBeNull();
    expect(pathDiagnostics("\\input{sections/intro}", projectPaths).map(({ message }) => message))
      .toEqual(["Missing file “sections/intro”."]);
    // A `..` path means only what it means from the root's folder.
    expect(resolveTexPath("../common/macros", projectPaths)).toBeNull();
    expect(resolveTexPath("../macros", projectPaths, "common/main.tex")).toBeNull();
  });

  it("names the root's own copy when a path differs from it only in case", () => {
    expect(pathDiagnostics("\\input{Sections/Intro}", projectPaths, [], undefined, "paper/main.tex").map(({ message }) => message))
      .toEqual(["“Sections/Intro” differs in case from paper/sections/intro.tex on disk. Overleaf and arXiv can fail to find it."]);
  });

  it("collapses . and .. and refuses a path that leaves the project", () => {
    expect(normalizeProjectPath("paper/./sections/../../common/macros.tex")).toBe("common/macros.tex");
    expect(normalizeProjectPath("paper/../../outside.tex")).toBeNull();
  });
});
