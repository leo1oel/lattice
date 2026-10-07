/**
 * The Trellis workspace: Project, Papers, Agent, the PDF and every
 * drawer as dockable panels, and document panels between them.
 *
 * See trellis-controller.ts for the contract with App. In short, App renders
 * everything; this component arranges stable host elements. Documents follow
 * App's single-active-document model: the active document's panel adopts the
 * live editor host, and every other document panel shows a read-only snapshot
 * (text, drawn the way it opens; a Paper; a PDF or an image) or a sleeping
 * card (boards, sheets) until it is clicked. A panel that is not on screen
 * renders nothing at all. Decks are the exception: each open one keeps its
 * own live host (see DeckSlot).
 */
import { Suspense, memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react/macro";
import {
  Workspace, ViewType, useCloseGuard, useView, useViewBadge,
  type LayoutDocument, type MenuEntry, type MenuItem, type MenuRequest, type ViewHandle, type ViewInfo,
  type WorkspaceHandle,
} from "@danfessler/trellis-react";
import type { LayoutNode, PanelNode } from "@danfessler/trellis";
import "@danfessler/trellis/style.css";
// Panel menus open at the pointer, with submenus and without the fluid hover
// surface of the shared DropdownMenuContent, so they build on the primitive.
// eslint-disable-next-line no-restricted-imports -- see above
import { DropdownMenu as MenuPrimitive } from "radix-ui";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { BookOpen, Check, ChevronRight, FileText, FolderTree, Moon, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { floatingSurfaceClassName, menuItemClassName, menuViewportClassName } from "@/components/ui/menu-surface";
import { popupMotionClassName } from "@/components/ui/popup-motion";
import { confirmAction, isOpenSlideDeckPath, markdownFrontmatterEnd } from "../app-utils";
import { isSpreadsheetPath } from "../editor/spreadsheet/spreadsheet-types";
import { luxLatexHighlightStyle } from "../editor/latex/latex-editor";
import { isLatexSourcePath, useTextLanguageExtensions } from "../canvas/editor-extensions";
import { latex } from "../editor/latex/latex-language";
import { revealExtension } from "../editor/editor-reveal";
import { resumeParkedEditor } from "../editor/parked-editors";
import { sourceGutter } from "../editor/source-gutter";
import { DeferredVisualMarkdownEditor } from "../canvas/canvas-lazy-editors";
import { Tip } from "../components/icon-tip";
import { ProjectAssetPreview } from "../canvas/project-asset-preview";
import { capturePreviewViewport, restorePreviewViewport } from "../canvas/markdown-preview-sync";
import type { AssetPreview } from "../app-types";
import {
  TOOL_KINDS, documentTools, useTrellisApp, type TrellisController, type TrellisSingleton, type TrellisToolKind,
} from "./trellis-controller";
import {
  arrangeDocuments, defaultLayout, differsFromWorkspace, enterPreset, filledSlots, keepDocumentSlot, openProjectLayout, placesOf,
  returnLayout, saveLayout, undoReset, workspaceArrangement,
  VIEW_TYPES, type ActivePreset, type DocumentPlaces,
} from "./trellis-layout";
import { notifyInfo } from "../telemetry/app-notify";
import { dismissAppToastByDedupeKey } from "../telemetry/app-log-store";
import { installTrellisLabels } from "./trellis-labels";
import { arrangementOf, layoutShape, NAVIGATORS, withDocumentPanel } from "./trellis-workspaces";
import { PANEL_TITLES, spaceMixedScript } from "./trellis-titles";
import { MENU_ICONS, PANEL_ICONS, fileIcon } from "./trellis-icons";
import { FileHeaderTools } from "./trellis-header-tools";
import { AfterSwitch } from "../canvas/after-switch";
import { measurePdfToolbarMinWidth } from "../pdf/pdf-toolbar-min-width";
import { holdWidthsWhileResizing } from "./trellis-hold-width";
import { isProjectFileMissing } from "../pdf/project-pdf-refusals";
import { useProjectPdfWatch } from "../pdf/use-project-pdf-watch";
import "./trellis.css";

// The live source editor parses LaTeX with Lattice's own `latex()`, not the
// `@codemirror/language-data` stex mode `useTextLanguageExtensions` would find:
// the two tag tokens differently, so the same highlight style painted a
// snapshot in another palette until it was clicked into.
const LATEX_SNAPSHOT_LANGUAGE = [latex()];

// Before any workspace exists: Trellis writes some labels once, at creation.
installTrellisLabels();

/** How long a heavy panel may be off screen before it unmounts. */
const HIBERNATE_AFTER_MS = 20_000;

/** Content minima only. The Trellis patch separately reserves header actions
 * and all tabs at 80px each (capped at 480px; under it the tabs shrink and the
 * actions give way before the strip scrolls, see trellis.css). A panel
 * is as wide as the widest of its views needs, so selecting another tab never
 * resizes it. The Agent and the PDF raise theirs to what their live content
 * measures (see `measuredMinSize`). */
const MIN_SIZE = {
  project: { width: 140, height: 120 },
  papers: { width: 180, height: 120 },
  agent: { width: 220, height: 200 },
  pdf: { width: 220, height: 160 },
  file: { width: 180, height: 140 },
  tool: { width: 200, height: 160 },
} as const;

/**
 * A static minimum raised to a width measured from the live content (0 until
 * measured). Trellis reads `minSize.width` whenever it lays out, so a getter
 * follows the measurement without re-rendering the workspace; the workspace
 * asks Trellis to lay out again when a measurement changes.
 */
function measuredMinSize(base: { width: number; height: number }, measured: () => number) {
  return {
    get width() { return Math.max(base.width, measured()); },
    height: base.height,
  };
}


type FileParams = { key: string };

function findPanel(node: LayoutNode, id: string): PanelNode | null {
  if (node.kind === "panel") return node.id === id ? node : null;
  if (node.kind === "stage") return node.child ? findPanel(node.child, id) : null;
  for (const child of node.children) {
    const found = findPanel(child, id);
    if (found) return found;
  }
  return null;
}

/** Boards, sheets and decks: expensive enough to unmount when their panel is off screen, and never drawn as a text snapshot. */
function isHeavyDocument(key: string) {
  return key.toLocaleLowerCase().endsWith(".tldr") || isSpreadsheetPath(key) || isOpenSlideDeckPath(key);
}

/**
 * Adopt a host element App portals into; it never leaves this slot while
 * mounted. `inline` slots sit in a tab bar and take only their content's
 * width: a full-size slot there would cover the bar and swallow the drags
 * and clicks that belong to it.
 */
function HostSlot({ host, className, inline = false }: { host: HTMLElement; className?: string; inline?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = ref.current;
    if (!slot) return;
    slot.appendChild(host);
    return () => {
      if (host.parentElement === slot) slot.removeChild(host);
    };
  }, [host]);
  return <div ref={ref} className={cn(inline ? "trellis-slot-inline" : "trellis-slot", className)} />;
}

/** Report a singleton panel's presence and visibility to the controller. */
function useReportPanel(controller: TrellisController, kind: TrellisSingleton) {
  const view = useView();
  const visible = view.visible;
  useEffect(() => {
    const { present, visible: shown } = controller.ui.get();
    controller.ui.set({ present: { ...present, [kind]: true }, visible: { ...shown, [kind]: visible } });
  }, [controller, kind, visible]);
  useEffect(() => () => {
    const { present, visible: shown } = controller.ui.get();
    controller.ui.set({ present: { ...present, [kind]: false }, visible: { ...shown, [kind]: false } });
  }, [controller, kind]);
  return view;
}

function NavigatorView({ controller, kind }: { controller: TrellisController; kind: "project" | "papers" }) {
  useReportPanel(controller, kind);
  return <HostSlot host={controller.hosts[kind]} className="trellis-navigator" />;
}

function AgentView({ controller }: { controller: TrellisController }) {
  useReportPanel(controller, "agent");
  useEffect(() => { controller.bridge?.agentShown(); }, [controller]);
  return <HostSlot host={controller.hosts.agent} className="trellis-agent" />;
}

/** A quiet placeholder for a panel whose content is not mounted right now. */
function EmptyState({ icon, title, detail, children, onActivate }: {
  icon: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
  onActivate?: () => void;
}) {
  return (
    <div
      className={cn("trellis-empty", onActivate && "trellis-empty-activatable")}
      onClick={onActivate}
      role={onActivate ? "button" : undefined}
      tabIndex={onActivate ? 0 : undefined}
      onKeyDown={onActivate ? (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onActivate();
        }
      } : undefined}
    >
      <span className="trellis-empty-icon">{icon}</span>
      <strong>{title}</strong>
      {detail && <span className="trellis-empty-detail">{detail}</span>}
      {children && <div className="trellis-empty-actions">{children}</div>}
    </div>
  );
}

