/**
 * The seam between App and the Trellis workspace.
 *
 * App keeps owning every document, buffer and panel's React tree exactly as in
 * the fixed layout. Trellis only owns *where* things are. Each panel's content
 * is rendered by App through a portal into a stable host element, and the
 * matching Trellis view just adopts that host into its content element. So
 * App's state flow (and every cross-panel interaction built on it) is the same
 * in both layouts, and Trellis never sees App re-render.
 *
 * This module is eager and must stay tiny: it imports nothing from Trellis.
 */
import { createContext, useContext, useSyncExternalStore } from "react";
import type { MenuEntry, Placement, WorkspaceHandle } from "@danfessler/trellis";
import type { AssetPreview, FileViewState } from "../app-types";
import type { AgentPdfDocumentPlace } from "../agent/agent-host-context";
import { isHtmlFilePath } from "../app-utils";
import type { BuildOutcome } from "../app/use-build-pipeline";
import type { LayoutPreset } from "./trellis-layout";
import { WorkspaceLibrary } from "./trellis-workspaces";

/** Drawers that become dockable tool panels, keyed by their Trellis view type. */
export const TOOL_KINDS = ["history", "git", "comments", "overleaf", "literature", "todos", "checklist"] as const;
export type TrellisToolKind = typeof TOOL_KINDS[number];

/** Which drawer (by the class it passes to ResizableDrawer) docks as which tool panel. */
const DRAWER_TOOL_CLASSES: Array<[string, TrellisToolKind]> = [
  ["project-history-drawer", "history"],
  ["synara-source-control-drawer", "git"],
  ["editor-comments-drawer", "comments"],
  // With an Overleaf link the comments surface becomes Overleaf's chat, comments and review.
  ["overleaf-collab-drawer", "overleaf"],
  ["literature-drawer", "literature"],
  ["todo-drawer", "todos"],
  ["checklist-drawer", "checklist"],
];

/** Frames an editor stays on screen before focus may land in it (see `focusDocument`). */
const FOCUS_SETTLE_FRAMES = 6;

export function toolKindForDrawer(className: string | undefined): TrellisToolKind | null {
  if (!className) return null;
  const classes = className.split(/\s+/);
  return DRAWER_TOOL_CLASSES.find(([name]) => classes.includes(name))?.[1] ?? null;
}

export type TrellisSingleton = "project" | "papers" | "agent" | "pdf" | TrellisToolKind;

/** What a file panel holds: a project text/structured file, an asset preview or a Paper. */
export type TrellisTabKind = "file" | "asset" | "paper";

export type DocumentTools = "build" | "views" | "paper" | null;

/** Which tools a document panel's header carries for one document. */
export function documentTools(kind: TrellisTabKind, key: string): DocumentTools {
  if (kind === "paper") return "paper";
  if (kind !== "file") return null;
  const lower = key.toLocaleLowerCase();
  if (lower.endsWith(".tex")) return "build";
  return lower.endsWith(".md") || isHtmlFilePath(key) ? "views" : null;
}

/** Edit, Split or Preview for a Markdown or HTML document. */
export type TrellisViewMode = "source" | "split" | "pdf";

/** App's side of the bridge, replaced on every App render and read at event time. */
export type TrellisBridge = {
  /** Make `key` App's active document, optionally revealing a 1-based line. */
  activate: (key: string, line?: number) => void;
  /** Close App's tab for `key`, saving first. False keeps the panel open. */
  closeTab: (key: string) => Promise<boolean>;
  /** Flush and save the active document; false when that failed. */
  save: () => Promise<boolean>;
  tabKind: (key: string) => TrellisTabKind;
  tabLabel: (key: string) => string;
  /** The last known text of a project file, for an inactive panel's snapshot. */
  readText: (path: string) => Promise<string | null>;
  /** A Paper's reading text (the view it was read in, else the other), for an inactive Paper panel. */
  readPaper: (key: string) => Promise<{ path: string; text: string } | null>;
  /** A project asset (a PDF) as its preview reads it, for an inactive panel beside the active document; rejects with the backend's refusal. */
  readAsset: (path: string) => Promise<AssetPreview>;
  /** Text selected in a project PDF beside the active document (empty once cleared), as Agent context. */
  pdfTextSelect: (text: string, place: AgentPdfDocumentPlace) => void;
  /** Where the reader was in a file (its scroll, a PDF's page), shared by its live view and its snapshot. */
  viewState: (path: string) => FileViewState | undefined;
  rememberViewState: (path: string, update: Partial<FileViewState>) => void;
  /** Open (or re-open) the drawer behind a tool panel restored from a saved layout. */
  openTool: (kind: TrellisToolKind) => void;
  agentShown: () => void;
  notify: (message: string) => void;
  /** Actions a panel offers in its menu (and, when there is room, as tab-bar icons). */
  panelMenu: (kind: "project" | "papers" | "agent" | "pdf") => MenuEntry[];
  quickOpen: () => void;
  /** Build the project for `key` (made the active document first), and bring the PDF panel up. */
  build: (key: string, options?: { clean?: boolean; beside?: string }) => void;
  stopBuild: () => void;
  /** Switch the active document between Edit, Split and Preview. */
  setViewMode: (mode: TrellisViewMode) => void;
  setPaperView: (view: "blog" | "fulltext") => void;
};

