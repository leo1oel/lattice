import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import type { I18n } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import { EditorContent, ReactNodeViewRenderer, useEditor, type Editor } from "@tiptap/react";
import { Extension, posToDOMRect } from "@tiptap/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { AllSelection, EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
// Vendored Open Knowledge editor chrome (see scripts/vendor-open-knowledge.mjs).
import { BridgeIdPlugin } from "@ok-app/editor/extensions/bridge-id-plugin";
import { SelectionStatePlugin } from "@ok-app/editor/extensions/selection-state-plugin";
import { KeyboardNav } from "@ok-app/editor/block-ux/keyboard-nav";
import { SlashCommand } from "@ok-app/editor/extensions/slash-command";
import { TiptapFindReplace } from "@ok-app/editor/find-replace/tiptap-find-replace-extension";
import { TableInsertControls } from "@ok-app/editor/extensions/table-insert-controls";
import { TableRowEnter } from "@ok-app/editor/extensions/table-row-enter";
import { FootnoteAnchorScroll } from "@ok-app/editor/extensions/footnote-anchor-scroll";
import { FormattingShortcuts } from "@ok-app/editor/extensions/formatting-shortcuts";
import { TabFocusTrap } from "@ok-app/editor/extensions/tab-focus-trap";
// Stateful seam, not the vendored original: upstream rebuilds its whole-doc
// DecorationSet on every view update (caret moves included), which is
// O(document) per keypress on large files. See the seam header for details.
import { HeadingAnchorsStateful as HeadingAnchors } from "@ok-app/editor/extensions/heading-anchors-stateful";
import { MathInputRule } from "@ok-app/editor/math-input-rule";
import { InlineLinkInputRule } from "@ok-app/editor/inline-link-input-rule";
import { setHostKatexMacros } from "@ok-app/shims/katex-macros";
import { TableCellHandles } from "@ok-app/editor/table-controls/TableCellHandles";
import { BubbleMenuBar } from "@ok-app/editor/bubble-menu/BubbleMenuBar";
import { VisualCommentProvider } from "@ok-app/comments/CommentBubbleButton";
import { ViewInSourceProvider } from "@ok-app/editor/bubble-menu/ViewInSourceBubbleButton";
import { serializeWysiwygSelection } from "@ok-app/editor/edit-with-ai-selection";
import { EmojiInsertPopover } from "@ok-app/editor/components/EmojiInsertPopover";
import { ImageSrcFidelity } from "../../open-knowledge-core/extensions/image-src-fidelity";
import type { PaperSummary } from "../../app-types";
import type { PresenceCursor, TrackedChangeTooltipActions } from "../../overleaf/overleaf-editor-extensions";
import type { TrackedChange } from "../../overleaf/use-overleaf-realtime";
import { editorCommentAuthorDisplayName, resolveCommentAnchor, type EditorComment } from "../comments/editor-comment-data";
import { notifyError } from "../../telemetry/app-notify";
import { addAppLog, dismissAppToastByDedupeKey } from "../../telemetry/app-log-store";
import { InlineMessage } from "../../components/ui/inline-message";
import { InfinityLoader } from "../../components/ui/activity-icons";
import { DocumentHeadingRail } from "./document-heading-rail";
import { documentHeadingItems } from "./document-heading-items";
import { listen, whenIdle } from "../dom-utils";
import { rebaseMarkdownDraft } from "./markdown-collab";
import { openMarkdownLink } from "./markdown-link-routing";
import { LARGE_MARKDOWN_PREVIEW_THRESHOLD, markdownPreviewSyncPolicy } from "./markdown-preview-sync-policy";
import type { MarkdownWorkspaceIndex } from "./markdown-workspace-index";
import { PRESERVE_VISUAL_VIEWPORT_META, VisualBlockControls, VisualBlockMover, type PreserveVisualViewportMeta } from "./visual-editor-block-controls";
import {
  AtomicBlockSelection,
  CalloutEnterGuard,
  ChunkWrapperDecoration,
  GeneratedPaperContents,
  LatticeFrozenTableHeaders,
} from "./visual-editor-extensions";
import { VisualLinkHover } from "./visual-link-hover";
import { VisualLinkInsertPopover } from "./visual-link-insert-popover";
import { buildVisualMarkdownBlockModel } from "./visual-markdown-block-model";
import { VisualMarkdownFindReplace } from "./visual-markdown-find-replace";
import { visualEditorExtensions } from "./visual-markdown-schema";
import {
  cachedVisualDocument,
  changedTopLevelBlocks,
  isMultilineTextNormalization,
  isRepresentedExactly,
  serializeMarkdown,
  setMarkdownWithoutHistory,
} from "./visual-markdown-serialization";
import { visualPaperCitationSuggestion } from "./visual-paper-citation-suggestion";
import {
  EditorHostProviders,
  PassiveVisualMarkdownViewport,
  ProjectInlineImageView,
  type PassiveEditorHandoff,
} from "./visual-passive-viewport";
import {
  TrackedChangeLayer,
  VisualCommentComposer,
  useVisualCommentInteractions,
  type CommentComposerState,
} from "./visual-review-overlays";
import { slashCategoryLabels, slashItemSources } from "./visual-slash-items";
import { SourceDirtyObserver } from "./visual-source-dirty-observer";
import { visualComments, visualPresence, visualTrackChanges } from "./visual-source-decorations";
import {
  blockSourceOffsetForPosition,
  proseMirrorPositionForSourceOffset,
  rowColumnForSourceOffset,
  sourceOffsetForProseMirrorPosition,
  visualSourceRanges,
  type VisualSourceRange,
} from "./visual-source-map";
import { TableSpanControls } from "./visual-table-span-controls";
import { visualWikiLinkSuggestion } from "./visual-wiki-link-suggestion";

// eslint-disable-next-line react-refresh/only-export-components -- exported for the corruption regression test
export { exactVisualSourceRanges } from "./visual-source-map";
// eslint-disable-next-line react-refresh/only-export-components -- exported for the corruption regression test
export { restoreUnchangedBlocks } from "./visual-markdown-serialization";

const EMPTY_MACROS: Record<string, string> = {};
const EMPTY_EDITOR_COMMENTS: EditorComment[] = [];
const VIRTUAL_BLOCK_MODEL_SOURCE_THRESHOLD = 20_000;
const VIRTUAL_BLOCK_COUNT_THRESHOLD = 160;
const VISUAL_EDITING_UNAVAILABLE_REASON =
  "Visual editing is unavailable because this Markdown contains unsupported or lossy syntax. Use source mode to preserve it.";
const SOURCE_LABELS = ["sourceLine", "sourceOffset", "sourceEndOffset"] as const;

/** Prime the bounded visual parse cache without mounting an editor. */
// eslint-disable-next-line react-refresh/only-export-components -- project-open idle warming shares the editor's private LRU.
export function prewarmVisualMarkdownDocument(path: string, text: string): void {
  cachedVisualDocument(path, text);
}

/**
 * Run a DOM mutation with ProseMirror's DOM observer paused, restarting it
 * even when the mutation throws. Hoisted to module scope: the try/finally
 * would make the React Compiler bail out of the component containing it.
 */
function withPausedDomObserver(view: Editor["view"], apply: () => void): void {
  const { domObserver } = view as unknown as { domObserver?: { flush: () => void; start: () => void; stop: () => void } };
  domObserver?.flush();
  domObserver?.stop();
  try {
    apply();
  } finally {
    domObserver?.start();
  }
}

