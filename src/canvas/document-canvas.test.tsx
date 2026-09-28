import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ComponentProps } from "react";
import type { AssetPreview, FileViewState } from "../app-types";
import { DocumentCanvas, OpenSlideTabPool } from "./document-canvas";
import { createEditorComment } from "../editor/comments/editor-comments";
import { EditorView } from "@codemirror/view";
import type { OpenSlideWorkspaceProps } from "../editor/presentation/open-slide-workspace";
import type { PdfPreview as RealPdfPreview } from "../pdf/pdf-viewer";

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
  const PdfPreview = (props: ComponentProps<typeof RealPdfPreview>) => (
    <div
      data-testid="pdf-preview"
      data-url={props.url ?? ""}
      data-file-name={props.fileName ?? ""}
      data-restored-page={String(props.initialViewState?.page ?? "")}
    >
      <button data-testid="pdf-view-state" onClick={() => props.onViewState?.({ page: 7, scale: 1, fitMode: null, scrollTop: 0, scrollLeft: 0 })} />
    </div>
  );
  const editorStub = (testId: string) => (props: {
    path?: string; source?: string; initialViewState?: { camera?: { x: number; y: number; z: number } };
    editorComments?: Array<{ id: string; from: number; to: number }>; activeEditorCommentId?: string | null;
    onEligibilityChange?: (reason: string | null) => void; onEditorCommentClick?: (id: string) => void;
    onCreateComment?: (from: number, to: number, body: string) => void;
  }) => (
    <div
      data-testid={testId}
      data-path={props.path ?? ""}
      data-source={props.source ?? ""}
      data-restored-camera={String(props.initialViewState?.camera?.x ?? "")}
      data-comments={JSON.stringify(props.editorComments ?? [])}
      data-active-comment={props.activeEditorCommentId ?? ""}
    >
      {props.editorComments?.map((comment) => (
        <button key={comment.id} data-testid={`thread-${comment.id}`} onClick={() => props.onEditorCommentClick?.(comment.id)} />
      ))}
      {props.onCreateComment && <button data-testid="preview-create-comment" onClick={() => props.onCreateComment?.(2, 7, "Preview comment")} />}
      {props.onEligibilityChange && (
        <button data-testid={`${testId}-report-lossy`} onClick={() => props.onEligibilityChange?.("Visual editing is unavailable here.")} />
      )}
    </div>
  );
  const OpenSlideWorkspace = (props: OpenSlideWorkspaceProps) => (
    <div
      data-testid="open-slide-workspace"
      data-project-root={props.projectRoot}
      data-path={props.path}
      data-source={props.source}
      data-locale={props.locale}
      data-theme={props.theme}
      data-active={String(props.active ?? true)}
      data-editable={String(props.editable)}
      data-restored-page={String(props.initialViewState?.page ?? "")}
    >
      <button data-testid="open-slide-mutation" onClick={() => void props.onMutation({
        id: 1, path: props.path, kind: "write", text: "export default [];\n", previousText: props.source,
      })} />
      <button type="button" data-testid="open-slide-view-state" onClick={() => props.onViewState?.({ page: 3 })} />
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

/** Callbacks every canvas gets as a bare spy; the ones that must answer something are set in `baseProps`. */
const HANDLERS = [
  "setSecondarySource", "onFocusPane", "setSource", "setSelection", "onPdfTextSelect", "onPaperTextSelect",
  "onContextSurfaceActivate", "onViewMarkdownSource", "onEditorLeave", "onPasteImageFile", "onRequestHandled",
  "onEditorPosition", "onCompletionActiveChange", "onViewState",
  "onGotoDefinition", "onTexlabGoto", "onFindReferences", "onRenameSymbol", "onRenameEnvironment", "onWrapEnvironment",
  "onGotoLineRequest", "onOutlineOpenChange", "onOutlineNavigate",
  "onInsertOpenChange", "onTableGeneratorOpenChange", "onForwardSync", "onPdfSource",
  "onCreateEditorComment", "onOpenEditorComments", "onResolveEditorComment", "onReplyEditorComment",
  "onCommentFocusHandled", "onOpenTodos", "onPdfPageCount", "onPdfPageChange", "onCreateMissingFile",
  "onOpenMarkdownPath", "onOpenCitation",
] as const satisfies readonly (keyof CanvasProps)[];

/** The canvas request bundle with only `pending` set. */
function pending(requests: Partial<CanvasProps["requests"]> = {}): CanvasProps["requests"] {
  return { navigation: null, restore: null, rename: null, wrap: null, cite: null, figure: null, ...requests };
}

function baseProps(): CanvasProps {
  return {
    ...Object.fromEntries(HANDLERS.map((name) => [name, vi.fn()])) as Record<(typeof HANDLERS)[number], Mock>,
    projectRoot: "/tmp/project", locale: "en", theme: "light", mode: "source",
    source: "\\section{Intro}\n", activeFile: "main.tex", secondaryFile: null, secondarySource: "", focusedPane: "primary",
    dualRatioResetGeneration: 0,
    onSave: vi.fn(async () => true),
    onOpenSlideMutation: vi.fn(async () => []),
    onLoadReferenceImage: vi.fn(async () => null),
    onPrepareFigure: vi.fn(async () => null),
    onAddSpellingWord: vi.fn(() => true),
    canOpenCitation: () => false,
    pdfUrl: null, activePaper: null, paperSide: "left", activeAsset: null, secondaryAsset: null,
    citationKeys: [], citations: [], references: [], unusedLabels: [], unusedCitations: [],
    localMacros: [], katexMacros: {}, spellingWords: [], projectPaths: ["main.tex"], graphicsRoots: [],
    buildDiagnostics: [], texlabDiagnostics: [], outlineNodes: [], editorComments: [],
    overleafPresenceCursors: [], overleafChanges: [], collabPeers: [],
    requests: pending(), commentFocusRequest: null, figurePointerPosition: null, fileDropTargetPane: null,
    activeOutlineId: null, activeEditorCommentId: null, pdfSyncTarget: null, projectWordCount: null, collabSession: null,
    nativeFigureDropActive: false, outlineOpen: false, insertOpen: false, tableGeneratorOpen: false,
    canForwardSync: false, locatingPdf: false, interactivePreviewsEnabled: false, collabReady: false,
    editorKeymap: "default", editorSpellcheck: false, editorEditable: true, secondaryEditorEditable: true,
    overleafTrackChangeActions: { authorName: () => "Unknown", canAct: () => false, onAccept: vi.fn(), onReject: vi.fn() },
    commentAuthorName: "Ada", commentAuthorId: "ada", todoCount: 0, collabEditorKey: "local",
  };
}

function renderCanvas(overrides?: Partial<CanvasProps>) {
  const props = { ...baseProps(), ...overrides };
  const view = render(<DocumentCanvas {...props} />);
  return {
    ...view,
    props,
    rerenderWith: (next: Partial<CanvasProps>) => view.rerender(<DocumentCanvas {...props} {...next} />),
  };
}

const imageAsset: AssetPreview = { path: "figures/plot.png", mimeType: "image/png", base64: "aGk=" };

/** The primary source editor, which every mode either shows or deliberately omits. */
function sourceEditor(container: HTMLElement) {
  return container.querySelector("[data-editor-pane='primary'] .cm-editor");
}

/** The primary source editor's view, once it has mounted. */
async function primarySourceView(container: HTMLElement) {
  await waitFor(() => expect(sourceEditor(container)).not.toBeNull());
  return EditorView.findFromDOM(sourceEditor(container) as HTMLElement)!;
}

/**
 * Select "bold" in "Hello bold world" and open the comment composer from the
 * selection toolbar. jsdom has no text layout, so the editor reports `bounds`
 * and the selection sits wherever `coords` says.
 */
async function composeCommentOnBold(container: HTMLElement, bounds: DOMRect, coords: () => { left: number; right: number; top: number; bottom: number }) {
  const view = await primarySourceView(container);
  vi.spyOn(view.dom.closest(".source-editor")!, "getBoundingClientRect").mockReturnValue(bounds);
  vi.spyOn(view.scrollDOM, "getBoundingClientRect").mockReturnValue(bounds);
  vi.spyOn(view, "coordsAtPos").mockImplementation(coords);
  act(() => {
    view.focus();
    view.dispatch({ selection: { anchor: 6, head: 10 } });
  });
  fireEvent.click(await screen.findByRole("button", { name: "Comment" }));
  return { view, composer: await screen.findByRole("dialog", { name: "Add comment" }) };
}

afterEach(cleanup);

beforeEach(() => {
  localStorage.clear();
});

describe("DocumentCanvas / mode", () => {
  it("discards a pending saved position when an explicit source jump arrives", async () => {
    const viewRestore = { path: "main.tex", cursor: 2, scrollTop: 450, id: "saved" };
    const { container, props, rerenderWith } = renderCanvas({
      mode: "pdf",
      source: "first\nsecond\ntarget\nlast\n",
      requests: pending({ restore: viewRestore }),
    });
    rerenderWith({ mode: "split", requests: pending({ restore: viewRestore, navigation: { path: "main.tex", line: 3, id: "jump" } }) });
    await waitFor(() => expect(props.onRequestHandled).toHaveBeenCalledWith("jump"));
    const view = await primarySourceView(container);
    expect(view.state.selection.main.head).toBe(13);
    // App settles requests and may supply a new settle callback on its next
    // render. An unconsumed restore must not move the cursor then.
    const restoreSettled = vi.mocked(props.onRequestHandled).mock.calls.some(([id]) => id === "saved");
    rerenderWith({ mode: "split", requests: pending({ restore: restoreSettled ? null : viewRestore }), onRequestHandled: vi.fn() });
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(view.state.selection.main.head).toBe(13);
    expect(view.scrollDOM.scrollTop).not.toBe(450);
    expect(props.onRequestHandled).toHaveBeenCalledWith("saved");
  });

  it.each([null, { path: "other.tex", line: 3, id: "other-jump" }])(
    "still restores a saved position without a competing jump in that file (%j)",
    async (navigation) => {
      const { container, props, rerenderWith } = renderCanvas({ source: "first\nsecond\ntarget\n" });
      const view = await primarySourceView(container);
      rerenderWith({ requests: pending({ navigation, restore: { path: "main.tex", cursor: 8, scrollTop: 120, id: "saved" } }) });
      await waitFor(() => expect(props.onRequestHandled).toHaveBeenCalledWith("saved"));
      expect(view.state.selection.main.head).toBe(8);
      expect(view.scrollDOM.scrollTop).toBe(120);
    },
  );

  it.each([
    { initialTextTop: 240, expectedTop: 218, expectedTranslate: "none" },
    { initialTextTop: 490, expectedTop: 432, expectedTranslate: "0 -100%" },
  ])("keeps the comment draft anchored at $initialTextTop while scrolling, preserving it offscreen", async ({ initialTextTop, expectedTop, expectedTranslate }) => {
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("editor-comment-popover") ? 180 : 0;
    });
    const { container, props } = renderCanvas({ source: "Hello bold world" });
    let textTop = initialTextTop;
    const { view, composer } = await composeCommentOnBold(
      container,
      new DOMRect(20, 50, 600, 500),
      () => ({ left: 100, right: 150, top: textTop, bottom: textTop + 20 }),
    );
    fireEvent.change(within(composer).getByRole("textbox"), { target: { value: "Keep this draft" } });
    const initialTop = Number.parseFloat(composer.style.top);
    expect(initialTop).toBe(expectedTop);
    expect(composer.style.translate).toBe(expectedTranslate);
    textTop -= 90;
    fireEvent.scroll(view.scrollDOM);
    await waitFor(() => expect(Number.parseFloat(composer.style.top)).toBe(initialTop - 90));
    textTop = 10;
    fireEvent.scroll(view.scrollDOM);
    await waitFor(() => expect(composer).not.toBeVisible());
    textTop = initialTextTop;
    fireEvent.scroll(view.scrollDOM);
    await waitFor(() => expect(composer).toBeVisible());
    expect(within(composer).getByRole("textbox")).toHaveValue("Keep this draft");
    fireEvent.click(within(composer).getByRole("button", { name: "Add comment" }));
    expect(props.onCreateEditorComment).toHaveBeenCalledWith(expect.objectContaining({ quote: "bold", body: "Keep this draft", from: 6, to: 10 }));
  });

  it("highlights the source selection while composing and removes only the draft on cancel", async () => {
    const source = "Hello bold world";
    const existing = createEditorComment({ path: "main.tex", source, from: 6, to: 10, body: "Existing", authorId: "ada", authorName: "Ada" })!;
    const { container, props } = renderCanvas({ source, editorComments: [existing] });
    const { view, composer } = await composeCommentOnBold(
      container,
      new DOMRect(0, 0, 600, 500),
      () => ({ left: 100, right: 150, top: 100, bottom: 120 }),
    );
    expect(view.dom.querySelector(".editor-comment-draft")?.textContent).toBe("bold");
    expect(props.onCreateEditorComment).not.toHaveBeenCalled();
    fireEvent.click(within(composer).getByRole("button", { name: "Cancel" }));
    expect(view.dom.querySelector(".editor-comment-draft")).toBeNull();
    expect(view.dom.querySelector(".cm-editor-comment")?.textContent).toBe("bold");
  });

  it("maps secondary Markdown comments around frontmatter and wires live threads and creation", async () => {
    const prefix = "---\ntitle: Notes\n---\n";
    const source = `${prefix}A local and remote passage.`;
    const local = createEditorComment({ path: "notes.md", source, from: prefix.length + 2, to: prefix.length + 7, body: "Local", authorId: "ada", authorName: "Ada" })!;
    const remote = { ...local, id: "overleaf:thread-2", from: prefix.length + 12, to: prefix.length + 18, quote: "remote" };
    const hidden = { ...local, id: "frontmatter", from: 4, to: prefix.length + 3 };
    const other = { ...local, id: "other", path: "main.tex" };
    const { props, rerenderWith } = renderCanvas({ mode: "dual", secondaryFile: "notes.md", secondarySource: source, dualPreviewPanes: { primary: false, secondary: true }, editorComments: [local, remote, hidden, other], activeEditorCommentId: remote.id });
    const preview = await screen.findByTestId("visual-markdown-editor");
    const comments = () => JSON.parse(preview.getAttribute("data-comments")!);
    expect(comments()).toEqual([{ ...local, from: 2, to: 7 }, { ...remote, from: 12, to: 18 }]);
    expect(preview).toHaveAttribute("data-active-comment", remote.id);
    fireEvent.click(screen.getByTestId(`thread-${remote.id}`));
    expect(props.onReplyEditorComment).toHaveBeenCalledWith(remote.id);
    fireEvent.click(screen.getByTestId("preview-create-comment"));
    expect(props.onCreateEditorComment).toHaveBeenCalledWith(expect.objectContaining({ path: "notes.md", from: prefix.length + 2, to: prefix.length + 7, quote: "local", body: "Preview comment" }));
    rerenderWith({ editorComments: [{ ...remote, body: "Updated reply", resolved: true }] });
    expect(comments()).toEqual([{ ...remote, from: 12, to: 18, body: "Updated reply", resolved: true }]);
  });

  it("keeps local and Overleaf comments on their file when it moves to the secondary source pane, and refreshes them", async () => {
    const source = "Local passage. Remote passage.";
    const local = createEditorComment({ path: "main.tex", source, from: 0, to: 5, body: "Local", authorId: "ada", authorName: "Ada" })!;
    const remote = { ...createEditorComment({ path: "main.tex", source, from: 15, to: 21, body: "Remote", authorId: "overleaf-user", authorName: "Grace" })!, id: "overleaf:thread-1" };
    const unrelated = { ...local, id: "other-file", path: "other.tex" };
    const { container, props, rerenderWith } = renderCanvas({ source, editorComments: [local, remote, unrelated] });
    await waitFor(() => expect(sourceEditor(container)?.querySelectorAll(".cm-editor-comment")).toHaveLength(2));
    const moved = { mode: "dual" as const, activeFile: "other.tex", source, secondaryFile: "main.tex", secondarySource: source };
    rerenderWith(moved);
    const secondaryMarks = () => [...container.querySelectorAll("[data-editor-pane='secondary'] .cm-editor-comment")].map((mark) => mark.getAttribute("data-comment-id"));
    await waitFor(() => expect(secondaryMarks()).toEqual([local.id, remote.id]));
    expect(sourceEditor(container)?.querySelector(".cm-editor-comment")).toHaveAttribute("data-comment-id", unrelated.id);
    rerenderWith({ ...moved, commentFocusRequest: { id: remote.id, nonce: "focus-right" } });
    const secondaryEditor = container.querySelector<HTMLElement>("[data-editor-pane='secondary'] .cm-editor")!;
    expect(EditorView.findFromDOM(secondaryEditor)?.state.selection.main).toMatchObject({ from: 15, to: 21 });
    expect(props.onCommentFocusHandled).toHaveBeenCalledWith("focus-right");
    rerenderWith({ ...moved, editorComments: [{ ...local, resolved: true }, remote, unrelated] });
    await waitFor(() => expect(secondaryMarks()).toEqual([remote.id]));
    rerenderWith({ ...moved, editorComments: [] });
    await waitFor(() => expect(secondaryMarks()).toEqual([]));
  });

  it.each([
    // Source and PDF give the whole canvas to one surface.
    { mode: "source", editors: 1, pdf: false, separators: [] },
    { mode: "pdf", editors: 0, pdf: true, separators: [] },
    { mode: "split", editors: 1, pdf: true, separators: ["Resize editor and PDF preview"] },
    // The separator is the only label a screen reader gets for the pane it moves,
    // so it names whatever the open document actually previews.
    { mode: "split", editors: 1, pdf: false, separators: ["Resize editor and Markdown preview"], activeFile: "notes.md" },
    { mode: "split", editors: 1, pdf: false, separators: ["Resize editor and asset preview"], activeFile: "notes.md", activeAsset: imageAsset },
    // Two editors and no project preview, until columns adds it with its own resizer.
    { mode: "dual", editors: 2, pdf: false, separators: ["Resize dual source panes"] },
    { mode: "columns", editors: 2, pdf: true, separators: ["Resize dual source panes", "Resize PDF pane"] },
  ] as const)("lays out $mode mode with $editors editors, PDF: $pdf, separators: $separators", async ({ mode, editors, pdf, separators, ...document }) => {
    const { container } = renderCanvas({ mode, secondaryFile: "appendix.tex", secondarySource: "\\section{Appendix}\n", ...document });

    await waitFor(() => expect(container.querySelectorAll(".cm-editor")).toHaveLength(editors));
    await waitFor(() => expect(Boolean(screen.queryByTestId("pdf-preview"))).toBe(pdf));
    expect(screen.queryAllByRole("separator").map((separator) => separator.getAttribute("aria-label"))).toEqual(separators);
    expect(Boolean(container.querySelector(".split-canvas"))).toBe(separators.length > 0);
    expect(Boolean(container.querySelector(".columns-canvas"))).toBe(mode === "columns");
  });

  it("embeds standalone data HTML frames inside the sandboxed HTML preview", async () => {
    const embeddedPlot = btoa(
      "<!doctype html><html><body><div id='plot'></div><script>window.inlinePlotReady=true</script></body></html>",
    );
    renderCanvas({
      mode: "pdf", activeFile: "presentation.html", interactivePreviewsEnabled: true,
      source: `<iframe src="data:text/html;charset=utf-8;base64,${embeddedPlot}" title="Plot"></iframe>`,
    });

    const preview = await screen.findByTitle<HTMLIFrameElement>("HTML preview for presentation.html");
    expect(preview.getAttribute("srcdoc")).not.toContain("data:text/html");
    expect(preview.getAttribute("srcdoc")).toContain("window.inlinePlotReady=true");
    expect(preview.getAttribute("srcdoc")).toContain('sandbox="allow-scripts"');
  });

  it("places a Paper beside an editor on either side", async () => {
    const { container, rerenderWith } = renderCanvas({
      mode: "dual", activeFile: ".research/papers/1706.03762/paper.md", source: "## Abstract\n\nPaper content.",
      activePaper: { arxivId: "1706.03762", title: "Attention Is All You Need", authors: "Ashish Vaswani and Noam Shazeer", hasFullText: true, hasBlog: false },
      paperSide: "left", secondaryFile: "main.tex", secondarySource: "\\documentclass{article}\n",
    });

    await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());
    const split = container.querySelector(".dual-canvas")!;
    expect(split.firstElementChild).toHaveClass("paper-pane");

    rerenderWith({ paperSide: "right" });
    expect(split.lastElementChild).toHaveClass("paper-pane");
  });

  // Mode and asset arrive from different pieces of App state, so the two can be
  // out of step for a render; without an asset the canvas must fall back to the
  // editor rather than preview nothing and lose the open file.
  it.each([imageAsset, null])("shows only the asset in asset mode, if there is one (%j)", async (activeAsset) => {
    const { container } = renderCanvas({ mode: "asset", activeAsset });

    await waitFor(() => expect(Boolean(sourceEditor(container))).toBe(!activeAsset));
    expect(Boolean(container.querySelector(".asset-preview"))).toBe(Boolean(activeAsset));
    if (!activeAsset) return;
    expect(screen.getByText("figures/plot.png")).toBeInTheDocument();
    expect(screen.queryByTestId("pdf-preview")).toBeNull();
  });
});

