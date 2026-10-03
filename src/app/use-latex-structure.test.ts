import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { FileNode, ProjectSnapshot } from "../app-types";
import { useLatexStructure, type LatexStructureDeps } from "./use-latex-structure";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
});

const file = (path: string): FileNode => ({ name: path.split("/").at(-1) ?? path, path, kind: "tex", children: [] });
const PROJECT = {
  root: "/project",
  manifest: { rootDocuments: [{ path: "main.tex", name: "Main", isDefault: true }] },
  files: ["main.tex", "chapters/intro.tex", "notes.md"].map(file),
} as unknown as ProjectSnapshot;
const MAIN = "\\documentclass{article}\n\\newcommand{\\R}{\\mathbb{R}}\n\\begin{document}\n\\input{chapters/intro}\n\\section{Results}\\label{sec:results}\n\\appendix\n\\section{Proofs}\n\\end{document}";
const DISK: Record<string, string> = { "chapters/intro.tex": "\\section{Introduction}\\label{sec:intro}" };

function renderStructure(overrides: Partial<LatexStructureDeps> = {}, appendixPage: () => number | null = () => 7) {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "read_project_file") return DISK[(args as { path: string }).path] ?? "";
    if (command === "synctex_view") {
      const page = appendixPage();
      return page == null ? null : { page };
    }
    throw new Error(`unexpected ${command}`);
  });
  return renderHook((props: LatexStructureDeps) => useLatexStructure(props), { initialProps: renderArgs(overrides) });
}

