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
 * own live host (see DeckSlot in trellis-document-views.tsx).
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import {
  Workspace, ViewType,
  type LayoutDocument, type MenuEntry, type MenuItem, type MenuRequest, type ViewHandle, type ViewInfo,
  type WorkspaceHandle,
} from "@danfessler/trellis-react";
import "@danfessler/trellis/style.css";
import { FileText } from "lucide-react";
import { retainParkedEditors } from "../editor/parked-editors";
import { TOOL_KINDS, documentTools, type TrellisController, type TrellisSingleton, type TrellisToolKind } from "./trellis-controller";
import {
  differsFromWorkspace, filledSlots, keepDocumentSlot, openProjectLayout, placesOf, saveLayout,
  VIEW_TYPES, type ActiveFocus, type ActivePreset, type DocumentPlaces,
} from "./trellis-layout";
import { dismissAppToastByDedupeKey } from "../telemetry/app-log-store";
import { TRELLIS_KEYMAP } from "./trellis-keymap";
import { installTrellisLabels } from "./trellis-labels";
import { layoutShape } from "./trellis-workspaces";
import { PANEL_TITLES } from "./trellis-titles";
import { PANEL_ICONS } from "./trellis-icons";
import { PanelMenu } from "./trellis-panel-menu";
import { useDocumentTabs, withTabItems } from "./trellis-document-tabs";
import type { FileParams } from "./trellis-tab-policy";
import { FileHeaderTools } from "./trellis-header-tools";
import { terminalViewType } from "../terminal/terminal-view-type";
import { measurePdfToolbarMinWidth } from "../pdf/pdf-toolbar-min-width";
import { holdWidthsWhileResizing } from "./trellis-hold-width";
import { AgentView, HostSlot, NavigatorView, PdfView, SlotView, ToolView, WorkspaceEmpty } from "./trellis-panel-views";
import { FileView } from "./trellis-document-views";
import { PanelErrorBoundary } from "../telemetry/panel-error-boundary";
import { installLayoutHandlers, RESET_UNDO_TOAST, type ResetUndo } from "./trellis-layout-handlers";
import { useTabSync } from "./use-tab-sync";
import { useHibernation } from "./use-hibernation";
import "./trellis.css";

// Before any workspace exists: Trellis writes some labels once, at creation.
installTrellisLabels();

/** Content minima only. The Trellis patch separately reserves header actions
 * and all tabs at 100px each (capped at 480px, see trellis.css). A panel is
 * as wide as its widest view needs, so selecting another tab never resizes
 * it. The Agent and the PDF raise theirs to what their live content
 * measures (see `measuredMinSize`). The Agent's height keeps one row of its
 * empty thread's starters clear of the composer and an editor selection's
 * context bar above it, the most the empty thread can give up (its starters
 * compact as the panel shortens). */
