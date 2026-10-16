import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { AssetPreview, FileViewState } from "../app-types";
import { AnnotationRounds } from "../app/annotation-rounds";
import { DocumentCanvas } from "./document-canvas";
import { splitGridTemplate } from "./use-split-layout";
import { createEditorComment } from "../editor/comments/editor-comment-data";
import { retainParkedEditors } from "../editor/parked-editors";
import { startCompletion } from "@codemirror/autocomplete";
import { undo } from "@codemirror/commands";
import { language } from "@codemirror/language";
import { StateEffect } from "@codemirror/state";
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
/** Whether the stubbed visual editors hold an edit an IME is still composing. */
const visualIme = vi.hoisted(() => ({ composing: false }));

vi.mock("./canvas-lazy-modules", async () => {
  const { chunk } = await import("../lib/lazy-chunk");
  const { useEffect } = await import("react");
  const PdfPreview = (props: ComponentProps<typeof RealPdfPreview>) => (
    <div
      data-testid="pdf-preview"
      data-url={props.url ?? ""}
      data-file-name={props.fileName ?? ""}
      data-restored-page={String(props.initialViewState?.page ?? "")}
    >
      <button data-testid="pdf-view-state" onClick={() => props.onViewState?.({ page: 7, scale: 1, fitMode: null, scrollTop: 0, scrollLeft: 0 })} />
      <button data-testid="pdf-read" onClick={() => { props.onNumPages?.(22); props.onPageChange?.(7); }} />
      <button data-testid="pdf-select" onClick={() => props.onTextSelect?.("Selected passage")} />
    </div>
  );
  const editorStub = (testId: string) => (props: {
    path?: string; source?: string; initialViewState?: { camera?: { x: number; y: number; z: number } };
    editorComments?: Array<{ id: string; from: number; to: number }>; activeEditorCommentId?: string | null;
    onEligibilityChange?: (reason: string | null) => void; onEditorCommentClick?: (id: string) => void;
    onCreateComment?: (from: number, to: number, body: string) => void; theme?: string;
    revealRequest?: { id: string; target: unknown } | null; onRevealHandled?: (id: string) => void;
    synchronizeSourceScroll?: boolean; onFlushPendingChange?: (flush: (() => boolean) | null) => void;
  }) => {
    // A visual editor's flush declines while an IME composes the edit it holds.
    const { onFlushPendingChange } = props;
    useEffect(() => {
      if (!onFlushPendingChange) return;
      onFlushPendingChange(() => !visualIme.composing);
      return () => onFlushPendingChange(null);
    }, [onFlushPendingChange]);
    return (
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
  };
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
    loadPdfPreviewModule: chunk(async () => ({ PdfPreview })),
    loadVisualMarkdownEditorModule: chunk(async () => ({ LatticeVisualMarkdownEditor: editorStub("visual-markdown-editor") })),
    loadBoardEditorModule: chunk(async () => ({ BoardEditor: editorStub("board-editor") })),
    loadSpreadsheetEditorModule: chunk(async () => ({ SpreadsheetEditor: editorStub("spreadsheet-editor") })),
    loadOpenSlideWorkspaceModule: chunk(async () => ({ OpenSlideWorkspace })),
    loadBibVisualEditorModule: chunk(async () => ({ BibVisualEditor: editorStub("bib-visual-editor") })),
    // Every .bib reads as a reference list here; the parser has its own tests.
    loadBibDocumentModule: async () => ({ readBibDocument: () => ({ document: { entries: [], macros: new Map() }, error: null }), bibUnreadableReason: () => "" }),
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
/** Fields to replace in each domain model; the rest keep `baseProps`. */
type CanvasOverrides = { [Model in keyof CanvasProps]?: Partial<CanvasProps[Model]> };

/**
 * The Trellis host the canvas portals into: the open document's panel. App
 * hands it the element Trellis adopted; here it is a plain div in the body.
 * (The compiled PDF is ProjectPdfPanel's, in a panel of its own.)
 */
let documentHost: HTMLElement;

/**
 * Each open deck's own host (TrellisController.decks): a plain div per path,
 * and the decks the workspace has put to sleep.
 */
const deckHosts = new Map<string, HTMLElement>();
let sleepingDecks: readonly string[] = [];
const sleepListeners = new Set<() => void>();
const decks = {
  host: (path: string) => {
    let host = deckHosts.get(path);
    if (!host) {
      host = document.body.appendChild(document.createElement("div"));
      deckHosts.set(path, host);
    }
    return host;
  },
  subscribe: (listener: () => void) => {
    sleepListeners.add(listener);
    return () => { sleepListeners.delete(listener); };
  },
  sleeping: () => sleepingDecks,
};
function setSleepingDecks(paths: readonly string[]) {
  sleepingDecks = paths;
  act(() => sleepListeners.forEach((listener) => listener()));
}

/** The canvas request bundle with only `pending` set. */
function pending(requests: Partial<CanvasProps["navigation"]["requests"]> = {}): CanvasProps["navigation"]["requests"] {
  return { navigation: null, restore: null, rename: null, wrap: null, cite: null, figure: null, proofread: null, replace: null, ...requests };
}

/** Every callback is a spy; the ones that must answer something answer it. */
function baseProps(): CanvasProps {
  return {
    document: {
      mode: "source", source: "\\section{Intro}\n", activeFile: "main.tex",
      setSource: vi.fn(), onSave: vi.fn(async () => true), onEditorLeave: vi.fn(), onCompletionActiveChange: vi.fn(),
      editorKey: "local", editorEditable: true, activeAsset: null, activePaper: null,
      onOpenMarkdownPath: vi.fn(), onViewMarkdownSource: vi.fn(), openPaths: [],
    },
    preferences: {
      projectRoot: "/tmp/project", locale: "en", theme: "light", editorKeymap: "default", editorSpellcheck: false,
      spellingWords: [], onAddSpellingWord: vi.fn(() => true), englishVariant: null, termRules: [], interactivePreviewsEnabled: false,
    },
    bibliography: {
      citationKeys: [], citations: [], references: [], unusedLabels: [], unusedCitations: [],
      onLoadReferenceImage: vi.fn(async () => null), localMacros: [], katexMacros: {}, projectPaths: ["main.tex"], graphicsRoots: [],
    },
    navigation: {
      requests: pending(), onRequestHandled: vi.fn(), onEditorPosition: vi.fn(), onViewState: vi.fn(),
      onGotoDefinition: vi.fn(), onTexlabGoto: vi.fn(), onFindReferences: vi.fn(), onRenameSymbol: vi.fn(),
      onRenameEnvironment: vi.fn(), onWrapEnvironment: vi.fn(), onGotoLineRequest: vi.fn(),
      outlineNodes: [], onOutlineNavigate: vi.fn(),
      tableGeneratorOpen: false, onTableGeneratorOpenChange: vi.fn(), onCreateMissingFile: vi.fn(),
    },
    pdf: { pdfUrl: null },
    review: {
      editorComments: [], overleafPresenceCursors: [], overleafChanges: [],
      overleafTrackChangeActions: { authorName: () => "Unknown", canAct: () => false, onAccept: vi.fn(), onReject: vi.fn() },
      activeEditorCommentId: null, commentAuthorName: "Ada", commentAuthorId: "ada", onCreateEditorComment: vi.fn(),
      annotationRounds: new AnnotationRounds(), onOpenEditorComments: vi.fn(), onResolveEditorComment: vi.fn(),
      onReplyEditorComment: vi.fn(), onPostEditorCommentReply: vi.fn(), commentFocusRequest: null, onCommentFocusHandled: vi.fn(),
    },
    selection: { setSelection: vi.fn(), onPdfTextSelect: vi.fn(), onPaperTextSelect: vi.fn(), onContextSurfaceActivate: vi.fn() },
    assets: {
      onOpenSlideMutation: vi.fn(async () => []), onPrepareFigure: vi.fn(async () => null), onPasteImageFile: vi.fn(),
      nativeFigureDropActive: false, fileDropTargetActive: false,
    },
    status: { todoCount: 0, onOpenTodos: vi.fn(), projectWordCount: null, buildDiagnostics: [], texlabDiagnostics: [] },
    hosts: {
      editorHost: documentHost, editorHibernated: false,
      hibernatedPlaceholder: <div data-testid="hibernated-document" />,
      decks,
      switchState: { subscribe: () => () => {}, switching: () => false },
    },
  };
}

/** `props` with each model's `overrides` laid over it. */
function withOverrides(props: CanvasProps, overrides: CanvasOverrides = {}): CanvasProps {
  return {
    document: { ...props.document, ...overrides.document },
    preferences: { ...props.preferences, ...overrides.preferences },
    bibliography: { ...props.bibliography, ...overrides.bibliography },
    navigation: { ...props.navigation, ...overrides.navigation },
    pdf: { ...props.pdf, ...overrides.pdf },
    review: { ...props.review, ...overrides.review },
    selection: { ...props.selection, ...overrides.selection },
    assets: { ...props.assets, ...overrides.assets },
    status: { ...props.status, ...overrides.status },
    hosts: { ...props.hosts, ...overrides.hosts },
  };
}

function renderCanvas(overrides?: CanvasOverrides) {
  const props = withOverrides(baseProps(), overrides);
  const view = render(<DocumentCanvas {...props} />);
  return {
    ...view,
    props,
    rerenderWith: (next: CanvasOverrides) => view.rerender(<DocumentCanvas {...withOverrides(props, next)} />),
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
  fireEvent.click(await screen.findByRole("button", { name: "Annotate" }));
  return { view, composer: await screen.findByRole("dialog", { name: "Annotate" }) };
}

beforeEach(() => {
  localStorage.clear();
  documentHost = document.body.appendChild(document.createElement("div"));
});

afterEach(() => {
  cleanup();
  documentHost.remove();
  for (const host of deckHosts.values()) host.remove();
  deckHosts.clear();
  sleepingDecks = [];
});

describe("DocumentCanvas / mode", () => {
  // A Markdown document in Preview has no source editor, so a saved position
  // can arrive before there is anything to apply it to.
  it("discards a pending saved position when an explicit source jump arrives", async () => {
    const viewRestore = { path: "notes.md", cursor: 2, scrollTop: 450, id: "saved" };
    const { props, rerenderWith } = renderCanvas({
      document: { mode: "pdf", activeFile: "notes.md", source: "first\nsecond\ntarget\nlast\n" },
      navigation: { requests: pending({ restore: viewRestore }) },
    });
    rerenderWith({ document: { mode: "split" }, navigation: { requests: pending({ restore: viewRestore, navigation: { path: "notes.md", line: 3, id: "jump" } }) } });
    await waitFor(() => expect(props.navigation.onRequestHandled).toHaveBeenCalledWith("jump"));
    const view = await primarySourceView();
    expect(view.state.selection.main.head).toBe(13);
    // App settles requests and may supply a new settle callback on its next
    // render. An unconsumed restore must not move the cursor then.
    const restoreSettled = vi.mocked(props.navigation.onRequestHandled).mock.calls.some(([id]) => id === "saved");
    rerenderWith({ document: { mode: "split" }, navigation: { requests: pending({ restore: restoreSettled ? null : viewRestore }), onRequestHandled: vi.fn() } });
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(view.state.selection.main.head).toBe(13);
    expect(view.scrollDOM.scrollTop).not.toBe(450);
    expect(props.navigation.onRequestHandled).toHaveBeenCalledWith("saved");
  });

  it("applies a saved position posted before the editor mounts once it mounts", async () => {
    const dispatch = vi.spyOn(EditorView.prototype, "dispatch");
    const restore = { path: "notes.md", cursor: 8, scrollTop: 120, id: "saved" };
    const { props, rerenderWith } = renderCanvas({
      document: { mode: "pdf", activeFile: "notes.md", source: "first\nsecond\ntarget\n" },
      navigation: { requests: pending({ restore }) },
    });
    expect(sourceEditor()).toBeNull();
    rerenderWith({ document: { mode: "source" }, navigation: { requests: pending({ restore }) } });
    const view = await primarySourceView();
    await waitFor(() => expect(props.navigation.onRequestHandled).toHaveBeenCalledWith("saved"));
    expect(view.state.selection.main.head).toBe(8);
    expect(view.scrollDOM.scrollTop).toBe(120);
    // The saved offset is the place: the caret is put back, not scrolled to,
    // or CodeMirror's next measure takes the view to wherever the caret was
    // left, however far the writer scrolled from it.
    expect(dispatch.mock.calls.some(([spec]) => (spec as { scrollIntoView?: boolean }).scrollIntoView)).toBe(false);
    dispatch.mockRestore();
  });

  it("lands a jump on its line: the caret there, the line centered and marked for a moment", async () => {
    const center = vi.spyOn(EditorView, "scrollIntoView");
    const { props, rerenderWith } = renderCanvas({ document: { source: "first\nsecond\ntarget\nlast\n" } });
    const view = await primarySourceView();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      rerenderWith({ navigation: { requests: pending({ navigation: { path: "main.tex", line: 3, id: "jump" } }) } });
      await vi.waitFor(() => expect(props.navigation.onRequestHandled).toHaveBeenCalledWith("jump"));
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

  it("applies a failed build's suggested fix on its line as an undoable edit", async () => {
    const { props, rerenderWith } = renderCanvas({ document: { source: "first\n\\cite{a} \\cietp{b}\nlast\n" } });
    const view = await primarySourceView();
    rerenderWith({ navigation: { requests: pending({ replace: { path: "main.tex", line: 2, token: "\\cietp", replacement: "\\citep", id: "fix" } }) } });
    await vi.waitFor(() => expect(props.navigation.onRequestHandled).toHaveBeenCalledWith("fix"));
    expect(view.state.doc.toString()).toBe("first\n\\cite{a} \\citep{b}\nlast\n");
    expect(view.state.selection.main.head).toBe("first\n\\cite{a} \\citep".length);
  });

  it.each([
    { kind: "comment", settled: (props: CanvasProps) => props.review.onCommentFocusHandled },
    { kind: "navigation", settled: (props: CanvasProps) => props.navigation.onRequestHandled },
  ] as const)("lands a $kind jump once its tab is shown, so it centers there and takes the writer's typing", async ({ kind, settled }) => {
    const source = "first\nsecond\nquoted passage\nlast\n";
    const comment = createEditorComment({ path: "main.tex", source, from: 13, to: 19, body: "Why?", authorId: "ada", authorName: "Ada" })!;
    const { props, rerenderWith } = renderCanvas({ document: { source }, review: { editorComments: [comment] } });
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
        ? { review: { commentFocusRequest: { id: comment.id, nonce: "jump" } } }
        : { navigation: { requests: pending({ navigation: { path: "main.tex", line: 3, id: "jump" } }) } });
      await frames(3);
      expect(settled(props)).not.toHaveBeenCalled();
      expect(view.state.selection.main.head).toBe(0);
      documentHost.style.visibility = "";
      documentHost.removeAttribute("inert");
      await waitFor(() => expect(settled(props)).toHaveBeenCalledWith("jump"));
      expect(view.state.selection.main).toMatchObject(kind === "comment" ? { from: 13, to: 19 } : { from: 13, to: 13 });
      expect(view.hasFocus).toBe(true);
    } finally {
      documentHost.style.visibility = "";
      documentHost.removeAttribute("inert");
    }
  });

  it("hands a jump in Markdown's Preview to the visual editor, which settles it once it lands", async () => {
    const { props, rerenderWith } = renderCanvas({
      document: { mode: "pdf", activeFile: "notes.md", source: "---\ntitle: x\n---\nfirst\ntarget\n" },
    });
    const visual = await screen.findByTestId("visual-markdown-editor");
    rerenderWith({ navigation: { requests: pending({ navigation: { path: "notes.md", line: 5, id: "jump" } }) } });
    // Line 5 of the file is line 2 of the body the visual editor shows, after the front matter.
    await waitFor(() => expect(JSON.parse(visual.dataset.reveal!)).toEqual({ id: "jump", kind: "navigation", target: { line: 2 } }));
    expect(sourceEditor()).toBeNull();
    expect(props.navigation.onRequestHandled).not.toHaveBeenCalledWith("jump");
    fireEvent.click(within(visual).getByTestId("visual-markdown-editor-landed"));
    expect(props.navigation.onRequestHandled).toHaveBeenCalledWith("jump");
  });

  it("labels Preview's blocks with their source lines while a jump is landing there", async () => {
    const { rerenderWith } = renderCanvas({ document: { mode: "pdf", activeFile: "notes.md", source: "first\n\ntarget\n" } });
    const visual = await screen.findByTestId("visual-markdown-editor");
    expect(visual).toHaveAttribute("data-source-labels", "false");
    rerenderWith({ navigation: { requests: pending({ navigation: { path: "notes.md", line: 3, id: "jump" } }) } });
    await waitFor(() => expect(visual).toHaveAttribute("data-source-labels", "true"));
    rerenderWith({ navigation: { requests: pending({ navigation: null }) } });
    await waitFor(() => expect(visual).toHaveAttribute("data-source-labels", "false"));
  });

  it("focuses a comment in Markdown's Preview through the visual editor", async () => {
    const source = "Local passage. Remote passage.";
    const comment = createEditorComment({ path: "notes.md", source, from: 15, to: 21, body: "Remote", authorId: "ada", authorName: "Ada" })!;
    const { props, rerenderWith } = renderCanvas({ document: { mode: "pdf", activeFile: "notes.md", source }, review: { editorComments: [comment] } });
    const visual = await screen.findByTestId("visual-markdown-editor");
    rerenderWith({ review: { commentFocusRequest: { id: comment.id, nonce: "focus" } } });
    await waitFor(() => expect(JSON.parse(visual.dataset.reveal!)).toMatchObject({ id: "focus", target: { commentId: comment.id } }));
    fireEvent.click(within(visual).getByTestId("visual-markdown-editor-landed"));
    expect(props.review.onCommentFocusHandled).toHaveBeenCalledWith("focus");
    expect(props.navigation.onRequestHandled).not.toHaveBeenCalledWith("focus");
  });

  it.each([null, { path: "other.tex", line: 3, id: "other-jump" }])(
    "still restores a saved position without a competing jump in that file (%j)",
    async (navigation) => {
      const { props, rerenderWith } = renderCanvas({ document: { source: "first\nsecond\ntarget\n" } });
      const view = await primarySourceView();
      rerenderWith({ navigation: { requests: pending({ navigation, restore: { path: "main.tex", cursor: 8, scrollTop: 120, id: "saved" } }) } });
      await waitFor(() => expect(props.navigation.onRequestHandled).toHaveBeenCalledWith("saved"));
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
    const { props } = renderCanvas({ document: { source: "Hello bold world" } });
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
    fireEvent.click(within(composer).getByRole("button", { name: /^Save(?! and)/ }));
    expect(props.review.onCreateEditorComment).toHaveBeenCalledWith(expect.objectContaining({ quote: "bold", body: "Keep this draft", from: 6, to: 10 }));
  });

  it("keeps the selection toolbar off a panel that replaced the editor", async () => {
    renderCanvas({ document: { source: "Hello bold world" } });
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

  it("highlights the source selection while composing and removes only the draft when a click lands outside", async () => {
    const source = "Hello bold world";
    const existing = createEditorComment({ path: "main.tex", source, from: 6, to: 10, body: "Existing", authorId: "ada", authorName: "Ada" })!;
    const { props } = renderCanvas({ document: { source }, review: { editorComments: [existing] } });
    const { view, composer } = await composeCommentOnBold(
      new DOMRect(0, 0, 600, 500),
      () => ({ left: 100, right: 150, top: 100, bottom: 120 }),
    );
    expect(view.dom.querySelector(".editor-comment-draft")?.textContent).toBe("bold");
    expect(props.review.onCreateEditorComment).not.toHaveBeenCalled();
    // No button closes the note: a click anywhere else does, as a popover's would.
    expect(within(composer).queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.pointerDown(composer);
    expect(view.dom.querySelector(".editor-comment-draft")?.textContent).toBe("bold");
    fireEvent.pointerDown(view.contentDOM);
    await waitFor(() => expect(view.dom.querySelector(".editor-comment-draft")).toBeNull());
    expect(view.dom.querySelector(".cm-editor-comment")?.textContent).toBe("bold");
  });

  it("maps Markdown preview comments around frontmatter and wires live threads and creation", async () => {
    const prefix = "---\ntitle: Notes\n---\n";
    const source = `${prefix}A local and remote passage.`;
    const local = createEditorComment({ path: "notes.md", source, from: prefix.length + 2, to: prefix.length + 7, body: "Local", authorId: "ada", authorName: "Ada" })!;
    const remote = { ...local, id: "overleaf:thread-2", from: prefix.length + 12, to: prefix.length + 18, quote: "remote" };
    const hidden = { ...local, id: "frontmatter", from: 4, to: prefix.length + 3 };
    const other = { ...local, id: "other", path: "main.tex" };
    const { props, rerenderWith } = renderCanvas({
      document: { mode: "pdf", activeFile: "notes.md", source },
      review: { editorComments: [local, remote, hidden, other], activeEditorCommentId: remote.id },
    });
    const preview = await screen.findByTestId("visual-markdown-editor");
    const comments = () => JSON.parse(preview.getAttribute("data-comments")!);
    expect(comments()).toEqual([{ ...local, from: 2, to: 7 }, { ...remote, from: 12, to: 18 }]);
    expect(preview).toHaveAttribute("data-active-comment", remote.id);
    fireEvent.click(screen.getByTestId(`thread-${remote.id}`));
    expect(props.review.onReplyEditorComment).toHaveBeenCalledWith(remote.id);
    fireEvent.click(screen.getByTestId("preview-create-comment"));
    expect(props.review.onCreateEditorComment).toHaveBeenCalledWith(expect.objectContaining({ path: "notes.md", from: prefix.length + 2, to: prefix.length + 7, quote: "local", body: "Preview comment" }));
    rerenderWith({ review: { editorComments: [{ ...remote, body: "Updated reply", resolved: true }] } });
    expect(comments()).toEqual([{ ...remote, from: 12, to: 18, body: "Updated reply", resolved: true }]);
  });

  it("marks the open file's local and Overleaf comments in its source editor, focuses one on request, and refreshes them", async () => {
    const source = "Local passage. Remote passage.";
    const local = createEditorComment({ path: "main.tex", source, from: 0, to: 5, body: "Local", authorId: "ada", authorName: "Ada" })!;
    const remote = { ...createEditorComment({ path: "main.tex", source, from: 15, to: 21, body: "Remote", authorId: "overleaf-user", authorName: "Grace" })!, id: "overleaf:thread-1" };
    const unrelated = { ...local, id: "other-file", path: "other.tex" };
    const { props, rerenderWith } = renderCanvas({ document: { source }, review: { editorComments: [local, remote, unrelated] } });
    const marks = () => [...sourceEditor()?.querySelectorAll(".cm-editor-comment") ?? []].map((mark) => mark.getAttribute("data-comment-id"));
    await waitFor(() => expect(marks()).toEqual([local.id, remote.id]));
    rerenderWith({ review: { commentFocusRequest: { id: remote.id, nonce: "focus-remote" } } });
    await waitFor(() => expect(props.review.onCommentFocusHandled).toHaveBeenCalledWith("focus-remote"));
    expect(EditorView.findFromDOM(sourceEditor() as HTMLElement)?.state.selection.main).toMatchObject({ from: 15, to: 21 });
    rerenderWith({ review: { editorComments: [{ ...local, resolved: true }, remote, unrelated] } });
    await waitFor(() => expect(marks()).toEqual([remote.id]));
    rerenderWith({ review: { editorComments: [] } });
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
    renderCanvas({ document: { mode, activeFile }, pdf: { pdfUrl: "blob:project.pdf" } });

    await waitFor(() => expect(documentHost.querySelectorAll(".cm-editor")).toHaveLength(editors));
    // The project PDF is the PDF panel's (ProjectPdfPanel): never the document's, whatever it previews.
    expect(screen.queryByTestId("pdf-preview")).toBeNull();
    expect(screen.queryAllByRole("separator").map((separator) => separator.getAttribute("aria-label"))).toEqual(separators);
    expect(Boolean(documentHost.querySelector(".split-canvas"))).toBe(separators.length > 0);
  });

  it("embeds standalone data HTML frames inside the sandboxed HTML preview", async () => {
    const embeddedPlot = btoa(
      "<!doctype html><html><body><div id='plot'></div><script>window.inlinePlotReady=true</script></body></html>",
    );
    renderCanvas({
      document: {
        mode: "pdf", activeFile: "presentation.html",
        source: `<iframe src="data:text/html;charset=utf-8;base64,${embeddedPlot}" title="Plot"></iframe>`,
      },
      preferences: { interactivePreviewsEnabled: true },
    });

    const preview = await screen.findByTitle<HTMLIFrameElement>("HTML preview for presentation.html");
    expect(preview.getAttribute("srcdoc")).not.toContain("data:text/html");
    expect(preview.getAttribute("srcdoc")).toContain("window.inlinePlotReady=true");
    expect(preview.getAttribute("srcdoc")).toContain('sandbox="allow-scripts"');
  });

  // A project PDF open as a document is a PDF the writer selects in as much
  // as the compiled preview: its selection reaches the Agent, naming it.
  it("offers a selection in a project PDF open as a document as Agent context, with its page", async () => {
    const { props } = renderCanvas({
      document: {
        mode: "asset",
        activeFile: "figures/survey.pdf",
        activeAsset: { path: "figures/survey.pdf", mimeType: "application/pdf", ranges: { length: 8, version: "v1" } },
      },
    });
    const preview = await within(documentHost).findByTestId("pdf-preview");
    fireEvent.click(within(preview).getByTestId("pdf-read"));
    fireEvent.click(within(preview).getByTestId("pdf-select"));
    expect(props.selection.onPdfTextSelect).toHaveBeenLastCalledWith("Selected passage", { path: "figures/survey.pdf", page: 7, pageCount: 22 });
  });

  // Mode and asset arrive from different pieces of App state, so the two can be
  // out of step for a render; without an asset the canvas must fall back to the
  // editor rather than preview nothing and lose the open file.
  it.each([imageAsset, null])("shows only the asset in asset mode, if there is one (%j)", async (activeAsset) => {
    renderCanvas({ document: { mode: "asset", activeAsset } });

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
    renderCanvas({ document: { mode, activeFile, source: "{}" } });

    // A deck renders in its own host, which its document panel adopts (see OpenSlideDeckPool).
    const host = testId === "open-slide-workspace" ? decks.host(activeFile) : documentHost;
    expect({ ...(await within(host).findByTestId(testId)).dataset }).toMatchObject(data);
    await waitFor(() => expect(Boolean(sourceEditor())).toBe(beside));
    for (const other of surfaces.filter((id) => id !== testId)) expect(screen.queryByTestId(other)).toBeNull();
  });

  it("places a paper's visual editing warning above its generated title", async () => {
    renderCanvas({
      document: {
        mode: "pdf", activeFile: ".research/papers/2408.05088/paper.md", source: "Paper body.",
        activePaper: { arxivId: "2408.05088", title: "UNIC", authors: "Mert and Philippe", hasFullText: true, hasBlog: false },
      },
    });

    fireEvent.click(await screen.findByTestId("visual-markdown-editor-report-lossy"));
    const warning = await screen.findByRole("status");
    const title = screen.getByRole("heading", { name: "UNIC" });

    expect(warning).toHaveTextContent("Visual editing is unavailable");
    expect(warning).toHaveClass("paper-visual-eligibility");
    expect(warning.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("reports while a paper's original PDF stands in for its Markdown", async () => {
    const onPaperPdfOpenChange = vi.fn();
    renderCanvas({
      document: {
        mode: "pdf", activeFile: ".research/papers/2408.05088/paper.md", source: "Paper body.", onPaperPdfOpenChange,
        activePaper: { arxivId: "2408.05088", title: "UNIC", authors: "Mert and Philippe", hasFullText: true, hasBlog: false },
      },
    });

    const toggle = await screen.findByRole("button", { name: "View original PDF" });
    expect(onPaperPdfOpenChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(onPaperPdfOpenChange).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole("button", { name: "View original PDF" }));
    await waitFor(() => expect(onPaperPdfOpenChange).toHaveBeenLastCalledWith(false));
  });

  it("hands a native Open Slide deck its complete workspace in the document panel", async () => {
    const path = "slides/research-update/index.tsx";
    const { props } = renderCanvas({
      document: { mode: "source", activeFile: path, source: "export default [];\n", editorEditable: false },
      preferences: { locale: "zh-CN", theme: "dark" },
    });

    const presentation = await within(decks.host(path)).findByTestId("open-slide-workspace");
    expect({ ...presentation.dataset }).toMatchObject({
      active: "true", editable: "false", projectRoot: "/tmp/project", path, locale: "zh-CN", theme: "dark",
    });
    expect(documentHost).toBeEmptyDOMElement();
    fireEvent.click(screen.getByTestId("open-slide-mutation"));
    expect(props.assets.onOpenSlideMutation).toHaveBeenCalledWith(expect.objectContaining({ path, kind: "write" }));
  });

  // Beta r20: "whenever I view another document, the PPT's index.tsx has to reload".
  it("keeps an open deck's frame while another document is active, and releases it when its tab closes", async () => {
    const path = "slides/research-update/index.tsx";
    const deck = { activeFile: path, source: "export default [];\n" };
    const openPaths = [path, "intro.tex"];
    const { rerenderWith } = renderCanvas({ document: { mode: "source", ...deck, openPaths } });
    const presentation = await within(decks.host(path)).findByTestId("open-slide-workspace");

    for (const [next, active] of [[{ activeFile: "intro.tex", source: "\\section{Intro}\n" }, "false"], [deck, "true"]] as const) {
      rerenderWith({ document: { ...next, openPaths } });
      expect(within(decks.host(path)).getByTestId("open-slide-workspace")).toBe(presentation);
      expect(presentation.dataset).toMatchObject({ active, source: deck.source });
    }

    rerenderWith({ document: { activeFile: "intro.tex", source: "\\section{Intro}\n", openPaths: ["intro.tex"] } });
    expect(screen.queryByTestId("open-slide-workspace")).toBeNull();
  });

  it("keeps every open deck in its own host, and releases them all on a project switch", async () => {
    const first = "slides/one/index.tsx";
    const second = "slides/two/index.tsx";
    const openPaths = [first, second];
    const { rerenderWith } = renderCanvas({ document: { mode: "source", activeFile: first, source: "one", openPaths } });
    await within(decks.host(first)).findByTestId("open-slide-workspace");
    rerenderWith({ document: { activeFile: second, source: "two", openPaths } });

    const secondDeck = await within(decks.host(second)).findByTestId("open-slide-workspace");
    expect(within(decks.host(first)).getByTestId("open-slide-workspace").dataset).toMatchObject({ active: "false", source: "one" });
    expect(secondDeck.dataset).toMatchObject({ active: "true", source: "two" });

    rerenderWith({ document: { activeFile: "main.tex", source: "", openPaths }, preferences: { projectRoot: "/tmp/other" } });
    expect(screen.queryByTestId("open-slide-workspace")).toBeNull();
  });

  it("unmounts a deck while its panel sleeps, and brings it back on the page it showed", async () => {
    const path = "slides/research-update/index.tsx";
    const states: Record<string, FileViewState> = {};
    const onFileViewState = vi.fn((statePath: string, update: Partial<FileViewState>) => {
      states[statePath] = { ...states[statePath], ...update };
    });
    const openPaths = [path, "intro.tex"];
    const { rerenderWith } = renderCanvas({
      document: { mode: "source", activeFile: path, source: "export default [];\n", openPaths },
      navigation: { getFileViewState: (statePath) => states[statePath], onFileViewState },
    });
    const before = await within(decks.host(path)).findByTestId("open-slide-workspace");
    fireEvent.click(within(before).getByTestId("open-slide-view-state"));
    rerenderWith({ document: { activeFile: "intro.tex", source: "", openPaths } });

    setSleepingDecks([path]);
    expect(screen.queryByTestId("open-slide-workspace")).toBeNull();
    setSleepingDecks([]);

    const after = await within(decks.host(path)).findByTestId("open-slide-workspace");
    expect(after).not.toBe(before);
    expect(after.dataset).toMatchObject({ active: "false", restoredPage: "3" });
  });

  it("shows the panel's placeholder instead of a hibernated board, and mounts the board again on wake", async () => {
    const hosts = { ...baseProps().hosts, editorHibernated: true };
    const { rerenderWith } = renderCanvas({ document: { activeFile: "diagram.tldr", source: "{}" }, hosts });

    expect(within(documentHost).getByTestId("hibernated-document")).toBeInTheDocument();
    expect(screen.queryByTestId("board-editor")).toBeNull();
    rerenderWith({ hosts: { ...hosts, editorHibernated: false } });
    expect(await within(documentHost).findByTestId("board-editor")).toBeInTheDocument();
    expect(screen.queryByTestId("hibernated-document")).toBeNull();
  });
});

describe("DocumentCanvas / source session", () => {
  afterEach(() => {
    retainParkedEditors(null, []);
    visualIme.composing = false;
    vi.restoreAllMocks();
  });

  /** The comments the source editor marks, by id. */
  const marks = () => [...sourceEditor()?.querySelectorAll(".cm-editor-comment") ?? []].map((mark) => mark.getAttribute("data-comment-id"));

  /** Type `text` at the end of the source as the writer would, and the string the editor hands App for it. */
  function typeAtEnd(view: EditorView, props: CanvasProps, text: string) {
    const end = view.state.doc.length;
    act(() => view.dispatch({ changes: { from: end, insert: text }, selection: { anchor: end + text.length }, userEvent: "input.type" }));
    return vi.mocked(props.document.setSource).mock.calls.at(-1)![0];
  }

  // The PDF panel ends the menu through App before leaving the editor: turning
  // to the PDF need not blur it, and an open menu holds off the save.
  it("hands App a way to end the source editor's completion while it is mounted", async () => {
    const onCompletionCloseChange = vi.fn();
    const source = "\\cite{}";
    const { props, unmount } = renderCanvas({
      document: { source, onCompletionCloseChange },
      bibliography: { citationKeys: ["lee2026"], citations: [{ key: "lee2026", title: "Spatial", authors: "Lee", year: "2026", venue: "" }] },
    });
    const view = await primarySourceView();
    const close = onCompletionCloseChange.mock.calls.at(-1)![0] as () => void;
    act(() => {
      view.dispatch({ selection: { anchor: source.length - 1 } });
      startCompletion(view);
    });
    await waitFor(() => expect(props.document.onCompletionActiveChange).toHaveBeenLastCalledWith(true));

    act(close);
    expect(props.document.onCompletionActiveChange).toHaveBeenLastCalledWith(false);
    unmount();
    expect(onCompletionCloseChange).toHaveBeenLastCalledWith(null);
  });

  // A reconfigure tears down the language, linters, spellchecker and review
  // layers and builds them again; typing must never pay for one.
  it("keeps the editor configured as it was through typing, caret moves and live data", async () => {
    const source = "\\section{Intro}\nText.\n";
    const { props, rerenderWith } = renderCanvas({ document: { source } });
    const view = await primarySourceView();
    const reconfigure = vi.spyOn(StateEffect.reconfigure, "of");

    // App hands back the very string the editor emitted, as it does on every keystroke.
    const typed = typeAtEnd(view, props, "More");
    expect(typed).toBe(`${source}More`);
    rerenderWith({ document: { source: typed, settledSource: typed } });
    act(() => view.dispatch({ selection: { anchor: 3 }, userEvent: "select" }));
    const comment = createEditorComment({ path: "main.tex", source: typed, from: 9, to: 14, body: "Name it", authorId: "ada", authorName: "Ada" })!;
    const onEditorPosition = vi.fn();
    rerenderWith({
      document: { source: typed, settledSource: typed },
      bibliography: { citationKeys: ["knuth84"], indexPending: true },
      review: { editorComments: [comment], commentAuthorName: "Ada L." },
      status: { buildDiagnostics: [], texlabDiagnostics: [] },
      preferences: { spellingWords: ["Lattice"] },
      navigation: { onEditorPosition, onGotoDefinition: vi.fn() },
    });
    await waitFor(() => expect(marks()).toEqual([comment.id]));
    // The handlers it reports through are the newest App gave, without a reconfigure.
    act(() => view.dispatch({ selection: { anchor: 5 }, userEvent: "select" }));
    expect(onEditorPosition).toHaveBeenLastCalledWith({ path: "main.tex", line: 1, column: 5 });

    expect(reconfigure).not.toHaveBeenCalled();
    expect(EditorView.findFromDOM(sourceEditor() as HTMLElement)).toBe(view);
  });

  it.each([
    ["spellchecking", { preferences: { editorSpellcheck: true } }],
    ["keymap", { preferences: { editorKeymap: "emacs" } }],
  ] as const)("reconfigures the editor for a new %s, once, keeping its document and caret", async (_, change) => {
    const { rerenderWith } = renderCanvas();
    const view = await primarySourceView();
    act(() => view.dispatch({ selection: { anchor: 4 } }));
    const reconfigure = vi.spyOn(StateEffect.reconfigure, "of");

    rerenderWith(change);
    await waitFor(() => expect(reconfigure).toHaveBeenCalledTimes(1));
    rerenderWith(change);
    expect(reconfigure).toHaveBeenCalledTimes(1);
    expect(EditorView.findFromDOM(sourceEditor() as HTMLElement)).toBe(view);
    expect(view.state.selection.main.head).toBe(4);
  });

  it("reconfigures for another document's language, including one that loads later", async () => {
    const { rerenderWith } = renderCanvas();
    const view = await primarySourceView();
    const reconfigure = vi.spyOn(StateEffect.reconfigure, "of");

    rerenderWith({ document: { activeFile: "notes.md", source: "# Notes\n" } });
    expect(reconfigure).toHaveBeenCalled();
    await waitFor(() => expect(view.state.facet(language)?.name).toBe("markdown"));
    expect(EditorView.findFromDOM(sourceEditor() as HTMLElement)).toBe(view);
  });

  it("resumes a parked editor with its undo history, its selection and the annotations made since", async () => {
    const text = "First paragraph here.\nSecond paragraph.\n";
    const old = createEditorComment({ path: "main.tex", source: text, from: 0, to: 5, body: "Old", authorId: "ada", authorName: "Ada" })!;
    const { props, rerenderWith } = renderCanvas({
      document: { activeFile: "main.tex", source: text, editorKey: "main.tex" },
      review: { editorComments: [old] },
    });
    const first = await primarySourceView();
    await waitFor(() => expect(marks()).toEqual([old.id]));
    const typed = typeAtEnd(first, props, "Typed.");
    act(() => first.dispatch({ selection: { anchor: 6, head: 15 } }));
    rerenderWith({ document: { source: typed } });

    // Away to another file, where the old note is resolved and a new one made on this one.
    rerenderWith({ document: { activeFile: "other.tex", source: "\\section{Other}\n", editorKey: "other.tex" } });
    expect(EditorView.findFromDOM(sourceEditor() as HTMLElement)).not.toBe(first);
    const fresh = createEditorComment({ path: "main.tex", source: typed, from: 22, to: 28, body: "New", authorId: "ada", authorName: "Ada" })!;
    rerenderWith({ document: { activeFile: "main.tex", source: typed, editorKey: "main.tex" }, review: { editorComments: [fresh] } });

    const resumed = await primarySourceView();
    expect(resumed).not.toBe(first);
    expect(resumed.state.selection.main).toMatchObject({ anchor: 6, head: 15 });
    expect(marks()).toEqual([fresh.id]);
    act(() => { undo(resumed); });
    expect(resumed.state.doc.toString()).toBe(text);
  });

  it("holds an outside change while an IME composes, then takes it without echoing it or reconfiguring", async () => {
    const source = "Hello world\n";
    const { props, rerenderWith } = renderCanvas({ document: { source } });
    const view = await primarySourceView();
    let composing = true;
    Object.defineProperty(view, "composing", { configurable: true, get: () => composing });
    const reconfigure = vi.spyOn(StateEffect.reconfigure, "of");

    rerenderWith({ document: { source: "Hello there world\n" } });
    expect(view.state.doc.toString()).toBe(source);
    composing = false;
    await waitFor(() => expect(view.state.doc.toString()).toBe("Hello there world\n"));
    expect(props.document.setSource).not.toHaveBeenCalled();
    expect(reconfigure).not.toHaveBeenCalled();
  });

  it("answers App's flush for the visual editor, declining while it composes, through a handoff to the source", async () => {
    const onVisualMarkdownFlushChange = vi.fn();
    const document = { activeFile: "notes.md", source: "# Notes\n", onVisualMarkdownFlushChange };
    const { rerenderWith } = renderCanvas({ document: { ...document, mode: "pdf" } });
    await screen.findByTestId("visual-markdown-editor");
    const flush = onVisualMarkdownFlushChange.mock.lastCall![0] as () => boolean;
    visualIme.composing = true;
    expect(flush()).toBe(false);
    visualIme.composing = false;
    expect(flush()).toBe(true);

    rerenderWith({ document: { ...document, mode: "source", source: "# Notes\nMore.\n" } });
    const view = await primarySourceView();
    expect(view.state.doc.toString()).toBe("# Notes\nMore.\n");
    // Nothing visual holds an edit any more: a composition elsewhere does not block App.
    visualIme.composing = true;
    expect(flush()).toBe(true);
    expect(onVisualMarkdownFlushChange).not.toHaveBeenLastCalledWith(null);
  });
});

describe("DocumentCanvas / split ratio", () => {
  const separator = () => screen.getByRole("separator", { name: "Resize editor and Markdown preview" });
  /** A Markdown document in Split, the one kind of document whose panel splits against a preview. */
  const markdownSplit = { mode: "split", activeFile: "notes.md", source: "Notes" } as const;

  /** Render the Markdown split measuring `bounds`; `offset` reads the grip's boundary resistance. */
  function renderGrip(bounds: Partial<DOMRect>) {
    renderCanvas({ document: markdownSplit });
    const split = documentHost.querySelector<HTMLElement>(".split-canvas")!;
    vi.spyOn(split, "getBoundingClientRect").mockReturnValue(bounds as DOMRect);
    const property = "--split-resizer-offset";
    const grip = separator();
    // The grip and both panes each carry the offset; it does not inherit.
    const offset = () => {
      const values = [...split.children].map((child) => (child as HTMLElement).style.getPropertyValue(property));
      expect(new Set(values).size).toBe(1);
      return Number.parseFloat(values[0]!);
    };
    return { split, property, offset, grip };
  }

  it("adds boundary-only resistance to the split without saving the offset", () => {
    const inside = 700;
    const { split, property, offset, grip } = renderGrip({ left: 100, right: 1700, width: 1600 });
    fireEvent.pointerDown(grip, { clientX: inside });
    fireEvent.pointerMove(window, { clientX: inside });
    expect(offset()).toBeCloseTo(0);
    fireEvent.pointerMove(window, { clientX: 50 });
    expect(offset()).toBeLessThan(0);
    expect(offset()).toBeGreaterThanOrEqual(-24);
    expect(grip.style.transform).toBe("");
    expect(split.style.getPropertyValue(property)).toBe("");
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
    renderCanvas({ document: markdownSplit });

    expect(separator()).toHaveAttribute("aria-valuenow", shown);
  });

  it("does not replace the saved split preference when a restored panel is temporarily narrow", () => {
    localStorage.setItem(SPLIT_RATIO_KEY, "0.6");
    const { rerenderWith } = renderCanvas({ document: { ...markdownSplit, mode: "source" } });
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ left: 0, width: 500, right: 500 } as DOMRect);
    try {
      rerenderWith({ document: { mode: "split" } });
      expect(Number(separator().getAttribute("aria-valuenow"))).toBeLessThan(60);
      expect(localStorage.getItem(SPLIT_RATIO_KEY)).toBe("0.6");
      rerenderWith({ document: { mode: "source" } });
      bounds.mockReturnValue({ left: 0, width: 1400, right: 1400 } as DOMRect);
      rerenderWith({ document: { mode: "split" } });
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
      renderCanvas({ document: markdownSplit });
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
      renderCanvas({ document: markdownSplit });
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
    const { offset, grip } = renderGrip({ left: 0, right: 800, width: 800 });
    fireEvent.pointerDown(grip, { clientX: 400 });
    fireEvent.pointerMove(window, { clientX: 200 });
    expect(offset()).toBeLessThan(0);
    fireEvent.blur(window);
    expect(offset()).toBe(0);
    expect(document.body).not.toHaveClass("resizing-split");
  });

  it("nudges the split with the arrow keys only, remembers where it stopped, and stops at the edge instead of hiding a pane", () => {
    renderCanvas({ document: markdownSplit });

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
    const { rerenderWith } = renderCanvas({ document: { mode: "source", activeFile: "main.tex" }, navigation: state });

    rerenderWith({ document: { activeFile: "diagram.tldr", source: "{}" } });

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
    const { rerenderWith } = renderCanvas({ document: { mode: "source", ...deck }, navigation: { getFileViewState, onFileViewState } });
    fireEvent.click(await screen.findByTestId("open-slide-view-state"));

    rerenderWith({ document: { activeFile: "intro.tex", source: "\\section{Intro}\n" } });
    await waitFor(() => expect(screen.queryByTestId("open-slide-workspace")).toBeNull());
    rerenderWith({ document: deck });

    expect((await screen.findByTestId("open-slide-workspace")).dataset.restoredPage).toBe("3");
    expect(onFileViewState).toHaveBeenCalledWith(path, { openSlide: { page: 3 } });
  });

  // The canvas compiles, and its saved views live in a store read through a
  // getter: a board that mounts again reads where it was left since, not
  // what the store held when the canvas last built it.
  it("brings a board back from hibernation where it was left, not where it first opened", async () => {
    const path = "diagram.tldr";
    const states: Record<string, FileViewState> = { [path]: { board: { pageId: "page:1", camera: { x: 120, y: 0, z: 1 } } } };
    const getFileViewState = (statePath: string) => states[statePath];
    const hosts = baseProps().hosts;
    const { rerenderWith } = renderCanvas({ document: { activeFile: path, source: "{}" }, navigation: { getFileViewState }, hosts });
    expect((await screen.findByTestId("board-editor")).dataset.restoredCamera).toBe("120");

    states[path] = { board: { pageId: "page:1", camera: { x: 480, y: 0, z: 1 } } };
    rerenderWith({ hosts: { ...hosts, editorHibernated: true } });
    expect(screen.queryByTestId("board-editor")).toBeNull();
    rerenderWith({ hosts: { ...hosts, editorHibernated: false } });
    expect((await screen.findByTestId("board-editor")).dataset.restoredCamera).toBe("480");
  });

  it("keeps the board on the app theme, including a live switch", async () => {
    const { rerenderWith } = renderCanvas({ document: { mode: "source", activeFile: "diagram.tldr", source: "{}" }, preferences: { theme: "dark" } });

    expect((await screen.findByTestId("board-editor")).dataset.theme).toBe("dark");
    rerenderWith({ document: { activeFile: "diagram.tldr", source: "{}" }, preferences: { theme: "light" } });
    expect(screen.getByTestId("board-editor").dataset.theme).toBe("light");
  });
});