/** Source-scroll labels on a rendered top-level block; `undefined` removes them. */
function labelSourceBlock(element: HTMLElement, values?: readonly [string, string, string]) {
  SOURCE_LABELS.forEach((key, index) => {
    if (!values) delete element.dataset[key];
    else if (element.dataset[key] !== values[index]) element.dataset[key] = values[index];
  });
}

function clearTimer(timer: { current: ReturnType<typeof setTimeout> | null }) {
  if (timer.current) clearTimeout(timer.current);
  timer.current = null;
}

/** Ask a transaction's host to hold the viewport around an inserted block. */
function requestViewportLock(editor: Editor, anchor: PreserveVisualViewportMeta, onLock?: VisualMarkdownEditorProps["onRequestViewportLock"], anchorTop = anchor.anchorTop) {
  const element = editor.view.nodeDOM(anchor.anchorPosition);
  const reveal = editor.view.nodeDOM(anchor.insertedPosition);
  onLock?.(element instanceof HTMLElement ? element : null, anchorTop, reveal instanceof HTMLElement ? reveal : null);
}

/**
 * True once the editor's ProseMirror view is mounted. TipTap v3's
 * `editor.view` is a proxy that throws pre-mount, and the vendored
 * BubbleMenuBar reads `editor.view.dom` during render — upstream only
 * renders it after mount, so the host must gate the same way. Reads the
 * non-throwing `editorView` field (upstream's get-editor-view.ts recipe)
 * and tracks TipTap's `mount`/`unmount` events.
 */
function useEditorViewMounted(editor: Editor | null): boolean {
  // State is only a re-render trigger; the returned value is read live each
  // render. A state-held boolean would go stale for one frame when useEditor
  // swaps in a fresh (not yet mounted) editor instance.
  const [, bump] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const update = () => bump((n) => n + 1);
    update();
    editor.on("mount", update);
    editor.on("unmount", update);
    return () => {
      editor.off("mount", update);
      editor.off("unmount", update);
    };
  }, [editor]);
  return Boolean((editor as unknown as { editorView?: unknown } | null)?.editorView);
}

type VisualMarkdownEditorProps = {
  text: string;
  activePath: string;
  projectRoot?: string;
  onChangeMarkdown: (next: string, expected: string) => boolean;
  onFlushPendingChange?: (flush: (() => boolean) | null) => void;
  optimizeForReading?: boolean;
  /** Lets a parent place the eligibility notice outside the article body. */
  onEligibilityChange?: (reason: string | null) => void;
  synchronizeSourceScroll?: boolean;
  onRequestViewportLock?: (anchor: HTMLElement | null, anchorTop: number | null, reveal: HTMLElement | null) => void;
  onOpenProjectPath?: (path: string) => void;
  workspaceIndex?: MarkdownWorkspaceIndex | null;
  /** Downloaded paper library backing the `@` citation typeahead. */
  papers?: PaperSummary[];
  macros?: Record<string, string>;
  onUndo: () => boolean;
  onRedo: () => boolean;
  onEditSource?: () => void;
  onViewInSource?: (sourceOffset: number, viewportY?: number, blockViewportY?: number) => void;
  onImportAsset?: (file: File) => Promise<string | null>;
  onLoadAsset?: (path: string) => Promise<string | null>;
  assetRevision?: number;
  presenceCursors?: PresenceCursor[];
  onCaretChange?: (row: number, column: number) => void;
  onSourceCaretChange?: (sourceOffset: number) => void;
  onSelectionMarkdown?: (value: string) => void;
  overleafChanges?: TrackedChange[];
  /** Comments anchored in this file, painted as highlights over the prose. */
  editorComments?: EditorComment[];
  activeEditorCommentId?: string | null;
  onEditorCommentClick?: (id: string) => void;
  overleafTrackChangeActions?: TrackedChangeTooltipActions;
  onCreateComment?: (from: number, to: number, body: string) => void;
  editable?: boolean;
};

type CompleteVisualMarkdownEditorProps = VisualMarkdownEditorProps & {
  /** Internal handoff from the passive block viewport to the complete editor. */
  initialHandoff?: PassiveEditorHandoff;
  onConsumeInitialHandoff?: () => void;
};

/** Move the fresh editor to where the passive viewport was clicked, then replay its gesture. */
function applyPassiveHandoff(
  editor: Editor,
  requested: PassiveEditorHandoff,
  text: string,
  activePath: string,
  onOpenProjectPath?: (path: string) => void,
): (() => void) | undefined {
  if (requested.fragment) {
    openMarkdownLink(activePath, requested.fragment, onOpenProjectPath, editor.view.dom);
    if (requested.navigationOnly) return;
  }
  const { view } = editor;
  const position = proseMirrorPositionForSourceOffset(editor.state.doc, text, requested.sourceOffset, activePath);
  if (position == null) return;
  if (requested.blockTop != null) {
    const resolved = editor.state.doc.resolve(position);
    const block = view.nodeDOM(resolved.depth > 0 ? resolved.before(1) : position);
    const scroller = view.dom.closest<HTMLElement>(".editor-doc-scroll");
    if (block instanceof HTMLElement && scroller) scroller.scrollTop += block.getBoundingClientRect().top - requested.blockTop;
  }
  const pointerPosition = requested.clientX != null && requested.clientY != null
    ? view.posAtCoords({ left: requested.clientX, top: requested.clientY })?.pos
    : undefined;
  const selection = TextSelection.near(editor.state.doc.resolve(pointerPosition ?? position), 1);
  view.dispatch(editor.state.tr.setSelection(selection));
  editor.commands.focus();
  if (requested.command === "selectAll") {
    view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
    return;
  }
  if (requested.command === "find") {
    queueMicrotask(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true })));
    return;
  }
  if (requested.pointerId == null) return;
  // Keep extending the native-selection drag that began on the passive surface.
  const anchor = selection.head;
  const ownPointer = (event: PointerEvent) => event.pointerId === requested.pointerId;
  const extendSelection = (event: PointerEvent) => {
    const head = ownPointer(event) ? view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos : null;
    if (head != null) view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, anchor, head)));
  };
  const finishSelection = (event: PointerEvent) => {
    if (ownPointer(event)) stop();
  };
  const stop = listen(window, [
    ["pointermove", extendSelection, true],
    ["pointerup", finishSelection, true],
    ["pointercancel", finishSelection, true],
  ]);
  return stop;
}

/**
 * Host extensions that read live props through refs. Built in one call so the
 * React Compiler sees a single ref hand-off; useEditor only consumes them when
 * it constructs an instance.
 */
function hostExtensions(
  { latest, activePathRef, flushPendingLocalUpdate }: {
    latest: { readonly current: CompleteVisualMarkdownEditorProps };
    activePathRef: { readonly current: string };
    flushPendingLocalUpdate: () => boolean;
  },
  i18n: I18n,
  onImportAsset: VisualMarkdownEditorProps["onImportAsset"],
) {
  const getActivePath = () => activePathRef.current;
  const flushThen = (command: () => boolean) => () => {
    flushPendingLocalUpdate();
    return command();
  };
  return {
    slashSources: slashItemSources(i18n, onImportAsset, getActivePath),
    image: ImageSrcFidelity.extend({ addNodeView: () => ReactNodeViewRenderer(ProjectInlineImageView) }).configure({ inline: true }),
    wikiLinks: visualWikiLinkSuggestion(() => latest.current.workspaceIndex ?? null),
    citations: visualPaperCitationSuggestion({
      getPapers: () => latest.current.papers ?? [],
      getActivePath,
      getProjectRoot: () => latest.current.projectRoot ?? "",
    }),
    shortcuts: Extension.create({
      name: "canonicalMarkdownHistory",
      addKeyboardShortcuts: () => ({
        "Mod-z": flushThen(() => latest.current.onUndo()),
        "Mod-Shift-z": flushThen(() => latest.current.onRedo()),
        "Mod-y": flushThen(() => latest.current.onRedo()),
        "Mod-Enter": ({ editor }) => {
          const href = editor.getAttributes("link").href as string | undefined;
          if (href) openMarkdownLink(activePathRef.current, href, latest.current.onOpenProjectPath, editor.view.dom);
          return Boolean(href);
        },
      }),
    }),
  };
}

