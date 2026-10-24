/**
 * The workspace's layout commands, installed on the controller for App and
 * the titlebar: reset (with its undo), the layout presets, focus mode, and
 * entering, saving, reverting and creating named workspaces. TrellisWorkspace
 * owns the state they share, in refs that outlive a reinstall.
 */
import type { RefObject } from "react";
import type { LayoutDocument, WorkspaceHandle } from "@danfessler/trellis-react";
import type { LayoutNode, PanelNode } from "@danfessler/trellis";
import { TOOL_KINDS, type TrellisController, type TrellisToolKind, type TrellisUiState } from "./trellis-controller";
import {
  arrangeDocuments, defaultLayout, enterFocus, enterPreset, loadFocusPdf, persistFocusPdf, placesOf, returnLayout, undoReset,
  workspaceArrangement, type ActiveFocus, type ActivePreset, type DocumentPlaces,
} from "./trellis-layout";
import { notifyInfo } from "../telemetry/app-notify";
import { arrangementOf, layoutShape } from "./trellis-workspaces";

function findPanel(node: LayoutNode, id: string): PanelNode | null {
  if (node.kind === "panel") return node.id === id ? node : null;
  if (node.kind === "stage") return node.child ? findPanel(node.child, id) : null;
  for (const child of node.children) {
    const found = findPanel(child, id);
    if (found) return found;
  }
  return null;
}

/** The toast that offers to undo a reset; a later reset's replaces it. */
export const RESET_UNDO_TOAST = "trellis-layout-reset";

/**
 * A reset that can still be undone: the layout, the preset, focus mode and
 * the focused view from before it, and the arrangement the reset left
 * (`left`, see layoutShape), which any change of the writer's own supersedes.
 */
export type ResetUndo = {
  document: LayoutDocument; preset: ActivePreset | null; focusMode: ActiveFocus | null; focused: string | null; left: string;
};

/** What the layout commands share with the workspace that installs them. */
export type LayoutHandlerState = {
  controller: TrellisController;
  /** Views a reset or a switch replaces: their close events must not close App tabs. */
  resettingRef: RefObject<boolean>;
  presetRef: RefObject<ActivePreset | null>;
  focusRef: RefObject<ActiveFocus | null>;
  workspaceRef: RefObject<string>;
  placesRef: RefObject<Record<string, DocumentPlaces>>;
  resetUndo: RefObject<ResetUndo | null>;
  pendingReset: RefObject<Promise<void> | null>;
  resetGeneration: RefObject<number>;
  flushSave: () => void;
  onDocumentChange: (document: LayoutDocument) => void;
  ownLayout: (document: LayoutDocument) => LayoutDocument;
  withdrawUndo: () => void;
  resetFailed: string;
  resetToast: { source: string; title: string; undo: string };
};

