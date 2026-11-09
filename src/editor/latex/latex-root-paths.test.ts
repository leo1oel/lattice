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

// TeX reads a figure path, and a `\graphicspath` root, from the root
// document's folder, like an `\input` path. The editor used to match figures
// as text instead: `./figures/plot` matched nothing (a false "Missing figure"),
// and `figures/plot` took the first file ending with it, even a stale copy.
describe("figure paths read from the root document's folder", () => {
  const figures = ["main.tex", "figures/plot.png", "paper/main.tex", "paper/figures/plot.png", "shared/logo.pdf"];

  it.each([
    ["./figures/plot.png", "main.tex", [], "figures/plot.png"],
    ["./figures/plot", "main.tex", [], "figures/plot.png"],
    ["./figures/plot", "paper/main.tex", [], "paper/figures/plot.png"],
    ["figures/plot", "paper/main.tex", [], "paper/figures/plot.png"],
    ["../shared/logo", "paper/main.tex", [], "shared/logo.pdf"],
    ["plot", "paper/main.tex", ["./figures"], "paper/figures/plot.png"],
    ["logo", "paper/main.tex", ["../shared"], "shared/logo.pdf"],
  ])("finds %s from %s", (path, root, graphicsRoots, file) => {
    const source = `\\includegraphics[width=\\linewidth]{${path}}`;
    expect(pathDiagnostics(source, figures, graphicsRoots, undefined, root)).toEqual([]);
    expect(definitionTargetAt(source, source.indexOf(path) + 1, [], figures, graphicsRoots, root))
      .toEqual({ kind: "asset", path: file });
  });

  it("takes a figure elsewhere only when it is the one file ending with the path", () => {
    const copies = ["paper/main.tex", "old/figures/plot.png", "arxiv-v1/figures/plot.png", "assets/logo.pdf"];
    expect(pathDiagnostics("\\includegraphics{figures/plot}", copies, [], undefined, "paper/main.tex")[0]?.message)
      .toBe("Missing figure “figures/plot”.");
    expect(pathDiagnostics("\\includegraphics{logo}", copies, [], undefined, "paper/main.tex")).toEqual([]);
  });

  // graphicx tries each extension in the build folder and then each
  // `\graphicspath` folder; it never searches the rest of the project.
  it.each([
    [["main.tex", "a/plot.pdf", "figs/plot.pdf", "c/plot.png"], "figs/plot.pdf"],
    [["main.tex", "old/plot.pdf", "figs/plot.png"], "figs/plot.png"],
  ])("finds a \\graphicspath figure before any file elsewhere in %j", (paths, file) => {
    const source = "\\includegraphics{plot}";
    expect(definitionTargetAt(source, source.indexOf("plot"), [], paths, ["figs"], "main.tex"))
      .toEqual({ kind: "asset", path: file });
  });

  it("finds a \\graphicspath figure beside a subfolder root before one at the project's top", () => {
    const paths = ["paper/main.tex", "plot.pdf", "paper/figs/plot.png"];
    const source = "\\includegraphics{plot}";
    expect(definitionTargetAt(source, source.indexOf("plot"), [], paths, ["figs"], "paper/main.tex"))
      .toEqual({ kind: "asset", path: "paper/figs/plot.png" });
  });

  it("gives the outline and the editor the same \\input file", () => {
    const paths = ["main.tex", "intro.tex", "old/intro"];
    expect(resolveTexPath("intro", paths, "main.tex")).toBe("intro.tex");
    expect(includedPathsIn("\\input{intro}", paths, "main.tex")).toEqual(["intro.tex"]);
  });

  it("leaves an absolute figure path to the disk, not the project", () => {
    expect(pathDiagnostics("\\includegraphics{/figures/plot.png}", figures, [], undefined, "main.tex")[0]?.message)
      .toBe("Missing figure “/figures/plot.png”.");
  });

  it("warns about letter case, not a missing figure, for a ./ path", () => {
    const [warning] = pathDiagnostics("\\includegraphics{./Figures/plot.png}", figures, [], undefined, "main.tex");
    expect(warning?.message).toBe("“./Figures/plot.png” differs in case from figures/plot.png on disk. Overleaf and arXiv can fail to find it.");
  });
});