const VisualEditorSurface = memo(function VisualEditorSurface({
  editor,
  activePath,
  onLoadAsset,
  assetRevision,
  workspaceIndex,
  viewInSource,
  editorViewMounted,
  openVisualCommentComposer,
  bubbleMenuHidden,
  editable,
  onLinkPopoverOpenChange,
}: {
  editor: Editor;
  activePath: string;
  onLoadAsset?: (path: string) => Promise<string | null>;
  assetRevision: number;
  workspaceIndex?: MarkdownWorkspaceIndex | null;
  viewInSource: (editor: Editor) => void;
  editorViewMounted: boolean;
  openVisualCommentComposer: (() => void) | null;
  bubbleMenuHidden: boolean;
  editable: boolean;
  onLinkPopoverOpenChange: (open: boolean) => void;
}) {
  return (
    <EditorHostProviders activePath={activePath} onLoadAsset={onLoadAsset} assetRevision={assetRevision} workspaceIndex={workspaceIndex}>
      <ViewInSourceProvider onViewInSource={viewInSource}>
        <div className="tiptap-editor">
          {editorViewMounted && (
            <>
              <VisualCommentProvider onComment={openVisualCommentComposer}>
                <BubbleMenuBar editor={editor} hidden={bubbleMenuHidden} commentOnly={!editable} />
              </VisualCommentProvider>
              <TableCellHandles editor={editor} />
              <TableSpanControls editor={editor} />
            </>
          )}
          <EmojiInsertPopover />
          {editorViewMounted && <VisualLinkInsertPopover editor={editor} onOpenChange={onLinkPopoverOpenChange} />}
          <EditorContent className="tiptap-editor-portal-content" editor={editor} />
        </div>
      </ViewInSourceProvider>
    </EditorHostProviders>
  );
});