const MIN_SIZE = {
  project: { width: 140, height: 120 },
  papers: { width: 180, height: 120 },
  agent: { width: 220, height: 240 },
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

// Trellis draws its chrome from these. Every value is a Lattice design token,
// so both themes follow the app.
const TOKENS: Record<string, string> = {
  "--trellis-font": "var(--ui-font)",
  "--trellis-font-size": "var(--type-body-compact-size)",
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
  "--trellis-radius": "calc(var(--radius-surface) * var(--corner-smoothing))",
  // The tabs' inset and corner are trellis.css's, on the tab bar.
  "--trellis-tabbar-height": "var(--tab-strip-height)",
  "--trellis-gap": "var(--space-3)",
  // eslint-disable-next-line lingui/no-unlocalized-strings -- a CSS box-shadow value
  "--trellis-focus-ring": "0 0 0 var(--focus-ring-width) var(--focus-ring)",
};

/** `focusMode` comes from App, which reads it already: a subscription here would cost a hook on every startup render. */
type WorkspaceProps = { controller: TrellisController; projectRoot: string; dark: boolean; focusMode: boolean };

/** Memoized: App re-renders on every keystroke, and nothing here needs to follow it. */
const TrellisWorkspace = memo(function TrellisWorkspace({ controller, projectRoot, dark, focusMode }: WorkspaceProps) {
  // Left to React as it was before its layout commands moved out to
  // trellis-layout-handlers.ts: their try/finally made the compiler skip it,
  // and compiling it changes what its renders memoize, which is a change of
  // its own to measure rather than a side effect of the move.
  // eslint-disable-next-line lingui/no-unlocalized-strings -- a React Compiler directive
  "use no memo";
  const { t, i18n } = useLingui();
  const [{ initial, initialPreset, initialFocus, initialWorkspace, initialPlaces, agentMinSize, pdfMinSize }] = useState(() => {
    installTrellisLabels();
    const saved = openProjectLayout(projectRoot, controller.workspaces);
    return {
      initial: saved.document,
      initialPreset: saved.preset,
      initialFocus: saved.focus,
      initialWorkspace: saved.workspace,
      initialPlaces: saved.places,
      agentMinSize: measuredMinSize(MIN_SIZE.agent, () => controller.ui.get().agentMinWidth),
      pdfMinSize: measuredMinSize(MIN_SIZE.pdf, () => controller.ui.get().pdfMinWidth),
    };
  });
  const [ws, setWs] = useState<WorkspaceHandle | null>(null);
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const handleRef = useCallback((handle: WorkspaceHandle | null) => {
    controller.attachWorkspace(handle);
    setWs(handle);
  }, [controller]);
  useEffect(() => {
    // The open tabs' source editors, parked while in the background, and only
    // theirs: a closed tab's or another project's state is let go. Here, not
    // beside the App code that sets the open tabs, which loads at startup
    // without CodeMirror.
    const retainOpenTabs = () => {
      const { projectRoot: root, openTabs } = controller.app.get();
      retainParkedEditors(root || null, openTabs);
    };
    const unsubscribe = controller.app.subscribe(retainOpenTabs);
    return () => {
      unsubscribe();
      controller.attachWorkspace(null);
    };
  }, [controller]);
  // Trellis reads its strings (menus, drop labels, tooltips) from this table on use.
  useEffect(() => installTrellisLabels(), [i18n.locale]);

  // Views App closed (a file deleted) or a reset replaced: their close
  // events must not close App tabs again.
  const quietCloses = useRef(new Set<string>());
  const resettingRef = useRef(false);
  /** The preset the layout is in, with the writer's own layout to return to. */
  const presetRef = useRef<ActivePreset | null>(initialPreset);
  /** Focus mode, over the layout (a preset's included) it returns to. */
  const focusRef = useRef<ActiveFocus | null>(initialFocus);
  /** The writer's own layout, under any preset or focus mode, given the one on screen. */
  const ownLayout = useCallback(
    (document: LayoutDocument) => presetRef.current?.previous ?? focusRef.current?.previous ?? document,
    [],
  );
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
  useDocumentTabs(controller, ws);

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
    controller.ui.set({ dirty: differsFromWorkspace(ownLayout(document), controller.workspaces, workspaceRef.current) });
    // Any arrangement but the one a reset left supersedes undoing it.
    if (resetUndo.current && layoutShape(document) !== resetUndo.current.left) withdrawUndo();
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    // The workspace this change was made in, even if the save lands after a switch.
    const workspace = workspaceRef.current;
    pendingSave.current = () => {
      placesRef.current = { ...placesRef.current, [workspace]: placesOf(ownLayout(document)) };
      saveLayout(projectRoot, { document, preset: presetRef.current, focus: focusRef.current, workspace, places: placesRef.current });
    };
    saveTimer.current = window.setTimeout(flushSave, 400);
    const snapshot = controller.ws?.getSnapshot();
    if (snapshot) {
      // In a preset or focus mode, the panels it parked come back with the
      // writer's own layout (or their toggles), not with a chip each.
      const hidden = snapshot.hidden
        .filter((entry) => (!presetRef.current && !focusRef.current) || entry.views.some((item) => item.type === "file"))
        .map((entry) => ({ panelId: entry.panelId, title: entry.views.map((item) => item.title).join(", ") }));
      const previous = controller.ui.get().hidden;
      // Every layout change reports the hidden list; keep the old array when
      // nothing in it changed, so its subscribers (the titlebar) do not
      // re-render on each drag, resize or restore step.
      const same = previous.length === hidden.length
        && previous.every((entry, index) => entry.panelId === hidden[index].panelId && entry.title === hidden[index].title);
      controller.ui.set({ framed: snapshot.framed, hidden: same ? previous : hidden });
    }
  }, [controller, flushSave, ownLayout, projectRoot, withdrawUndo]);
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
    // (in a preset or focus mode, the return to the writer's layout keeps it).
    const handle = controller.ws;
    const kept = handle && view.type === "file" && !presetRef.current && !focusRef.current
      ? keepDocumentSlot(lastDocument.current, handle.getDocument(), view.id)
      : null;
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
  useEffect(() => installLayoutHandlers({
    controller, resettingRef, presetRef, focusRef, workspaceRef, placesRef, resetUndo, pendingReset, resetGeneration,
    flushSave, onDocumentChange, ownLayout, withdrawUndo,
    resetFailed, resetToast: { source: resetToast.source, title: resetToast.title, undo: resetToast.undo },
  }), [controller, flushSave, onDocumentChange, ownLayout, resetFailed, resetToast.source, resetToast.title, resetToast.undo, withdrawUndo]);
  // The titlebar follows this workspace's preset, named workspace and unsaved changes; another project's starts in its own.
  useEffect(() => {
    controller.ui.set({
      preset: presetRef.current?.preset ?? null,
      focus: Boolean(focusRef.current),
      focusPdf: focusRef.current?.pdf ?? false,
      workspace: workspaceRef.current,
      dirty: differsFromWorkspace(ownLayout(controller.ws?.getDocument() ?? initial), controller.workspaces, workspaceRef.current),
    });
    return () => controller.ui.set({ preset: null, focus: false, focusPdf: false, dirty: false });
  }, [controller, initial, ownLayout]);
  // Another window can delete the workspace the project is in: the project
  // moves to the one last entered, its layout as it is, and remembers that.
  // Or save it: the project keeps its layout, which differs from the new
  // arrangement, or now matches it.
  useEffect(() => controller.workspaces.subscribe(() => {
    const handle = controller.ws;
    if (controller.workspaces.get(workspaceRef.current)) {
      const document = handle?.getDocument();
      if (document) controller.ui.set({ dirty: differsFromWorkspace(ownLayout(document), controller.workspaces, workspaceRef.current) });
      return;
    }
    workspaceRef.current = controller.workspaces.recent();
    controller.ui.set({ workspace: workspaceRef.current });
    if (handle) onDocumentChange(handle.getDocument());
  }), [controller, onDocumentChange, ownLayout]);

  const title = (kind: TrellisSingleton) => i18n._(PANEL_TITLES[kind]);
  const actions = (kind: "project" | "papers" | "agent" | "pdf") => () => controller.bridge?.panelMenu(kind) ?? [];
  const menuRef = useRef<MenuRequest | null>(null);
  const menuOpenRef = useRef(false);
  const dismissMenu = useCallback(() => {
    menuOpenRef.current = false;
    setMenuOpen(false);
  }, []);
  const openMenu = useCallback((request: MenuRequest) => {
    // The button that opened the menu closes it again, as a menu button does.
    if (menuOpenRef.current && request.anchor && request.anchor === menuRef.current?.anchor) {
      request.close();
      dismissMenu();
      return;
    }
    menuRef.current?.close();
    menuRef.current = request;
    menuOpenRef.current = true;
    setMenu(request);
    setMenuOpen(true);
  }, [dismissMenu]);
  const closeMenu = useCallback(() => {
    menuRef.current?.close();
    menuRef.current = null;
    menuOpenRef.current = false;
    setMenu(null);
    setMenuOpen(false);
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
        keymap={TRELLIS_KEYMAP}
        navigation="free"
        floating="overlay"
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
        {/* Focus mode drops the document and PDF panels' tab bars: the panel is the page. */}
        <ViewType
          id="pdf" title={title("pdf")} singleton icon={PANEL_ICONS.pdf} minSize={pdfMinSize} scaling={false}
          menu={actions("pdf")} tabbar={focusMode ? "never" : undefined}
        >
          <PdfView controller={controller} />
        </ViewType>
        <ViewType<FileParams>
          id="file"
          minSize={MIN_SIZE.file}
          scaling={false}
          tabbar={focusMode ? "never" : undefined}
          title={(view) => controller.bridge?.tabLabel(String(view.params.key ?? "")) ?? String(view.params.key ?? "")}
          accessory={<FileHeaderTools controller={controller} />}
          menu={(view) => withTabItems(controller, view, fileMenu(view))}
        >
          {/* The read-only snapshots drawn here; the live editor's own boundary is App's (use-document-surfaces.tsx). */}
          <PanelErrorBoundary name="document"><FileView controller={controller} /></PanelErrorBoundary>
        </ViewType>
        {/* Its tab carries the empty state's icon, as every other tab carries one. */}
        <ViewType id="slot" title={t`Empty`} icon={<FileText size={14} />} minSize={MIN_SIZE.file} scaling={false}>
          <SlotView controller={controller} />
        </ViewType>
        {TOOL_KINDS.map((kind) => (
          <ViewType key={kind} id={kind} title={title(kind)} singleton icon={PANEL_ICONS[kind]} minSize={MIN_SIZE.tool} scaling={false}>
            <ToolView controller={controller} kind={kind} />
          </ViewType>
        ))}
        {terminalViewType(controller)}
        <Workspace.Empty>
          <WorkspaceEmpty controller={controller} />
        </Workspace.Empty>
      </Workspace>
      {menu && <PanelMenu request={menu} open={menuOpen} onDismiss={dismissMenu} onClose={closeMenu} />}
    </>
  );
});

export default TrellisWorkspace;