describe("DocumentCanvas / editor for the open document", () => {
  const surfaces = ["board-editor", "spreadsheet-editor", "visual-markdown-editor", "pdf-preview"];

  it.each([
    // Whole-file editors are handed their document; plain LaTeX previews the project's compiled PDF.
    { mode: "source", activeFile: "diagram.tldr", testId: "board-editor", beside: false, data: { path: "diagram.tldr", source: "{}" } },
    { mode: "source", activeFile: "data.lattice-sheet", testId: "spreadsheet-editor", beside: false, data: { path: "data.lattice-sheet", source: "{}" } },
    { mode: "split", activeFile: "notes.md", testId: "visual-markdown-editor", beside: true, data: {} },
    { mode: "pdf", activeFile: "main.tex", testId: "pdf-preview", beside: false, data: { url: "blob:project.pdf" } },
  ] as const)("mounts only the $testId for $activeFile in $mode mode, source editor beside: $beside", async ({ mode, activeFile, testId, beside, data }) => {
    const { container } = renderCanvas({ mode, activeFile, source: "{}", pdfUrl: "blob:project.pdf" });

    expect({ ...(await screen.findByTestId(testId)).dataset }).toMatchObject(data);
    await waitFor(() => expect(Boolean(sourceEditor(container))).toBe(beside));
    for (const other of surfaces.filter((id) => id !== testId)) expect(screen.queryByTestId(other)).toBeNull();
  });

  it("places a paper's visual editing warning above its generated title", async () => {
    renderCanvas({
      mode: "pdf", activeFile: ".research/papers/2408.05088/paper.md", source: "Paper body.",
      activePaper: { arxivId: "2408.05088", title: "UNIC", authors: "Mert and Philippe", hasFullText: true, hasBlog: false },
    });

    fireEvent.click(await screen.findByTestId("visual-markdown-editor-report-lossy"));
    const warning = await screen.findByRole("status");
    const title = screen.getByRole("heading", { name: "UNIC" });

    expect(warning).toHaveTextContent("Visual editing is unavailable");
    expect(warning).toHaveClass("paper-visual-eligibility");
    expect(warning.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps an open presentation iframe mounted while another tab is active", async () => {
    const path = "slides/research-update/index.tsx";
    const activeWorkspace = {
      projectRoot: "/tmp/project", path, source: "export default [];\n", editable: true,
      locale: "en" as const, theme: "light" as const, onMutation: vi.fn(async () => []),
    };
    const pool = (workspace: typeof activeWorkspace | null, openPaths: string[]) => (
      <OpenSlideTabPool projectRoot="/tmp/project" activeWorkspace={workspace} openPaths={openPaths} />
    );
    const { rerender } = render(pool(activeWorkspace, [path]));
    const presentation = await screen.findByTestId("open-slide-workspace");

    for (const [workspace, active] of [[null, "false"], [activeWorkspace, "true"]] as const) {
      rerender(pool(workspace, [path]));
      expect(screen.getByTestId("open-slide-workspace")).toBe(presentation);
      expect(presentation.dataset.active).toBe(active);
    }

    rerender(pool(null, []));
    expect(screen.queryByTestId("open-slide-workspace")).toBeNull();
  });

  it("lets the external presentation pool own the primary Open Slide surface", async () => {
    const { container } = renderCanvas({ mode: "source", activeFile: "slides/research-update/index.tsx", source: "export default [];\n" });

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("keeps a native Open Slide deck inside the secondary pane as its complete workspace", async () => {
    const path = "slides/research-update/index.tsx";
    const { container, props } = renderCanvas({
      mode: "dual", activeFile: "main.tex", secondaryFile: path, secondarySource: "export default [];\n",
      focusedPane: "secondary", secondaryEditorEditable: false, locale: "zh-CN", theme: "dark",
    });

    const presentation = await screen.findByTestId("open-slide-workspace");
    expect({ ...presentation.dataset }).toMatchObject({
      active: "true", editable: "false", projectRoot: "/tmp/project", path, locale: "zh-CN", theme: "dark",
    });
    fireEvent.click(screen.getByTestId("open-slide-mutation"));
    expect(props.onOpenSlideMutation).toHaveBeenCalledWith(expect.objectContaining({ path, kind: "write" }));
    expect(container.querySelector("[data-editor-pane='secondary'] [data-testid='open-slide-workspace']"))
      .not.toBeNull();
  });

  it("keeps a board inside its pane when a second editor is open", async () => {
    // Board and spreadsheet documents take over the canvas — except in the
    // two-pane modes, where taking over would close the other pane's editor.
    const { container } = renderCanvas({ mode: "dual", activeFile: "diagram.tldr", source: "{}", secondaryFile: "main.tex", secondarySource: "\\section{Intro}\n" });

    expect(await screen.findByTestId("board-editor")).toBeInTheDocument();
    expect(container.querySelector("[data-editor-pane='primary'] [data-testid='board-editor']")).not.toBeNull();
    await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());
  });
});

describe("DocumentCanvas / split ratio", () => {
  const separator = () => screen.getByRole("separator", { name: "Resize editor and PDF preview" });

  /** Render `mode` with a second file open and the split measuring `bounds`; `offset` reads `label`'s boundary resistance. */
  function renderGrip(mode: CanvasProps["mode"], label: string, bounds: Partial<DOMRect>) {
    const { container } = renderCanvas({ mode, secondaryFile: "appendix.tex", secondarySource: "Appendix" });
    const split = container.querySelector<HTMLElement>(".split-canvas")!;
    vi.spyOn(split, "getBoundingClientRect").mockReturnValue(bounds as DOMRect);
    const property = label === "Resize PDF pane" ? "--split-pdf-offset" : "--split-resizer-offset";
    const offset = () => Number.parseFloat(split.style.getPropertyValue(property));
    return { split, property, offset, grip: screen.getByRole("separator", { name: label }) };
  }

  it.each([
    { mode: "split", label: "Resize editor and PDF preview", inside: 700, saved: 1099 / 1599, key: SPLIT_RATIO_KEY },
    { mode: "dual", label: "Resize dual source panes", inside: 700, saved: 0.8, key: SPLIT_RATIO_KEY },
    { mode: "columns", label: "Resize dual source panes", inside: 600, saved: 0.75, key: SPLIT_RATIO_KEY },
    { mode: "columns", label: "Resize PDF pane", inside: 1100, saved: 0.22, key: "lattice.columns-pdf-ratio.v1" },
  ] as const)("adds boundary-only resistance to $mode / $label without saving the offset", ({ mode, label, inside, saved, key }) => {
    const { property, offset, grip } = renderGrip(mode, label, { left: 100, right: 1700, width: 1600 });
    fireEvent.pointerDown(grip, { clientX: inside });
    fireEvent.pointerMove(window, { clientX: inside });
    expect(offset()).toBeCloseTo(0);
    fireEvent.pointerMove(window, { clientX: 50 });
    expect(offset()).toBeLessThan(0);
    expect(offset()).toBeGreaterThanOrEqual(-24);
    expect(grip.style.transform).toBe("");
    expect(grip.style.getPropertyValue(property)).toBe("");
    fireEvent.pointerCancel(window);
    expect(offset()).toBe(0);
    expect(document.body).not.toHaveClass("resizing-split");
    fireEvent.pointerDown(grip, { clientX: inside });
    fireEvent.pointerMove(window, { clientX: 1800 });
    expect(offset()).toBeGreaterThan(0);
    expect(offset()).toBeLessThanOrEqual(24);
    fireEvent.pointerMove(window, { clientX: inside });
    expect(offset()).toBeCloseTo(0);
    fireEvent.pointerMove(window, { clientX: 1800 });
    fireEvent.pointerUp(window);
    expect(offset()).toBe(0);
    expect(Number(localStorage.getItem(key))).toBeCloseTo(saved);
    fireEvent.pointerMove(window, { clientX: 50 });
    expect(offset()).toBe(0);
  });

  it.each([
    // Persisted values outlive the layout that produced them (a wider window,
    // an older build), and either extreme leaves one side unusable.
    { stored: "0.6", shown: "60", case: "opens at the ratio the last session left behind" },
    { stored: "not-a-ratio", shown: "46", case: "falls back to the default when nothing usable is stored" },
    { stored: "0.97", shown: "80", case: "clamps a stored ratio that would collapse a pane" },
  ])("$case", ({ stored, shown }) => {
    localStorage.setItem(SPLIT_RATIO_KEY, stored);
    renderCanvas({ mode: "split" });

    expect(separator()).toHaveAttribute("aria-valuenow", shown);
  });

  it("does not replace the saved split preference when a restored window is temporarily narrow", () => {
    localStorage.setItem(SPLIT_RATIO_KEY, "0.6");
    const { container, rerenderWith } = renderCanvas({ mode: "source" });
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ left: 0, width: 700, right: 700 } as DOMRect);
    try {
      rerenderWith({ mode: "split" });
      expect(Number(separator().getAttribute("aria-valuenow"))).toBeLessThan(60);
      expect(localStorage.getItem(SPLIT_RATIO_KEY)).toBe("0.6");
      rerenderWith({ mode: "source" });
      bounds.mockReturnValue({ left: 0, width: 1400, right: 1400 } as DOMRect);
      rerenderWith({ mode: "split" });
      expect(container.querySelector(".split-canvas")).not.toBeNull();
      expect(separator()).toHaveAttribute("aria-valuenow", "60");
    } finally {
      bounds.mockRestore();
    }
  });

  it.each([
    { mode: "dual", label: "Resize dual source panes", width: 800, x: 200, direction: -1 },
    { mode: "columns", label: "Resize PDF pane", width: 1200, x: 760, direction: 1 },
  ] as const)("respects pixel minimums before ratio limits in $mode", ({ mode, label, width, x, direction }) => {
    const { split, property, offset, grip } = renderGrip(mode, label, { left: 0, right: width, width });
    fireEvent.pointerDown(grip, { clientX: width / 2 });
    fireEvent.pointerMove(window, { clientX: x });
    expect(offset() * direction).toBeGreaterThan(0);
    fireEvent.blur(window);
    expect(split.style.getPropertyValue(property)).toBe("0px");
    expect(document.body).not.toHaveClass("resizing-split");
  });

  it("nudges the split with the arrow keys only, remembers where it stopped, and stops at the edge instead of hiding a pane", () => {
    renderCanvas({ mode: "split" });

    fireEvent.keyDown(separator(), { key: "ArrowUp" });
    expect(separator()).toHaveAttribute("aria-valuenow", "46");
    expect(localStorage.getItem(SPLIT_RATIO_KEY)).toBeNull();
    fireEvent.keyDown(separator(), { key: "ArrowRight" });
    expect(separator()).toHaveAttribute("aria-valuenow", "49");
    fireEvent.keyDown(separator(), { key: "ArrowLeft" });
    fireEvent.keyDown(separator(), { key: "ArrowLeft" });
    expect(separator()).toHaveAttribute("aria-valuenow", "43");
    expect(Number(localStorage.getItem(SPLIT_RATIO_KEY))).toBeCloseTo(0.43, 5);

    for (let step = 0; step < 20; step += 1) fireEvent.keyDown(separator(), { key: "ArrowLeft" });
    expect(separator()).toHaveAttribute("aria-valuenow", "20");
  });
});