function CompleteVisualMarkdownEditor(props: CompleteVisualMarkdownEditorProps): JSX.Element {
  const {
    text,
    activePath,
    onFlushPendingChange,
    optimizeForReading = false,
    onEligibilityChange,
    synchronizeSourceScroll = true,
    onOpenProjectPath,
    workspaceIndex,
    onEditSource,
    onViewInSource,
    onImportAsset,
    onLoadAsset,
    assetRevision = 0,
    presenceCursors,
    overleafChanges,
    editorComments = EMPTY_EDITOR_COMMENTS,
    activeEditorCommentId = null,
    onEditorCommentClick,
    overleafTrackChangeActions,
    onCreateComment,
    editable = true,
    initialHandoff,
    onConsumeInitialHandoff,
  } = props;
  const { i18n, t } = useLingui();
  const anonymousAuthor = t`Anonymous`;
  const headingItems = useMemo(() => documentHeadingItems(
    cachedVisualDocument(activePath, text).content,
    { hideGeneratedContents: optimizeForReading },
  ), [activePath, optimizeForReading, text]);
  const [conflictDraft, setConflictDraft] = useState<string | null>(null);
  const [renderedPath, setRenderedPath] = useState(activePath);
  const [eligibilityReason, setEligibilityReason] = useState<string | null>(null);
  const [linkPopoverOpen, setLinkPopoverOpen] = useState(false);
  const [commentComposer, setCommentComposer] = useState<CommentComposerState | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  // Callbacks and collections read from editor handlers and timers. Refreshed
  // after commit (not during a layout effect): the path-switch layout effect
  // below must still flush the outgoing document through the old publisher.
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const editorReadyForChanges = useRef(false);
  const activePathRef = useRef(activePath);
  const acceptedMarkdown = useRef(text);
  const pendingCanonical = useRef<string | null>(null);
  const composing = useRef(false);
  const compositionClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conflictDraftRef = useRef<string | null>(null);
  // The source text whose round-trip eligibility is known, and the verdict.
  const eligibility = useRef<{ text: string; exact: boolean } | null>(null);
  const indexedDocumentRef = useRef<{ index: MarkdownWorkspaceIndex; path: string } | null>(null);
  // Overlay plugins stay idle until they have something to paint, and publish
  // one final empty snapshot when the last overlay disappears.
  const commentsWereActive = useRef(false);
  const presenceWasActive = useRef(false);
  const trackChangesWereActive = useRef(false);
  const pendingLocalUpdate = useRef<{
    editor: Editor;
    explicitReplacement: boolean;
    changedBlocks: Set<number>;
    viewportAnchor: PreserveVisualViewportMeta | null;
  } | null>(null);
  const localUpdateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localUpdateMaxTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const caretReportTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commentTooltipId = useId();

  const reportVisualCaret = useCallback((currentEditor: Editor, expectedMarkdown: string, unpublished = false) => {
    clearTimer(caretReportTimer);
    const { onCaretChange, onSourceCaretChange } = latest.current;
    if (!onCaretChange) return;
    const head = currentEditor.state.selection.head;
    // With edits still waiting for publication the document no longer
    // serializes to the published Markdown, so the whole-document fallback
    // would serialize a large file after every keystroke only to discard the
    // result below. The caret's own block maps if it is unchanged; otherwise
    // the publication reports the caret when it lands.
    const mapped = unpublished && expectedMarkdown.length >= LARGE_MARKDOWN_PREVIEW_THRESHOLD
      ? blockSourceOffsetForPosition(currentEditor, head, expectedMarkdown)
      : sourceOffsetForProseMirrorPosition(currentEditor, head, expectedMarkdown);
    if (mapped?.markdown !== expectedMarkdown) return;
    const caret = rowColumnForSourceOffset(expectedMarkdown, Math.min(mapped.offset, expectedMarkdown.length));
    onCaretChange(caret.row, caret.column);
    onSourceCaretChange?.(mapped.offset);
  }, []);
  // Selection updates arrive per keystroke, and recovering a caret's source
  // offset costs a serialization pass. Coalesce to one report per interaction
  // pause so editor transactions themselves stay cheap; explicit callers
  // (publication flush) still report synchronously and cancel a pending one.
  const scheduleVisualCaretReport = useCallback((currentEditor: Editor) => {
    clearTimer(caretReportTimer);
    caretReportTimer.current = setTimeout(() => {
      caretReportTimer.current = null;
      if (!currentEditor.isDestroyed) reportVisualCaret(currentEditor, acceptedMarkdown.current, pendingLocalUpdate.current !== null);
    }, 120);
  }, [reportVisualCaret]);
  useEffect(() => () => clearTimer(caretReportTimer), []);
  const refreshVisualPresence = useCallback((currentEditor: Editor, markdown: string) => {
    if (!presenceWasActive.current) return;
    visualPresence.publish(currentEditor, {
      text: markdown,
      sourcePath: activePathRef.current,
      cursors: latest.current.presenceCursors ?? [],
    });
  }, []);
  const refreshVisualTrackChanges = useCallback((currentEditor: Editor, markdown: string, requestedChanges?: TrackedChange[]) => {
    // Resolved in the body rather than as a default parameter: the React
    // Compiler cannot reorder member expressions in default-value position.
    const changes = requestedChanges ?? latest.current.overleafChanges ?? [];
    if (!changes.length && !trackChangesWereActive.current) return;
    visualTrackChanges.publish(currentEditor, { text: markdown, sourcePath: activePathRef.current, changes });
  }, []);
  const flushPendingLocalUpdate = useCallback(() => {
    // WebKit can deliver the final composition transaction during blur. Do
    // not hand document ownership to another path until compositionend has
    // made that transaction publishable by the current editor.
    if (composing.current) return false;
    // A failed publication blocks the first ownership change so its recovery
    // notification can appear. Once the rejected draft has been preserved,
    // holding every later close or file switch hostage only strands the user
    // on this document; the explicit Copy/Restore actions remain available.
    if (conflictDraftRef.current != null) return true;
    clearTimer(localUpdateTimer);
    clearTimer(localUpdateMaxTimer);
    const pending = pendingLocalUpdate.current;
    pendingLocalUpdate.current = null;
    if (!pending || pending.editor.isDestroyed) return true;
    const { editor: updatedEditor, explicitReplacement, changedBlocks, viewportAnchor } = pending;
    // Initialization and canonical-reconciliation transactions are not user
    // edits. In particular, never let opening a source-only paper normalize
    // and silently overwrite syntax that the visual editor cannot preserve.
    if (!explicitReplacement && !(eligibility.current?.text === acceptedMarkdown.current && eligibility.current.exact)) return true;
    const expected = acceptedMarkdown.current;
    const next = serializeMarkdown(updatedEditor, expected, changedBlocks, activePathRef.current);
    if (next === expected) {
      // Edits that cancel out publish nothing, so report the caret the
      // pending-publication path above may have left unreported.
      reportVisualCaret(updatedEditor, expected);
      return true;
    }
    // A deferred split publication happens after the short lock requested by
    // the original + transaction. Re-lock immediately before the source echo
    // so its CodeMirror update cannot move the preview several frames later.
    // The first lock may already have scrolled down to reveal the inserted
    // row, so preserve the anchor's current screen position rather than
    // replaying its pre-insertion position and briefly jumping upward.
    if (viewportAnchor) {
      const anchor = updatedEditor.view.nodeDOM(viewportAnchor.anchorPosition);
      requestViewportLock(
        updatedEditor,
        viewportAnchor,
        latest.current.onRequestViewportLock,
        anchor instanceof HTMLElement && anchor.isConnected ? anchor.getBoundingClientRect().top : viewportAnchor.anchorTop,
      );
    }
    const accepted = latest.current.onChangeMarkdown(next, expected);
    if (accepted) {
      acceptedMarkdown.current = next;
      reportVisualCaret(updatedEditor, next);
      refreshVisualPresence(updatedEditor, next);
      // A document emitted by this editor is already representable. Mark it
      // before the canonical prop comes back so the eligibility effect does
      // not serialize the entire document a second time for the same edit.
      eligibility.current = { text: next, exact: true };
    }
    conflictDraftRef.current = accepted ? null : next;
    setConflictDraft(conflictDraftRef.current);
    return accepted;
  }, [refreshVisualPresence, reportVisualCaret]);
  useLayoutEffect(() => {
    if (!onFlushPendingChange) return;
    onFlushPendingChange(flushPendingLocalUpdate);
    return () => onFlushPendingChange(null);
  }, [flushPendingLocalUpdate, onFlushPendingChange]);
  // `useEditor` only consumes `content` while creating the editor, but its
  // options object is evaluated on every React render. Parsing here lazily
  // avoids reparsing an entire Markdown document when editor chrome mounts or
  // local status changes; later source updates are reconciled below.
  const [initialContent] = useState(() => structuredClone(cachedVisualDocument(activePath, text).content));

  useEffect(() => {
    if (!workspaceIndex) return;
    const indexed = indexedDocumentRef.current;
    if (indexed?.index !== workspaceIndex || indexed.path !== activePath) {
      indexedDocumentRef.current = { index: workspaceIndex, path: activePath };
      workspaceIndex.noteDocumentContent(activePath, text);
      return;
    }
    return whenIdle(() => workspaceIndex.noteDocumentContent(activePath, text), 1_000, 400);
  }, [workspaceIndex, activePath, text]);

  const host = useMemo(
    () => hostExtensions({ latest, activePathRef, flushPendingLocalUpdate }, i18n, onImportAsset),
    [flushPendingLocalUpdate, i18n, onImportAsset],
  );
  useEffect(() => whenIdle(() => host.slashSources.forEach((source) => source()), 600, 80), [host]);

  const editor = useEditor({
    // Upstream default (false): the vendored chrome (BubbleMenuBar,
    // TableCellHandles, …) subscribes to editor state itself via
    // useEditorState; re-rendering this host per transaction feeds a
    // render→dispatch cycle that React aborts as an infinite update loop.
    shouldRerenderOnTransaction: false,
    // The matching Markdown eligibility effect is the sole initial owner of
    // editability. Starting writable leaves a gap where onUpdate correctly
    // ignores initialization but a queued user key would be lost with it.
    editable: false,
    extensions: [
      ...visualEditorExtensions(host.image),
      SourceDirtyObserver,
      // Keep WebKit's native caret. The old fixed-height overlay listened to
      // every ancestor scroll and forced coordsAtPos/layout work per frame.
      visualPresence.extension,
      visualTrackChanges.extension,
      visualComments.extension,
      // Vendored Open Knowledge chrome: block "+"/grip, keyboard block nav,
      // slash menu, table insert bars, frozen headers, footnote scrolling.
      // BridgeIdPlugin must precede SelectionStatePlugin (priority 1000 in
      // the extension itself); both power JsxComponentView's selection halo
      // and ancestor-chain chrome.
      BridgeIdPlugin,
      SelectionStatePlugin,
      VisualBlockControls,
      VisualBlockMover,
      CalloutEnterGuard,
      KeyboardNav,
      SlashCommand.configure({ itemsSources: host.slashSources, categoryLabels: slashCategoryLabels(i18n) }),
      TiptapFindReplace,
      ...(optimizeForReading ? [ChunkWrapperDecoration, GeneratedPaperContents] : [TableInsertControls, LatticeFrozenTableHeaders]),
      FootnoteAnchorScroll,
      FormattingShortcuts,
      TabFocusTrap,
      HeadingAnchors,
      MathInputRule,
      InlineLinkInputRule,
      host.wikiLinks,
      host.citations,
      VisualLinkHover,
      TableRowEnter,
      host.shortcuts,
      AtomicBlockSelection,
    ],
    content: initialContent,
    editorProps: {
      attributes: (state) => ({
        "aria-label": "Markdown document editor",
        "aria-multiline": "true",
        role: "textbox",
        // Only a real NodeSelection should suppress the browser's native
        // text-selection paint. Key on the selection type, not on
        // ProseMirror-selectednode: before @tiptap/react 3.31, NodeViews
        // enclosed by a text range or AllSelection carried that class too.
        "data-node-selection": String(state.selection instanceof NodeSelection),
      }),
      // Return used to commit a macOS IME candidate is not an editing Enter.
      // Consuming it keeps lower-priority container shortcuts from observing
      // the transient empty composition paragraph and turning the Callout into
      // a selected, zero-height component. A Return after compositionend
      // remains an ordinary paragraph split.
      handleKeyDown: (_view, event) => event.key === "Enter"
        && (event.isComposing || event.keyCode === 229 || composing.current),
      handleDOMEvents: {
        compositionstart: () => {
          clearTimer(compositionClearTimer);
          composing.current = true;
          return false;
        },
        compositionend: () => {
          // WebKit can dispatch compositionend immediately before the Enter
          // keydown that committed the candidate. Keep the guard alive through
          // the current event turn so that trailing Enter cannot reach the
          // container-exit shortcut and select/collapse the Callout.
          clearTimer(compositionClearTimer);
          compositionClearTimer.current = setTimeout(() => {
            composing.current = false;
            compositionClearTimer.current = null;
          }, 0);
          const pending = pendingCanonical.current;
          pendingCanonical.current = null;
          if (pending != null) queueMicrotask(() => reconcileCanonical(pending));
          return false;
        },
        blur: () => {
          flushPendingLocalUpdate();
          return false;
        },
        // Links with an href are routed by the section's click capture before
        // ProseMirror sees the event; only the cases below reach it.
        click: (view, event) => {
          const target = event.target as HTMLElement | null;
          const cell = target?.closest<HTMLTableCellElement>("td, th");
          const plainClick = event.button === 0 && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey;
          if (plainClick && cell?.querySelector(".visual-overleaf-caret")) {
            const cellFrom = view.posAtDOM(cell, 0);
            const cellTo = view.posAtDOM(cell, cell.childNodes.length);
            const current = view.state.selection;
            // Let WebKit's native mousedown/mousemove selection stand. Only a
            // collapsed click that still landed outside the occupied cell
            // (a peer caret widget is its hit target) needs this fallback.
            if (current.empty && (current.from < cellFrom || current.from > cellTo)) {
              const pointer = view.posAtCoords({ left: event.clientX, top: event.clientY });
              let selection = TextSelection.near(view.state.doc.resolve(Math.min(Math.max(pointer?.pos ?? cellFrom, cellFrom), cellTo)), 1);
              if (selection.from < cellFrom || selection.from > cellTo) {
                selection = TextSelection.near(view.state.doc.resolve(cellFrom), 1);
              }
              event.preventDefault();
              view.dispatch(view.state.tr.setSelection(selection));
              view.focus();
              return true;
            }
          }
          if (target?.matches("hr")) {
            event.preventDefault();
            view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, view.posAtDOM(target, 0))));
            return true;
          }
          const wikiTarget = event.metaKey || event.ctrlKey ? target?.closest<HTMLElement>("[data-wiki-link]")?.dataset.target : undefined;
          const wikiDoc = wikiTarget ? latest.current.workspaceIndex?.getDoc(wikiTarget) : undefined;
          if (wikiDoc) {
            event.preventDefault();
            latest.current.onOpenProjectPath?.(wikiDoc.path);
            return true;
          }
          if (!target?.closest("a")) return false;
          event.preventDefault();
          return true;
        },
      },
    },
    onUpdate: ({ editor: currentEditor, transaction }) => {
      if (!editorReadyForChanges.current || transaction.getMeta("preventUpdate") === true) return;
      if (isMultilineTextNormalization(transaction)) return;
      const viewportAnchor = transaction.getMeta(PRESERVE_VISUAL_VIEWPORT_META) as PreserveVisualViewportMeta | undefined;
      if (viewportAnchor) requestViewportLock(currentEditor, viewportAnchor, latest.current.onRequestViewportLock);
      const changedBlocks = changedTopLevelBlocks(transaction);
      for (const index of pendingLocalUpdate.current?.changedBlocks ?? []) changedBlocks.add(index);
      pendingLocalUpdate.current = {
        editor: currentEditor,
        explicitReplacement: transaction.getMeta("preventUpdate") === false,
        changedBlocks,
        viewportAnchor: viewportAnchor ?? pendingLocalUpdate.current?.viewportAnchor ?? null,
      };
      // Every preview uses the same adaptive publication boundary. The editor
      // DOM remains immediate; source serialization waits for an idle pause,
      // with a bounded maximum delay during sustained typing.
      clearTimer(localUpdateTimer);
      const policy = markdownPreviewSyncPolicy(latest.current.text.length);
      localUpdateTimer.current = setTimeout(flushPendingLocalUpdate, policy.publicationIdleMs);
      if (!localUpdateMaxTimer.current) localUpdateMaxTimer.current = setTimeout(flushPendingLocalUpdate, policy.publicationMaxMs);
    },
    onSelectionUpdate: ({ editor: currentEditor }) => {
      const selection = currentEditor.state.selection;
      latest.current.onSelectionMarkdown?.(selection.empty ? "" : serializeWysiwygSelection(currentEditor));
      scheduleVisualCaretReport(currentEditor);
    },
    onFocus: ({ editor: currentEditor }) => scheduleVisualCaretReport(currentEditor),
  // Recreate only when reading-mode chrome changes. File switches reuse this
  // instance via the path-swap effects below — remounting TipTap is what made
  // .md navigation feel slow.
  }, [optimizeForReading]);
  useVisualCommentInteractions(sectionRef, {
    editor,
    comments: editorComments,
    activePath,
    tooltipId: commentTooltipId,
    onOpen: onEditorCommentClick,
  });
  const initialHandoffRef = useRef(initialHandoff);
  useLayoutEffect(() => {
    const requested = initialHandoffRef.current;
    if (!editor || editor.isDestroyed || !requested) return;
    initialHandoffRef.current = undefined;
    queueMicrotask(() => onConsumeInitialHandoff?.());
    return applyPassiveHandoff(editor, requested, text, activePath, onOpenProjectPath);
  }, [activePath, editor, onConsumeInitialHandoff, onOpenProjectPath, text]);
  const reconcileCanonical = useCallback((canonical: string) => {
    if (!editor || editor.isDestroyed || canonical === acceptedMarkdown.current) return;
    const base = acceptedMarkdown.current;
    // Parser/serializer formatting drift is not authorship. Only an actual
    // pending editor transaction (or an already preserved rejection) can be a
    // local draft when an Agent or collaborator replaces the canonical text.
    const hasPendingDraft = conflictDraftRef.current != null || pendingLocalUpdate.current != null;
    const draft = conflictDraftRef.current
      ?? (hasPendingDraft ? serializeMarkdown(editor, base, undefined, activePathRef.current) : base);
    if (hasPendingDraft && draft !== base) {
      const rebased = rebaseMarkdownDraft(base, draft, canonical);
      if (rebased != null && latest.current.onChangeMarkdown(rebased, canonical)) {
        acceptedMarkdown.current = rebased;
        conflictDraftRef.current = null;
        setConflictDraft(null);
        setMarkdownWithoutHistory(editor, rebased, activePathRef.current);
        refreshVisualPresence(editor, rebased);
        refreshVisualTrackChanges(editor, rebased, []);
        return;
      }
      setConflictDraft(draft);
    }
    acceptedMarkdown.current = canonical;
    setMarkdownWithoutHistory(editor, canonical, activePathRef.current);
    refreshVisualPresence(editor, canonical);
    refreshVisualTrackChanges(editor, canonical);
  }, [editor, refreshVisualPresence, refreshVisualTrackChanges]);

  /**
   * A failed publish is an error like any other, so it belongs in the app's
   * notifications rather than wedged into the document as a red bar the reader
   * has to scroll past. Its ordinary Copy action remains a useful error report;
   * the rejected document has a separately labelled Copy draft action so the
   * two payloads cannot be mistaken for each other.
   */
  useEffect(() => {
    if (conflictDraft == null) return;
    const key = `visual-conflict:${activePath}`;
    const dismiss = () => {
      conflictDraftRef.current = null;
      setConflictDraft(null);
    };
    notifyError(t`Preview`, t`This document changed in the same place`, {
      detail: t`The shared version is shown. Your visual draft was kept — copy it, or restore it and try again.`,
      timeoutMs: 0,
      dedupeKey: key,
      primaryAction: { label: t`Copy draft`, onClick: () => writeText(conflictDraft) },
      secondaryAction: {
        label: t`Restore draft and retry`,
        onClick: () => {
          if (editor && !editor.isDestroyed) setMarkdownWithoutHistory(editor, conflictDraft, activePathRef.current);
          dismiss();
        },
      },
      onDismiss: dismiss,
    });
    return () => dismissAppToastByDedupeKey(key);
  }, [activePath, conflictDraft, editor, t]);

  useEffect(() => {
    if (!editor) return;
    const canEdit = editable && editorReadyForChanges.current;
    if (editor.isEditable !== canEdit) editor.setEditable(canEdit);
  }, [editable, editor]);

  const resetTransientUi = () => {
    setCommentComposer(null);
    setLinkPopoverOpen(false);
  };

  // Flush edits against the old publisher before the passive ref refresh. The
  // actual ProseMirror replacement is scheduled as a task below: TipTap's
  // ReactNodeViewRenderer uses flushSync while constructing NodeViews, which
  // React explicitly forbids from inside a lifecycle method.
  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed || activePathRef.current === activePath) return;
    flushPendingLocalUpdate();
    // The App owner has already accepted the final old-path flush before it
    // commits a new activePath. Ignore any blur/NodeView bookkeeping emitted
    // while this old DOM is disabled and waiting for the painted handoff;
    // letting it repopulate pendingLocalUpdate would attach obsolete work to
    // the incoming document generation.
    editorReadyForChanges.current = false;
    editor.commands.blur();
    editor.setEditable(false);
    resetTransientUi();
    const scroller = sectionRef.current?.closest<HTMLElement>("[data-testid='editor-scroll-container']");
    if (scroller) scroller.scrollTop = 0;
  }, [activePath, editor, flushPendingLocalUpdate]);

  // Swap TipTap content across .md files without tearing down the editor. A
  // frame followed by a task gives WebKit a real paint opportunity for the
  // lightweight opening state. A zero-delay task alone can run before paint,
  // leaving the old document frozen on screen throughout a long parse.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (activePathRef.current === activePath) {
      // A rapid A → B → A navigation can cancel B's scheduled replacement
      // after the layout effect disabled A. Restore the retained document
      // instead of leaving its TipTap surface permanently read-only.
      if (renderedPath === activePath && acceptedMarkdown.current === text && eligibility.current?.text === text) {
        editorReadyForChanges.current = true;
        const canEdit = editable && eligibility.current.exact;
        if (editor.isEditable !== canEdit) editor.setEditable(canEdit);
      }
      return;
    }
    let timer: number | null = null;
    const frame = window.requestAnimationFrame(() => {
      timer = window.setTimeout(() => {
        if (editor.isDestroyed) return;
        activePathRef.current = activePath;
        composing.current = false;
        clearTimer(compositionClearTimer);
        pendingCanonical.current = null;
        conflictDraftRef.current = null;
        setConflictDraft(null);
        resetTransientUi();
        eligibility.current = null;
        editorReadyForChanges.current = false;
        acceptedMarkdown.current = text;
        const handoffStartedAt = performance.now();
        setMarkdownWithoutHistory(editor, text, activePath);
        const handoffEndedAt = performance.now();
        const handoffMs = handoffEndedAt - handoffStartedAt;
        try {
          performance.measure("lattice:visual-markdown-handoff", {
            start: handoffStartedAt,
            end: handoffEndedAt,
            detail: { path: activePath },
          });
        } catch {
          // Older WebKit builds do not support PerformanceMeasureOptions.detail.
        }
        if (handoffMs >= 50) {
          addAppLog({
            level: "info",
            source: "Navigation performance",
            title: "Visual Markdown handoff",
            detail: `${activePath}\nsetContentMs=${handoffMs.toFixed(1)}`,
            toast: false,
          });
        }
        // Fresh history so Undo cannot walk back into the previous file.
        editor.view.updateState(EditorState.create({ doc: editor.state.doc, plugins: editor.state.plugins }));
        // Eligibility still belongs to the outgoing document. Keep the new
        // tree inert until its round-trip check installs the matching owner;
        // otherwise a queued key can mutate ProseMirror while onUpdate is
        // intentionally ignoring initialization transactions.
        editor.setEditable(false);
        setRenderedPath(activePath);
      }, 0);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (timer != null) window.clearTimeout(timer);
    };
  }, [activePath, editable, editor, renderedPath, text]);

  useEffect(() => {
    // Path swaps are handled above; skip the reconcile echo for the same
    // commit so we do not double-apply content.
    if (!editor || activePathRef.current !== activePath || text === acceptedMarkdown.current) return;
    if (composing.current) {
      pendingCanonical.current = text;
      return;
    }
    queueMicrotask(() => {
      if (editor.isDestroyed || latest.current.text !== text || text === acceptedMarkdown.current) return;
      if (activePathRef.current === activePath) reconcileCanonical(text);
    });
  }, [activePath, editor, reconcileCanonical, text]);

  useLayoutEffect(() => () => {
    // Keyboard mode/tab switches can unmount the editor without a DOM blur.
    // Publish the pending ProseMirror state while the editor is still alive so
    // the paper debounce cannot discard the user's final input.
    flushPendingLocalUpdate();
    clearTimer(compositionClearTimer);
    clearTimer(localUpdateTimer);
    clearTimer(localUpdateMaxTimer);
  }, [flushPendingLocalUpdate]);

  useEffect(() => {
    if (!editor || renderedPath !== activePath || activePathRef.current !== activePath) return;
    if (eligibility.current?.text === text) {
      onEligibilityChange?.(eligibility.current.exact ? null : VISUAL_EDITING_UNAVAILABLE_REASON);
      return;
    }
    // Eligibility is a property of the source parser's round trip, not of the
    // live Editor instance. The editor can still be applying initialization or
    // path-switch transactions while a tutorial advances, which made the same
    // lossless paper appear incompatible only during the guided flow.
    const representedExactly = isRepresentedExactly(activePath, text, editor.state.schema);
    eligibility.current = { text, exact: representedExactly };
    const reason = representedExactly ? null : VISUAL_EDITING_UNAVAILABLE_REASON;
    setEligibilityReason(reason);
    onEligibilityChange?.(reason);
    const canEdit = representedExactly && editable;
    if (editor.isEditable !== canEdit) editor.setEditable(canEdit);
    editorReadyForChanges.current = true;
  }, [activePath, editable, editor, onEligibilityChange, renderedPath, text]);

  const editorViewMounted = useEditorViewMounted(editor);

  useEffect(() => {
    if (editor && editorViewMounted && !editor.isDestroyed) reportVisualCaret(editor, acceptedMarkdown.current);
  }, [editor, editorViewMounted, reportVisualCaret]);

  useEffect(() => {
    const cursors = presenceCursors ?? [];
    if (!editor || !editorViewMounted || editor.isDestroyed || text !== acceptedMarkdown.current) return;
    if (!cursors.length && !presenceWasActive.current) return;
    presenceWasActive.current = cursors.length > 0;
    visualPresence.publish(editor, { text, sourcePath: activePath, cursors });
  }, [activePath, editor, editorViewMounted, presenceCursors, text]);

  useEffect(() => {
    const changes = overleafChanges ?? [];
    if (!editor || !editorViewMounted || editor.isDestroyed || text !== acceptedMarkdown.current) return;
    if (!changes.length && !trackChangesWereActive.current) return;
    trackChangesWereActive.current = changes.length > 0;
    visualTrackChanges.publish(editor, { text, sourcePath: activePath, changes });
  }, [activePath, editor, editorViewMounted, overleafChanges, text]);

  useLayoutEffect(() => {
    if (!editor || !editorViewMounted || editor.isDestroyed) return;
    // Use the accepted source, including edits flushed when the composer opens.
    // The parent prop can lag behind; cancellation must still clear the draft.
    if (!editorComments.length && !commentComposer && !commentsWereActive.current) return;
    commentsWereActive.current = editorComments.length > 0 || Boolean(commentComposer);
    visualComments.publish(editor, {
      text: acceptedMarkdown.current,
      sourcePath: activePath,
      comments: editorComments,
      draft: commentComposer,
      activeId: activeEditorCommentId,
      tooltipId: commentTooltipId,
      labelForAuthor: (authorName) => {
        const author = editorCommentAuthorDisplayName(authorName, anonymousAuthor);
        return t({ message: `Comment by ${author}` });
      },
    });
  }, [activeEditorCommentId, activePath, anonymousAuthor, commentComposer, commentTooltipId, editor, editorComments, editorViewMounted, i18n.locale, t, text]);

  useEffect(() => {
    if (!editor || !editorViewMounted || !synchronizeSourceScroll) return;
    const editorDom = sectionRef.current?.querySelector<HTMLElement>(".ProseMirror");
    let active = true;
    let sourceRanges: VisualSourceRange[] | null = null;
    const labelSourceBlocks = () => {
      if (!active || editor.isDestroyed || !editorDom) return;
      const renderedBlocks = Array.from(editorDom.children);
      if (sourceRanges?.length !== renderedBlocks.length) sourceRanges = visualSourceRanges(text, renderedBlocks.length);
      const ranges = sourceRanges;
      // Source labels are synchronization metadata, not editable document
      // attributes. Keep ProseMirror's DOM observer from reparsing the whole
      // document when these data attributes change; reparsing destroys every
      // React NodeView and visibly reloads images, Mermaid, and HTML previews.
      withPausedDomObserver(editor.view, () => {
        let previousOffset = 0;
        let sourceLine = 1;
        for (const [index, element] of renderedBlocks.entries()) {
          if (!(element instanceof HTMLElement)) continue;
          const range = ranges[index];
          if (!range) {
            labelSourceBlock(element);
            continue;
          }
          sourceLine += text.slice(previousOffset, range.from).split(/\r\n|\r|\n/).length - 1;
          previousOffset = range.from;
          labelSourceBlock(element, [String(sourceLine), String(range.from), String(range.to)]);
        }
      });
    };
    labelSourceBlocks();
    // A canonical source update is reconciled in a microtask above. Label the
    // blocks again after that transaction so inserted or removed blocks receive
    // the source positions for their new DOM nodes, rather than the old tree.
    queueMicrotask(labelSourceBlocks);
    return () => {
      active = false;
    };
  }, [editor, editorViewMounted, synchronizeSourceScroll, text]);

  useEffect(() => {
    if (!editor || !editorViewMounted || !synchronizeSourceScroll) return;
    const editorDom = sectionRef.current?.querySelector<HTMLElement>(".ProseMirror");
    return () => {
      for (const element of Array.from(editorDom?.children ?? [])) {
        if (element instanceof HTMLElement) labelSourceBlock(element);
      }
    };
  }, [editor, editorViewMounted, synchronizeSourceScroll]);

  const viewInSource = useCallback((selectedEditor: Editor) => {
    if (!onViewInSource || !flushPendingLocalUpdate()) return;
    const { view, state } = selectedEditor;
    const { selection } = state;
    const blockIndex = selection.$from.index(0);
    const renderedBlock = view.dom.children[blockIndex];
    let viewportY: number | undefined;
    let blockViewportY: number | undefined;
    try {
      const { top, bottom } = view.coordsAtPos(selection.from);
      if (Number.isFinite((top + bottom) / 2)) viewportY = (top + bottom) / 2;
    } catch {
      // The DOM selection can briefly be unavailable while a NodeView updates.
      // Source navigation still works; it falls back to centering the target.
    }
    const viewport = view.dom.closest<HTMLElement>(".editor-doc-scroll");
    if (renderedBlock instanceof HTMLElement && viewport) {
      const offset = renderedBlock.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      if (Number.isFinite(offset)) blockViewportY = offset;
    }
    const source = acceptedMarkdown.current;
    const mapped = sourceOffsetForProseMirrorPosition(selectedEditor, selection.from, source);
    const blockSourceOffset = renderedBlock instanceof HTMLElement ? Number(renderedBlock.dataset.sourceOffset) : Number.NaN;
    const sourceOffset = mapped?.markdown === source
      ? mapped.offset
      : Number.isFinite(blockSourceOffset)
        ? blockSourceOffset
        : visualSourceRanges(source, state.doc.childCount)[blockIndex]?.from ?? 0;
    onViewInSource(sourceOffset, viewportY, blockViewportY);
  }, [flushPendingLocalUpdate, onViewInSource]);

  const openVisualCommentComposer = useCallback(() => {
    if (!editor || !onCreateComment) return;
    // The bubble button preserves editor focus, so blur has not published a
    // pending edit. Anchor against the current document, not its stale source.
    if (!flushPendingLocalUpdate()) return;
    const { from, to, empty } = editor.state.selection;
    if (empty) return;
    const source = acceptedMarkdown.current;
    const mapOffset = (position: number) => {
      const mapped = blockSourceOffsetForPosition(editor, position, source)
        ?? sourceOffsetForProseMirrorPosition(editor, position, source);
      return mapped?.markdown === source ? mapped.offset : null;
    };
    const sourceFrom = mapOffset(from);
    const sourceTo = mapOffset(to);
    if (sourceFrom === null || sourceTo === null || sourceTo <= sourceFrom) {
      notifyError(t`Comment`, t`Cannot precisely locate this selection in Markdown source. Switch to Source view to add a comment.`);
      return;
    }
    const quote = source.slice(sourceFrom, sourceTo);
    if (!quote.trim()) return;
    const rect = posToDOMRect(editor.view, from, to);
    setCommentComposer({
      path: activePath,
      from: sourceFrom,
      to: sourceTo,
      quote,
      prefix: source.slice(Math.max(0, sourceFrom - 32), sourceFrom),
      suffix: source.slice(sourceTo, sourceTo + 32),
      body: "",
      error: null,
      left: Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 328)),
      top: Math.min(window.innerHeight - 220, rect.bottom + 8),
    });
  }, [activePath, editor, flushPendingLocalUpdate, onCreateComment, t]);

  if (!editor) return <div aria-label="Loading Markdown editor" />;

  const closeCommentComposer = () => {
    setCommentComposer(null);
    editor.commands.focus();
  };
  const submitVisualComment = () => {
    if (!commentComposer || !commentComposer.body.trim() || !onCreateComment) return;
    if (commentComposer.path !== activePath) {
      setCommentComposer(null);
      return;
    }
    const range = resolveCommentAnchor(acceptedMarkdown.current, commentComposer);
    if (!range) {
      setCommentComposer((current) => current && {
        ...current,
        error: t`The selected text changed. Select it again before commenting.`,
      });
      return;
    }
    onCreateComment(range.from, range.to, commentComposer.body.trim());
    closeCommentComposer();
  };
  const openLink = (href: string) => openMarkdownLink(activePath, href, latest.current.onOpenProjectPath, sectionRef.current ?? undefined);

  const documentPending = renderedPath !== activePath;
  return (
    <section
      ref={sectionRef}
      className={`visual-markdown-editor${optimizeForReading ? " optimize-for-reading" : ""}${documentPending ? " is-document-pending" : ""}`}
      data-active-path={activePath}
      aria-busy={documentPending}
      aria-label={t`Visual Markdown editor`}
      onPointerDownCapture={(event) => {
        // Re-selecting the same block does not emit a ProseMirror selection
        // update, so publish it again after the host surface clears its context.
        if (!(event.target instanceof HTMLElement) || !event.target.closest(".ok-drag-grip")) return;
        if (!editor.state.selection.empty) latest.current.onSelectionMarkdown?.(serializeWysiwygSelection(editor));
      }}
      onClickCapture={(event) => {
        // Link marks install their own click handler before editorProps are
        // consulted. Capture at the host boundary so ordinary project links
        // and anchors consistently use the application router.
        const href = event.target instanceof HTMLElement
          ? event.target.closest("a[href]")?.getAttribute("href")
          : null;
        if (!href) return;
        event.preventDefault();
        event.stopPropagation();
        openLink(href);
      }}
    >
      <DocumentHeadingRail
        items={documentPending ? [] : headingItems}
        onSelect={(item) => openLink(`#${encodeURIComponent(item.id)}`)}
      />
      {documentPending && (
        // App already announces the complete file-opening operation. Keep the
        // same centered activity cue while TipTap finishes its handoff, but do
        // not present it as a second status or repeat “Opening document”.
        <div className="visual-markdown-loading" aria-hidden="true">
          <InfinityLoader size={16} />
        </div>
      )}
      {!documentPending && (
        <VisualMarkdownFindReplace
          key={activePath}
          editor={editor}
          editable={editable && !eligibilityReason}
          editorRoot={sectionRef}
        />
      )}
      {!documentPending && commentComposer && (
        <VisualCommentComposer
          composer={commentComposer}
          onChange={(body) => setCommentComposer((current) => current && { ...current, body })}
          onCancel={closeCommentComposer}
          onSubmit={submitVisualComment}
        />
      )}
      <TrackedChangeLayer
        key={`${activePath}\n${renderedPath}`}
        sectionRef={sectionRef}
        changes={overleafChanges ?? []}
        actions={overleafTrackChangeActions}
        hidden={documentPending}
      />
      {/* A parent may own this notice so it can sit before surrounding chrome,
          such as a downloaded paper's generated title. */}
      {!documentPending && eligibilityReason && !onEligibilityChange && (
        <InlineMessage level="warning" className="visual-markdown-eligibility">
          {eligibilityReason}
          {onEditSource && <button type="button" onClick={onEditSource}>Edit Markdown source</button>}
        </InlineMessage>
      )}
      {/* Upstream DOM shape (TiptapEditor.tsx): the .tiptap-editor grid
          directly contains the bubble menu, the table cell handle layer
          (pinned to grid row 1), and EditorContent as the content-column
          grid item. `.editor-doc-scroll` lives on the ScrollArea viewport
          ancestor (document-canvas.tsx) per upstream's scroll-container
          contract (bubble-menu-clip.ts resolves it via closest()). Keep the
          portal plane outside controlled Markdown echo renders: NodeView
          subscriptions update their own chrome, and unchanged image, Mermaid,
          and HTML views must retain their mounted DOM and state. */}
      <VisualEditorSurface
        editor={editor}
        activePath={renderedPath}
        onLoadAsset={onLoadAsset}
        assetRevision={assetRevision}
        workspaceIndex={workspaceIndex}
        viewInSource={viewInSource}
        editorViewMounted={editorViewMounted}
        openVisualCommentComposer={onCreateComment ? openVisualCommentComposer : null}
        bubbleMenuHidden={documentPending || linkPopoverOpen || Boolean(commentComposer)}
        editable={editable && !documentPending}
        onLinkPopoverOpenChange={setLinkPopoverOpen}
      />
    </section>
  );
}

