import { describe, expect, it } from "vitest";
import { buildAgentHostContext, LATTICE_HOST_CONTEXT } from "./agent-host-context";

describe("agent host context", () => {
  it("shares bounded editor and PDF location metadata", () => {
    expect(buildAgentHostContext({
      workspaceRoot: "/tmp/paper",
      activeFile: "main.tex",
      secondaryFile: "appendix.tex",
      editorPosition: { path: "main.tex", line: 42, column: 7 },
      activePaper: null,
      canvasMode: "split",
      paperView: "blog",
      pdfPage: 3,
      pdfPageCount: 8,
      selection: "related work",
      selectionSource: "editor",
      activeSurface: "editor",
    })).toEqual({
      type: LATTICE_HOST_CONTEXT,
      version: 1,
      workspaceRoot: "/tmp/paper",
      activeSurface: "editor",
      editor: {
        path: "main.tex",
        line: 42,
        column: 7,
        secondaryPath: "appendix.tex",
        selection: "related work",
      },
      pdf: { page: 3, pageCount: 8 },
    });
  });

  it("points at the active locally cached paper view", () => {
    expect(buildAgentHostContext({
      workspaceRoot: "/tmp/paper",
      activeFile: "main.tex",
      secondaryFile: null,
      editorPosition: null,
      activePaper: {
        arxivId: "1706.03762",
        title: "Attention Is All You Need",
        citationKey: "vaswani2017attention",
        hasFullText: true,
        hasBlog: true,
      },
      canvasMode: "pdf",
      paperView: "fulltext",
      pdfPage: 1,
      pdfPageCount: null,
      selection: "scaled dot-product attention",
      selectionSource: "paper",
      activeSurface: "paper",
    }).paper).toEqual({
      title: "Attention Is All You Need",
      arxivId: "1706.03762",
      citationKey: "vaswani2017attention",
      path: ".research/papers/1706.03762/paper.md",
      view: "fulltext",
      selection: "scaled dot-product attention",
    });
  });

  it("uses the actually focused split-view surface", () => {
    expect(buildAgentHostContext({
      workspaceRoot: "/tmp/paper",
      activeFile: "main.tex",
      secondaryFile: null,
      editorPosition: { path: "main.tex", line: 12, column: 3 },
      activePaper: null,
      canvasMode: "split",
      paperView: "blog",
      pdfPage: 6,
      pdfPageCount: 9,
      selection: "",
      selectionSource: null,
      activeSurface: "pdf",
    })).toMatchObject({
      activeSurface: "pdf",
      editor: { path: "main.tex", line: 12, column: 3 },
      pdf: { page: 6, pageCount: 9 },
    });
  });
});