/**
 * Keep the PDF panel's minimum at what its toolbar needs (every control, and
 * a search field that fits its placeholder and, with a query, its match controls). Re-measured when the toolbar itself
 * changes (a build loads, the locale changes a label), when fonts arrive, and
 * once the panel is first laid out; never per resize or per rendered page.
 */
function observePdfToolbarMinimum(controller: TrellisController): () => void {
  const host = controller.hosts.pdf;
  let frame = 0;
  let measured = false;
  const measure = () => {
    frame = 0;
    const toolbar = host.querySelector<HTMLElement>(".pdf-toolbar");
    const width = toolbar ? measurePdfToolbarMinWidth(toolbar) : null;
    if (width === null) return;
    measured = true;
    controller.ui.set({ pdfMinWidth: width });
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(measure);
  };
  const inToolbar = (node: Node) => node instanceof Element && (node.closest(".pdf-toolbar") !== null || node.querySelector(".pdf-toolbar") !== null);
  const mutations = new MutationObserver((records) => {
    if (records.some((record) => inToolbar(record.target) || [...record.addedNodes].some(inToolbar))) schedule();
  });
  mutations.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ["placeholder"] });
  const firstLayout = new ResizeObserver(() => {
    if (!measured) schedule();
  });
  firstLayout.observe(host);
  document.fonts?.addEventListener("loadingdone", schedule);
  schedule();
  return () => {
    cancelAnimationFrame(frame);
    mutations.disconnect();
    firstLayout.disconnect();
    document.fonts?.removeEventListener("loadingdone", schedule);
  };
}

function PdfView({ controller }: { controller: TrellisController }) {
  const { t } = useLingui();
  useReportPanel(controller, "pdf");
  const live = useSyncExternalStore(controller.ui.subscribe, () => controller.ui.get().pdfLive);
  return (
    <>
      <HostSlot host={controller.hosts.pdf} className="trellis-pdf" />
      {!live && (
        <EmptyState icon={<Moon size={16} />} title={t`PDF preview paused`} />
      )}
    </>
  );
}

function ToolView({ controller, kind }: { controller: TrellisController; kind: TrellisToolKind }) {
  const { t, i18n } = useLingui();
  useReportPanel(controller, kind);
  const open = useSyncExternalStore(controller.openDrawers.subscribe, () => Boolean(controller.openDrawers.get()[kind]));
  // A tool panel restored from a saved layout re-opens its drawer once.
  useEffect(() => {
    if (!controller.openDrawers.get()[kind]) controller.bridge?.openTool(kind);
  }, [controller, kind]);
  const title = i18n._(PANEL_TITLES[kind]);
  return (
    <>
      <HostSlot host={controller.toolHost(kind)} className="trellis-tool" />
      {!open && (
        <EmptyState icon={PANEL_ICONS[kind]} title={title}>
          <button type="button" className="trellis-empty-button" onClick={() => controller.bridge?.openTool(kind)}>
            {spaceMixedScript(t`Open ${title}`)}
          </button>
        </EmptyState>
      )}
    </>
  );
}

const refuse = () => false;

/**
 * A document that is not the active one, read-only and drawn the way it
 * opens: a CodeMirror of its source, and a Markdown file's rendered page
 * beside it (Split) or instead of it (Preview), so a document beside the one
 * being worked on keeps its look. Click to edit there.
 */
function TextSnapshot({ controller, fileKey, panelId }: { controller: TrellisController; fileKey: string; panelId: string }) {
  const { t } = useLingui();
  const parentRef = useRef<HTMLDivElement>(null);
  // Markdown opens in the view last chosen for Markdown, which the active
  // document's switch changes. A tab on its way to becoming active (see
  // useBesideActive) shows only its source until the live editor takes over.
  const besideActive = useBesideActive(controller, panelId);
  const chosen = useSyncExternalStore(controller.docTools.subscribe, () => (
    isMarkdownSnapshot(fileKey) ? controller.bridge?.documentMode() ?? "source" : "source"
  ));
  const mode = besideActive ? chosen : "source";
  const viewRef = useRef<EditorView | null>(null);
  const [text, setText] = useState<string | null>(() => controller.texts.get(fileKey) ?? null);
  const filesRevision = useTrellisApp(controller, (state) => state.filesRevision);
  const projectRoot = useTrellisApp(controller, (state) => state.projectRoot);
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
      // And its room below the last line: a place parked near the end lands
      // where the live editor will put it.
      revealExtension(),
      EditorView.lineWrapping,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      syntaxHighlighting(luxLatexHighlightStyle),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      EditorView.theme({ "&": { height: "100%" }, "& .cm-scroller": { height: "100% !important" } }),
      ...language,
    ];
    // The live editor this tab last had, parked: its place to the pixel and
    // its parse, so the snapshot shown while the tab becomes active again
    // matches what the live editor then shows (see parked-editors.ts).
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
  }, [controller, fileKey, language, mode, projectRoot, text]);
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
      {mode !== "pdf" && <div ref={parentRef} className="code-editor-root trellis-snapshot-editor" />}
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
function ReadOnlyMarkdown({ controller, path, text, sourceLines = false }: {
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
            onChangeMarkdown={refuse}
            onUndo={refuse}
            onRedo={refuse}
            synchronizeSourceScroll={sourceLines}
          />
        </Suspense>
      </div>
    </div>
  );
}

function SleepingDocument({ controller, fileKey, detail }: { controller: TrellisController; fileKey: string; detail: string }) {
  const bridge = controller.bridge;
  const kind = bridge?.tabKind(fileKey) ?? "file";
  return (
    <EmptyState
      icon={fileIcon(fileKey, kind, 16)}
      title={bridge?.tabLabel(fileKey) ?? fileKey}
      detail={detail}
      onActivate={() => controller.activate(fileKey)}
    />
  );
}

/**
 * A Paper that is not the active document, drawn read-only where it was being
 * read, so the Reading layout keeps it legible beside the notes being
 * written. It scrolls in place, and the place it is left at is where the full
 * reader, brought back by its header's button, picks up.
 */
function PaperSnapshot({ controller, fileKey, panelId }: { controller: TrellisController; fileKey: string; panelId: string }) {
  const { t } = useLingui();
  if (!useBesideActive(controller, panelId)) return <SleepingDocument controller={controller} fileKey={fileKey} detail={t`Sleeping · click to open`} />;
  return <PaperSnapshotContent controller={controller} fileKey={fileKey} />;
}

/**
 * Not in place of the document being worked on: a tab that has just covered
 * the active document in its own panel is merely selected on the way to
 * becoming active (a click, a restore). Anywhere else on screen it is being
 * read, whether or not the active document is on screen too.
 */
function useBesideActive(controller: TrellisController, panelId: string) {
  return useSyncExternalStore(controller.ui.subscribe, () => {
    if (controller.ui.get().editorVisible) return true;
    const { activeKey } = controller.app.get();
    return controller.ws?.views({ type: "file" }).find((view) => view.params.key === activeKey)?.panelId !== panelId;
  });
}