/** What the tools in a document panel's header show; App keeps it current. */
export type TrellisDocToolsState = {
  building: boolean;
  /** How the last build ended: its time on a success, a failure, or null when there is nothing to show. */
  lastBuild: BuildOutcome | null;
  /** The active document's view, and whether it has Edit/Split/Preview at all. */
  viewMode: TrellisViewMode;
  viewModes: "markdown" | "html" | null;
  paperView: "blog" | "fulltext" | null;
  /** Both a blog and a full text exist, so the Paper panel can switch. */
  paperViews: boolean;
};

/** Where a panel is now: absent (closed), hidden (restore chip), or in the layout. */
export type TrellisPanelState = "absent" | "hidden" | "shown";

/** App state the workspace mirrors into panels. */
export type TrellisAppState = {
  projectRoot: string;
  activeKey: string;
  activeDirty: boolean;
  openTabs: readonly string[];
  /** False until App restored this project's tabs; file panels are reconciled only after. */
  tabsReady: boolean;
  /** Counts App's explicit opens: each one shows the active document, even one that was already active. */
  revealRequest: number;
  /** Latest revision of the project file list, so snapshots can re-read. */
  filesRevision: number;
  /**
   * App's project-scoped, cached image loader, for snapshots that show a
   * document's relative images (a Paper's figures). Its identity changes with
   * the project, which fences a switch; `assetRevision` bumps when a loaded
   * image changes on disk.
   */
  loadAsset: ((path: string) => Promise<string | null>) | null;
  assetRevision: number;
};

/** Workspace state App and the titlebar react to. */
export type TrellisUiState = {
  ready: boolean;
  present: Partial<Record<TrellisSingleton, boolean>>;
  visible: Partial<Record<TrellisSingleton, boolean>>;
  /** False while the PDF panel is hibernated (hidden long enough) or closed. */
  pdfLive: boolean;
  /** The active heavy document (board/sheet/deck) is hibernated. */
  editorHibernated: boolean;
  /** Whether the active document's panel is on screen. */
  editorVisible: boolean;
  hidden: Array<{ panelId: string; title: string }>;
  framed: string | null;
  /** The layout preset the workspace is in, or null in the writer's own layout. */
  preset: LayoutPreset | null;
  /** The named workspace the project is in (under any preset); empty before the workspace mounts. */
  workspace: string;
  /** The workspace whose name the titlebar is editing, as a new one's is at once. */
  renaming: string | null;
  /** Whether the project's layout (under any preset) is arranged other than its workspace saved it. */
  dirty: boolean;
  /** The narrowest window content, in CSS px, at which the docked layout still fits at full size (0 without a workspace). */
  minWidth: number;
  /** Content minimums measured from the live panels, in CSS px (0 until measured): the Agent's from its composer, the PDF's from its toolbar. */
  agentMinWidth: number;
  pdfMinWidth: number;
};

type Listener = () => void;

function createHost({ className }: { className: string }): HTMLDivElement {
  const host = document.createElement("div");
  host.className = className;
  return host;
}

/** Pinch and Ctrl/Alt+wheel inside this host zoom its content, not the workspace (see the Trellis patch). */
function ownsGestures(host: HTMLDivElement) {
  host.setAttribute("data-trellis-owns-gestures", "");
  return host;
}

