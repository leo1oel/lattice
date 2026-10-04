import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ComponentProps } from "react";
import type { AssetPreview, FileViewState } from "../app-types";
import { DocumentCanvas } from "./document-canvas";
import { splitGridTemplate } from "./use-split-layout";
import { createEditorComment } from "../editor/comments/editor-comment-data";
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
    onCreateComment?: (from: number, to: number, body: string) => void; theme?: string;
    revealRequest?: { id: string; target: unknown } | null; onRevealHandled?: (id: string) => void;
    synchronizeSourceScroll?: boolean;
  }) => (
    <div
      data-testid={testId}
      data-path={props.path ?? ""}
      data-theme={props.theme ?? ""}
      data-source={props.source ?? ""}
      data-restored-camera={String(props.initialViewState?.camera?.x ?? "")}
      data-comments={JSON.stringify(props.editorComments ?? [])}
      data-active-comment={props.activeEditorCommentId ?? ""}
      data-reveal={JSON.stringify(props.revealRequest ?? null)}
      data-source-labels={String(Boolean(props.synchronizeSourceScroll))}
    >
      {props.revealRequest && (
        <button data-testid={`${testId}-landed`} onClick={() => props.onRevealHandled?.(props.revealRequest!.id)} />
      )}
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
    loadVisualMarkdownEditorModule: async () => ({ LatticeVisualMarkdownEditor: editorStub("visual-markdown-editor") }),
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
  "setSource", "setSelection", "onPdfTextSelect", "onPaperTextSelect",
  "onContextSurfaceActivate", "onViewMarkdownSource", "onEditorLeave", "onPasteImageFile", "onRequestHandled",
  "onEditorPosition", "onCompletionActiveChange", "onViewState",
  "onGotoDefinition", "onTexlabGoto", "onFindReferences", "onRenameSymbol", "onRenameEnvironment", "onWrapEnvironment",
  "onGotoLineRequest", "onOutlineOpenChange", "onOutlineNavigate",
  "onTableGeneratorOpenChange", "onForwardSync", "onPdfSource",
  "onCreateEditorComment", "onOpenEditorComments", "onResolveEditorComment", "onReplyEditorComment",
  "onCommentFocusHandled", "onOpenTodos", "onPdfPageCount", "onPdfPageChange", "onCreateMissingFile",
  "onOpenMarkdownPath", "onOpenCitation",
] as const satisfies readonly (keyof CanvasProps)[];

/**
 * The Trellis hosts the canvas portals into: the open document's panel and the
 * PDF panel. App hands it the elements Trellis adopted; here they are plain
 * divs in the body, so `screen` sees both and `within` tells them apart.
 */
let documentHost: HTMLElement;
let pdfHost: HTMLElement;

/** The canvas request bundle with only `pending` set. */
function pending(requests: Partial<CanvasProps["requests"]> = {}): CanvasProps["requests"] {
  return { navigation: null, restore: null, rename: null, wrap: null, cite: null, figure: null, ...requests };
}