/**
 * Large documents begin in a bounded, passive block viewport. The first
 * editing or native-selection gesture hands off once to the complete editor,
 * which remains the only writable surface until block-scoped editing owns all
 * cross-block commands. Uncertain source ownership always keeps the complete
 * editor.
 */
export function VisualMarkdownEditor(props: VisualMarkdownEditorProps): JSX.Element {
  // Publish before either passive chunks or the complete editor can construct
  // eager math NodeViews. The existing renderer seam is process-global.
  setHostKatexMacros(props.macros ?? EMPTY_MACROS);
  const [completeSession, setCompleteSession] = useState<{ path: string; handoff: PassiveEditorHandoff | null } | null>(null);
  const hasDocumentOverlays = (props.presenceCursors?.length ?? 0) > 0
    || (props.overleafChanges?.length ?? 0) > 0
    || (props.editorComments?.some((comment) => !comment.resolved) ?? false);
  // An editable document must keep one scroll geometry from opening through
  // the first click. Switching from estimated passive chunks to the complete
  // TipTap tree on pointer-down changes the scroll height (and therefore the
  // scrollbar thumb) before the clicked block can be anchored reliably.
  const mayUsePassiveViewport = props.editable === false
    && props.text.length >= VIRTUAL_BLOCK_MODEL_SOURCE_THRESHOLD
    && completeSession?.path !== props.activePath
    && !hasDocumentOverlays;
  const model = useMemo(
    () => mayUsePassiveViewport ? buildVisualMarkdownBlockModel(props.text, props.activePath) : null,
    [mayUsePassiveViewport, props.activePath, props.text],
  );
  const consumeInitialHandoff = useCallback(() => {
    setCompleteSession((current) => current && { ...current, handoff: null });
  }, []);

  if (model && (props.text.length >= LARGE_MARKDOWN_PREVIEW_THRESHOLD || model.blocks.length >= VIRTUAL_BLOCK_COUNT_THRESHOLD)) {
    return (
      <PassiveVisualMarkdownViewport
        key={`${props.activePath}:${model.id}`}
        model={model}
        activePath={props.activePath}
        optimizeForReading={Boolean(props.optimizeForReading)}
        onLoadAsset={props.onLoadAsset}
        assetRevision={props.assetRevision ?? 0}
        onOpenProjectPath={props.onOpenProjectPath}
        workspaceIndex={props.workspaceIndex}
        onActivate={(handoff) => setCompleteSession({
          path: props.activePath,
          handoff: { ...handoff, sourceOffset: handoff.sourceOffset + model.sourceOffsetBase },
        })}
      />
    );
  }
  return (
    <CompleteVisualMarkdownEditor
      {...props}
      initialHandoff={completeSession?.path === props.activePath ? completeSession.handoff ?? undefined : undefined}
      onConsumeInitialHandoff={consumeInitialHandoff}
    />
  );
}
