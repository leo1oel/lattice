/**
 * The Trellis workspace: Project, Papers, Agent, the PDF and every
 * drawer as dockable panels, and document panels between them.
 *
 * See trellis-controller.ts for the contract with App. In short, App renders
 * everything; this component arranges stable host elements. Documents follow
 * App's single-active-document model: the active document's panel adopts the
 * live editor host, and every other document panel shows a read-only snapshot
 * (text) or a sleeping card (boards, sheets, decks, assets, papers) until it is
 * clicked. A panel that is not on screen renders nothing at all.
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
import { EditorView, lineNumbers } from "@codemirror/view";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { BookOpen, Check, ChevronRight, FileText, FolderTree, Moon, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { floatingSurfaceClassName, menuItemClassName, menuViewportClassName } from "@/components/ui/menu-surface";
import { popupMotionClassName } from "@/components/ui/popup-motion";
import { confirmAction, isOpenSlideDeckPath } from "../app-utils";
import { isSpreadsheetPath } from "../editor/spreadsheet/spreadsheet-types";
import { luxLatexHighlightStyle } from "../editor/latex/latex-editor";
import { isLatexSourcePath, useTextLanguageExtensions } from "../canvas/editor-extensions";
import { latex } from "../editor/latex/latex-language";
import { DeferredVisualMarkdownEditor } from "../canvas/canvas-lazy-editors";
import {
  TOOL_KINDS, documentTools, useTrellisApp, type TrellisController, type TrellisSingleton, type TrellisToolKind,
} from "./trellis-controller";
import {
  defaultLayout, loadLayout, saveLayout, clearLayout, enterPreset, returnLayout, withDocumentPanel, VIEW_TYPES,
  type ActivePreset,
} from "./trellis-layout";
import { installTrellisLabels } from "./trellis-labels";
import { PANEL_TITLES, spaceMixedScript } from "./trellis-titles";
import { MENU_ICONS, PANEL_ICONS, fileIcon } from "./trellis-icons";
import { FileHeaderTools } from "./trellis-header-tools";
import { measurePdfToolbarMinWidth } from "../pdf/pdf-toolbar-min-width";
import { holdWidthsWhileResizing } from "./trellis-hold-width";
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

/** Boards, sheets and decks: expensive enough to unmount when their panel is off screen. */
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

/** A read-only CodeMirror of a document that is not the active one. Click to edit there. */
function TextSnapshot({ controller, fileKey }: { controller: TrellisController; fileKey: string }) {
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
    if (!parent || text === null) return;
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers(),
          EditorView.lineWrapping,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          syntaxHighlighting(luxLatexHighlightStyle),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          EditorView.theme({ "&": { height: "100%" }, "& .cm-scroller": { height: "100% !important" } }),
          ...language,
        ],
      }),
    });
    viewRef.current = view;
    const scrollTop = controller.bridge?.textScrollTop(fileKey);
    if (scrollTop) requestAnimationFrame(() => { view.scrollDOM.scrollTop = scrollTop; });
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, [controller, fileKey, language, text]);
  return (
    <div
      className="trellis-snapshot source-editor"
      title={t`Click to edit`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const view = viewRef.current;
        const position = view?.posAtCoords({ x: event.clientX, y: event.clientY });
        const line = view && position != null ? view.state.doc.lineAt(position).number : undefined;
        controller.activate(fileKey, line);
      }}
    >
      <div ref={parentRef} className="code-editor-root trellis-snapshot-editor" />
      <span className="trellis-snapshot-badge">{t`Read-only preview · click to edit`}</span>
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

const refuse = () => false;

/**
 * A Paper that is not the active document, drawn read-only where it was being
 * read, so the Reading layout keeps it legible beside the notes being
 * written. It scrolls in place; a click (or its header's button) brings the
 * full reader back.
 */
function PaperSnapshot({ controller, fileKey }: { controller: TrellisController; fileKey: string }) {
  const { t } = useLingui();
  // Only beside the document being worked on: with that off screen, this tab
  // is merely selected on the way to becoming active (a restore, a switch).
  const besideActive = useSyncExternalStore(controller.ui.subscribe, () => controller.ui.get().editorVisible);
  if (!besideActive) return <SleepingDocument controller={controller} fileKey={fileKey} detail={t`Sleeping · click to open`} />;
  return <PaperSnapshotContent controller={controller} fileKey={fileKey} />;
}