function PaperSnapshotContent({ controller, fileKey }: { controller: TrellisController; fileKey: string }) {
  const { t } = useLingui();
  const [paper, setPaper] = useState<{ path: string; text: string } | null | undefined>(undefined);
  useEffect(() => {
    let disposed = false;
    void controller.bridge?.readPaper(fileKey).then((value) => {
      if (!disposed) setPaper(value);
    }, () => {
      if (!disposed) setPaper(null);
    });
    return () => { disposed = true; };
  }, [controller, fileKey]);
  if (paper === null) return <SleepingDocument controller={controller} fileKey={fileKey} detail={t`Sleeping · click to open`} />;
  return (
    <div className="trellis-paper-snapshot">
      {/* The reader's own header, so the text holds its place when the reader comes back. */}
      <header className="paper-reader-header">
        <div className="paper-local-actions">
          {/* Named apart from its text, which a narrow header hides; the tip
              then says what the bare icon does. */}
          <Tip label={t`Open the full reader · your notes stay beside it`}>
            <button type="button" className="paper-local-action" aria-label={t`Open the reader`} onClick={() => controller.activate(fileKey)}>
              <BookOpen size={14} aria-hidden="true" />
              <span>{t`Open the reader`}</span>
            </button>
          </Tip>
        </div>
      </header>
      {paper && <ReadOnlyMarkdown controller={controller} path={paper.path} text={paper.text} />}
    </div>
  );
}

/**
 * A project PDF (or image) that is not the active document, kept open where
 * it was being read: the Reading layout pairs a PDF with the notes being
 * written, and a sleeping card there would hide it at the moment the notes
 * are typed. It is the asset preview itself, sharing the reader's page and
 * zoom both ways.
 */
function AssetSnapshot({ controller, fileKey, panelId }: { controller: TrellisController; fileKey: string; panelId: string }) {
  const { t } = useLingui();
  const besideActive = useBesideActive(controller, panelId);
  const [asset, setAsset] = useState<AssetPreview | null | undefined>(undefined);
  const [missing, setMissing] = useState(false);
  // A rewrite on disk hands the viewer the new version, as the live document
  // host does; a removed file stays open with a notice until it is back.
  const [recheck, setRecheck] = useState(0);
  const projectRoot = useTrellisApp(controller, (state) => state.projectRoot);
  useProjectPdfWatch(besideActive && (asset === null || asset?.ranges) ? projectRoot : null, fileKey, missing, () => setRecheck((count) => count + 1));
  useEffect(() => {
    if (!besideActive) return;
    let disposed = false;
    void controller.bridge?.readAsset(fileKey).then((value) => {
      if (disposed) return;
      setMissing(false);
      setAsset((current) => (current && current.ranges?.version === value.ranges?.version ? current : value));
    }, (reason: unknown) => {
      if (disposed) return;
      setAsset((current) => current ?? null);
      if (isProjectFileMissing(reason)) setMissing(true);
    });
    return () => { disposed = true; };
  }, [besideActive, controller, fileKey, recheck]);
  // Paging, zooming or searching the PDF beside the notes keeps the notes
  // active: the focus Trellis reports for it would otherwise activate the PDF
  // and replace this viewer, and the field just clicked, with the live host.
  // Native capture listeners, so they run after the workspace root's release
  // and before the deferred activation (React's would run ahead of the root's).
  // Its tab stays the way to open the PDF itself.
  const holdReading = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const hold = () => controller.holdReading(fileKey);
    element.addEventListener("pointerdown", hold, true);
    element.addEventListener("focusin", hold, true);
    return () => {
      element.removeEventListener("pointerdown", hold, true);
      element.removeEventListener("focusin", hold, true);
    };
  }, [controller, fileKey]);
  if (!besideActive || asset === null) return <SleepingDocument controller={controller} fileKey={fileKey} detail={t`Sleeping · click to open`} />;
  if (!asset) return null;
  return (
    <div ref={holdReading} className="trellis-pdf-snapshot">
      {/* Laid out as the live document host lays out the preview. */}
      <div className="canvas-body">
        <AfterSwitch state={controller.switchState}>
          <ProjectAssetPreview
            asset={asset}
            missing={missing}
            viewState={controller.bridge?.viewState(fileKey)}
            onViewState={(update) => controller.bridge?.rememberViewState(fileKey, update)}
            onFileChanged={() => setRecheck((count) => count + 1)}
            onPdfTextSelect={(text, place) => controller.bridge?.pdfTextSelect(text, place)}
          />
        </AfterSwitch>
      </div>
    </div>
  );
}

function FileView({ controller }: { controller: TrellisController }) {
  const { t } = useLingui();
  const view = useView<FileParams>();
  const key = view.params.key;
  const active = useTrellisApp(controller, (state) => state.activeKey === key);
  const dirty = useTrellisApp(controller, (state) => state.activeKey === key && state.activeDirty);
  const hibernated = useSyncExternalStore(controller.ui.subscribe, () => active && controller.ui.get().editorHibernated);
  useViewBadge(dirty ? true : null);
  // Lattice saves instead of discarding: a dirty document saves before its
  // panel closes, and a failed save asks before anything is lost.
  useCloseGuard(async () => {
    const state = controller.app.get();
    if (state.activeKey !== key || !state.activeDirty) return true;
    if (await controller.bridge?.save()) return true;
    const name = controller.bridge?.tabLabel(key) ?? key;
    return confirmAction({
      title: t`Unsaved changes`,
      message: t`${name} could not be saved. Close it and discard the unsaved changes?`,
      confirmLabel: t`Discard and close`,
      destructive: true,
    });
  });
  useEffect(() => {
    if (active) controller.ui.set({ editorVisible: view.visible });
  }, [active, controller, view.visible]);
  const surfaceIcon = useFileTabIcon(controller, view.id, key);
  if (isOpenSlideDeckPath(key)) {
    return (
      <>
        {surfaceIcon}
        <DeckSlot controller={controller} fileKey={key} view={view} />
        {/* What App lays over the active document (a document opening) still shows over a deck. */}
        {active && <HostSlot host={controller.hosts.editor} className="trellis-deck-overlay" />}
      </>
    );
  }
  if (active) {
    return (
      <>
        {surfaceIcon}
        <HostSlot host={controller.hosts.editor} className="trellis-file-live" />
        {hibernated && <SleepingDocument controller={controller} fileKey={key} detail={t`Paused while hidden · click to resume`} />}
      </>
    );
  }
  if (!view.visible) return <>{surfaceIcon}</>;
  const kind = controller.bridge?.tabKind(key) ?? "file";
  return (
    <>
      {surfaceIcon}
      {kind === "file" && !isHeavyDocument(key)
        ? <TextSnapshot controller={controller} fileKey={key} panelId={view.panelId} />
        : kind === "paper"
          ? <PaperSnapshot controller={controller} fileKey={key} panelId={view.panelId} />
          : kind === "asset"
            ? <AssetSnapshot controller={controller} fileKey={key} panelId={view.panelId} />
            : <SleepingDocument controller={controller} fileKey={key} detail={t`Sleeping · click to open`} />}
    </>
  );
}

/**
 * An open deck's own host, adopted for as long as its panel holds it, active
 * or not and selected or not: its Open Slide frame never leaves the page, so
 * nothing reloads it (Trellis keeps a view's content element in place while
 * the view exists, and only hides an unselected one). Its tab only goes to
 * sleep when its panel has been off screen for a while: hidden, or out of
 * the framing; an unselected tab in a panel on screen is a click away and
 * stays loaded.
 */