class SmallStore<T extends object> {
  private listeners = new Set<Listener>();
  constructor(private value: T) {}
  get = () => this.value;
  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  set(patch: Partial<T>) {
    let changed = false;
    for (const key of Object.keys(patch) as Array<keyof T>) {
      if (!Object.is(this.value[key], patch[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.value = { ...this.value, ...patch };
    for (const listener of [...this.listeners]) listener();
  }
}

export class TrellisController {
  /** Stable mount points App portals panel content into. */
  readonly hosts = {
    editor: createHost({ className: "canvas-body trellis-editor-host" }),
    pdf: ownsGestures(createHost({ className: "canvas-body trellis-pdf-host" })),
    project: createHost({ className: "trellis-host trellis-navigator-host" }),
    papers: createHost({ className: "trellis-host trellis-navigator-host" }),
    agent: createHost({ className: "trellis-host trellis-agent-host" }),
    projectActions: createHost({ className: "trellis-accessory-host" }),
    papersActions: createHost({ className: "trellis-accessory-host" }),
    agentActions: createHost({ className: "trellis-accessory-host" }),
  };
  readonly toolHosts = new Map<TrellisToolKind, HTMLDivElement>();
  readonly app = new SmallStore<TrellisAppState>({
    projectRoot: "", activeKey: "", activeDirty: false, openTabs: [], tabsReady: false, revealRequest: 0, filesRevision: 0,
    loadAsset: null, assetRevision: 0,
  });
  readonly ui = new SmallStore<TrellisUiState>({
    ready: false, present: {}, visible: {}, pdfLive: false, editorHibernated: false, editorVisible: false,
    hidden: [], framed: null, preset: null, workspace: "", renaming: null, dirty: false, minWidth: 0, agentMinWidth: 0, pdfMinWidth: 0,
  });
  /** The writer's named workspaces, shared by every project. */
  readonly workspaces = new WorkspaceLibrary();
  /** The layout's minimum width as a live value the native window minimum follows. */
  readonly layoutMinWidth = { subscribe: this.ui.subscribe, get: () => this.ui.get().minWidth };
  /** Tool drawers App currently has open, with the callback that closes each. */
  readonly openDrawers = new SmallStore<Partial<Record<TrellisToolKind, () => void>>>({});
  readonly docTools = new SmallStore<TrellisDocToolsState>({
    building: false, lastBuild: null, viewMode: "source", viewModes: null, paperView: null, paperViews: false,
  });
  /** Files being dragged in from the Project panel: open as panels, not yet as App tabs. */
  readonly pendingDrops = new Set<string>();
  bridge: TrellisBridge | null = null;
  ws: WorkspaceHandle | null = null;
  private pointerPanel: string | null = null;
  private resetHandler: (() => Promise<void>) | null = null;
  private resyncHandler: (() => void) | null = null;
  private presetHandler: ((preset: LayoutPreset | null) => void) | null = null;
  private workspaceHandler: ((id: string) => void) | null = null;
  private newWorkspaceHandler: ((name: string) => string | null) | null = null;
  private saveWorkspaceHandler: (() => void) | null = null;
  private revertWorkspaceHandler: (() => void) | null = null;
  private shownHandler: ((kind: TrellisSingleton) => void) | null = null;

  setBridge(bridge: TrellisBridge) {
    this.bridge = bridge;
  }

  /** Save, then animate back to the default layout (installed by the mounted workspace). */
  resetLayout() {
    return this.resetHandler?.() ?? Promise.resolve();
  }

  /** Reconcile document panels with App's tabs now (installed by the mounted workspace). */
  resync() {
    this.resyncHandler?.();
  }

  /** Enter a layout preset, or (null) return to the writer's own layout (installed by the mounted workspace). */
  setPreset(preset: LayoutPreset | null) {
    this.presetHandler?.(preset);
  }

  /**
   * Enter the named workspace `id` (installed by the mounted workspace). The
   * one the project is in already returns from a preset over it.
   */
  switchWorkspace(id: string) {
    if (id === this.ui.get().workspace && this.ui.get().preset) this.setPreset(null);
    else this.workspaceHandler?.(id);
  }

  /** ⌘1 to ⌘9: the workspace at that position, if there is one. */
  switchWorkspaceAt(index: number) {
    const entry = this.workspaces.list()[index];
    if (entry) this.switchWorkspace(entry.id);
  }

  /**
   * A new workspace named from `name`, holding the arrangement on screen, and
   * the project in it; its name goes straight into editing. Null without a workspace.
   */
  createWorkspace(name: string): string | null {
    const id = this.newWorkspaceHandler?.(name) ?? null;
    if (id) this.ui.set({ renaming: id });
    return id;
  }

  /** Save the project's arrangement (under any preset) to its workspace. */
  saveWorkspace() {
    this.saveWorkspaceHandler?.();
  }

  /** Load the project's workspace as it was saved, the open documents placed in it. */
  revertWorkspace() {
    this.revertWorkspaceHandler?.();
  }

  installHandlers(handlers: {
    reset?: () => Promise<void>;
    resync?: () => void;
    preset?: (preset: LayoutPreset | null) => void;
    workspace?: (id: string) => void;
    newWorkspace?: (name: string) => string | null;
    saveWorkspace?: () => void;
    revertWorkspace?: () => void;
    shown?: (kind: TrellisSingleton) => void;
  }) {
    if (handlers.reset) this.resetHandler = handlers.reset;
    if (handlers.resync) this.resyncHandler = handlers.resync;
    if (handlers.preset) this.presetHandler = handlers.preset;
    if (handlers.workspace) this.workspaceHandler = handlers.workspace;
    if (handlers.newWorkspace) this.newWorkspaceHandler = handlers.newWorkspace;
    if (handlers.saveWorkspace) this.saveWorkspaceHandler = handlers.saveWorkspace;
    if (handlers.revertWorkspace) this.revertWorkspaceHandler = handlers.revertWorkspace;
    if (handlers.shown) this.shownHandler = handlers.shown;
    return () => {
      if (handlers.reset && this.resetHandler === handlers.reset) this.resetHandler = null;
      if (handlers.resync && this.resyncHandler === handlers.resync) this.resyncHandler = null;
      if (handlers.preset && this.presetHandler === handlers.preset) this.presetHandler = null;
      if (handlers.workspace && this.workspaceHandler === handlers.workspace) this.workspaceHandler = null;
      if (handlers.newWorkspace && this.newWorkspaceHandler === handlers.newWorkspace) this.newWorkspaceHandler = null;
      if (handlers.saveWorkspace && this.saveWorkspaceHandler === handlers.saveWorkspace) this.saveWorkspaceHandler = null;
      if (handlers.revertWorkspace && this.revertWorkspaceHandler === handlers.revertWorkspace) this.revertWorkspaceHandler = null;
      if (handlers.shown && this.shownHandler === handlers.shown) this.shownHandler = null;
    };
  }

  /** Papers, and PDFs opened as documents, are what the Reading layout reads. */
  isReading(key: string) {
    const kind = this.bridge?.tabKind(key) ?? "file";
    return kind === "paper" || (kind === "asset" && key.toLocaleLowerCase().endsWith(".pdf"));
  }
  private wsListeners = new Set<Listener>();

  /** Last text seen per document, so an inactive panel's snapshot paints at once. */
  readonly texts = new Map<string, string>();
  private lastExplicitActivation = { key: "", at: 0 };

  /**
   * A click inside a document panel (with the line it landed on) activates it
   * right away; the focus Trellis reports for that same click must not race it
   * with a line-less activation.
   */
  activate(key: string, line?: number) {
    this.lastExplicitActivation = { key, at: performance.now() };
    this.bridge?.activate(key, line);
  }

  /**
   * The inactive PDF whose Reading snapshot the current press or focus landed
   * in. That snapshot is the working viewer beside the notes: activating the
   * PDF would swap it for the live host mid-click, destroying the page, zoom
   * or search field the reader just focused. The workspace clears this on
   * every press and focus before the snapshot (deeper in the tree) sets it.
   */
  private readingHold = { key: "", at: 0 };

  holdReading(key: string | null) {
    this.readingHold = { key: key ?? "", at: performance.now() };
  }

  activateFromFocus(key: string) {
    // A file dragged in from the Project panel is activated once it lands.
    if (this.pendingDrops.has(key)) return;
    window.setTimeout(() => {
      const recent = this.lastExplicitActivation;
      if (recent.key === key && performance.now() - recent.at < 500) return;
      // Bounded in time too: a later focus Trellis reports without a DOM
      // event (a keyboard shortcut) must not be held by an old press.
      const hold = this.readingHold;
      if (hold.key === key && performance.now() - hold.at < 500) return;
      if (key !== this.app.get().activeKey) this.bridge?.activate(key);
    }, 0);
  }

  panelState(kind: TrellisSingleton): TrellisPanelState {
    const view = this.ws?.view(kind);
    if (!view) return "absent";
    return view.placement === "hidden" ? "hidden" : "shown";
  }

  /**
   * Bring a panel on screen: restore it if hidden, reopen it where it belongs
   * if it was closed, and focus it (which also widens a framing that hid it).
   */
  showPanel(kind: TrellisSingleton, { focus = true }: { focus?: boolean } = {}) {
    const ws = this.ws;
    if (!ws) return;
    this.shownHandler?.(kind);
    if ((TOOL_KINDS as readonly string[]).includes(kind)) {
      this.bridge?.openTool(kind as TrellisToolKind);
      return;
    }
    const view = ws.view(kind);
    if (view) {
      if (view.placement === "hidden" || focus || !view.visible) ws.focus(kind);
      return;
    }
    ws.open(kind, { id: kind, focus, placement: this.homeOf(kind) });
  }

  /**
   * Bring the document panel for `key` forward and hand its editor the
   * keyboard. Focus alone restores the caret and selection the editor kept
   * while it was covered, so nothing is selected or moved. The document may
   * still be becoming active (a Paper was in front) and its editor mounting,
   * so both are waited for a frame at a time, for about a second.
   *
   * An editor that has just appeared is still landing its remembered caret
   * and measuring its lines, and focus taken then puts the caret at the
   * start; so it is focused only once it has been on screen for a few frames.
   * Trellis settles its own focus on the panel a frame or so after showing
   * it, so the editor's focus counts only once it has held for a frame.
   */
  focusDocument(key: string) {
    let frames = 0;
    let shown = false;
    let settled = 0;
    let held = false;
    let last: HTMLElement | null = null;
    const land = () => {
      const ws = this.ws;
      const view = ws?.views({ type: "file" }).find((item) => item.params.key === key);
      if (!ws || !view || this.app.get().activeKey !== key) {
        if (++frames < 90) requestAnimationFrame(land);
        return;
      }
      if (!shown) ws.focus(view.id);
      shown = true;
      const surface = this.hosts.editor.querySelector<HTMLElement>(".cm-content, .ProseMirror");
      settled = surface && surface === last && surface.getClientRects().length ? settled + 1 : 0;
      last = surface;
      if (surface && settled >= FOCUS_SETTLE_FRAMES) {
        if (document.activeElement === surface && held) return;
        held = document.activeElement === surface;
        if (!held) surface.focus({ preventScroll: true });
      }
      if (++frames < 90) requestAnimationFrame(land);
    };
    land();
  }

  /**
   * Titlebar toggles: hide a panel that is on screen (it keeps its state);
   * one that is closed, hidden, behind another tab or outside a zoomed-in
   * view comes forward instead.
   */
  togglePanel(kind: TrellisSingleton) {
    const ws = this.ws;
    if (!ws) return;
    const view = ws.view(kind);
    if (view && view.placement !== "hidden" && view.visible) ws.hide(kind);
    else this.showPanel(kind);
  }


  /**
   * Bring the PDF panel up for a build: a closed one comes back to the right
   * of the document that asked for the build.
   */
  showPdfFor(panelId?: string) {
    const ws = this.ws;
    if (!ws) return;
    if (ws.view("pdf") || !panelId) {
      this.showPanel("pdf", { focus: false });
      return;
    }
    this.shownHandler?.("pdf");
    ws.open("pdf", { id: "pdf", focus: false, placement: { beside: panelId, edge: "right", share: 0.42 } });
  }

  /** The panel of the active document, else of any document on screen. */
  private documentPanel(): string | null {
    const files = this.ws?.views({ type: "file" }).filter((view) => view.placement !== "hidden") ?? [];
    const key = this.app.get().activeKey;
    return (files.find((view) => view.params.key === key) ?? files[0])?.panelId ?? null;
  }

  /**
   * Where a closed panel comes back. Project and the Agent share a panel,
   * Papers sits below them, the PDF right of the documents, and tools join
   * the Project/Agent panel as tabs; with those gone, beside the documents.
   */
  private homeOf(kind: TrellisSingleton): Placement {
    const ws = this.ws;
    const docked = (id: string) => {
      const view = ws?.view(id);
      return view && view.placement === "docked" ? view.panelId : null;
    };
    const into = (id: string): Placement | null => {
      const panelId = docked(id);
      return panelId ? { into: panelId } : null;
    };
    const near = (id: string, edge: "top" | "bottom", share: number): Placement | null => {
      const panelId = docked(id);
      return panelId ? { beside: panelId, edge, share } : null;
    };
    const documents = this.documentPanel();
    const besideDocuments = (edge: "left" | "right", share: number): Placement =>
      documents ? { beside: documents, edge, share } : "side";
    switch (kind) {
      case "project": return into("agent") ?? near("papers", "top", 0.62) ?? besideDocuments("left", 0.3);
      case "agent": return into("project") ?? near("papers", "top", 0.62) ?? besideDocuments("left", 0.3);
      case "papers": return near("project", "bottom", 0.38) ?? near("agent", "bottom", 0.38) ?? besideDocuments("left", 0.25);
      case "pdf": return besideDocuments("right", 0.42);
      default: return into("agent") ?? into("project") ?? besideDocuments("right", 0.32);
    }
  }

  toolHost(kind: TrellisToolKind): HTMLDivElement {
    let host = this.toolHosts.get(kind);
    if (!host) {
      host = createHost({ className: `trellis-host trellis-tool-host trellis-tool-${kind}` });
      this.toolHosts.set(kind, host);
    }
    return host;
  }

  attachWorkspace(ws: WorkspaceHandle | null) {
    this.pointerPanel = null;
    this.ws = ws;
    for (const listener of [...this.wsListeners]) listener();
  }

  subscribeWorkspace = (listener: Listener) => {
    this.wsListeners.add(listener);
    return () => { this.wsListeners.delete(listener); };
  };

  /**
   * A drawer opened in App: show (or reveal) its tool panel. A panel that is
   * already in the layout was restored with it (a drawer's panel closes with
   * the drawer) and asked for the drawer itself, so it stays where the layout
   * put it, even parked hidden by a Writing or Reading layout, rather than
   * moving into the document panel.
   */
  openDrawer(kind: TrellisToolKind, close: () => void) {
    this.openDrawers.set({ [kind]: close });
    if (!this.ws?.view(kind)) this.revealTool(kind);
  }

  /** The drawer closed in App: its panel goes too, unless it was already closed there. */
  closeDrawer(kind: TrellisToolKind, close: () => void) {
    if (this.openDrawers.get()[kind] !== close) return;
    this.openDrawers.set({ [kind]: undefined });
    const ws = this.ws;
    if (ws?.views({ type: kind }).length) void ws.close(kind, { force: true });
  }

  /** A view's tab element: its icon slot sits directly inside it. */
  private tabOf(viewId: string): HTMLElement | null {
    return this.ws?.surfaces().find((surface) => surface.view.id === viewId)?.icon.parentElement ?? null;
  }

  /** Where the panel holding `viewId` is on screen (its header included), if it is. */
  panelRect(viewId: string): DOMRect | null {
    let node = this.tabOf(viewId);
    while (node && node.dataset.trellisPart !== "panel") node = node.parentElement;
    return node?.getBoundingClientRect() ?? null;
  }

  /** Reveal a tool panel whose drawer is already open; an opening drawer reveals itself. */
  revealOpenTool(kind: TrellisToolKind) {
    if (this.openDrawers.get()[kind]) this.revealTool(kind);
  }

  /**
   * Hand a pointer drag of a project file that left the Project panel to
   * Trellis, so the file lands where Trellis's own drop targets say: beside a
   * panel's edge, in a seam, or on a tab strip. The file
   * joins the Project panel as a tab and a press on that tab starts Trellis's
   * tab drag; the pointer is already away, so the tab lifts out at once.
   * Released without a target, the tab falls back into the Project panel and
   * is closed again. Returns false when there is no workspace to drag into.
   */
  beginFileDrag(key: string, pointer: PointerEvent): boolean {
    const ws = this.ws;
    const project = ws?.view("project");
    if (!ws || !project || project.placement === "hidden") return false;
    const existing = ws.views({ type: "file" }).find((view) => view.params.key === key);
    if (existing?.placement === "hidden") return false;
    const opened = !existing;
    // The tab the Project panel shows now (Project, or a tool beside it) stays
    // selected: the dragged file only passes through that panel.
    const shown = ws.views().find((view) => view.panelId === project.panelId && view.selected)?.id ?? project.id;
    this.pendingDrops.add(key);
    const info = existing ?? ws.open("file", {
      params: { key },
      focus: false,
      reuse: (view) => view.type === "file" && view.params.key === key,
      placement: { into: project.panelId },
    });
    if (opened) ws.select(shown);
    const tab = this.tabOf(info.id);
    if (tab?.dataset.trellisPart !== "tab") {
      if (opened) void ws.close(info.id, { force: true });
      this.pendingDrops.delete(key);
      return false;
    }
    const box = tab.getBoundingClientRect();
    const finish = (dropped: boolean) => {
      listening.abort();
      // Trellis commits the drop on the same pointerup; read the outcome after it.
      // The file's own tab closes while it is still a pending drop: not an App tab.
      requestAnimationFrame(() => {
        const view = ws.view(info.id);
        const keepShown = () => {
          const source = ws.view(shown);
          if (source && !source.selected) ws.select(shown);
        };
        const cancelled = !view || !dropped || view.panelId === ws.view("project")?.panelId;
        if (view && cancelled && opened) void ws.close(info.id, { force: true }).then(keepShown);
        this.pendingDrops.delete(key);
        if (!cancelled) this.activate(key);
        keepShown();
      });
    };
    const listening = new AbortController();
    window.addEventListener("pointerup", (event) => { if (event.pointerId === pointer.pointerId) finish(true); }, { signal: listening.signal });
    window.addEventListener("pointercancel", (event) => { if (event.pointerId === pointer.pointerId) finish(false); }, { signal: listening.signal });
    window.addEventListener("keydown", (event) => { if (event.key === "Escape") finish(false); }, { signal: listening.signal, capture: true });
    tab.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerId: pointer.pointerId,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: box.left + Math.min(24, box.width / 2),
      clientY: box.top + box.height / 2,
    }));
    return true;
  }

  /** Remember the panel crossed before entering the global titlebar. This is
   * event-only state: hovering never triggers a React render or a layout read. */
  rememberPointerPanel(target: EventTarget | null) {
    if (!(target instanceof Element)) return;
    const surface = target.closest<HTMLElement>('[data-trellis-part="surface"]');
    const panel = target.closest<HTMLElement>('[data-trellis-part="panel"]');
    const id = surface?.dataset.view;
    const panelId = (id ? this.ws?.view(id)?.panelId : null) ?? panel?.dataset.panel;
    if (panelId) this.pointerPanel = panelId;
  }

  revealTool(kind: TrellisToolKind) {
    const ws = this.ws;
    if (!ws) return;
    const views = ws.views();
    const anchor = views.some((view) => view.panelId === this.pointerPanel && view.placement !== "hidden")
      ? this.pointerPanel : this.documentPanel();
    const existing = views.find((view) => view.type === kind);
    if (existing) {
      // Repeated clicks follow the same placement rule, preserving the tool's
      // singleton state instead of silently focusing a distant old location.
      if (anchor && existing.panelId !== anchor) ws.dock(existing.id, { into: anchor });
      ws.focus(existing.id);
      return;
    }
    ws.open(kind, { id: kind, placement: anchor ? { into: anchor } : this.homeOf(kind) });
  }

}

export const TrellisControllerContext = createContext<TrellisController | null>(null);

export function useTrellisController() {
  return useContext(TrellisControllerContext);
}

export function useTrellisUi<T>(controller: TrellisController, select: (state: TrellisUiState) => T): T {
  return useSyncExternalStore(controller.ui.subscribe, () => select(controller.ui.get()));
}

export function useTrellisApp<T>(controller: TrellisController, select: (state: TrellisAppState) => T): T {
  return useSyncExternalStore(controller.app.subscribe, () => select(controller.app.get()));
}

/** The named workspaces, re-read when one is added, removed, renamed or moved. */
export function useWorkspaces(controller: TrellisController) {
  return useSyncExternalStore(controller.workspaces.subscribe, controller.workspaces.list);
}

/**
 * The workspace the project is in; before the workspace mounts, the one it
 * will open in (so its mount, naming the same one, renders nothing again).
 */
export function useCurrentWorkspace(controller: TrellisController) {
  return useTrellisUi(controller, (state) => state.workspace || controller.workspaces.recent());
}