describe("DocumentCanvas / per-file view state", () => {
  const pdfViewState = (page: number) => ({ page, scale: 1, fitMode: null, scrollTop: 0, scrollLeft: 0 });

  function viewStates(states: Record<string, FileViewState>) {
    const updates: { path: string; update: Partial<FileViewState> }[] = [];
    return {
      updates,
      getFileViewState: (path: string) => states[path],
      onFileViewState: (path: string, update: Partial<FileViewState>) => void updates.push({ path, update }),
    };
  }

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
    // The canvas hosts decks in the secondary pane; App's tab pool hosts the primary one.
    const { rerenderWith } = renderCanvas({
      mode: "dual", activeFile: "main.tex", secondaryFile: path, secondarySource: "export default [];\n", getFileViewState, onFileViewState,
    });
    fireEvent.click(await screen.findByTestId("open-slide-view-state"));

    rerenderWith({ secondaryFile: "intro.tex", secondarySource: "\\section{Intro}\n" });
    rerenderWith({ secondaryFile: path, secondarySource: "export default [];\n" });

    expect((await screen.findByTestId("open-slide-workspace")).dataset.restoredPage).toBe("3");
    expect(onFileViewState).toHaveBeenCalledWith(path, { openSlide: { page: 3 } });
  });

  it("keeps the compiled PDF mounted when source navigation changes TeX files", async () => {
    const state = viewStates({
      "main.tex": { pdf: pdfViewState(3) },
      "chapters/results.tex": { pdf: pdfViewState(1) },
    });
    const { rerenderWith } = renderCanvas({ mode: "split", activeFile: "main.tex", ...state });
    const preview = await screen.findByTestId("pdf-preview");
    preview.scrollTop = 2450;

    // SyncTeX can resolve into a different included file. The PDF is still
    // the same build, even when that file has a different saved PDF position.
    for (const activeFile of ["chapters/results.tex", "refs.bib", "main.tex"]) {
      rerenderWith({ activeFile, source: "\\section{Results}\n" });
      expect(await screen.findByTestId("pdf-preview")).toBe(preview);
      expect(preview.scrollTop).toBe(2450);
    }

    // A different project must not inherit this viewer instance.
    rerenderWith({ projectRoot: "/tmp/other-project" });
    expect(await screen.findByTestId("pdf-preview")).not.toBe(preview);
  });

  it("restores each document's own place, files updates back under it, and keeps it for files without a preview", async () => {
    const state = viewStates({ "main.tex": { pdf: pdfViewState(3) }, "refs.bib": { pdf: pdfViewState(9) } });
    const { rerenderWith } = renderCanvas({ mode: "pdf", activeFile: "main.tex", ...state });
    expect((await screen.findByTestId("pdf-preview")).dataset.restoredPage).toBe("3");
    fireEvent.click(screen.getByTestId("pdf-view-state"));
    expect(state.updates).toEqual([{ path: "main.tex", update: { pdf: pdfViewState(7) } }]);

    // Opening a .bib from a citation, or a .sty from a macro, must not throw
    // away the reader's page in the compiled PDF: those files have no preview
    // of their own, so the preview column keeps the document it was showing.
    rerenderWith({ activeFile: "refs.bib", source: "@article{a}\n" });
    await waitFor(() => expect(screen.getByTestId("pdf-preview").dataset.restoredPage).toBe("3"));
    fireEvent.click(screen.getByTestId("pdf-view-state"));
    expect(state.updates.at(-1)).toEqual({ path: "main.tex", update: { pdf: pdfViewState(7) } });
    expect(state.updates.every((update) => update.path === "main.tex")).toBe(true);
  });
});