function DeckSlot({ controller, fileKey, view }: { controller: TrellisController; fileKey: string; view: { visible: boolean; selected: boolean; placement: string } }) {
  const onScreen = view.visible || (!view.selected && view.placement !== "hidden");
  useEffect(() => {
    if (onScreen) {
      controller.decks.setSleeping(fileKey, false);
      return;
    }
    const timer = window.setTimeout(() => controller.decks.setSleeping(fileKey, true), HIBERNATE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [controller, fileKey, onScreen]);
  useEffect(() => () => controller.decks.setSleeping(fileKey, false), [controller, fileKey]);
  // An inactive deck streams nothing and holds the props it was last handed,
  // so working in it makes it the active document (see `decks.watchFocus`).
  const active = useTrellisApp(controller, (state) => state.activeKey === fileKey);
  useEffect(() => {
    if (active) return;
    // Left in the frame when another document became active without taking
    // focus (an agent opening a file), focus would already be where a press
    // back into the deck puts it.
    if (controller.decks.host(fileKey).contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    return controller.decks.watchFocus(fileKey);
  }, [active, controller, fileKey]);
  return <HostSlot host={controller.decks.host(fileKey)} className="trellis-file-live" />;
}

/** Per-file tab icons: a type's `icon` is shared by all its views, so file panels portal their own. */
function useFileTabIcon(controller: TrellisController, viewId: string, key: string) {
  const ws = controller.ws;
  // Read during render, not set from an effect: the tab's icon slot usually
  // exists by the time the view renders, and an effect would cost every file
  // panel an extra commit on mount.
  const subscribe = useCallback((listener: () => void) => ws?.on("surfaces", listener) ?? (() => {}), [ws]);
  const iconHost = useSyncExternalStore(subscribe, () => ws?.surfaces().find((surface) => surface.view.id === viewId)?.icon ?? null);
  const kind = controller.bridge?.tabKind(key) ?? "file";
  return iconHost ? createPortal(fileIcon(key, kind), iconHost) : null;
}

/** A document panel with no document in it: the next one opened lands here. */
function SlotView({ controller }: { controller: TrellisController }) {
  const { t } = useLingui();
  return (
    <EmptyState icon={<FileText size={18} />} title={t`No document open`}>
      <button type="button" className="trellis-empty-button" onClick={() => controller.bridge?.quickOpen()}>
        <Search size={13} />
        {t`Quick open`}
        <kbd>⌘P</kbd>
      </button>
    </EmptyState>
  );
}

/** Only when every panel is closed: panels fill each other's space otherwise. */
function WorkspaceEmpty({ controller }: { controller: TrellisController }) {
  const { t } = useLingui();
  return (
    <EmptyState
      icon={<FileText size={18} />}
      title={t`Every panel is closed`}
    >
      <button type="button" className="trellis-empty-button" onClick={() => controller.bridge?.quickOpen()}>
        <Search size={13} />
        {t`Quick open`}
        <kbd>⌘P</kbd>
      </button>
      <button type="button" className="trellis-empty-button" onClick={() => void controller.resetLayout()}>
        <FolderTree size={13} />
        {t`Reset layout`}
      </button>
    </EmptyState>
  );
}

/**
 * Panel menus drawn with Lattice's own menu surface (portaled, so they are
 * not clipped to the workspace), instead of Trellis's built-in menu.
 */
function MenuEntries({ entries, onRun }: { entries: readonly MenuEntry[]; onRun: () => void }) {
  // A check column only when something in this list can be checked.
  const checks = entries.some((entry) => entry !== "separator" && entry.checked !== undefined);
  return (
    <>
      {entries.map((entry, index) => {
        if (entry === "separator") {
          return <MenuPrimitive.Separator key={`separator-${index}`} className="-mx-1 my-1 h-px bg-border" />;
        }
        if (entry.items?.length) {
          return (
            <MenuPrimitive.Sub key={entry.id ?? entry.label}>
              <MenuPrimitive.SubTrigger className={cn(menuItemClassName, "data-[state=open]:bg-accent")} disabled={entry.disabled}>
                {checks && <span className="trellis-menu-check" />}
                {entry.id && MENU_ICONS[entry.id]}
                <span className="flex-1 truncate">{entry.label}</span>
                <ChevronRight className="ml-auto" />
              </MenuPrimitive.SubTrigger>
              <MenuPrimitive.Portal>
                <MenuPrimitive.SubContent
                  sideOffset={4}
                  className={cn(floatingSurfaceClassName, menuViewportClassName, "min-w-[10rem]", popupMotionClassName)}
                >
                  <MenuEntries entries={entry.items} onRun={onRun} />
                </MenuPrimitive.SubContent>
              </MenuPrimitive.Portal>
            </MenuPrimitive.Sub>
          );
        }
        return (
          <MenuPrimitive.Item
            key={entry.id ?? entry.label}
            className={menuItemClassName}
            data-variant={entry.danger ? "destructive" : "default"}
            disabled={entry.disabled}
            onSelect={() => {
              onRun();
              entry.run?.();
            }}
          >
            {checks && <span className="trellis-menu-check">{entry.checked && <Check />}</span>}
            {entry.id && MENU_ICONS[entry.id]}
            <span className="flex-1 truncate">{entry.label}</span>
            {entry.shortcut && <span className="trellis-menu-shortcut">{entry.shortcut}</span>}
          </MenuPrimitive.Item>
        );
      })}
    </>
  );
}

function PanelMenu({ request, onClose }: { request: MenuRequest; onClose: () => void }) {
  return (
    <MenuPrimitive.Root open modal={false} onOpenChange={(open) => { if (!open) onClose(); }}>
      <MenuPrimitive.Trigger asChild>
        <span aria-hidden="true" style={{ position: "fixed", left: request.x, top: request.y, width: 0, height: 0 }} />
      </MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Content
          align={request.align}
          side="bottom"
          sideOffset={4}
          className={cn(floatingSurfaceClassName, menuViewportClassName, "min-w-[12rem] max-w-[20rem]", popupMotionClassName)}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <MenuEntries entries={request.entries} onRun={onClose} />
        </MenuPrimitive.Content>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

// Trellis draws its chrome from these. Every value is a Lattice design token,
// so both themes follow the app.
const TOKENS: Record<string, string> = {
  "--trellis-font": "var(--ui-font)",
  "--trellis-font-size": "var(--type-label-size)",
  "--trellis-accent": "var(--control-active)",
  "--trellis-accent-contrast": "var(--control-active-contrast)",
  // The workspace paints the shell behind Trellis; a second coat would
  // darken a translucent window's gutters.
  "--trellis-bg": "transparent",
  "--trellis-stage": "transparent",
  "--trellis-panel": "var(--surface-app)",
  "--trellis-tabbar": "var(--surface-sidebar)",
  "--trellis-tab-hover": "var(--chrome-hover-surface)",
  "--trellis-text": "var(--text-primary)",
  "--trellis-text-muted": "var(--text-secondary)",
  "--trellis-border": "var(--border-subtle)",
  "--trellis-slot": "color-mix(in srgb, var(--control-active) 14%, transparent)",
  "--trellis-menu": "var(--surface-panel-raised)",
  "--trellis-menu-hover": "var(--chrome-hover-surface)",
  "--trellis-radius": "var(--radius-surface)",
  "--trellis-tab-radius": "var(--radius-chrome)",
  "--trellis-tabbar-height": "var(--tab-strip-height-chrome)",
  "--trellis-gap": "var(--space-3)",
  // eslint-disable-next-line lingui/no-unlocalized-strings -- a CSS box-shadow value
  "--trellis-focus-ring": "0 0 0 var(--focus-ring-width) var(--focus-ring)",
};

/** The toast that offers to undo a reset; a later reset's replaces it. */
const RESET_UNDO_TOAST = "trellis-layout-reset";

/**
 * A reset that can still be undone: the layout, the preset and the focused
 * view from before it, and the arrangement the reset left (`left`, see
 * layoutShape), which any change of the writer's own supersedes.
 */
type ResetUndo = { document: LayoutDocument; preset: ActivePreset | null; focused: string | null; left: string };

/** Trellis's own shortcuts, less the whole-workspace overview (⌘⌥↑), which Lattice does not offer. */
const KEYMAP = { "navigation.overview": null };

type WorkspaceProps = { controller: TrellisController; projectRoot: string; dark: boolean };

/** Memoized: App re-renders on every keystroke, and nothing here needs to follow it. */
const TrellisWorkspace = memo(function TrellisWorkspace({ controller, projectRoot, dark }: WorkspaceProps) {
  const { t, i18n } = useLingui();
  const [{ initial, initialPreset, initialWorkspace, initialPlaces, agentMinSize, pdfMinSize }] = useState(() => {
    installTrellisLabels();
    const saved = openProjectLayout(projectRoot, controller.workspaces);
    return {
      initial: saved.document,
      initialPreset: saved.preset,
      initialWorkspace: saved.workspace,
      initialPlaces: saved.places,
      agentMinSize: measuredMinSize(MIN_SIZE.agent, () => controller.ui.get().agentMinWidth),
      pdfMinSize: measuredMinSize(MIN_SIZE.pdf, () => controller.ui.get().pdfMinWidth),
    };
  });
  const [ws, setWs] = useState<WorkspaceHandle | null>(null);
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  const handleRef = useCallback((handle: WorkspaceHandle | null) => {
    controller.attachWorkspace(handle);
    setWs(handle);
  }, [controller]);
  useEffect(() => () => controller.attachWorkspace(null), [controller]);
  // Trellis reads its own strings (menus, drop labels, tooltips) from this table at use time.
  useEffect(() => installTrellisLabels(), [i18n.locale]);

  // Views App closed (e.g. file deleted) or a reset replaced: their
  // close events must not close App tabs a second time.
  const quietCloses = useRef(new Set<string>());
  const resettingRef = useRef(false);
  /** The preset the layout is in, with the writer's own layout to return to. */
  const presetRef = useRef<ActivePreset | null>(initialPreset);
  /** The named workspace the project is in, and where its documents sat in each workspace it visited. */
  const workspaceRef = useRef(initialWorkspace);
  const placesRef = useRef<Record<string, DocumentPlaces>>(initialPlaces);
  const resetUndo = useRef<ResetUndo | null>(null);
  /** Take back the offer to undo the last reset, and its toast. */
  const withdrawUndo = useCallback(() => {
    if (!resetUndo.current) return;
    resetUndo.current = null;
    dismissAppToastByDedupeKey(RESET_UNDO_TOAST);
  }, []);

  useTabSync(controller, ws, quietCloses);
  useHibernation(controller);

  // The window's minimum follows the layout's: its panels' minimums plus
  // whatever sits beside the workspace. Measured only when the layout's own
  // minimum changes, not on every layout frame.
  useEffect(() => {
    if (!ws) return;
    let last = -1;
    const update = () => {
      const min = ws.getSnapshot().minWidth;
      if (min === last) return;
      last = min;
      const width = ws.element.getBoundingClientRect().width;
      const beside = width > 0 ? Math.max(0, window.innerWidth - width) : 0;
      controller.ui.set({ minWidth: Math.ceil(min + beside) });
    };
    update();
    const unsubscribe = ws.subscribe(update);
    // The Agent's and the PDF's measured minimums reach Trellis through their
    // minSize getters; lay out again when either changes. (Kept in this effect
    // rather than their own hooks: the workspace renders on startup and each
    // hook there is counted by the performance budget.)
    let measured = { agent: 0, pdf: 0 };
    const offMeasured = controller.ui.subscribe(() => {
      const { agentMinWidth: agent, pdfMinWidth: pdf } = controller.ui.get();
      if (agent === measured.agent && pdf === measured.pdf) return;
      measured = { agent, pdf };
      ws.update({});
    });
    const stopPdf = observePdfToolbarMinimum(controller);
    const stopHolding = holdWidthsWhileResizing(ws.element);
    return () => {
      unsubscribe();
      offMeasured();
      stopPdf();
      stopHolding();
      controller.ui.set({ minWidth: 0 });
    };
  }, [controller, ws]);

  // Persist the layout per project, debounced.
  const saveTimer = useRef<number | null>(null);
  const pendingSave = useRef<(() => void) | null>(null);
  /** The layout as Trellis last reported it: what a close just changed. */
  const lastDocument = useRef(initial);
  const flushSave = useCallback(() => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    pendingSave.current?.();
    pendingSave.current = null;
  }, []);
  const onDocumentChange = useCallback((document: LayoutDocument) => {
    // A slot leaves its panel once a document is in it; each close reports the layout again.
    const handle = controller.ws;
    const filled = filledSlots(document);
    if (handle && filled.length) {
      for (const id of filled) void handle.close(id, { force: true });
      return;
    }
    lastDocument.current = document;
    // The workspace's own arrangement is written only by saving to it: here the project just differs from it, or not.
    controller.ui.set({ dirty: differsFromWorkspace(presetRef.current?.previous ?? document, controller.workspaces, workspaceRef.current) });
    // Any arrangement but the one a reset left supersedes undoing it.
    if (resetUndo.current && layoutShape(document) !== resetUndo.current.left) withdrawUndo();
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    // The workspace this change was made in, even if the save lands after a switch.
    const workspace = workspaceRef.current;
    pendingSave.current = () => {
      const preset = presetRef.current;
      placesRef.current = { ...placesRef.current, [workspace]: placesOf(preset?.previous ?? document) };
      saveLayout(projectRoot, { document, preset, workspace, places: placesRef.current });
    };
    saveTimer.current = window.setTimeout(flushSave, 400);
    const snapshot = controller.ws?.getSnapshot();
    if (snapshot) {
      // In a preset, the panels it parked come back with the writer's own
      // layout (or their toggles), not with a chip each.
      const hidden = snapshot.hidden
        .filter((entry) => !presetRef.current || entry.views.some((item) => item.type === "file"))
        .map((entry) => ({ panelId: entry.panelId, title: entry.views.map((item) => item.title).join(", ") }));
      const previous = controller.ui.get().hidden;
      // Every layout change reports the hidden list; keep the old array when
      // nothing in it changed, so its subscribers (the titlebar) do not
      // re-render on each drag, resize or restore step.
      const same = previous.length === hidden.length
        && previous.every((entry, index) => entry.panelId === hidden[index].panelId && entry.title === hidden[index].title);
      controller.ui.set({ framed: snapshot.framed, hidden: same ? previous : hidden });
    }
  }, [controller, flushSave, projectRoot, withdrawUndo]);
  // Unmounting (a project switch, the window closing) writes the last change
  // now, and a reset can no longer be undone into another project.
  useEffect(() => () => {
    flushSave();
    withdrawUndo();
  }, [flushSave, withdrawUndo]);

  // Focusing a document panel makes its document App's active one.
  const onFocus = useCallback((viewId: string | null) => {
    const view = viewId ? controller.ws?.view(viewId) : null;
    if (!view || view.type !== "file") return;
    const key = String(view.params.key ?? "");
    if (key) controller.activateFromFocus(key);
  }, [controller]);
  // Trellis reports focus only when it moves, and App switching documents
  // selects a tab without moving it: a click on the tab of a document that
  // still holds Trellis's focus has to activate that document itself. A click
  // on the tab's close button is not one: Trellis closes that tab without
  // selecting it, and activating it here would reopen the file the close just
  // removed (this listener runs first, its activation lands after the close).
  useEffect(() => {
    const root = ws?.element;
    if (!root) return;
    // The inactive document whose tab the event landed on, if any.
    const tabKey = (target: EventTarget | null) => {
      if (!(target instanceof Element) || target.closest("[data-trellis-part=tab-close]")) return null;
      const tab = target.closest<HTMLElement>("[data-trellis-part=tab]");
      const view = tab?.dataset.view ? ws.view(tab.dataset.view) : null;
      if (view?.type !== "file") return null;
      const key = String(view.params.key ?? "");
      return key && key !== controller.app.get().activeKey ? key : null;
    };
    const onPress = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const key = tabKey(event.target);
      if (!key) return;
      // A click with no press before it (assistive technology's activation)
      // never released a PDF snapshot's hold; its tab is the way to open it.
      controller.holdReading(null);
      controller.activateFromFocus(key);
    };
    // Enter or Space on a focused tab is the keyboard's press of it, but
    // Trellis consumes the key (no click follows) and moves focus into the
    // view a frame later, which for a PDF beside the notes lands in its
    // snapshot and sets the hold a deferred activation would honour. So the
    // keyboard opens the document now, explicitly, ahead of that focus.
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.key !== "Enter" && event.key !== " ") || event.repeat || event.isComposing) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const key = tabKey(event.target);
      if (!key) return;
      controller.holdReading(null);
      controller.activate(key);
    };
    const onPointerOver = (event: PointerEvent) => controller.rememberPointerPanel(event.target);
    // Ahead of Trellis's own listeners and of a PDF snapshot's (see AssetSnapshot).
    const releaseReading = () => controller.holdReading(null);
    root.addEventListener("click", onPress, true);
    root.addEventListener("keydown", onKeyDown, true);
    root.addEventListener("pointerover", onPointerOver, true);
    root.addEventListener("pointerdown", releaseReading, true);
    root.addEventListener("focusin", releaseReading, true);
    return () => {
      root.removeEventListener("click", onPress, true);
      root.removeEventListener("keydown", onKeyDown, true);
      root.removeEventListener("pointerover", onPointerOver, true);
      root.removeEventListener("pointerdown", releaseReading, true);
      root.removeEventListener("focusin", releaseReading, true);
    };
  }, [controller, ws]);

  const onClose = useCallback((view: ViewInfo) => {
    // A file dragged from the Project panel that went back: its tab was never an App tab.
    if (resettingRef.current || (view.type === "file" && controller.pendingDrops.has(String(view.params.key ?? "")))) return;
    // The document panel a document was the last of stays, an empty slot
    // (in a preset, the return to the writer's layout keeps it).
    const handle = controller.ws;
    const kept = handle && view.type === "file" && !presetRef.current ? keepDocumentSlot(lastDocument.current, handle.getDocument(), view.id) : null;
    if (kept) handle?.setDocument(kept, { animate: false });
    if (quietCloses.current.delete(view.id)) return;
    if (view.type === "file") {
      void controller.bridge?.closeTab(String(view.params.key ?? ""));
    } else if ((TOOL_KINDS as readonly string[]).includes(view.type)) {
      controller.openDrawers.get()[view.type as TrellisToolKind]?.();
    }
  }, [controller]);

  // Reset: save first (Trellis skips close guards), then animate to the
  // default, with a toast offering to undo it. The undo restores only the
  // arrangement: documents keep the tabs they have now.
  const resetFailed = t`Save failed, so the layout was not reset.`;
  const resetToast = { source: t`Layout`, title: t`Layout reset`, undo: t`Undo` };
  // The reset waiting on its save: a second request joins it rather than
  // resetting the default again, whose Undo would only bring the default back.
  const pendingReset = useRef<Promise<void> | null>(null);
  // Bumped by entering a workspace, which cancels a reset still waiting on its save.
  const resetGeneration = useRef(0);
  useEffect(() => {
    const resetAfterSave = async (handle: WorkspaceHandle) => {
      const generation = resetGeneration.current;
      const saved = !controller.bridge || await controller.bridge.save();
      // The save can outlast this workspace: a project switch (or the window
      // closing) unmounts it and attaches the next project's. Its reset, or
      // its failure, is no longer anything to clear, rearrange or announce
      // there: the Undo it would offer could restore nothing.
      if (controller.ws !== handle || resetGeneration.current !== generation) return;
      if (!saved) {
        controller.bridge?.notify(resetFailed);
        return;
      }
      // Read after the save: the arrangement and the focus as they are now.
      const snapshot = handle.getSnapshot();
      const before = { document: snapshot.document, preset: presetRef.current, focused: snapshot.focusedView };
      resettingRef.current = true;
      presetRef.current = null;
      try {
        handle.setDocument(defaultLayout());
      } finally {
        resettingRef.current = false;
      }
      controller.ui.set({ preset: null });
      controller.app.set({ filesRevision: controller.app.get().filesRevision + 1 });
      controller.resync();
      // The open documents are back in panels now; that arrangement is the reset's own.
      const undo: ResetUndo = { ...before, left: layoutShape(handle.getDocument()) };
      resetUndo.current = undo;
      // Undo: the layout from before, reconciled with what is open now
      // (undoReset), back in the preset it was in, with the writer's view
      // focused again if it is still on screen.
      const restore = () => {
        if (resetUndo.current !== undo || controller.ws !== handle) return;
        resetUndo.current = null;
        const { activeKey, openTabs } = controller.app.get();
        const drawers = controller.openDrawers.get();
        const next = undoReset(undo.document, handle.getDocument(), { activeKey, openTabs }, (type) => Boolean(drawers[type as TrellisToolKind]));
        resettingRef.current = true;
        presetRef.current = undo.preset;
        try {
          handle.setDocument(next);
        } finally {
          resettingRef.current = false;
        }
        controller.ui.set({ preset: undo.preset?.preset ?? null });
        controller.resync();
        const focused = undo.focused ? handle.view(undo.focused) : null;
        if (focused && focused.placement !== "hidden") handle.focus(focused.id);
      };
      notifyInfo(resetToast.source, resetToast.title, {
        dedupeKey: RESET_UNDO_TOAST,
        primaryAction: { label: resetToast.undo, onClick: restore },
        onDismiss: () => {
          if (resetUndo.current === undo) resetUndo.current = null;
        },
      });
    };
    const cancelReset = () => {
      resetGeneration.current += 1;
      pendingReset.current = null;
    };
    // The project into workspace `id` as it was saved, out of any preset, its
    // documents placed by `placesFor` the writer's own layout.
    const load = (id: string, placesFor: (own: LayoutDocument) => DocumentPlaces) => {
      const handle = controller.ws;
      if (!handle) return;
      withdrawUndo();
      cancelReset();
      flushSave();
      const current = handle.getDocument();
      // Before App restored its tabs, the documents are the layout's own.
      const { activeKey, openTabs: tabs, tabsReady } = controller.app.get();
      const openTabs = tabsReady ? tabs : Object.keys(placesOf(current));
      const active = presetRef.current;
      const own = active ? returnLayout(active.previous, current, { activeKey, openTabs }, active.supplied) : current;
      const next = arrangeDocuments(workspaceArrangement(controller.workspaces, id), own, { activeKey, openTabs }, placesFor(own));
      presetRef.current = null;
      workspaceRef.current = id;
      controller.workspaces.use(id);
      controller.beginSwitch();
      resettingRef.current = true;
      try {
        handle.setDocument(next);
      } finally {
        resettingRef.current = false;
      }
      const drawers = controller.openDrawers.get();
      for (const kind of TOOL_KINDS) if (!handle.views({ type: kind }).length) drawers[kind]?.();
      controller.ui.set({ workspace: id, preset: null });
      controller.resync();
    };
    return controller.installHandlers({
      reset: () => {
        const handle = controller.ws;
        if (!handle) return Promise.resolve();
        if (pendingReset.current) return pendingReset.current;
        const pending = resetAfterSave(handle).finally(() => {
          if (pendingReset.current === pending) pendingReset.current = null;
        });
        pendingReset.current = pending;
        return pending;
      },
      // A preset regroups the open documents' own views, so no document closes
      // and nothing needs saving first; navigators, the Agent and tools wait
      // hidden, still mounted, for the writer's own layout to bring them back.
      preset: (preset) => {
        const handle = controller.ws;
        const current = presetRef.current;
        if (!handle || (current?.preset ?? null) === preset) return;
        withdrawUndo();
        const { activeKey, openTabs } = controller.app.get();
        const document = handle.getDocument();
        let next: LayoutDocument;
        if (preset) {
          const entered = enterPreset(preset, document, current, { activeKey, openTabs, isReading: (key) => controller.isReading(key) });
          next = entered.document;
          presetRef.current = entered.active;
        } else if (current) {
          next = returnLayout(current.previous, document, { activeKey, openTabs }, current.supplied);
          presetRef.current = null;
        } else {
          return;
        }
        controller.beginSwitch();
        resettingRef.current = true;
        try {
          handle.setDocument(next);
        } finally {
          resettingRef.current = false;
        }
        controller.ui.set({ preset });
        controller.resync();
        // The document the layout is for becomes the active one: the source to
        // write, the paper to read. Keyboard focus stays on the layout switch,
        // so its arrow keys keep moving between layouts.
        const root = handle.getDocument().root;
        const lead = root && preset ? findPanel(root, preset === "writing" ? "panel-writing" : "panel-reading")?.selected : null;
        const key = lead ? handle.view(lead)?.params.key : null;
        if (typeof key === "string" && key !== activeKey) controller.activate(key);
      },
      // Entering another workspace loads its saved arrangement, re-placing
      // the open documents (so none closes, and nothing needs saving first)
      // where each sat when the project was last in it. Tools follow the
      // arrangement: one it does not show closes, one it shows opens (see ToolView).
      workspace: (id) => {
        const from = workspaceRef.current;
        if (id === from || !controller.workspaces.get(id)) return;
        load(id, (own) => {
          placesRef.current = { ...placesRef.current, [from]: placesOf(own) };
          return placesRef.current[id] ?? {};
        });
      },
      // Revert: the workspace as saved, the open documents kept where they are when it has their panels.
      revertWorkspace: () => {
        if (controller.workspaces.get(workspaceRef.current)) load(workspaceRef.current, placesOf);
      },
      // Save: the arrangement under any preset becomes the workspace's.
      saveWorkspace: () => {
        const handle = controller.ws;
        if (!handle) return;
        const own = presetRef.current?.previous ?? handle.getDocument();
        if (controller.workspaces.setArrangement(workspaceRef.current, arrangementOf(own))) controller.ui.set({ dirty: false });
      },
      // A new workspace starts as the arrangement on screen, a preset's
      // included, and the project moves into it without anything moving.
      newWorkspace: (name) => {
        const handle = controller.ws;
        if (!handle) return null;
        withdrawUndo();
        cancelReset();
        flushSave();
        const document = handle.getDocument();
        const id = controller.workspaces.add(name, arrangementOf(document), workspaceRef.current);
        presetRef.current = null;
        workspaceRef.current = id;
        controller.workspaces.use(id);
        controller.ui.set({ workspace: id, preset: null });
        // Saves it, and shows the panels a preset had parked as hidden ones.
        onDocumentChange(document);
        return id;
      },
      // A panel the writer asks for is theirs to keep, even one a preset brought in.
      shown: (kind) => {
        const current = presetRef.current;
        if (current?.supplied.includes(kind)) presetRef.current = { ...current, supplied: current.supplied.filter((id) => id !== kind) };
      },
    });
  }, [controller, flushSave, onDocumentChange, resetFailed, resetToast.source, resetToast.title, resetToast.undo, withdrawUndo]);
  // The titlebar follows this workspace's preset, named workspace and unsaved changes; another project's starts in its own.
  useEffect(() => {
    controller.ui.set({
      preset: presetRef.current?.preset ?? null,
      workspace: workspaceRef.current,
      dirty: differsFromWorkspace(presetRef.current?.previous ?? controller.ws?.getDocument() ?? initial, controller.workspaces, workspaceRef.current),
    });
    return () => controller.ui.set({ preset: null, dirty: false });
  }, [controller, initial]);
  // Another window can delete the workspace the project is in: the project
  // moves to the one last entered, its layout as it is, and remembers that.
  // Or save it: the project keeps its layout, which differs from the new
  // arrangement, or now matches it.
  useEffect(() => controller.workspaces.subscribe(() => {
    const handle = controller.ws;
    if (controller.workspaces.get(workspaceRef.current)) {
      const own = presetRef.current?.previous ?? handle?.getDocument();
      if (own) controller.ui.set({ dirty: differsFromWorkspace(own, controller.workspaces, workspaceRef.current) });
      return;
    }
    workspaceRef.current = controller.workspaces.recent();
    controller.ui.set({ workspace: workspaceRef.current });
    if (handle) onDocumentChange(handle.getDocument());
  }), [controller, onDocumentChange]);

  const title = (kind: TrellisSingleton) => i18n._(PANEL_TITLES[kind]);
  const actions = (kind: "project" | "papers" | "agent" | "pdf") => () => controller.bridge?.panelMenu(kind) ?? [];
  const menuRef = useRef<MenuRequest | null>(null);
  const openMenu = useCallback((request: MenuRequest) => {
    menuRef.current?.close();
    menuRef.current = request;
    setMenu(request);
  }, []);
  const closeMenu = useCallback(() => {
    menuRef.current?.close();
    menuRef.current = null;
    setMenu(null);
  }, []);
  // A document panel's menu repeats its header tools, so hiding them loses nothing.
  const fileMenu = (view: ViewHandle): MenuEntry[] => {
    const key = String(view.params.key ?? "");
    const bridge = controller.bridge;
    const tools = controller.docTools.get();
    const active = controller.app.get().activeKey === key;
    const viewModes = (): MenuItem[] => (!active || !tools.viewModes ? [] : ([["source", t`Edit`], ["split", t`Split`], ["pdf", t`Preview`]] as const).map(([mode, label]) => ({
      id: `view-${mode}`, label, checked: tools.viewMode === mode, run: () => bridge?.setViewMode(mode),
    })));
    switch (documentTools(controller.bridge?.tabKind(key) ?? "file", key)) {
      case "build":
        return [
          { id: "build", label: t`Build`, shortcut: "⌘S", run: () => bridge?.build(key, { beside: view.panelId }) },
          { id: "clean-build", label: t`Clean rebuild`, run: () => bridge?.build(key, { clean: true, beside: view.panelId }) },
          ...(tools.building ? [{ id: "stop-build", label: t`Stop the build`, run: () => bridge?.stopBuild() }] : []),
        ];
      case "views":
        return viewModes();
      case "paper": {
        const paperViews: MenuItem[] = !active || !tools.paperViews ? [] : ([["blog", t`Blog`], ["fulltext", t`Paper`]] as const).map(([paperView, label]) => ({
          id: `paper-${paperView}`, label, checked: tools.paperView === paperView, run: () => bridge?.setPaperView(paperView),
        }));
        const modes = viewModes();
        return paperViews.length && modes.length ? [...paperViews, "separator", ...modes] : [...paperViews, ...modes];
      }
      default:
        return [];
    }
  };
  return (
    <>
      <Workspace
        ref={handleRef}
        className="lattice-trellis"
        theme={dark ? "dark" : "light"}
        tokens={TOKENS}
        keymap={KEYMAP}
        navigation="free"
        floating="overlay"
        tabs={{ inset: 6 }}
        defaultLayout={initial}
        onDocumentChange={onDocumentChange}
        onFocus={onFocus}
        onClose={onClose}
        onMissingType={(type) => ((VIEW_TYPES as readonly string[]).includes(type) ? "placeholder" : "drop")}
        renderMenu={openMenu}
        label={t`Lattice workspace`}
      >
        <ViewType
          id="project" title={title("project")} singleton icon={PANEL_ICONS.project} minSize={MIN_SIZE.project} scaling={false}
          accessory={<HostSlot host={controller.hosts.projectActions} inline />} menu={actions("project")}
        >
          <NavigatorView controller={controller} kind="project" />
        </ViewType>
        <ViewType
          id="papers" title={title("papers")} singleton icon={PANEL_ICONS.papers} minSize={MIN_SIZE.papers} scaling={false}
          accessory={<HostSlot host={controller.hosts.papersActions} inline />} menu={actions("papers")}
        >
          <NavigatorView controller={controller} kind="papers" />
        </ViewType>
        <ViewType
          id="agent" title={title("agent")} singleton icon={PANEL_ICONS.agent} minSize={agentMinSize} scaling={false}
          accessory={<HostSlot host={controller.hosts.agentActions} inline />} menu={actions("agent")}
        >
          <AgentView controller={controller} />
        </ViewType>
        <ViewType
          id="pdf" title={title("pdf")} singleton icon={PANEL_ICONS.pdf} minSize={pdfMinSize} scaling={false}
          menu={actions("pdf")}
        >
          <PdfView controller={controller} />
        </ViewType>
        <ViewType<FileParams>
          id="file"
          minSize={MIN_SIZE.file}
          scaling={false}
          title={(view) => controller.bridge?.tabLabel(String(view.params.key ?? "")) ?? String(view.params.key ?? "")}
          accessory={<FileHeaderTools controller={controller} />}
          menu={fileMenu}
        >
          <FileView controller={controller} />
        </ViewType>
        <ViewType id="slot" title={t`Empty`} minSize={MIN_SIZE.file} scaling={false}>
          <SlotView controller={controller} />
        </ViewType>
        {TOOL_KINDS.map((kind) => (
          <ViewType key={kind} id={kind} title={title(kind)} singleton icon={PANEL_ICONS[kind]} minSize={MIN_SIZE.tool} scaling={false}>
            <ToolView controller={controller} kind={kind} />
          </ViewType>
        ))}
        <Workspace.Empty>
          <WorkspaceEmpty controller={controller} />
        </Workspace.Empty>
      </Workspace>
      {menu && <PanelMenu request={menu} onClose={closeMenu} />}
    </>
  );
});