function PaperSnapshotContent({ controller, fileKey }: { controller: TrellisController; fileKey: string }) {
  const { t } = useLingui();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [paper, setPaper] = useState<{ path: string; text: string; scrollTop: number } | null | undefined>(undefined);
  useEffect(() => {
    let disposed = false;
    void controller.bridge?.readPaper(fileKey).then((value) => {
      if (!disposed) setPaper(value);
    }, () => {
      if (!disposed) setPaper(null);
    });
    return () => { disposed = true; };
  }, [controller, fileKey]);
  // Back to where the reader left off once the document is tall enough to hold it.
  useEffect(() => {
    const scroller = scrollRef.current;
    const target = paper?.scrollTop ?? 0;
    if (!scroller || target <= 0) return;
    let frames = 0;
    let frame = requestAnimationFrame(function settle() {
      scroller.scrollTop = target;
      if (scroller.scrollTop < target - 1 && ++frames < 60) frame = requestAnimationFrame(settle);
    });
    return () => cancelAnimationFrame(frame);
  }, [paper]);
  if (paper === null) return <SleepingDocument controller={controller} fileKey={fileKey} detail={t`Sleeping · click to open`} />;
  return (
    <div className="trellis-paper-snapshot">
      {/* The reader's own header, so the text holds its place when the reader comes back. */}
      <header className="paper-reader-header">
        <div className="paper-local-actions">
          <button type="button" className="paper-local-action" onClick={() => controller.activate(fileKey)}>
            <BookOpen size={14} aria-hidden="true" />
            <span>{t`Open the reader`}</span>
          </button>
        </div>
      </header>
      <div ref={scrollRef} className="markdown-preview trellis-paper-snapshot-scroll">
        <div className="markdown-preview-content">
          {paper && (
            <Suspense fallback={null}>
              <DeferredVisualMarkdownEditor
                text={paper.text}
                activePath={paper.path}
                editable={false}
                optimizeForReading
                onChangeMarkdown={refuse}
                onUndo={refuse}
                onRedo={refuse}
              />
            </Suspense>
          )}
        </div>
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
        ? <TextSnapshot controller={controller} fileKey={key} />
        : kind === "paper"
          ? <PaperSnapshot controller={controller} fileKey={key} />
          : <SleepingDocument controller={controller} fileKey={key} detail={t`Sleeping · click to open`} />}
    </>
  );
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
  "--trellis-bg": "var(--surface-sidebar)",
  "--trellis-stage": "var(--surface-sidebar)",
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

/** Trellis's own shortcuts, less the whole-workspace overview (⌘⌥↑), which Lattice does not offer. */
const KEYMAP = { "navigation.overview": null };

type WorkspaceProps = { controller: TrellisController; projectRoot: string; dark: boolean };

