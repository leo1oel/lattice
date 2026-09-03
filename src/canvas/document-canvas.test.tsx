import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { AssetPreview, FileViewState } from "../app-types";
import { DocumentCanvas } from "./document-canvas";

/**
 * The canvas decides *what* to mount; the editors themselves are covered by
 * their own suites. Stubbing the lazy chunk loaders keeps that decision the
 * only thing under test — and keeps tldraw, Univer, ProseMirror and pdf.js out
 * of jsdom, where none of them have the APIs they need.
 *
 * The stubs report the props the canvas is responsible for wiring (the
 * per-file view state, the document each editor was handed) as DOM attributes,
 * so an assertion reads like the thing a user would notice.
 */
vi.mock("./canvas-lazy-modules", () => {
  const PdfPreview = (props: {
    url: string | null;
    fileName?: string;
    initialViewState?: { page?: number };
    onViewState?: (state: { page: number; scale: number; fitMode: null; scrollTop: number; scrollLeft: number }) => void;
  }) => (
    <div
      data-testid="pdf-preview"
      data-url={props.url ?? ""}
      data-file-name={props.fileName ?? ""}
      data-restored-page={String(props.initialViewState?.page ?? "")}
    >
      <button
        type="button"
        data-testid="pdf-view-state"
        onClick={() => props.onViewState?.({ page: 7, scale: 1, fitMode: null, scrollTop: 0, scrollLeft: 0 })}
      />
    </div>
  );
  const editorStub = (testId: string) => (props: {
    path?: string;
    source?: string;
    onEligibilityChange?: (reason: string | null) => void;
    initialViewState?: { camera?: { x: number; y: number; z: number } };
  }) => (
    <div
      data-testid={testId}
      data-path={props.path ?? ""}
      data-source={props.source ?? ""}
      data-restored-camera={String(props.initialViewState?.camera?.x ?? "")}
    >
      {props.onEligibilityChange && (
        <button
          type="button"
          data-testid={`${testId}-report-lossy`}
          onClick={() => props.onEligibilityChange?.(
            "Visual editing is unavailable because this Markdown contains unsupported or lossy syntax. Use source mode to preserve it.",
          )}
        />
      )}
    </div>
  );
  const OpenSlideWorkspace = (props: {
    projectRoot: string;
    path: string;
    source: string;
    locale: "en" | "zh-CN";
    theme: "light" | "dark";
    active?: boolean;
    editable?: boolean;
    initialViewState?: { page: number };
    onViewState?: (state: { page: number }) => void;
    onMutation: (mutation: {
      id: number;
      path: string;
      kind: "write";
      text: string;
      previousText: string;
    }) => Promise<unknown>;
  }) => (
    <div
      data-testid="open-slide-workspace"
      data-project-root={props.projectRoot}
      data-path={props.path}
      data-source={props.source}
      data-locale={props.locale}
      data-theme={props.theme}
      data-active={String(props.active ?? true)}
      data-editable={String(props.editable ?? true)}
      data-restored-page={String(props.initialViewState?.page ?? "")}
    >
      <button
        type="button"
        data-testid="open-slide-mutation"
        onClick={() => void props.onMutation({
          id: 1,
          path: props.path,
          kind: "write",
          text: "export default [];\n",
          previousText: props.source,
        })}
      />
      <button
        type="button"
        data-testid="open-slide-view-state"
        onClick={() => props.onViewState?.({ page: 3 })}
      />
    </div>
  );
  return {
    loadPdfPreviewModule: async () => ({ PdfPreview }),
    loadVisualMarkdownEditorModule: async () => ({ VisualMarkdownEditor: editorStub("visual-markdown-editor") }),
    loadBoardEditorModule: async () => ({ BoardEditor: editorStub("board-editor") }),
    loadSpreadsheetEditorModule: async () => ({ SpreadsheetEditor: editorStub("spreadsheet-editor") }),
    loadOpenSlideWorkspaceModule: async () => ({ OpenSlideWorkspace }),
    // Reported as warmed so DeferredVisualMarkdownEditor skips its one-frame
    // placeholder; the deferral is a paint concern, not canvas behaviour.
    isVisualMarkdownEditorWarmed: () => true,
    markVisualMarkdownEditorWarmed: () => {},
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));

const SPLIT_RATIO_KEY = "lattice.split-ratio.v1";

type CanvasProps = ComponentProps<typeof DocumentCanvas>;

function baseProps(): CanvasProps {
  return {
    projectRoot: "/tmp/project",
    locale: "en",
    theme: "light",
    mode: "source",
    source: "\\section{Intro}\n",
    activeFile: "main.tex",
    secondaryFile: null,
    secondarySource: "",
    setSecondarySource: vi.fn(),
    focusedPane: "primary",
    onFocusPane: vi.fn(),
    dualRatioResetGeneration: 0,
    setSource: vi.fn(),
    onSave: vi.fn(async () => true),
    setSelection: vi.fn(),
    onPdfTextSelect: vi.fn(),
    onPaperTextSelect: vi.fn(),
    onContextSurfaceActivate: vi.fn(),
    onViewMarkdownSource: vi.fn(),
    onOpenSlideMutation: vi.fn(async () => []),
    pdfUrl: null,
    pdfBase64: null,
    activePaper: null,
    activeAsset: null,
    secondaryAsset: null,
    citationKeys: [],
    citations: [],
    references: [],
    unusedLabels: [],
    unusedCitations: [],
    onLoadReferenceImage: vi.fn(async () => null),
    onEditorLeave: vi.fn(),
    onPrepareFigure: vi.fn(async () => null),
    onPasteImageFile: vi.fn(),
    nativeFigureDropActive: false,
    fileDropTargetPane: null,
    figurePointerPosition: null,
    figureDropRequest: null,
    onFigureDropHandled: vi.fn(),
    editorNavigation: null,
    onEditorNavigationHandled: vi.fn(),
    onEditorPosition: vi.fn(),
    onViewState: vi.fn(),
    viewRestore: null,
    onViewRestoreHandled: vi.fn(),
    onGotoDefinition: vi.fn(),
    onTexlabGoto: vi.fn(),
    onFindReferences: vi.fn(),
    onRenameSymbol: vi.fn(),
    onRenameEnvironment: vi.fn(),
    onWrapEnvironment: vi.fn(),
    envRenameRequest: null,
    onEnvRenameHandled: vi.fn(),
    wrapEnvRequest: null,
    onWrapEnvHandled: vi.fn(),
    localMacros: [],
    katexMacros: {},
    onGotoLineRequest: vi.fn(),
    outlineOpen: false,
    onOutlineOpenChange: vi.fn(),
    outlineNodes: [],
    activeOutlineId: null,
    onOutlineNavigate: vi.fn(),
    insertOpen: false,
    onInsertOpenChange: vi.fn(),
    tableGeneratorOpen: false,
    onTableGeneratorOpenChange: vi.fn(),
    editorKeymap: "default",
    editorSpellcheck: false,
    spellingWords: [],
    onAddSpellingWord: vi.fn(() => true),
    citeInsertRequest: null,
    onCiteInsertHandled: vi.fn(),
    projectPaths: ["main.tex"],
    graphicsRoots: [],
    buildDiagnostics: [],
    texlabDiagnostics: [],
    pdfSyncTarget: null,
    canForwardSync: false,
    locatingPdf: false,
    onForwardSync: vi.fn(),
    onPdfSource: vi.fn(),
    editorComments: [],
    overleafPresenceCursors: [],
    overleafChanges: [],
    overleafTrackChangeActions: {
      authorName: () => "Unknown",
      canAct: () => false,
      onAccept: vi.fn(),
      onReject: vi.fn(),
    },
    activeEditorCommentId: null,
    commentAuthorName: "Ada",
    commentAuthorId: "ada",
    onCreateEditorComment: vi.fn(),
    onOpenEditorComments: vi.fn(),
    onResolveEditorComment: vi.fn(),
    onReplyEditorComment: vi.fn(),
    commentFocusRequest: null,
    onCommentFocusHandled: vi.fn(),
    todoCount: 0,
    onOpenTodos: vi.fn(),
    projectWordCount: null,
    onPdfPageCount: vi.fn(),
    onPdfPageChange: vi.fn(),
    onCreateMissingFile: vi.fn(),
    onOpenMarkdownPath: vi.fn(),
    interactivePreviewsEnabled: false,
    collabSession: null,
    collabPeers: [],
    collabReady: false,
    collabEditorKey: "local",
    editorEditable: true,
    secondaryEditorEditable: true,
    onOpenCitation: vi.fn(),
    canOpenCitation: () => false,
  };
}

function renderCanvas(overrides?: Partial<CanvasProps>) {
  const props = { ...baseProps(), ...overrides };
  const view = render(<DocumentCanvas {...props} />);
  return {
    ...view,
    props,
    rerenderWith: (next: Partial<CanvasProps>) => {
      view.rerender(<DocumentCanvas {...props} {...next} />);
    },
  };
}

const imageAsset: AssetPreview = {
  path: "figures/plot.png",
  mimeType: "image/png",
  base64: "aGk=",
};

/** The primary source editor, which every mode either shows or deliberately omits. */
function sourceEditor(container: HTMLElement) {
  return container.querySelector("[data-editor-pane='primary'] .cm-editor");
}

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
});

