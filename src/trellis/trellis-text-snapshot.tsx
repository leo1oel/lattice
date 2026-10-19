/**
 * The read-only drawings of an open document that is not the active one:
 * its source and, for Markdown, its rendered page. Trellis document panels
 * show them until a click makes the document active (see trellis-workspace.tsx).
 */
import { Suspense, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useLingui } from "@lingui/react/macro";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { isOpenSlideDeckPath, markdownFrontmatterEnd } from "../app-utils";
import { latexHighlightStyle } from "../editor/latex/latex-editor";
import { isLatexSourcePath, useTextLanguageExtensions } from "../canvas/editor-extensions";
import { latex } from "../editor/latex/latex-language";
import { resumeParkedEditor } from "../editor/parked-editors";
import { sourceGutter } from "../editor/source-gutter";
import { DeferredVisualMarkdownEditor } from "../canvas/canvas-lazy-editors";
import { DocumentSkeleton } from "../canvas/document-skeleton";
import { capturePreviewViewport, restorePreviewViewport } from "../canvas/markdown-preview-sync";
import { useTrellisApp, type TrellisController, type TrellisViewMode } from "./trellis-controller";
import { useBesideActive } from "./use-beside-active";

// The live source editor parses LaTeX with Lattice's own `latex()`, not the
// `@codemirror/language-data` stex mode `useTextLanguageExtensions` would find:
// the two tag tokens differently, so the same highlight style painted a
// snapshot in another palette until it was clicked into.
const LATEX_SNAPSHOT_LANGUAGE = [latex()];

const refuseEdit = () => false;

/**
 * A document that is not the active one, read-only and drawn the way it
 * opens: a CodeMirror of its source, and a Markdown file's rendered page
 * beside it (Split) or instead of it (Preview), so a document beside the one
 * being worked on keeps its look. Click to edit there.
 *
 * A tab on its way to becoming active (see useBesideActive) is the live
 * document a moment later, so it draws the skeleton of the view it opens in
 * instead: its source where the page will be, or a source without the live
 * editor's rail and decorations, would be seen turning into something else.
 */
export function TextSnapshot({ controller, fileKey, panelId }: { controller: TrellisController; fileKey: string; panelId: string }) {
  const { t } = useLingui();
  const besideActive = useBesideActive(controller, panelId);
  // The active document's view switch changes the view each kind opens in.
  const opening = useSyncExternalStore(controller.docTools.subscribe, () => controller.bridge?.documentMode(fileKey) ?? "source");
  if (!besideActive) {
    const name = controller.bridge?.tabLabel(fileKey) ?? fileKey;
    return <DocumentSkeleton shape={opening === "pdf" ? "page" : opening} label={t`Opening ${name}…`} />;
  }
  return <SnapshotContent controller={controller} fileKey={fileKey} mode={isMarkdownSnapshot(fileKey) ? opening : "source"} />;
}

function SnapshotContent({ controller, fileKey, mode }: { controller: TrellisController; fileKey: string; mode: TrellisViewMode }) {
  const { t } = useLingui();
  const parentRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [text, setText] = useState<string | null>(() => controller.texts.get(fileKey) ?? null);
  const filesRevision = useTrellisApp(controller, (state) => state.filesRevision);
  const isLatex = isLatexSourcePath(fileKey);
  const textLanguage = useTextLanguageExtensions(isLatex ? "" : fileKey);
  const language = isLatex ? LATEX_SNAPSHOT_LANGUAGE : textLanguage;
  useEffect(() => {
    let disposed = false;
    void controller.bridge?.readText(fileKey).then((value) => {
      if (disposed || value === null) return;
      controller.texts.set(fileKey, value);
      setText((current) => (current === value ? current : value));
    });
    return () => { disposed = true; };
  }, [controller, fileKey, filesRevision]);
  useLayoutEffect(() => {
    const parent = parentRef.current;
    if (!parent || text === null || mode === "pdf") return;
    const extensions = [
      // The live editor's gutter, so taking over from the snapshot
      // moves nothing.
      sourceGutter(),
      EditorView.lineWrapping,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      syntaxHighlighting(latexHighlightStyle),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      EditorView.theme({ "&": { height: "100%" }, "& .cm-scroller": { height: "100% !important" } }),
      ...language,
    ];
    // The live editor this tab last had, parked: its place to the pixel and
    // its parse, so the snapshot shown while the tab becomes active again
    // matches what the live editor then shows (see parked-editors.ts).
    const { projectRoot } = controller.app.get();
    const resumed = projectRoot ? resumeParkedEditor(projectRoot, fileKey, text, extensions) : null;
    const view = new EditorView({
      parent,
      state: resumed?.state ?? EditorState.create({ doc: text, extensions }),
      scrollTo: resumed?.scrollTo,
    });
    viewRef.current = view;
    const scrollTop = controller.bridge?.viewState(fileKey)?.text?.scrollTop;
    if (!resumed && scrollTop) requestAnimationFrame(() => { view.scrollDOM.scrollTop = scrollTop; });
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, [controller, fileKey, language, mode, text]);
  return (
    <div
      className="trellis-snapshot source-editor"
      data-mode={mode}
      title={t`Click to edit`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const view = viewRef.current;
        const inSource = view?.dom.contains(event.target as Node);
        const position = inSource ? view?.posAtCoords({ x: event.clientX, y: event.clientY }) : null;
        // On the rendered page: the source line of the block pressed, so the
        // live document opens there with the editor focused, as a press in
        // the source does.
        const pageLine = !inSource && text !== null ? renderedLineAt(event.currentTarget, event.clientY) : undefined;
        const line = view && position != null ? view.state.doc.lineAt(position).number
          : pageLine !== undefined && text !== null ? pageLine + lineCount(text.slice(0, markdownFrontmatterEnd(text))) - 1 : undefined;
        controller.activate(fileKey, line);
      }}
    >
      {mode !== "pdf" && (
        <div className="trellis-snapshot-source">
          <div ref={parentRef} className="code-editor-root trellis-snapshot-editor" />
          {/* The live editor's status bar, empty, so the source is as tall as
              the live editor's: scrolled to its end, it shows the same lines. */}
          <div className="editor-status-bar" aria-hidden="true" />
        </div>
      )}
      {mode !== "source" && text !== null && (
        <ReadOnlyMarkdown controller={controller} path={fileKey} text={text.slice(markdownFrontmatterEnd(text))} sourceLines />
      )}
      <span className="trellis-snapshot-badge">{t`Read-only preview · click to edit`}</span>
    </div>
  );
}