/** Install the layout commands; returns their uninstall. */
export function installLayoutHandlers({
  controller, resettingRef, presetRef, focusRef, workspaceRef, placesRef, resetUndo, pendingReset, resetGeneration,
  flushSave, onDocumentChange, ownLayout, withdrawUndo, resetFailed, resetToast,
}: LayoutHandlerState): () => void {
  const resetAfterSave = async (handle: WorkspaceHandle) => {
    const generation = resetGeneration.current;
    const saved = !controller.bridge || await controller.bridge.save();
    // The save can outlast this workspace if the window closes (a project
    // switch or another surface taking over saves first, waiting for it).
    // Its reset, or failure, is then nothing to clear, rearrange or
    // announce: the Undo it would offer could restore nothing.
    if (controller.ws !== handle || resetGeneration.current !== generation) return;
    if (!saved) {
      controller.bridge?.notify(resetFailed);
      return;
    }
    // Read after the save: the arrangement and the focus as they are now.
    const snapshot = handle.getSnapshot();
    const before = { document: snapshot.document, preset: presetRef.current, focusMode: focusRef.current, focused: snapshot.focusedView };
    resettingRef.current = true;
    presetRef.current = null;
    focusRef.current = null;
    try {
      // The default with its document panel between the navigators and the
      // PDF: the open documents fill it, and with none open it stays as an
      // empty one, where the next document opens.
      handle.setDocument(arrangementOf(defaultLayout()));
    } finally {
      resettingRef.current = false;
    }
    controller.ui.set({ preset: null, focus: false, focusPdf: false });
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
      focusRef.current = undo.focusMode;
      try {
        handle.setDocument(next);
      } finally {
        resettingRef.current = false;
      }
      controller.ui.set({ preset: undo.preset?.preset ?? null, focus: Boolean(undo.focusMode), focusPdf: undo.focusMode?.pdf ?? false });
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
  // `current` out of focus mode: the layout it was entered from, brought up
  // to date with the documents opened and closed meanwhile.
  const unfocused = (current: LayoutDocument, documents: { activeKey: string; openTabs: readonly string[] }) => {
    const focus = focusRef.current;
    return focus ? returnLayout(focus.previous, current, documents, focus.supplied) : current;
  };
  // Animate the workspace to `next`, as a switch: no document closes on the
  // way, and PDFs coming on screen wait for the motion to settle.
  const show = (handle: WorkspaceHandle, next: LayoutDocument, ui: Partial<TrellisUiState>) => {
    controller.beginSwitch();
    resettingRef.current = true;
    try {
      handle.setDocument(next);
    } finally {
      resettingRef.current = false;
    }
    controller.ui.set(ui);
    controller.resync();
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
    const shown = unfocused(current, { activeKey, openTabs });
    const own = active ? returnLayout(active.previous, shown, { activeKey, openTabs }, active.supplied) : shown;
    const next = arrangeDocuments(workspaceArrangement(controller.workspaces, id), own, { activeKey, openTabs }, placesFor(own));
    presetRef.current = null;
    focusRef.current = null;
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
    controller.ui.set({ workspace: id, preset: null, focus: false, focusPdf: false });
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
      if (!handle || ((current?.preset ?? null) === preset && !focusRef.current)) return;
      withdrawUndo();
      const { activeKey, openTabs } = controller.app.get();
      // Choosing a layout leaves focus mode, for the layout it was entered from.
      const document = unfocused(handle.getDocument(), { activeKey, openTabs });
      focusRef.current = null;
      if ((current?.preset ?? null) === preset) {
        show(handle, document, { preset: current?.preset ?? null, focus: false, focusPdf: false });
        return;
      }
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
      show(handle, next, { preset, focus: false, focusPdf: false });
      // The document the layout is for becomes the active one: the source to
      // write, the paper to read. Keyboard focus stays where it was.
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
      const own = ownLayout(handle.getDocument());
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
      if (focusRef.current) {
        show(handle, unfocused(handle.getDocument(), controller.app.get()), { focus: false, focusPdf: false });
        focusRef.current = null;
      }
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
    // Focus mode regroups the open documents' own views like a preset, over
    // whatever is on screen; leaving it brings that back. The keyboard goes
    // to the document either way, so the writer keeps typing.
    focus: (on, pdf) => {
      const handle = controller.ws;
      const current = focusRef.current;
      if (!handle || (!on && !current) || (on && current && (pdf === undefined || pdf === current.pdf))) return;
      withdrawUndo();
      const { activeKey, openTabs } = controller.app.get();
      if (on) {
        const showPdf = pdf ?? loadFocusPdf();
        if (pdf !== undefined) persistFocusPdf(pdf);
        const entered = enterFocus(handle.getDocument(), current, { activeKey, openTabs, isReading: (key) => controller.isReading(key) }, showPdf);
        focusRef.current = entered.active;
        show(handle, entered.document, { focus: true, focusPdf: showPdf });
      } else {
        const next = unfocused(handle.getDocument(), { activeKey, openTabs });
        focusRef.current = null;
        show(handle, next, { focus: false, focusPdf: false });
      }
      if (activeKey) controller.focusDocument(activeKey);
    },
  });
}
