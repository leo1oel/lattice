/**
 * The workspace's side of the document-tab policy (see trellis-tab-policy.ts):
 * opening a document's tab, which may replace its panel's preview or close a
 * tab for room; the marks a tab carries; its Keep open and Pin items; and the
 * gestures that keep a preview.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { LayoutDocument, LayoutNode, MenuEntry, PanelNode, ViewInfo, WorkspaceHandle } from "@danfessler/trellis";
import { i18n } from "../i18n";
import type { TrellisController } from "./trellis-controller";
import { fileIcon } from "./trellis-icons";
import { chooseEvictions, type FileParams } from "./trellis-tab-policy";

/** A document tab's minimum width: trellis.css's --trellis-tab-min. */
const TAB_MIN_WIDTH = 100;
/** How far a press on a preview tab moves before it is a drag of the tab, which keeps it. */
const DRAG_START = 4;

function findPanel(node: LayoutNode | null | undefined, id: string): PanelNode | null {
  if (!node) return null;
  if (node.kind === "panel") return node.id === id ? node : null;
  if (node.kind === "stage") return findPanel(node.child, id);
  for (const child of node.children) {
    const found = findPanel(child, id);
    if (found) return found;
  }
  return null;
}

/** Panel `id` wherever it is: docked, floating or hidden. */
function panelOf(doc: LayoutDocument, id: string): PanelNode | null {
  return findPanel(doc.root, id)
    ?? [...doc.floating, ...doc.hidden].find((entry) => entry.panel.id === id)?.panel
    ?? null;
}

/** A tab's width with its whole title (up to Trellis's tab maximum), unsqueezed. */
function naturalWidth(tab: HTMLElement) {
  const shrink = tab.style.flexShrink;
  tab.style.flexShrink = "0";
  const width = tab.getBoundingClientRect().width;
  tab.style.flexShrink = shrink;
  return Math.max(TAB_MIN_WIDTH, width);
}

/**
 * How many px `panel`'s strip, as it is laid out now, lacks for every tab and
 * one more titled `label` to show their whole titles, and what each tab takes
 * (its gap included); null when the strip is not on screen (hidden, or focus
 * mode's bare page). The new tab is measured as a hidden copy of a document
 * tab carrying its title.
 */
export function stripShortfall(ws: WorkspaceHandle, panel: PanelNode, label: string) {
  const first = panel.views[0];
  const strip = first ? ws.element.querySelector(`[data-trellis-part="tab"][data-view="${CSS.escape(first)}"]`)?.parentElement : null;
  if (!strip || !strip.getClientRects().length) return null;
  const style = getComputedStyle(strip);
  const gap = parseFloat(style.columnGap) || 0;
  const width = strip.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
  // An empty document slot leaves once a document is in its panel.
  const tabs = [...strip.children].filter((tab): tab is HTMLElement => (
    tab instanceof HTMLElement && tab.dataset.trellisPart === "tab" && tab.dataset.type !== "slot"
  ));
  const widths = new Map<string, number>();
  for (const tab of tabs) {
    // A named panel's tab (a tool beside the documents) keeps the width it has.
    const taken = tab.hasAttribute("data-atomic") ? tab.getBoundingClientRect().width : naturalWidth(tab);
    widths.set(tab.dataset.view ?? "", taken + gap);
  }
  let incoming = TAB_MIN_WIDTH;
  const model = tabs.find((tab) => tab.dataset.type === "file");
  if (model) {
    const probe = model.cloneNode(true) as HTMLElement;
    probe.removeAttribute("id");
    const title = probe.querySelector('[data-trellis-part="tab-title"]');
    if (title) title.textContent = label;
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    strip.append(probe);
    incoming = naturalWidth(probe);
    probe.remove();
  }
  const used = [...widths.values()].reduce((sum, taken) => sum + taken, 0);
  return { short: used + incoming - width, widths };
}

/**
 * Open `key`'s tab in panel `panelId`. `opened` is App's explicit open of the
 * active document (a quick look, or any other open); reconciling restored
 * tabs passes null, which neither replaces nor closes anything. A quick look
 * takes the place of the panel's preview; otherwise the tabs used least
 * recently go when the strip has no room for its whole title. Both close through Trellis as the
 * tab's own close button does, so App saves, forgets and offers to reopen
 * them exactly as it does then.
 */
export function openDocumentTab(
  controller: TrellisController, ws: WorkspaceHandle, key: string, panelId: string, opened: "preview" | "open" | null,
): ViewInfo {
  const reuse = (view: ViewInfo) => view.type === "file" && view.params.key === key;
  const panel = opened ? panelOf(ws.getDocument(), panelId) : null;
  const files = panel ? ws.views({ type: "file" }).filter((view) => view.panelId === panelId) : [];
  const params: FileParams = opened === "preview" ? { key, preview: true } : { key };
  const replaced = opened === "preview"
    ? files.find((view) => view.params.preview && !view.params.pinned && view.params.key !== key)
    : undefined;
  if (panel && replaced) {
    const info = ws.open("file", { params, reuse, focus: false, placement: { into: panelId, index: panel.views.indexOf(replaced.id) } });
    void ws.close(replaced.id);
    return info;
  }
  const room = panel ? stripShortfall(ws, panel, controller.bridge?.tabLabel(key) ?? key) : null;
  const { activeKey } = controller.app.get();
  const evicted = !room || room.short <= 0 ? [] : chooseEvictions(
    files.map((view) => ({
      id: view.id, key: String(view.params.key ?? ""), preview: Boolean(view.params.preview), pinned: Boolean(view.params.pinned),
      width: room.widths.get(view.id) ?? 0,
    })),
    room.short,
    // Only the active document can hold unsaved changes: App saves each one it leaves.
    { held: (tab) => tab === key || tab === activeKey || controller.pendingDrops.has(tab), lastUsed: controller.tabs.lastUsed },
  );
  const info = ws.open("file", { params, reuse, focus: false, placement: { into: panelId } });
  for (const id of evicted) void ws.close(id);
  return info;
}