/**
 * Keep document panels in step with App's tabs: a tab App opens gets a panel,
 * a tab App closes loses it, and App's active document is the selected tab of
 * its panel. The reverse direction (focus, close) is in the event handlers.
 */
function useTabSync(controller: TrellisController, ws: WorkspaceHandle | null, quietCloses: { current: Set<string> }) {
  useEffect(() => {
    if (!ws) return;
    let lastActive = "";
    let lastTabsReady = false;
    let lastReveal = controller.app.get().revealRequest;
    const fileViews = () => ws.views({ type: "file" });
    const reconcile = () => {
      const { activeKey, openTabs, tabsReady, revealRequest } = controller.app.get();
      const views = fileViews();
      const byKey = new Map(views.map((view) => [String(view.params.key ?? ""), view]));
      // A new document joins the active document's panel, else an empty
      // document slot on screen, else any document panel; with none left, it gets a panel of its own between
      // the navigators and the rest of the layout.
      //
      // In the Reading layout a document keeps to its side instead: papers
      // join the paper being read (with the library), everything else the
      // notes, and a first note gets a panel of its own beside the paper.
      const anchorPanel = (key: string) => {
        if (controller.ui.get().preset === "reading") {
          const reading = controller.isReading(key);
          const library = ws.view("papers");
          if (reading && library && library.placement !== "hidden") return library.panelId;
          const side = fileViews().find((view) => view.placement !== "hidden" && controller.isReading(String(view.params.key ?? "")) === reading);
          if (side || !reading) return side?.panelId ?? null;
        }
        const current = byKey.get(activeKey);
        if (current && current.placement !== "hidden") return current.panelId;
        const slot = ws.views({ type: "slot" }).find((view) => view.placement !== "hidden");
        if (slot) return slot.panelId;
        return fileViews().find((view) => view.placement !== "hidden")?.panelId ?? null;
      };
      const open = (key: string) => {
        const panelId = anchorPanel(key);
        let info: ViewInfo | undefined;
        if (panelId) {
          info = ws.open("file", {
            params: { key },
            reuse: (view) => view.type === "file" && view.params.key === key,
            focus: false,
            placement: { into: panelId },
          });
        } else {
          const id = `file-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
          const navigators = NAVIGATORS.flatMap((kind) => ws.view(kind)?.panelId ?? []);
          // Not animated: this is how the first document appears at startup,
          // and animating the whole layout there costs a frame of work each.
          ws.setDocument(withDocumentPanel(ws.getDocument(), { id, key }, { after: navigators }), { animate: false });
          info = ws.views({ type: "file" }).find((view) => view.id === id);
        }
        if (info) byKey.set(key, info);
        return info ?? null;
      };
      if (tabsReady) {
        for (const view of views) {
          const key = String(view.params.key ?? "");
          if (openTabs.includes(key) || key === activeKey || controller.pendingDrops.has(key)) continue;
          byKey.delete(key);
          quietCloses.current.add(view.id);
          void ws.close(view.id, { force: true });
        }
        for (const key of openTabs) if (!byKey.has(key)) open(key);
      }
      // Selection follows only a change of active document, or an explicit
      // open (which may reopen the active one from a navigator tabbed over
      // it): any other reconcile must leave the panels' own selection alone.
      const activeChanged = activeKey !== lastActive || (tabsReady && !lastTabsReady) || revealRequest !== lastReveal;
      lastActive = activeKey;
      lastTabsReady = tabsReady;
      lastReveal = revealRequest;
      if (!activeKey || !activeChanged) return;
      const info = byKey.get(activeKey) ?? (tabsReady ? open(activeKey) : null);
      if (!info) return;
      if (info.placement === "hidden") ws.focus(info.id);
      else if (!info.selected) {
        // Selecting alone leaves DOM focus on the view it covers, which then
        // hides and drops focus to the body: an Enter on the paper's own
        // library button would strand the keyboard. When focus is still in
        // that covered view, take it along; focus anywhere else (the notes,
        // reached while a paper read was pending) stays where the writer put it.
        const covered = ws.views().find((view) => view.panelId === info.panelId && view.selected);
        const focusedView = document.activeElement?.closest("[data-view]")?.getAttribute("data-view");
        if (covered && focusedView === covered.id) ws.focus(info.id);
        else ws.select(info.id);
      }
      // A camera framing elsewhere hides it: widen the framing to show it,
      // unless the writer has moved on to another document meanwhile.
      requestAnimationFrame(() => {
        if (controller.app.get().activeKey !== activeKey) return;
        const handle = ws.view(info.id);
        if (handle && !handle.visible && handle.placement !== "hidden") ws.focus(info.id);
      });
    };
    const uninstall = controller.installHandlers({ resync: reconcile });
    reconcile();
    const unsubscribe = controller.app.subscribe(reconcile);
    return () => {
      unsubscribe();
      uninstall();
    };
  }, [controller, quietCloses, ws]);
}

/**
 * Pause, then unmount, heavy content whose panel is off screen: the PDF after
 * a while hidden, and the active board/sheet likewise (decks hibernate per
 * panel, see DeckSlot). The agent never hibernates; inactive boards and sheets
 * never mount anything heavy to begin with.
 */
function useHibernation(controller: TrellisController) {
  useEffect(() => {
    let pdfTimer: number | null = null;
    let editorTimer: number | null = null;
    const clear = (timer: number | null) => {
      if (timer !== null) window.clearTimeout(timer);
      return null;
    };
    const update = () => {
      const { present, visible, pdfLive, editorVisible, editorHibernated, switching } = controller.ui.get();
      const pdfShown = Boolean(present.pdf && visible.pdf);
      if (!present.pdf) {
        pdfTimer = clear(pdfTimer);
        if (pdfLive) controller.ui.set({ pdfLive: false });
      } else if (pdfShown) {
        pdfTimer = clear(pdfTimer);
        // Woken after a switch's animation, not in its frames (see beginSwitch).
        if (!pdfLive && !switching) controller.ui.set({ pdfLive: true });
      } else if (pdfLive && pdfTimer === null) {
        pdfTimer = window.setTimeout(() => {
          pdfTimer = null;
          const now = controller.ui.get();
          if (!now.visible.pdf) controller.ui.set({ pdfLive: false });
        }, HIBERNATE_AFTER_MS);
      }
      // Decks keep their own hosts, which hibernate per panel (see DeckSlot).
      const activeKey = controller.app.get().activeKey;
      const heavy = isHeavyDocument(activeKey) && !isOpenSlideDeckPath(activeKey);
      // Boards and sheets zoom themselves on pinch (decks, in their own hosts,
      // likewise); text editors let it zoom the workspace.
      // (A PDF opened here marks its own reader, whether or not the host is marked.)
      controller.hosts.editor.toggleAttribute("data-trellis-owns-gestures", heavy);
      if (!heavy || editorVisible) {
        editorTimer = clear(editorTimer);
        if (editorHibernated) controller.ui.set({ editorHibernated: false });
      } else if (!editorHibernated && editorTimer === null) {
        editorTimer = window.setTimeout(() => {
          editorTimer = null;
          const key = controller.app.get().activeKey;
          if (!controller.ui.get().editorVisible && isHeavyDocument(key) && !isOpenSlideDeckPath(key)) {
            controller.ui.set({ editorHibernated: true });
          }
        }, HIBERNATE_AFTER_MS);
      }
    };
    update();
    const offUi = controller.ui.subscribe(update);
    const offApp = controller.app.subscribe(update);
    return () => {
      offUi();
      offApp();
      clear(pdfTimer);
      clear(editorTimer);
    };
  }, [controller]);
}

export default TrellisWorkspace;