describe("DocumentCanvas / mode", () => {
  it("gives the whole canvas to the editor in source mode", async () => {
    const { container } = renderCanvas({ mode: "source" });

    await waitFor(() => expect(sourceEditor(container)).not.toBeNull());
    expect(screen.queryByTestId("pdf-preview")).toBeNull();
    expect(container.querySelector(".split-canvas")).toBeNull();
  });

  it("gives the whole canvas to the preview in pdf mode", async () => {
    const { container } = renderCanvas({ mode: "pdf" });

    expect(await screen.findByTestId("pdf-preview")).toBeInTheDocument();
    expect(sourceEditor(container)).toBeNull();
    expect(container.querySelector(".split-canvas")).toBeNull();
  });

  it("embeds standalone data HTML frames inside the sandboxed HTML preview", async () => {
    const embeddedPlot = btoa(
      "<!doctype html><html><body><div id='plot'></div><script>window.inlinePlotReady=true</script></body></html>",
    );
    renderCanvas({
      mode: "pdf",
      activeFile: "presentation.html",
      source: `<iframe src="data:text/html;charset=utf-8;base64,${embeddedPlot}" title="Plot"></iframe>`,
      interactivePreviewsEnabled: true,
    });

    const preview = await screen.findByTitle<HTMLIFrameElement>("HTML preview for presentation.html");
    expect(preview.getAttribute("srcdoc")).not.toContain("data:text/html");
    expect(preview.getAttribute("srcdoc")).toContain("window.inlinePlotReady=true");
    expect(preview.getAttribute("srcdoc")).toContain('sandbox="allow-scripts"');
  });

  it("shows editor and preview either side of a resizer in split mode", async () => {
    const { container } = renderCanvas({ mode: "split" });

    expect(await screen.findByTestId("pdf-preview")).toBeInTheDocument();
    await waitFor(() => expect(sourceEditor(container)).not.toBeNull());
    expect(screen.getByRole("separator", { name: "Resize editor and PDF preview" })).toBeInTheDocument();
  });

  it("names the resizer after whatever is actually being previewed", async () => {
    // The separator is the only label a screen reader gets for the pane it
    // moves, and the pane's contents depend on the open document's kind.
    const { rerenderWith } = renderCanvas({ mode: "split", activeFile: "notes.md" });

    expect(screen.getByRole("separator", { name: "Resize editor and Markdown preview" })).toBeInTheDocument();

    rerenderWith({ activeAsset: imageAsset });
    expect(screen.getByRole("separator", { name: "Resize editor and asset preview" })).toBeInTheDocument();
  });

  it("puts two editors and no project preview in dual mode", async () => {
    const { container } = renderCanvas({
      mode: "dual",
      secondaryFile: "appendix.tex",
      secondarySource: "\\section{Appendix}\n",
    });

    await waitFor(() => expect(container.querySelectorAll(".cm-editor").length).toBeGreaterThan(1));
    expect(screen.getByRole("separator", { name: "Resize dual source panes" })).toBeInTheDocument();
    expect(screen.queryByTestId("pdf-preview")).toBeNull();
    expect(container.querySelector(".columns-canvas")).toBeNull();
  });

  it("adds the preview column and its own resizer in columns mode", async () => {
    const { container } = renderCanvas({
      mode: "columns",
      secondaryFile: "appendix.tex",
      secondarySource: "\\section{Appendix}\n",
    });

    expect(await screen.findByTestId("pdf-preview")).toBeInTheDocument();
    expect(container.querySelector(".columns-canvas")).not.toBeNull();
    expect(screen.getByRole("separator", { name: "Resize dual source panes" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize PDF pane" })).toBeInTheDocument();
  });

  it("shows only the asset in asset mode", () => {
    const { container } = renderCanvas({ mode: "asset", activeAsset: imageAsset });

    expect(container.querySelector(".asset-preview")).not.toBeNull();
    expect(screen.getByText("figures/plot.png")).toBeInTheDocument();
    expect(sourceEditor(container)).toBeNull();
    expect(screen.queryByTestId("pdf-preview")).toBeNull();
  });

  it("falls back to the editor when asset mode has no asset to show", async () => {
    // Mode and asset arrive from different pieces of App state, so the two can
    // be out of step for a render; without the guard the canvas renders a
    // preview of nothing and the open file disappears.
    const { container } = renderCanvas({ mode: "asset", activeAsset: null });

    await waitFor(() => expect(sourceEditor(container)).not.toBeNull());
    expect(container.querySelector(".asset-preview")).toBeNull();
  });
});

describe("DocumentCanvas / editor for the open document", () => {
  it("mounts the board editor for a .tldr file", async () => {
    const { container } = renderCanvas({ activeFile: "diagram.tldr", source: "{}" });

    const board = await screen.findByTestId("board-editor");
    expect(board.dataset.source).toBe("{}");
    expect(sourceEditor(container)).toBeNull();
  });

  it("mounts the spreadsheet editor for a .lattice-sheet file", async () => {
    const { container } = renderCanvas({ activeFile: "data.lattice-sheet", source: "{}" });

    const sheet = await screen.findByTestId("spreadsheet-editor");
    expect(sheet.dataset.path).toBe("data.lattice-sheet");
    expect(sourceEditor(container)).toBeNull();
  });

  it("mounts the visual Markdown editor for a .md file, beside its source", async () => {
    const { container } = renderCanvas({ mode: "split", activeFile: "notes.md", source: "# Notes\n" });

    expect(await screen.findByTestId("visual-markdown-editor")).toBeInTheDocument();
    await waitFor(() => expect(sourceEditor(container)).not.toBeNull());
    expect(screen.queryByTestId("pdf-preview")).toBeNull();
  });

  it("places a paper's visual editing warning above its generated title", async () => {
    renderCanvas({
      mode: "pdf",
      activeFile: ".research/papers/2408.05088/paper.md",
      source: "Paper body.",
      activePaper: {
        arxivId: "2408.05088",
        title: "UNIC",
        authors: "Mert and Philippe",
        hasFullText: true,
        hasBlog: false,
      },
    });

    fireEvent.click(await screen.findByTestId("visual-markdown-editor-report-lossy"));
    const warning = await screen.findByRole("status");
    const title = screen.getByRole("heading", { name: "UNIC" });

    expect(warning).toHaveTextContent("Visual editing is unavailable");
    expect(warning).toHaveClass("paper-visual-eligibility");
    expect(warning.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  it("hosts a native Open Slide deck as the complete presentation workspace", async () => {
    const onOpenSlideMutation = vi.fn(async () => []);
    const { container } = renderCanvas({
      mode: "source",
      activeFile: "slides/research-update/index.tsx",
      source: "export default [];\n",
      locale: "zh-CN",
      theme: "dark",
      onOpenSlideMutation,
    });

    const presentation = await screen.findByTestId("open-slide-workspace");
    expect(presentation.dataset.projectRoot).toBe("/tmp/project");
    expect(presentation.dataset.path).toBe("slides/research-update/index.tsx");
    expect(presentation.dataset.locale).toBe("zh-CN");
    expect(presentation.dataset.theme).toBe("dark");
    expect(sourceEditor(container)).toBeNull();
    fireEvent.click(screen.getByTestId("open-slide-mutation"));
    expect(onOpenSlideMutation).toHaveBeenCalledWith(expect.objectContaining({
      path: "slides/research-update/index.tsx",
      kind: "write",
    }));
  });

  it("keeps a native Open Slide deck inside the secondary pane", async () => {
    const { container } = renderCanvas({
      mode: "dual",
      activeFile: "main.tex",
      secondaryFile: "slides/research-update/index.tsx",
      secondarySource: "export default [];\n",
      focusedPane: "secondary",
      secondaryEditorEditable: false,
    });

    const presentation = await screen.findByTestId("open-slide-workspace");
    expect(presentation.dataset.active).toBe("true");
    expect(presentation.dataset.editable).toBe("false");
    expect(container.querySelector("[data-editor-pane='secondary'] [data-testid='open-slide-workspace']"))
      .not.toBeNull();
  });

  it("keeps a board inside its pane when a second editor is open", async () => {
    // Board and spreadsheet documents take over the canvas — except in the
    // two-pane modes, where taking over would close the other pane's editor.
    const { container } = renderCanvas({
      mode: "dual",
      activeFile: "diagram.tldr",
      source: "{}",
      secondaryFile: "main.tex",
      secondarySource: "\\section{Intro}\n",
    });

    expect(await screen.findByTestId("board-editor")).toBeInTheDocument();
    expect(container.querySelector("[data-editor-pane='primary'] [data-testid='board-editor']")).not.toBeNull();
    await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());
  });

  it("previews the compiled project PDF for a plain LaTeX file", async () => {
    renderCanvas({ mode: "pdf", activeFile: "main.tex", pdfUrl: "blob:project.pdf" });

    expect((await screen.findByTestId("pdf-preview")).dataset.url).toBe("blob:project.pdf");
    expect(screen.queryByTestId("visual-markdown-editor")).toBeNull();
  });
});

describe("DocumentCanvas / split ratio", () => {
  function separator() {
    return screen.getByRole("separator", { name: "Resize editor and PDF preview" });
  }

  it("opens at the ratio the last session left behind", () => {
    localStorage.setItem(SPLIT_RATIO_KEY, "0.6");
    renderCanvas({ mode: "split" });

    expect(separator()).toHaveAttribute("aria-valuenow", "60");
  });

  it("falls back to the default when nothing usable is stored", () => {
    localStorage.setItem(SPLIT_RATIO_KEY, "not-a-ratio");
    renderCanvas({ mode: "split" });

    expect(separator()).toHaveAttribute("aria-valuenow", "46");
  });

  it("clamps a stored ratio that would collapse a pane", () => {
    // Persisted values outlive the layout that produced them (a wider window,
    // an older build), and either extreme leaves one side unusable.
    localStorage.setItem(SPLIT_RATIO_KEY, "0.97");
    renderCanvas({ mode: "split" });

    expect(separator()).toHaveAttribute("aria-valuenow", "80");
  });

  it("nudges the split with the arrow keys and remembers where it stopped", () => {
    renderCanvas({ mode: "split" });

    fireEvent.keyDown(separator(), { key: "ArrowRight" });
    expect(separator()).toHaveAttribute("aria-valuenow", "49");
    fireEvent.keyDown(separator(), { key: "ArrowLeft" });
    fireEvent.keyDown(separator(), { key: "ArrowLeft" });
    expect(separator()).toHaveAttribute("aria-valuenow", "43");
    expect(Number(localStorage.getItem(SPLIT_RATIO_KEY))).toBeCloseTo(0.43, 5);
  });

  it("stops nudging at the edge instead of hiding a pane", () => {
    renderCanvas({ mode: "split" });

    for (let step = 0; step < 20; step += 1) {
      fireEvent.keyDown(separator(), { key: "ArrowLeft" });
    }

    expect(separator()).toHaveAttribute("aria-valuenow", "20");
  });

  it("ignores keys that are not a nudge", () => {
    renderCanvas({ mode: "split" });

    fireEvent.keyDown(separator(), { key: "ArrowUp" });

    expect(separator()).toHaveAttribute("aria-valuenow", "46");
    expect(localStorage.getItem(SPLIT_RATIO_KEY)).toBeNull();
  });
});

describe("DocumentCanvas / per-file view state", () => {
  const pdfViewState = (page: number) => ({ page, scale: 1, fitMode: null, scrollTop: 0, scrollLeft: 0 });

  function viewStates(states: Record<string, FileViewState>) {
    const updates: { path: string; update: Partial<FileViewState> }[] = [];
    return {
      updates,
      getFileViewState: (path: string) => states[path],
      onFileViewState: (path: string, update: Partial<FileViewState>) => {
        updates.push({ path, update });
      },
    };
  }

  it("restores each document's own place and files updates back under it", async () => {
    const state = viewStates({ "main.tex": { pdf: pdfViewState(3) } });
    renderCanvas({ mode: "pdf", activeFile: "main.tex", ...state });

    expect((await screen.findByTestId("pdf-preview")).dataset.restoredPage).toBe("3");

    fireEvent.click(screen.getByTestId("pdf-view-state"));
    expect(state.updates).toEqual([{ path: "main.tex", update: { pdf: pdfViewState(7) } }]);
  });

  it("hands the board its own saved view, not the previous file's", async () => {
    const state = viewStates({
      "main.tex": { pdf: pdfViewState(3) },
      "diagram.tldr": { board: { pageId: "page:1", camera: { x: 120, y: 0, z: 1 } } },
    });
    const { rerenderWith } = renderCanvas({ mode: "source", activeFile: "main.tex", ...state });

    rerenderWith({ activeFile: "diagram.tldr", source: "{}" });

    expect((await screen.findByTestId("board-editor")).dataset.restoredCamera).toBe("120");
  });

  it("returns an open presentation tab to the page it was showing", async () => {
    const path = "slides/research-update/index.tsx";
    const states: Record<string, FileViewState> = {};
    const onFileViewState = vi.fn((statePath: string, update: Partial<FileViewState>) => {
      states[statePath] = { ...states[statePath], ...update };
    });
    const getFileViewState = (statePath: string) => states[statePath];
    const { rerenderWith } = renderCanvas({
      activeFile: path,
      source: "export default [];\n",
      getFileViewState,
      onFileViewState,
    });
    fireEvent.click(await screen.findByTestId("open-slide-view-state"));

    rerenderWith({ activeFile: "main.tex", source: "\\section{Intro}\n" });
    rerenderWith({ activeFile: path, source: "export default [];\n" });

    expect((await screen.findByTestId("open-slide-workspace")).dataset.restoredPage).toBe("3");
    expect(onFileViewState).toHaveBeenCalledWith(path, { openSlide: { page: 3 } });
  });

  it("keeps the preview on the last file that owns one", async () => {
    // Opening a .bib from a citation, or a .sty from a macro, must not throw
    // away the reader's page in the compiled PDF: those files have no preview
    // of their own, so the preview column keeps the document it was showing.
    const state = viewStates({
      "main.tex": { pdf: pdfViewState(3) },
      "refs.bib": { pdf: pdfViewState(9) },
    });
    const { rerenderWith } = renderCanvas({ mode: "pdf", activeFile: "main.tex", ...state });
    expect((await screen.findByTestId("pdf-preview")).dataset.restoredPage).toBe("3");

    rerenderWith({ activeFile: "refs.bib", source: "@article{a}\n" });

    await waitFor(() => expect(screen.getByTestId("pdf-preview").dataset.restoredPage).toBe("3"));
    fireEvent.click(screen.getByTestId("pdf-view-state"));
    expect(state.updates).toEqual([{ path: "main.tex", update: { pdf: pdfViewState(7) } }]);
  });
});