function baseProps(): CanvasProps {
  return {
    ...Object.fromEntries(HANDLERS.map((name) => [name, vi.fn()])) as Record<(typeof HANDLERS)[number], Mock>,
    projectRoot: "/tmp/project", locale: "en", theme: "light", mode: "source",
    source: "\\section{Intro}\n", activeFile: "main.tex",
    onSave: vi.fn(async () => true),
    onOpenSlideMutation: vi.fn(async () => []),
    onLoadReferenceImage: vi.fn(async () => null),
    onPrepareFigure: vi.fn(async () => null),
    onAddSpellingWord: vi.fn(() => true),
    canOpenCitation: () => false,
    pdfUrl: null, activePaper: null, activeAsset: null,
    citationKeys: [], citations: [], references: [], unusedLabels: [], unusedCitations: [],
    localMacros: [], katexMacros: {}, spellingWords: [], projectPaths: ["main.tex"], graphicsRoots: [],
    buildDiagnostics: [], texlabDiagnostics: [], outlineNodes: [], editorComments: [],
    overleafPresenceCursors: [], overleafChanges: [],
    requests: pending(), commentFocusRequest: null, fileDropTargetActive: false,
    activeOutlineId: null, activeEditorCommentId: null, pdfSyncTarget: null, projectWordCount: null,
    nativeFigureDropActive: false, outlineOpen: false, tableGeneratorOpen: false,
    canForwardSync: false, locatingPdf: false, interactivePreviewsEnabled: false,
    editorKeymap: "default", editorSpellcheck: false, editorEditable: true,
    overleafTrackChangeActions: { authorName: () => "Unknown", canAct: () => false, onAccept: vi.fn(), onReject: vi.fn() },
    commentAuthorName: "Ada", commentAuthorId: "ada", todoCount: 0, editorKey: "local",
    trellis: {
      editorHost: documentHost, pdfHost, editorHibernated: false,
      hibernatedPlaceholder: <div data-testid="hibernated-document" />,
    },
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
function sourceEditor() {
  return documentHost.querySelector("[data-editor-pane='primary'] .cm-editor");
}

/** The primary source editor's view, once it has mounted. */
async function primarySourceView() {
  await waitFor(() => expect(sourceEditor()).not.toBeNull());
  return EditorView.findFromDOM(sourceEditor() as HTMLElement)!;
}

/**
 * Select "bold" in "Hello bold world" and open the comment composer from the
 * selection toolbar. jsdom has no text layout, so the editor reports `bounds`
 * and the selection sits wherever `coords` says.
 */
async function composeCommentOnBold(bounds: DOMRect, coords: () => { left: number; right: number; top: number; bottom: number }) {
  const view = await primarySourceView();
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

beforeEach(() => {
  localStorage.clear();
  documentHost = document.body.appendChild(document.createElement("div"));
  pdfHost = document.body.appendChild(document.createElement("div"));
});

afterEach(() => {
  cleanup();
  documentHost.remove();
  pdfHost.remove();
});

describe("DocumentCanvas / mode", () => {
  // A Markdown document in Preview has no source editor, so a saved position
  // can arrive before there is anything to apply it to.
  it("discards a pending saved position when an explicit source jump arrives", async () => {
    const viewRestore = { path: "notes.md", cursor: 2, scrollTop: 450, id: "saved" };
    const { props, rerenderWith } = renderCanvas({
      mode: "pdf",
      activeFile: "notes.md",
      source: "first\nsecond\ntarget\nlast\n",
      requests: pending({ restore: viewRestore }),
    });
    rerenderWith({ mode: "split", requests: pending({ restore: viewRestore, navigation: { path: "notes.md", line: 3, id: "jump" } }) });
    await waitFor(() => expect(props.onRequestHandled).toHaveBeenCalledWith("jump"));
    const view = await primarySourceView();
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

  it("applies a saved position posted before the editor mounts once it mounts", async () => {
    const restore = { path: "notes.md", cursor: 8, scrollTop: 120, id: "saved" };
    const { props, rerenderWith } = renderCanvas({
      mode: "pdf", activeFile: "notes.md", source: "first\nsecond\ntarget\n", requests: pending({ restore }),
    });
    expect(sourceEditor()).toBeNull();
    rerenderWith({ mode: "source", requests: pending({ restore }) });
    const view = await primarySourceView();
    await waitFor(() => expect(props.onRequestHandled).toHaveBeenCalledWith("saved"));
    expect(view.state.selection.main.head).toBe(8);
    expect(view.scrollDOM.scrollTop).toBe(120);
  });

  it("lands a jump on its line: the caret there, the line centered and marked for a moment", async () => {
    const center = vi.spyOn(EditorView, "scrollIntoView");
    const { props, rerenderWith } = renderCanvas({ source: "first\nsecond\ntarget\nlast\n" });
    const view = await primarySourceView();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      rerenderWith({ requests: pending({ navigation: { path: "main.tex", line: 3, id: "jump" } }) });
      await vi.waitFor(() => expect(props.onRequestHandled).toHaveBeenCalledWith("jump"));
      expect(view.state.selection.main.head).toBe(13);
      expect(center).toHaveBeenCalledWith(13, { y: "center" });
      const marked = () => [...view.contentDOM.querySelectorAll(".cm-reveal-flash")].map((line) => line.textContent);
      expect(marked()).toEqual(["target"]);
      act(() => { vi.advanceTimersByTime(2000); });
      expect(marked()).toEqual([]);
    } finally {
      vi.useRealTimers();
      center.mockRestore();
    }
  });

  it.each([
    { kind: "comment", settled: "onCommentFocusHandled" },
    { kind: "navigation", settled: "onRequestHandled" },
  ] as const)("lands a $kind jump once its tab is shown, so it centers there and takes the writer's typing", async ({ kind, settled }) => {
    const source = "first\nsecond\nquoted passage\nlast\n";
    const comment = createEditorComment({ path: "main.tex", source, from: 13, to: 19, body: "Why?", authorId: "ada", authorName: "Ada" })!;
    const { props, rerenderWith } = renderCanvas({ source, editorComments: [comment] });
    const view = await primarySourceView();
    // Opened from the comments panel over the document, the canvas moves into
    // a Trellis tab that is still hidden and inert, and shows a frame or more later.
    documentHost.style.visibility = "hidden";
    documentHost.setAttribute("inert", "");
    const frames = (count: number) => act(async () => {
      for (let frame = 0; frame < count; frame += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    try {
      rerenderWith(kind === "comment"
        ? { commentFocusRequest: { id: comment.id, nonce: "jump" } }
        : { requests: pending({ navigation: { path: "main.tex", line: 3, id: "jump" } }) });
      await frames(3);
      expect(props[settled]).not.toHaveBeenCalled();
      expect(view.state.selection.main.head).toBe(0);
      documentHost.style.visibility = "";
      documentHost.removeAttribute("inert");
      await waitFor(() => expect(props[settled]).toHaveBeenCalledWith("jump"));
      expect(view.state.selection.main).toMatchObject(kind === "comment" ? { from: 13, to: 19 } : { from: 13, to: 13 });
      expect(view.hasFocus).toBe(true);
    } finally {
      documentHost.style.visibility = "";
      documentHost.removeAttribute("inert");
    }
  });

  it("hands a jump in Markdown's Preview to the visual editor, which settles it once it lands", async () => {
    const { props, rerenderWith } = renderCanvas({
      mode: "pdf", activeFile: "notes.md", source: "---\ntitle: x\n---\nfirst\ntarget\n",
    });
    const visual = await screen.findByTestId("visual-markdown-editor");
    rerenderWith({ requests: pending({ navigation: { path: "notes.md", line: 5, id: "jump" } }) });
    // Line 5 of the file is line 2 of the body the visual editor shows, after the front matter.
    await waitFor(() => expect(JSON.parse(visual.dataset.reveal!)).toEqual({ id: "jump", kind: "navigation", target: { line: 2 } }));
    expect(sourceEditor()).toBeNull();
    expect(props.onRequestHandled).not.toHaveBeenCalledWith("jump");
    fireEvent.click(within(visual).getByTestId("visual-markdown-editor-landed"));
    expect(props.onRequestHandled).toHaveBeenCalledWith("jump");
  });

  it("labels Preview's blocks with their source lines while a jump is landing there", async () => {
    const { rerenderWith } = renderCanvas({ mode: "pdf", activeFile: "notes.md", source: "first\n\ntarget\n" });
    const visual = await screen.findByTestId("visual-markdown-editor");
    expect(visual).toHaveAttribute("data-source-labels", "false");
    rerenderWith({ requests: pending({ navigation: { path: "notes.md", line: 3, id: "jump" } }) });
    await waitFor(() => expect(visual).toHaveAttribute("data-source-labels", "true"));
    rerenderWith({ requests: pending({ navigation: null }) });
    await waitFor(() => expect(visual).toHaveAttribute("data-source-labels", "false"));
  });

  it("focuses a comment in Markdown's Preview through the visual editor", async () => {
    const source = "Local passage. Remote passage.";
    const comment = createEditorComment({ path: "notes.md", source, from: 15, to: 21, body: "Remote", authorId: "ada", authorName: "Ada" })!;
    const { props, rerenderWith } = renderCanvas({ mode: "pdf", activeFile: "notes.md", source, editorComments: [comment] });
    const visual = await screen.findByTestId("visual-markdown-editor");
    rerenderWith({ commentFocusRequest: { id: comment.id, nonce: "focus" } });
    await waitFor(() => expect(JSON.parse(visual.dataset.reveal!)).toMatchObject({ id: "focus", target: { commentId: comment.id } }));
    fireEvent.click(within(visual).getByTestId("visual-markdown-editor-landed"));
    expect(props.onCommentFocusHandled).toHaveBeenCalledWith("focus");
    expect(props.onRequestHandled).not.toHaveBeenCalledWith("focus");
  });

  it.each([null, { path: "other.tex", line: 3, id: "other-jump" }])(
    "still restores a saved position without a competing jump in that file (%j)",
    async (navigation) => {
      const { props, rerenderWith } = renderCanvas({ source: "first\nsecond\ntarget\n" });
      const view = await primarySourceView();
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
    const { props } = renderCanvas({ source: "Hello bold world" });
    let textTop = initialTextTop;
    const { view, composer } = await composeCommentOnBold(
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

  it("keeps the selection toolbar off a panel that replaced the editor", async () => {
    renderCanvas({ source: "Hello bold world" });
    const view = await primarySourceView();
    const bounds = new DOMRect(0, 0, 600, 500);
    vi.spyOn(view.dom.closest(".source-editor")!, "getBoundingClientRect").mockReturnValue(bounds);
    vi.spyOn(view, "coordsAtPos").mockImplementation(() => ({ left: 100, right: 150, top: 100, bottom: 120 }));
    const toolbar = () => screen.queryByRole("toolbar", { name: "Format selected LaTeX" });
    const select = (anchor: number) => act(() => {
      view.focus();
      view.dispatch({ selection: { anchor, head: 10 } });
    });
    const outside = document.body.appendChild(document.createElement("button"));
    try {
      select(6);
      expect(toolbar()).not.toBeNull();
      // A click elsewhere (a tab, the titlebar's Comments) dismisses it, and
      // the editor's blur that follows must not bring it back.
      fireEvent.pointerDown(outside);
      act(() => outside.focus());
      // CodeMirror reports a focus change 10 ms after the blur.
      await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
      expect(toolbar()).toBeNull();

      // Focus moved by the keyboard (a shortcut opening a panel) hides it too.
      select(5);
      expect(toolbar()).not.toBeNull();
      act(() => outside.focus());
      await waitFor(() => expect(toolbar()).toBeNull());

      // An editor in a tab behind another one is laid out but hidden.
      documentHost.setAttribute("inert", "");
      select(6);
      expect(toolbar()).toBeNull();
    } finally {
      outside.remove();
      documentHost.removeAttribute("inert");
    }
  });

  it("highlights the source selection while composing and removes only the draft on cancel", async () => {
    const source = "Hello bold world";
    const existing = createEditorComment({ path: "main.tex", source, from: 6, to: 10, body: "Existing", authorId: "ada", authorName: "Ada" })!;
    const { props } = renderCanvas({ source, editorComments: [existing] });
    const { view, composer } = await composeCommentOnBold(
      new DOMRect(0, 0, 600, 500),
      () => ({ left: 100, right: 150, top: 100, bottom: 120 }),
    );
    expect(view.dom.querySelector(".editor-comment-draft")?.textContent).toBe("bold");
    expect(props.onCreateEditorComment).not.toHaveBeenCalled();
    fireEvent.click(within(composer).getByRole("button", { name: "Cancel" }));
    expect(view.dom.querySelector(".editor-comment-draft")).toBeNull();
    expect(view.dom.querySelector(".cm-editor-comment")?.textContent).toBe("bold");
  });

  it("maps Markdown preview comments around frontmatter and wires live threads and creation", async () => {
    const prefix = "---\ntitle: Notes\n---\n";
    const source = `${prefix}A local and remote passage.`;
    const local = createEditorComment({ path: "notes.md", source, from: prefix.length + 2, to: prefix.length + 7, body: "Local", authorId: "ada", authorName: "Ada" })!;
    const remote = { ...local, id: "overleaf:thread-2", from: prefix.length + 12, to: prefix.length + 18, quote: "remote" };
    const hidden = { ...local, id: "frontmatter", from: 4, to: prefix.length + 3 };
    const other = { ...local, id: "other", path: "main.tex" };
    const { props, rerenderWith } = renderCanvas({ mode: "pdf", activeFile: "notes.md", source, editorComments: [local, remote, hidden, other], activeEditorCommentId: remote.id });
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

  it("marks the open file's local and Overleaf comments in its source editor, focuses one on request, and refreshes them", async () => {
    const source = "Local passage. Remote passage.";
    const local = createEditorComment({ path: "main.tex", source, from: 0, to: 5, body: "Local", authorId: "ada", authorName: "Ada" })!;
    const remote = { ...createEditorComment({ path: "main.tex", source, from: 15, to: 21, body: "Remote", authorId: "overleaf-user", authorName: "Grace" })!, id: "overleaf:thread-1" };
    const unrelated = { ...local, id: "other-file", path: "other.tex" };
    const { props, rerenderWith } = renderCanvas({ source, editorComments: [local, remote, unrelated] });
    const marks = () => [...sourceEditor()?.querySelectorAll(".cm-editor-comment") ?? []].map((mark) => mark.getAttribute("data-comment-id"));
    await waitFor(() => expect(marks()).toEqual([local.id, remote.id]));
    rerenderWith({ commentFocusRequest: { id: remote.id, nonce: "focus-remote" } });
    await waitFor(() => expect(props.onCommentFocusHandled).toHaveBeenCalledWith("focus-remote"));
    expect(EditorView.findFromDOM(sourceEditor() as HTMLElement)?.state.selection.main).toMatchObject({ from: 15, to: 21 });
    rerenderWith({ editorComments: [{ ...local, resolved: true }, remote, unrelated] });
    await waitFor(() => expect(marks()).toEqual([remote.id]));
    rerenderWith({ editorComments: [] });
    await waitFor(() => expect(marks()).toEqual([]));
  });

  it.each([
    // LaTeX and other source files never split in their panel: the PDF is a
    // panel of its own, whatever the view.
    { mode: "source", activeFile: "main.tex", editors: 1, separators: [] },
    { mode: "split", activeFile: "main.tex", editors: 1, separators: [] },
    // Readable documents give their panel to one surface, or split it with a
    // separator that names whatever the open document actually previews.
    { mode: "source", activeFile: "notes.md", editors: 1, separators: [] },
    { mode: "pdf", activeFile: "notes.md", editors: 0, separators: [] },
    { mode: "split", activeFile: "notes.md", editors: 1, separators: ["Resize editor and Markdown preview"] },
    { mode: "split", activeFile: "page.html", editors: 1, separators: ["Resize editor and HTML preview"] },
  ] as const)("lays out $activeFile in $mode mode with $editors editors, separators: $separators", async ({ mode, activeFile, editors, separators }) => {
    renderCanvas({ mode, activeFile, pdfUrl: "blob:project.pdf" });

    await waitFor(() => expect(documentHost.querySelectorAll(".cm-editor")).toHaveLength(editors));
    // The project PDF always goes to the PDF panel, never into the document's.
    expect(await within(pdfHost).findByTestId("pdf-preview")).toHaveAttribute("data-url", "blob:project.pdf");
    expect(within(documentHost).queryByTestId("pdf-preview")).toBeNull();
    expect(screen.queryAllByRole("separator").map((separator) => separator.getAttribute("aria-label"))).toEqual(separators);
    expect(Boolean(documentHost.querySelector(".split-canvas"))).toBe(separators.length > 0);
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

  // Mode and asset arrive from different pieces of App state, so the two can be
  // out of step for a render; without an asset the canvas must fall back to the
  // editor rather than preview nothing and lose the open file.
  it.each([imageAsset, null])("shows only the asset in asset mode, if there is one (%j)", async (activeAsset) => {
    renderCanvas({ mode: "asset", activeAsset });

    await waitFor(() => expect(Boolean(sourceEditor())).toBe(!activeAsset));
    expect(Boolean(documentHost.querySelector(".asset-preview"))).toBe(Boolean(activeAsset));
    if (!activeAsset) return;
    expect(within(documentHost).getByText("figures/plot.png")).toBeInTheDocument();
    expect(within(documentHost).queryByTestId("pdf-preview")).toBeNull();
  });
});

describe("DocumentCanvas / editor for the open document", () => {
  const surfaces = ["board-editor", "spreadsheet-editor", "visual-markdown-editor", "open-slide-workspace"];

  it.each([
    // Whole-file editors are handed their document and own the panel.
    { mode: "source", activeFile: "diagram.tldr", testId: "board-editor", beside: false, data: { path: "diagram.tldr", source: "{}" } },
    { mode: "source", activeFile: "data.lattice-sheet", testId: "spreadsheet-editor", beside: false, data: { path: "data.lattice-sheet", source: "{}" } },
    { mode: "source", activeFile: "slides/research-update/index.tsx", testId: "open-slide-workspace", beside: false, data: { path: "slides/research-update/index.tsx", source: "{}" } },
    { mode: "split", activeFile: "notes.md", testId: "visual-markdown-editor", beside: true, data: {} },
  ] as const)("mounts only the $testId for $activeFile in $mode mode, source editor beside: $beside", async ({ mode, activeFile, testId, beside, data }) => {
    renderCanvas({ mode, activeFile, source: "{}" });

    expect({ ...(await within(documentHost).findByTestId(testId)).dataset }).toMatchObject(data);
    await waitFor(() => expect(Boolean(sourceEditor())).toBe(beside));
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

  it("hands a native Open Slide deck its complete workspace in the document panel", async () => {
    const path = "slides/research-update/index.tsx";
    const { props } = renderCanvas({
      mode: "source", activeFile: path, source: "export default [];\n", editorEditable: false, locale: "zh-CN", theme: "dark",
    });

    const presentation = await within(documentHost).findByTestId("open-slide-workspace");
    expect({ ...presentation.dataset }).toMatchObject({
      active: "true", editable: "false", projectRoot: "/tmp/project", path, locale: "zh-CN", theme: "dark",
    });
    fireEvent.click(screen.getByTestId("open-slide-mutation"));
    expect(props.onOpenSlideMutation).toHaveBeenCalledWith(expect.objectContaining({ path, kind: "write" }));
  });

  it("shows the panel's placeholder instead of a hibernated board, and mounts the board again on wake", async () => {
    const trellis = { ...baseProps().trellis, editorHibernated: true };
    const { rerenderWith } = renderCanvas({ activeFile: "diagram.tldr", source: "{}", trellis });

    expect(within(documentHost).getByTestId("hibernated-document")).toBeInTheDocument();
    expect(screen.queryByTestId("board-editor")).toBeNull();
    rerenderWith({ trellis: { ...trellis, editorHibernated: false } });
    expect(await within(documentHost).findByTestId("board-editor")).toBeInTheDocument();
    expect(screen.queryByTestId("hibernated-document")).toBeNull();
  });
});

describe("DocumentCanvas / split ratio", () => {
  const separator = () => screen.getByRole("separator", { name: "Resize editor and Markdown preview" });
  /** A Markdown document in Split, the one kind of document whose panel splits against a preview. */
  const markdownSplit = { mode: "split", activeFile: "notes.md", source: "Notes" } as const;

  /** Render the Markdown split measuring `bounds`; `offset` reads the grip's boundary resistance. */
  function renderGrip(bounds: Partial<DOMRect>) {
    renderCanvas(markdownSplit);
    const split = documentHost.querySelector<HTMLElement>(".split-canvas")!;
    vi.spyOn(split, "getBoundingClientRect").mockReturnValue(bounds as DOMRect);
    const property = "--split-resizer-offset";
    const offset = () => Number.parseFloat(split.style.getPropertyValue(property));
    return { split, property, offset, grip: separator() };
  }

  it("adds boundary-only resistance to the split without saving the offset", () => {
    const inside = 700;
    const { property, offset, grip } = renderGrip({ left: 100, right: 1700, width: 1600 });
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
    // The preview keeps its minimum width: 1599 px of tracks less 280.
    expect(Number(localStorage.getItem(SPLIT_RATIO_KEY))).toBeCloseTo(1319 / 1599);
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
    renderCanvas(markdownSplit);

    expect(separator()).toHaveAttribute("aria-valuenow", shown);
  });

  it("does not replace the saved split preference when a restored panel is temporarily narrow", () => {
    localStorage.setItem(SPLIT_RATIO_KEY, "0.6");
    const { rerenderWith } = renderCanvas({ ...markdownSplit, mode: "source" });
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ left: 0, width: 500, right: 500 } as DOMRect);
    try {
      rerenderWith({ mode: "split" });
      expect(Number(separator().getAttribute("aria-valuenow"))).toBeLessThan(60);
      expect(localStorage.getItem(SPLIT_RATIO_KEY)).toBe("0.6");
      rerenderWith({ mode: "source" });
      bounds.mockReturnValue({ left: 0, width: 1400, right: 1400 } as DOMRect);
      rerenderWith({ mode: "split" });
      expect(documentHost.querySelector(".split-canvas")).not.toBeNull();
      expect(separator()).toHaveAttribute("aria-valuenow", "60");
    } finally {
      bounds.mockRestore();
    }
  });

  /**
   * Resolve the split's grid columns at `width` px. jsdom neither lays out
   * grids nor keeps a `clamp()` inline style, so evaluate the template's CSS
   * math the way a browser sizes the source track and the preview's
   * `minmax(…, 1fr)`.
   */
  function splitColumns(ratio: number, width: number) {
    const template = splitGridTemplate({ source: 240, preview: 280 });
    const [, sourceTrack, previewMinimum] = /^(.+) 1px minmax\((.+), 1fr\)$/.exec(template) ?? [];
    expect(sourceTrack, template).toBeDefined();
    const resolve = (expression: string) => new Function("min", "clamp", `return ${expression
      .replace(/var\(--split-ratio\)/g, String(ratio))
      .replace(/calc\(/g, "(")
      .replace(/(\d+(?:\.\d+)?)%/g, (_, percent: string) => String((Number(percent) / 100) * width))
      .replace(/(\d)px/g, "$1")};`)(Math.min, (low: number, value: number, high: number) => Math.max(low, Math.min(value, high))) as number;
    const source = resolve(sourceTrack);
    return { source, preview: Math.max(resolve(previewMinimum), width - 1 - source) };
  }

  it("keeps both panes inside a document panel narrower than their minimums", () => {
    // Writing layout at a 1512 px window: Project, the document and the PDF
    // side by side leave the document panel 480 px, under 240 + 1 + 280.
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ left: 0, width: 480, right: 480 } as DOMRect);
    try {
      renderCanvas(markdownSplit);
      const split = documentHost.querySelector<HTMLElement>(".split-canvas")!;
      // The panel is too narrow for any ratio but the minimums' own.
      expect(separator()).toHaveAttribute("aria-valuenow", "46");
      for (const ratio of [0.2, 240 / 520, 0.8]) {
        const narrow = splitColumns(ratio, 480);
        expect(narrow.source + 1 + narrow.preview).toBeCloseTo(480);
        expect(narrow.source / narrow.preview).toBeCloseTo(240 / 280);
      }

      // Dragging cannot push either pane back past the panel's edge.
      fireEvent.pointerDown(separator(), { clientX: 220 });
      fireEvent.pointerMove(window, { clientX: 400 });
      const dragged = splitColumns(Number(split.style.getPropertyValue("--split-ratio")), 480);
      expect(dragged.source + 1 + dragged.preview).toBeCloseTo(480);
      fireEvent.pointerUp(window);

      // A panel wide enough for both minimums keeps them whole.
      const wide = splitColumns(0.5, 1201);
      expect(wide).toEqual({ source: 600, preview: 600 });
      expect(splitColumns(0.2, 521)).toEqual({ source: 240, preview: 280 });
    } finally {
      bounds.mockRestore();
    }
  });

  it("keeps a released drag responsive when the document panel narrows again", () => {
    // A drag used to leave its pixel columns on the split. When the fitted
    // ratio did not change, React never rewrote them, so shrinking the panel
    // from 400 to 360 px pushed the preview 40 px under the PDF panel.
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ left: 0, width: 400, right: 400 } as DOMRect);
    try {
      renderCanvas(markdownSplit);
      const split = documentHost.querySelector<HTMLElement>(".split-canvas")!;
      fireEvent.pointerDown(separator(), { clientX: 184 });
      fireEvent.pointerMove(window, { clientX: 314 });
      fireEvent.pointerUp(window);
      expect(split.style.gridTemplateColumns).not.toMatch(/^[\d.]+px /);
      expect(separator()).toHaveAttribute("aria-valuenow", "46");
      expect(Number(split.style.getPropertyValue("--split-ratio"))).toBeCloseTo(240 / 520);

      bounds.mockReturnValue({ left: 0, width: 360, right: 360 } as DOMRect);
      const narrow = splitColumns(Number(split.style.getPropertyValue("--split-ratio")), 360);
      expect(narrow.source + 1 + narrow.preview - 360).toBeLessThanOrEqual(0.5);
    } finally {
      bounds.mockRestore();
    }
  });

  it("respects pixel minimums before ratio limits", () => {
    // 200 of 800 px is inside the 20% ratio limit, but under the source minimum.
    const { split, property, offset, grip } = renderGrip({ left: 0, right: 800, width: 800 });
    fireEvent.pointerDown(grip, { clientX: 400 });
    fireEvent.pointerMove(window, { clientX: 200 });
    expect(offset()).toBeLessThan(0);
    fireEvent.blur(window);
    expect(split.style.getPropertyValue(property)).toBe("0px");
    expect(document.body).not.toHaveClass("resizing-split");
  });

  it("nudges the split with the arrow keys only, remembers where it stopped, and stops at the edge instead of hiding a pane", () => {
    renderCanvas(markdownSplit);

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

  it("returns a presentation to the page it was showing", async () => {
    const path = "slides/research-update/index.tsx";
    const states: Record<string, FileViewState> = {};
    const onFileViewState = vi.fn((statePath: string, update: Partial<FileViewState>) => {
      states[statePath] = { ...states[statePath], ...update };
    });
    const getFileViewState = (statePath: string) => states[statePath];
    const deck = { activeFile: path, source: "export default [];\n" };
    const { rerenderWith } = renderCanvas({ mode: "source", ...deck, getFileViewState, onFileViewState });
    fireEvent.click(await screen.findByTestId("open-slide-view-state"));

    rerenderWith({ activeFile: "intro.tex", source: "\\section{Intro}\n" });
    await waitFor(() => expect(screen.queryByTestId("open-slide-workspace")).toBeNull());
    rerenderWith(deck);

    expect((await screen.findByTestId("open-slide-workspace")).dataset.restoredPage).toBe("3");
    expect(onFileViewState).toHaveBeenCalledWith(path, { openSlide: { page: 3 } });
  });

  it("keeps the board on the app theme, including a live switch", async () => {
    const { rerenderWith } = renderCanvas({ mode: "source", activeFile: "diagram.tldr", source: "{}", theme: "dark" });

    expect((await screen.findByTestId("board-editor")).dataset.theme).toBe("dark");
    rerenderWith({ activeFile: "diagram.tldr", source: "{}", theme: "light" });
    expect(screen.getByTestId("board-editor").dataset.theme).toBe("light");
  });

  it("keeps the compiled PDF mounted when source navigation changes TeX files", async () => {
    const state = viewStates({
      "main.tex": { pdf: pdfViewState(3) },
      "chapters/results.tex": { pdf: pdfViewState(1) },
    });
    const { rerenderWith } = renderCanvas({ mode: "split", activeFile: "main.tex", ...state });
    const preview = await within(pdfHost).findByTestId("pdf-preview");
    preview.scrollTop = 2450;

    // SyncTeX can resolve into a different included file. The PDF is still
    // the same build, even when that file has a different saved PDF position.
    for (const activeFile of ["chapters/results.tex", "refs.bib", "main.tex"]) {
      rerenderWith({ activeFile, source: "\\section{Results}\n" });
      expect(await within(pdfHost).findByTestId("pdf-preview")).toBe(preview);
      expect(preview.scrollTop).toBe(2450);
    }

    // A different project must not inherit this viewer instance.
    rerenderWith({ projectRoot: "/tmp/other-project" });
    expect(await within(pdfHost).findByTestId("pdf-preview")).not.toBe(preview);
  });

  it("restores each document's own place, files updates back under it, and keeps it for files without a preview", async () => {
    const state = viewStates({ "main.tex": { pdf: pdfViewState(3) }, "refs.bib": { pdf: pdfViewState(9) } });
    const { rerenderWith } = renderCanvas({ mode: "pdf", activeFile: "main.tex", ...state });
    expect((await screen.findByTestId("pdf-preview")).dataset.restoredPage).toBe("3");
    fireEvent.click(screen.getByTestId("pdf-view-state"));
    expect(state.updates).toEqual([{ path: "main.tex", update: { pdf: pdfViewState(7) } }]);

    // Opening a .bib from a citation, or a .sty from a macro, must not throw
    // away the reader's page in the compiled PDF: those files have no preview
    // of their own, so the PDF panel keeps the document it was showing.
    rerenderWith({ activeFile: "refs.bib", source: "@article{a}\n" });
    await waitFor(() => expect(screen.getByTestId("pdf-preview").dataset.restoredPage).toBe("3"));
    fireEvent.click(screen.getByTestId("pdf-view-state"));
    expect(state.updates.at(-1)).toEqual({ path: "main.tex", update: { pdf: pdfViewState(7) } });
    expect(state.updates.every((update) => update.path === "main.tex")).toBe(true);
  });
});