/** Memoized: App re-renders on every keystroke, and nothing here needs to follow it. */
const TrellisWorkspace = memo(function TrellisWorkspace({ controller, projectRoot, dark }: WorkspaceProps) {
  const { t, i18n } = useLingui();
  const [{ initial, initialPreset, agentMinSize, pdfMinSize }] = useState(() => {
    installTrellisLabels();
    const saved = loadLayout(projectRoot);
    return {
      initial: saved.document,
      initialPreset: saved.preset,
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
  const onDocumentChange = useCallback((document: LayoutDocument) => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    pendingSave.current = () => saveLayout(projectRoot, document, presetRef.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      pendingSave.current?.();
      pendingSave.current = null;
    }, 400);
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
  }, [controller, projectRoot]);
  // Unmounting (a project switch, the window closing) writes the last change now.
  useEffect(() => () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    pendingSave.current?.();
    pendingSave.current = null;
  }, []);

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
    const onPress = (event: MouseEvent) => {
      if (event.button !== 0) return;
      if (event.target instanceof Element && event.target.closest("[data-trellis-part=tab-close]")) return;
      let node = event.target instanceof Element ? event.target : null;
      while (node && !(node instanceof HTMLElement && node.dataset.trellisPart === "tab")) node = node.parentElement;
      const viewId = node instanceof HTMLElement ? node.dataset.view : undefined;
      const view = viewId ? ws.view(viewId) : null;
      if (view?.type !== "file") return;
      const key = String(view.params.key ?? "");
      if (key && key !== controller.app.get().activeKey) controller.activateFromFocus(key);
    };
    const onPointerOver = (event: PointerEvent) => controller.rememberPointerPanel(event.target);
    root.addEventListener("click", onPress, true);
    root.addEventListener("pointerover", onPointerOver, true);
    return () => {
      root.removeEventListener("click", onPress, true);
      root.removeEventListener("pointerover", onPointerOver, true);
    };
  }, [controller, ws]);

  const onClose = useCallback((view: ViewInfo) => {
    if (resettingRef.current || quietCloses.current.delete(view.id)) return;
    if (view.type === "file") {
      void controller.bridge?.closeTab(String(view.params.key ?? ""));
    } else if ((TOOL_KINDS as readonly string[]).includes(view.type)) {
      controller.openDrawers.get()[view.type as TrellisToolKind]?.();
    }
  }, [controller]);

  // Reset: save first (Trellis skips close guards), then animate to the default.
  const resetFailed = t`Save failed, so the layout was not reset.`;
  useEffect(() => controller.installHandlers({
    reset: async () => {
      const handle = controller.ws;
      if (!handle) return;
      if (controller.bridge && !(await controller.bridge.save())) {
        controller.bridge.notify(resetFailed);
        return;
      }
      resettingRef.current = true;
      presetRef.current = null;
      try {
        clearLayout(projectRoot);
        handle.setDocument(defaultLayout());
      } finally {
        resettingRef.current = false;
      }
      controller.ui.set({ preset: null });
      controller.app.set({ filesRevision: controller.app.get().filesRevision + 1 });
      controller.resync();
    },
    // A preset regroups the open documents' own views, so no document closes
    // and nothing needs saving first; navigators, the Agent and tools wait
    // hidden, still mounted, for the writer's own layout to bring them back.
    preset: (preset) => {
      const handle = controller.ws;
      const current = presetRef.current;
      if (!handle || (current?.preset ?? null) === preset) return;
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
    // A panel the writer asks for is theirs to keep, even one a preset brought in.
    shown: (kind) => {
      const current = presetRef.current;
      if (current?.supplied.includes(kind)) presetRef.current = { ...current, supplied: current.supplied.filter((id) => id !== kind) };
    },
  }), [controller, projectRoot, resetFailed]);
  // The titlebar follows this workspace's preset; another project's starts in its own.
  useEffect(() => {
    controller.ui.set({ preset: presetRef.current?.preset ?? null });
    return () => controller.ui.set({ preset: null });
  }, [controller]);

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
  const fileMenu = (view: ViewHandle): MenuItem[] => {
    const key = String(view.params.key ?? "");
    const bridge = controller.bridge;
    const tools = controller.docTools.get();
    const active = controller.app.get().activeKey === key;
    switch (documentTools(controller.bridge?.tabKind(key) ?? "file", key)) {
      case "build":
        return [
          { id: "build", label: t`Build`, shortcut: "⌘S", run: () => bridge?.build(key, { beside: view.panelId }) },
          { id: "clean-build", label: t`Clean rebuild`, run: () => bridge?.build(key, { clean: true, beside: view.panelId }) },
          ...(tools.building ? [{ id: "stop-build", label: t`Stop the build`, run: () => bridge?.stopBuild() }] : []),
        ];
      case "views":
        if (!active || !tools.viewModes) return [];
        return ([["source", t`Edit`], ["split", t`Split`], ["pdf", t`Preview`]] as const).map(([mode, label]) => ({
          id: `view-${mode}`, label, checked: tools.viewMode === mode, run: () => bridge?.setViewMode(mode),
        }));
      case "paper":
        if (!active || !tools.paperViews) return [];
        return ([["blog", t`Blog`], ["fulltext", t`Paper`]] as const).map(([paperView, label]) => ({
          id: `paper-${paperView}`, label, checked: tools.paperView === paperView, run: () => bridge?.setPaperView(paperView),
        }));
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
    const fileViews = () => ws.views({ type: "file" });
    const reconcile = () => {
      const { activeKey, openTabs, tabsReady } = controller.app.get();
      const views = fileViews();
      const byKey = new Map(views.map((view) => [String(view.params.key ?? ""), view]));
      // A new document joins the active document's panel, else any document
      // panel on screen; with none left, it gets a panel of its own between
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
          const navigators = ["project", "papers", "agent"].flatMap((kind) => ws.view(kind)?.panelId ?? []);
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
      const activeChanged = activeKey !== lastActive || (tabsReady && !lastTabsReady);
      lastActive = activeKey;
      lastTabsReady = tabsReady;
      if (!activeKey || !activeChanged) return;
      const info = byKey.get(activeKey) ?? (tabsReady ? open(activeKey) : null);
      if (!info) return;
      if (info.placement === "hidden") ws.focus(info.id);
      else if (!info.selected) ws.select(info.id);
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
 * a while hidden, and the active board/sheet/deck likewise. The agent never
 * hibernates; inactive documents never mount anything heavy to begin with.
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
      const { present, visible, pdfLive, editorVisible, editorHibernated } = controller.ui.get();
      const pdfShown = Boolean(present.pdf && visible.pdf);
      if (!present.pdf) {
        pdfTimer = clear(pdfTimer);
        if (pdfLive) controller.ui.set({ pdfLive: false });
      } else if (pdfShown) {
        pdfTimer = clear(pdfTimer);
        if (!pdfLive) controller.ui.set({ pdfLive: true });
      } else if (pdfLive && pdfTimer === null) {
        pdfTimer = window.setTimeout(() => {
          pdfTimer = null;
          const now = controller.ui.get();
          if (!now.visible.pdf) controller.ui.set({ pdfLive: false });
        }, HIBERNATE_AFTER_MS);
      }
      const heavy = isHeavyDocument(controller.app.get().activeKey);
      // Boards, sheets and decks zoom themselves on pinch; text editors let it zoom the workspace.
      controller.hosts.editor.toggleAttribute("data-trellis-owns-gestures", heavy);
      if (!heavy || editorVisible) {
        editorTimer = clear(editorTimer);
        if (editorHibernated) controller.ui.set({ editorHibernated: false });
      } else if (!editorHibernated && editorTimer === null) {
        editorTimer = window.setTimeout(() => {
          editorTimer = null;
          if (!controller.ui.get().editorVisible && isHeavyDocument(controller.app.get().activeKey)) {
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