describe("the project's LaTeX structure", () => {
  it("outlines sections across included files once something lists the outline", async () => {
    const view = renderStructure({ outlineWanted: false });
    expect(invoke).not.toHaveBeenCalled();
    view.rerender(renderArgs({ outlineWanted: true }));
    await waitFor(() => expect(view.result.current.outlineNodes.flatMap(function titles(node): string[] {
      return [node.title, ...node.children.flatMap(titles)];
    })).toEqual(expect.arrayContaining(["Introduction", "Results", "Proofs"])));
    expect(invoke).toHaveBeenCalledWith("read_project_file", { path: "chapters/intro.tex" });
  });

  it("joins the open TeX buffer's labels and macros, and leaves a Markdown buffer out of them", () => {
    const tex = renderStructure();
    expect(tex.result.current.liveReferences.map((reference) => reference.label)).toContain("sec:results");
    expect(tex.result.current.macros.map((macro) => macro.label)).toContain("\\R");
    const markdown = renderStructure({ activeFile: "notes.md", settledSource: "\\label{not-tex}" });
    expect(markdown.result.current.liveReferences).toEqual([]);
  });

  it("counts the main body's pages from where \\appendix lands in the PDF", async () => {
    const view = renderStructure({ compiledPdf: "blob:first-build" });
    await waitFor(() => expect(view.result.current.appendixBoundary).toEqual({ kind: "resolved", mainPages: 6 }));
    expect(invoke).toHaveBeenCalledWith("synctex_view", { path: "main.tex", line: 6, column: 0 });
    view.rerender(renderArgs({ compiledPdf: null }));
    expect(view.result.current.appendixBoundary).toEqual({ kind: "unresolved" });
  });

  it("tells a manuscript without an appendix from one SyncTeX could not place", async () => {
    const plain = renderStructure({ compiledPdf: "blob:build", settledSource: MAIN.replace("\\appendix\n", "") });
    expect(plain.result.current.appendixBoundary).toEqual({ kind: "none" });
    expect(invoke).not.toHaveBeenCalledWith("synctex_view", expect.anything());
    cleanup();

    // Each rebuild asks again, and an answer that does not place the
    // appendix drops the last placement instead of keeping it.
    let appendixPage = (): number | null => 7;
    const placed = renderStructure({ compiledPdf: "blob:first-build" }, () => appendixPage());
    await waitFor(() => expect(placed.result.current.appendixBoundary).toEqual({ kind: "resolved", mainPages: 6 }));
    appendixPage = () => null;
    placed.rerender(renderArgs({ compiledPdf: "blob:no-target" }));
    await waitFor(() => expect(placed.result.current.appendixBoundary).toEqual({ kind: "unresolved" }));
    appendixPage = () => 7;
    placed.rerender(renderArgs({ compiledPdf: "blob:third-build" }));
    await waitFor(() => expect(placed.result.current.appendixBoundary).toEqual({ kind: "resolved", mainPages: 6 }));
    appendixPage = () => {
      throw new Error("synctex: no such file");
    };
    placed.rerender(renderArgs({ compiledPdf: "blob:lookup-failed" }));
    await waitFor(() => expect(placed.result.current.appendixBoundary).toEqual({ kind: "unresolved" }));
  });

  it("counts again for each new PDF, though the appendix stayed on its line", async () => {
    let appendixPage = 7;
    const view = renderStructure({ compiledPdf: "blob:first-build" }, () => appendixPage);
    await waitFor(() => expect(view.result.current.appendixBoundary).toEqual({ kind: "resolved", mainPages: 6 }));

    // A paragraph grew without adding a line, and the next build paginated
    // the appendix four pages later.
    appendixPage = 11;
    const longer = MAIN.replace("\\label{sec:results}", "\\label{sec:results} A much longer paragraph.");
    view.rerender(renderArgs({ settledSource: longer, compiledPdf: "blob:first-build" }));
    view.rerender(renderArgs({ settledSource: longer, compiledPdf: "blob:second-build" }));
    await waitFor(() => expect(view.result.current.appendixBoundary).toEqual({ kind: "resolved", mainPages: 10 }));
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "synctex_view")).toHaveLength(2);
  });

  it("never shows a placement from another project or an earlier marker", async () => {
    let answer: (page: number) => void = () => {};
    const view = renderStructure({ compiledPdf: "blob:a-build" });
    await waitFor(() => expect(view.result.current.appendixBoundary).toEqual({ kind: "resolved", mainPages: 6 }));

    // Project B opens; its first build is on screen before SyncTeX answers for it.
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "read_project_file") return DISK[(args as { path: string }).path] ?? "";
      if (command === "synctex_view") return new Promise((resolve) => {
        answer = (page) => resolve({ page });
      });
      throw new Error(`unexpected ${command}`);
    });
    const other = { ...PROJECT, root: "/other" } as ProjectSnapshot;
    view.rerender(renderArgs({ project: other, compiledPdf: null }));
    expect(view.result.current.appendixBoundary).toEqual({ kind: "unresolved" });
    view.rerender(renderArgs({ project: other, compiledPdf: "blob:b-build" }));
    expect(view.result.current.appendixBoundary).toEqual({ kind: "unresolved" });
    answer(3);
    await waitFor(() => expect(view.result.current.appendixBoundary).toEqual({ kind: "resolved", mainPages: 2 }));

    // The appendix is deleted, then added back on another line: the old page no longer applies.
    const moved = MAIN.replace("\\appendix\n", "").replace("\\end{document}", "\\appendix\n\\end{document}");
    view.rerender(renderArgs({ project: other, compiledPdf: "blob:b-build", settledSource: MAIN.replace("\\appendix\n", "") }));
    expect(view.result.current.appendixBoundary).toEqual({ kind: "none" });
    view.rerender(renderArgs({ project: other, compiledPdf: "blob:b-build", settledSource: moved }));
    expect(view.result.current.appendixBoundary).toEqual({ kind: "unresolved" });
    answer(9);
    await waitFor(() => expect(view.result.current.appendixBoundary).toEqual({ kind: "resolved", mainPages: 8 }));

    // A build that leaves no PDF drops the placement, so the next build waits for its own answer.
    view.rerender(renderArgs({ project: other, compiledPdf: null, settledSource: moved }));
    view.rerender(renderArgs({ project: other, compiledPdf: "blob:b-rebuild", settledSource: moved }));
    expect(view.result.current.appendixBoundary).toEqual({ kind: "unresolved" });
  });
});

function renderArgs(overrides: Partial<LatexStructureDeps> = {}): LatexStructureDeps {
  return {
    project: PROJECT, activeFile: "main.tex", settledSource: MAIN, references: [], diskTodos: [],
    editorPosition: null, outlineWanted: true, compiledPdf: null, ...overrides,
  };
}
