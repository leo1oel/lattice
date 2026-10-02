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

function renderStructure(overrides: Partial<LatexStructureDeps> = {}) {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "read_project_file") return DISK[(args as { path: string }).path] ?? "";
    if (command === "synctex_view") return { page: 7 };
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
    const view = renderStructure({ compiledPdf: true });
    await waitFor(() => expect(view.result.current.mainBodyPages).toBe(6));
    expect(invoke).toHaveBeenCalledWith("synctex_view", { path: "main.tex", line: 6, column: 0 });
    view.rerender(renderArgs({ compiledPdf: false }));
    expect(view.result.current.mainBodyPages).toBeNull();
  });
});

function renderArgs(overrides: Partial<LatexStructureDeps> = {}): LatexStructureDeps {
  return {
    project: PROJECT, activeFile: "main.tex", settledSource: MAIN, references: [], diskTodos: [],
    editorPosition: null, outlineWanted: true, compiledPdf: false, ...overrides,
  };
}