/** Lines in `text`, counting the one it ends on. */
const lineCount = (text: string) => text.split("\n").length;

/**
 * The source line (1-based, within the rendered text) of the rendered block
 * at `clientY` in `snapshot`'s page: the last block starting at or above it,
 * else the first.
 */
function renderedLineAt(snapshot: Element, clientY: number) {
  const blocks = [...snapshot.querySelectorAll<HTMLElement>(".markdown-preview [data-source-line]")];
  const block = blocks.filter((element) => element.getBoundingClientRect().top <= clientY).at(-1) ?? blocks[0];
  const line = Number(block?.dataset.sourceLine);
  return Number.isFinite(line) && line > 0 ? line : undefined;
}

/** A Markdown file, not a deck in Markdown's clothing: what a snapshot can render as a page. */
function isMarkdownSnapshot(key: string) {
  return key.toLocaleLowerCase().endsWith(".md") && !isOpenSlideDeckPath(key);
}

/**
 * Rendered Markdown, read-only, at the place its reader left it (the saved
 * block at the top, retried each frame while the editor draws); then this
 * panel's scrolling is where the reader resumes.
 */
export function ReadOnlyMarkdown({ controller, path, text, sourceLines = false }: {
  controller: TrellisController; path: string; text: string;
  /** Mark each block with its source line (see renderedLineAt). */
  sourceLines?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // The reader's own image loader: figures are project files relative to
  // their Markdown, which the webview cannot fetch by that path.
  const loadAsset = useTrellisApp(controller, (state) => state.loadAsset);
  const assetRevision = useTrellisApp(controller, (state) => state.assetRevision);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const saved = controller.bridge?.viewState(path)?.visualMarkdown;
    let restoring = Boolean(saved && (saved.anchor || saved.scrollTop > 0));
    let frames = 0;
    let frame = requestAnimationFrame(function settle() {
      frames += 1;
      const placed = restorePreviewViewport(scroller, { ...saved, scrollTop: saved?.scrollTop ?? 0, scrollRange: saved?.scrollRange ?? 0 });
      if (!placed && frames < 60) frame = requestAnimationFrame(settle);
      else restoring = false;
    });
    const report = () => {
      if (restoring) return;
      controller.bridge?.rememberViewState(path, {
        visualMarkdown: capturePreviewViewport(scroller),
      });
    };
    scroller.addEventListener("scroll", report, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", report);
    };
  }, [controller, path, text]);
  return (
    <div ref={scrollRef} className="markdown-preview trellis-paper-snapshot-scroll">
      <div className="markdown-preview-content">
        <Suspense fallback={null}>
          <DeferredVisualMarkdownEditor
            text={text}
            activePath={path}
            editable={false}
            optimizeForReading
            onLoadAsset={loadAsset ?? undefined}
            assetRevision={assetRevision}
            onChangeMarkdown={refuseEdit}
            onUndo={refuseEdit}
            onRedo={refuseEdit}
            synchronizeSourceScroll={sourceLines}
          />
        </Suspense>
      </div>
    </div>
  );
}
