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
  files: ["main.tex", "chapters/intro.tex", "chapters/ch01.tex", "review-notes.tex", "notes.md"].map(file),
} as unknown as ProjectSnapshot;
const MAIN = "\\documentclass{article}\n\\newcommand{\\R}{\\mathbb{R}}\n\\begin{document}\n\\input{chapters/intro}\n\\section{Results}\\label{sec:results}\n\\appendix\n\\section{Proofs}\n\\end{document}";
const DISK: Record<string, string> = { "chapters/intro.tex": "\\section{Introduction}\\label{sec:intro}" };

function renderStructure(
  overrides: Partial<LatexStructureDeps> = {},
  appendixPage: () => number | null = () => 7,
  disk: Record<string, string> = DISK,
) {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "read_project_file") {
      const { path } = args as { path: string };
      if (!(path in disk)) throw new Error(`no such file: ${path}`);
      return disk[path];
    }
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
    // The included file has not been read yet, so it may still hold one.
    expect(plain.result.current.appendixBoundary).toEqual({ kind: "unread" });
    await waitFor(() => expect(plain.result.current.appendixBoundary).toEqual({ kind: "none" }));
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

describe("the main body's scope behind the page budget", () => {
  // The root includes a chapter that opens the appendix; the PDF puts it on page 7.
  const ROOT = "\\documentclass{article}\n\\begin{document}\n\\section{Results}\n\\input{chapters/ch01}\n\\end{document}";
  const CHAPTER = "\\appendix\n\\section{Proofs}";
  const closed = { outlineWanted: false, settledSource: ROOT };

  it("reads an included appendix for a built PDF with the outline closed, never taking it for none", async () => {
    const view = renderStructure({ ...closed, compiledPdf: "blob:build" }, () => 7, { "chapters/ch01.tex": CHAPTER });
    expect(view.result.current.appendixBoundary).toEqual({ kind: "unread" });
    await waitFor(() => expect(view.result.current.appendixBoundary).toEqual({ kind: "resolved", mainPages: 6 }));
    expect(invoke).toHaveBeenCalledWith("read_project_file", { path: "chapters/ch01.tex" });
    expect(invoke).toHaveBeenCalledWith("synctex_view", { path: "chapters/ch01.tex", line: 1, column: 0 });
  });

  it("reads nothing before there is a PDF or an outline to serve", () => {
    renderStructure(closed, () => 7, { "chapters/ch01.tex": CHAPTER });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("leaves the scope unknown, not appendix-free, when an included file cannot be read", async () => {
    const view = renderStructure({ ...closed, compiledPdf: "blob:build" }, () => 7, {});
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("read_project_file", { path: "chapters/ch01.tex" }));
    // Rebuilding retries nothing on its own, and never settles on none.
    view.rerender(renderArgs({ ...closed, compiledPdf: "blob:rebuild" }));
    await Promise.resolve();
    expect(view.result.current.appendixBoundary).toEqual({ kind: "unread" });
    expect(invoke).not.toHaveBeenCalledWith("synctex_view", expect.anything());
  });

  it("does not place an included appendix SyncTeX finds no target for", async () => {
    const view = renderStructure({ ...closed, compiledPdf: "blob:build" }, () => null, { "chapters/ch01.tex": CHAPTER });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("synctex_view", { path: "chapters/ch01.tex", line: 1, column: 0 }));
    await Promise.resolve();
    expect(view.result.current.appendixBoundary).toEqual({ kind: "unresolved" });
  });

  it("keeps the root's appendix while an unrelated file is open, as the buffer last said it", async () => {
    // The disk copy is older: its appendix sits on another line than the buffer's.
    const disk = { "main.tex": MAIN.replace("\\appendix\n", "\n\\appendix\n"), "chapters/intro.tex": DISK["chapters/intro.tex"] };
    const view = renderStructure({ outlineWanted: false, compiledPdf: "blob:build" }, () => 7, disk);
    await waitFor(() => expect(view.result.current.appendixBoundary).toEqual({ kind: "resolved", mainPages: 6 }));
    expect(invoke).toHaveBeenCalledWith("synctex_view", { path: "main.tex", line: 6, column: 0 });

    const notes = "\\section{Reviewer 2}\nNo appendix here.";
    view.rerender(renderArgs({ outlineWanted: false, compiledPdf: "blob:build", activeFile: "review-notes.tex", settledSource: notes }));
    expect(view.result.current.appendixBoundary).toEqual({ kind: "resolved", mainPages: 6 });
    await Promise.resolve();
    expect(view.result.current.appendixBoundary).toEqual({ kind: "resolved", mainPages: 6 });
    // The older disk copy would have moved the marker to line 7 and asked again.
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "synctex_view")).toHaveLength(1);
  });

  it("never answers for one project with another's included files", async () => {
    const view = renderStructure({ ...closed, compiledPdf: "blob:a-build" }, () => 7, { "chapters/ch01.tex": CHAPTER });
    await waitFor(() => expect(view.result.current.appendixBoundary).toEqual({ kind: "resolved", mainPages: 6 }));

    // Project B has a chapter at the same path, without the appendix.
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "read_project_file") return new Promise(() => {});
      throw new Error(`unexpected ${command}`);
    });
    const other = { ...PROJECT, root: "/other" } as ProjectSnapshot;
    view.rerender(renderArgs({ ...closed, project: other, compiledPdf: "blob:b-build" }));
    expect(view.result.current.appendixBoundary).toEqual({ kind: "unread" });
    expect(invoke).toHaveBeenCalledWith("read_project_file", { path: "chapters/ch01.tex" });
  });
});

function renderArgs(overrides: Partial<LatexStructureDeps> = {}): LatexStructureDeps {
  return {
    project: PROJECT, activeFile: "main.tex", settledSource: MAIN, references: [], diskTodos: [],
    editorPosition: null, outlineWanted: true, compiledPdf: null, ...overrides,
  };
}
