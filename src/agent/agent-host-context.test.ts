import { describe, expect, it, vi } from "vitest";
import { buildAgentHostContext, LATTICE_HOST_CONTEXT, selectedMarkdownImageProjectPath } from "./agent-host-context";

describe("selected Markdown image context", () => {
  // Markdown and HTML image blocks resolve relative to their document; prose,
  // remote images, and paths outside the project do not resolve.
  it.each([
    ["![Figure](paper_assets/figure-001.webp)", ".research/papers/2010.11929/paper.md", ".research/papers/2010.11929/paper_assets/figure-001.webp"],
    ['<img src="../figures/My%20Plot.png" alt="Plot" width={223} />', "notes/method.md", "figures/My Plot.png"],
    ["![Figure](figures/Figure%20%231.png?raw#top)", "notes/method.md", "notes/figures/Figure #1.png"],
    ["A paragraph", "notes.md", null],
    ["![Remote](https://example.com/figure.png)", "notes.md", null],
    ["![Outside](../../figure.png)", "notes/method.md", null],
  ])("resolves %s in %s to %s", (block, documentPath, expected) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(selectedMarkdownImageProjectPath(block, documentPath)).toBe(expected);
    vi.restoreAllMocks();
  });
});

const baseInput: Parameters<typeof buildAgentHostContext>[0] = {
  workspaceRoot: "/tmp/paper",
  activeFile: "main.tex",
  editorPosition: null,
  activePaper: null,
  canvasMode: "split",
  paperView: "blog",
  pdfPage: 1,
  pdfPageCount: null,
  selection: "",
  selectionSource: null,
  activeSurface: "editor",
};

describe("agent host context", () => {
  it("shares bounded editor and PDF location metadata", () => {
    expect(buildAgentHostContext({
      ...baseInput,
      editorPosition: { path: "main.tex", line: 42, column: 7 },
      pdfPage: 3,
      pdfPageCount: 8,
      selection: "related work",
      selectionSource: "editor",
      now: () => new Date("2026-08-14T10:00:00.000Z"),
    })).toEqual({
      type: LATTICE_HOST_CONTEXT,
      version: 1,
      capturedAt: "2026-08-14T10:00:00.000Z",
      workspaceRoot: "/tmp/paper",
      presentationAuthoring: {
        nativeEntryPattern: "slides/<deck-id>/index.tsx",
        nativeFormat: "open_slide_tsx",
        skill: "authoring-presentations",
        defaultWhenOutputFormatUnspecified: true,
        unsupportedPptx: true,
        supportsHtmlExport: true,
        supportsPdfExport: true,
        explicitUnsupportedRequestPolicy: "explain_unsupported_offer_native",
      },
      activeSurface: "editor",
      editor: { path: "main.tex", line: 42, column: 7, selection: "related work" },
      pdf: { page: 3, pageCount: 8 },
    });
  });

  it("shares the live Open Slide page and inspector selection for the open deck", () => {
    const presentation = {
      slideId: "research-update", pageIndex: 2, pageNumber: 3, totalPages: 8, slideTitle: "Research update",
      view: "slides" as const, pagePath: "slides/research-update/index.tsx",
      pendingComments: [{ id: "c-1234abcd", line: 44, ts: "2026-09-03T00:00:00.000Z", note: "Make this chart larger" }],
      selection: { line: 42, column: 6, tagName: "h1", text: "Q2 Roadmap" },
      updatedAt: "2026-08-30T12:00:00.000Z",
    };
    expect(buildAgentHostContext({
      ...baseInput,
      activeFile: "slides/research-update/index.tsx",
      canvasMode: "source",
      presentation,
    }).presentation).toEqual(presentation);
  });

  it("points at the active locally cached paper view", () => {
    const selectionImage = {
      sourcePath: ".research/papers/1706.03762/paper_assets/figure-001.webp",
      agentReadablePath: ".research/papers/1706.03762/paper_assets/figure-001-converted.png",
      mimeType: "image/png" as const,
    };
    expect(buildAgentHostContext({
      ...baseInput,
      activePaper: {
        arxivId: "1706.03762",
        title: "Attention Is All You Need",
        citationKey: "vaswani2017attention",
        hasFullText: true,
        hasBlog: true,
      },
      canvasMode: "pdf",
      paperView: "fulltext",
      selection: "scaled dot-product attention",
      selectionSource: "paper",
      selectionImage: { source: "paper", ...selectionImage },
      activeSurface: "paper",
    }).paper).toEqual({
      title: "Attention Is All You Need",
      arxivId: "1706.03762",
      citationKey: "vaswani2017attention",
      path: ".research/papers/1706.03762/paper.md",
      view: "fulltext",
      selection: "scaled dot-product attention",
      selectionImage,
    });
  });

  it("uses the actually focused split-view surface and reports only the omitted selection length at 12k", () => {
    const context = buildAgentHostContext({
      ...baseInput,
      editorPosition: { path: "main.tex", line: 12, column: 3 },
      pdfPage: 6,
      pdfPageCount: 9,
      activeSurface: "pdf",
      selection: "x".repeat(12_019),
      selectionSource: "editor",
      now: () => new Date("2026-08-14T10:00:00Z"),
    });
    expect(context).toMatchObject({
      activeSurface: "pdf",
      editor: { path: "main.tex", line: 12, column: 3 },
      pdf: { page: 6, pageCount: 9 },
    });
    // The model text keeps 12k characters; only the omitted length is reported.
    expect(context.editor?.selection).toHaveLength(12_000);
    expect(context.editor?.selectionOmittedChars).toBe(19);
    expect(context.capturedAt).toBe("2026-08-14T10:00:00.000Z");
  });

  it("names a project PDF open as a document, and its page, when its selection is the context", () => {
    const fromDocument = {
      ...baseInput,
      activeFile: "figures/survey.pdf",
      pdfPage: 2,
      pdfPageCount: 4,
      activeSurface: "pdf" as const,
      selection: "the cited result",
      selectionSource: "pdf" as const,
      selectionPdfDocument: { path: "figures/survey.pdf", page: 7, pageCount: 22 },
    };
    expect(buildAgentHostContext(fromDocument).pdf).toEqual({
      path: "figures/survey.pdf", page: 7, pageCount: 22, selection: "the cited result",
    });
    // An editor selection keeps the compiled preview's place.
    expect(buildAgentHostContext({ ...fromDocument, selectionSource: "editor" }).pdf).toEqual({ page: 2, pageCount: 4 });
  });
});