/** A preview's Keep open, and Pin or Unpin, after the document's own menu items. */
export function withTabItems(controller: TrellisController, view: { id: string; params: FileParams }, entries: MenuEntry[]): MenuEntry[] {
  const { key, preview, pinned } = view.params;
  const items: MenuEntry[] = [
    ...(preview ? [{ id: "keep-open", label: i18n._(msg`Keep open`), run: () => controller.tabs.keep(key) }] : []),
    pinned
      ? { id: "unpin", label: i18n._(msg`Unpin tab`), run: () => controller.tabs.setPinned(view.id, false) }
      : { id: "pin", label: i18n._(msg`Pin tab`), run: () => controller.tabs.setPinned(view.id, true) },
  ];
  return entries.length ? [...entries, "separator", ...items] : items;
}

/**
 * Keep the preview the writer works with: a double-click on its tab, or a
 * drag of it. Every document made active counts as used, and an edit keeps
 * its tab.
 */
export function useDocumentTabs(controller: TrellisController, ws: WorkspaceHandle | null) {
  useEffect(() => {
    if (!ws) return;
    let active = "";
    let dirty = false;
    const follow = () => {
      const { activeKey, activeDirty } = controller.app.get();
      if (activeKey !== active && activeKey) controller.tabs.touch(activeKey);
      if (activeDirty && (!dirty || activeKey !== active)) controller.tabs.keep(activeKey);
      active = activeKey;
      dirty = activeDirty;
    };
    follow();
    const unsubscribe = controller.app.subscribe(follow);
    const fileTab = (target: EventTarget | null) => {
      if (!(target instanceof Element) || target.closest("[data-trellis-part=tab-close]")) return null;
      const id = target.closest<HTMLElement>("[data-trellis-part=tab]")?.dataset.view;
      const view = id ? ws.view(id) : null;
      return view?.type === "file" ? view : null;
    };
    let press: { x: number; y: number; key: string } | null = null;
    const onDoubleClick = (event: MouseEvent) => {
      const view = fileTab(event.target);
      if (view) controller.tabs.keep(String(view.params.key ?? ""));
    };
    const onPointerDown = (event: PointerEvent) => {
      const view = fileTab(event.target);
      press = event.button === 0 && view?.params.preview ? { x: event.clientX, y: event.clientY, key: String(view.params.key ?? "") } : null;
    };
    // On the window: a dragged tab's pointer leaves the workspace.
    const onPointerMove = (event: PointerEvent) => {
      if (!press) return;
      if (!(event.buttons & 1)) press = null;
      else if (Math.hypot(event.clientX - press.x, event.clientY - press.y) >= DRAG_START) {
        controller.tabs.keep(press.key);
        press = null;
      }
    };
    const root = ws.element;
    root.addEventListener("dblclick", onDoubleClick, true);
    root.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    return () => {
      unsubscribe();
      root.removeEventListener("dblclick", onDoubleClick, true);
      root.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
    };
  }, [controller, ws]);
}

/**
 * A document tab's icon and marks. A type's `icon` is shared by all its
 * views, so file panels portal their own into the tab's icon slot, with what
 * a screen reader says before the title (Preview, Pinned, Unsaved changes);
 * trellis.css draws the marks from these spans (an italic title, a pin).
 */
export function useFileTab(controller: TrellisController, view: { id: string; params: FileParams }, dirty: boolean) {
  const { t } = useLingui();
  const ws = controller.ws;
  // Read during render, not set from an effect: the tab's icon slot usually
  // exists by the time the view renders, and an effect would cost every file
  // panel an extra commit on mount.
  const subscribe = useCallback((listener: () => void) => ws?.on("surfaces", listener) ?? (() => {}), [ws]);
  const iconHost = useSyncExternalStore(subscribe, () => ws?.surfaces().find((surface) => surface.view.id === view.id)?.icon ?? null);
  const { key, preview = false, pinned = false } = view.params;
  const kind = controller.bridge?.tabKind(key) ?? "file";
  const marks = [preview && t`Preview`, pinned && t`Pinned`, dirty && t`Unsaved changes`].filter(Boolean).join(", ");
  return iconHost ? createPortal(
    <>
      {fileIcon(key, kind)}
      {marks && <span className="sr-only" data-tab-preview={preview || undefined} data-tab-pinned={pinned || undefined}>{marks}</span>}
    </>,
    iconHost,
  ) : null;
}
