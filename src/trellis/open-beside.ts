/**
 * Open to the side: a document opened from the Project tree or the Papers
 * library into another document panel than the one in front, so the two stay
 * on screen together (two PDFs compared side by side, a paper beside the
 * draft citing it). Nothing else changes how a document opens: a press in the
 * tree still lands in the active document's panel, which after an open to the
 * side is the new one, so the next PDF looked at replaces the one beside
 * instead of the one being compared against.
 *
 * The ask is made before App's open, which reads the document first; the tab
 * sync answers it once App makes that document active (use-tab-sync.ts).
 * Eager, as the controller that holds it: nothing from Trellis at runtime.
 */
import type { ViewInfo, WorkspaceHandle } from "@danfessler/trellis";
import type { TrellisController } from "./trellis-controller";

/** The panel an open to the side leaves, and the tab it showed there. */
export type BesideAsk = { key: string; from: string; shown: string | null };

const onScreen = (view: ViewInfo) => view.placement !== "hidden";
const isDocument = (view: ViewInfo) => view.type === "file" || view.type === "slot";

/**
 * Where a document opened to the side of panel `from` goes: an empty
 * document slot on screen first, then a panel showing a PDF or a paper
 * (the other side of a comparison already set up), then any other document
 * panel on screen. Null when there is none: a new split opens beside `from`.
 */
export function besideTarget(views: readonly ViewInfo[], from: string, isReading: (key: string) => boolean): string | null {
  const others = views.filter((view) => isDocument(view) && onScreen(view) && view.panelId !== from);
  const shown = others.filter((view) => view.selected);
  return (shown.find((view) => view.type === "slot")
    ?? shown.find((view) => isReading(String(view.params.key ?? "")))
    ?? others[0])?.panelId ?? null;
}

/**
 * Ask that the next open of `key` lands beside the document in front. With
 * no document panel on screen there is no side: the open goes where it would.
 */
export function openToTheSide(controller: TrellisController, key: string) {
  const ws = controller.ws;
  if (!ws) return;
  const files = ws.views({ type: "file" }).filter(onScreen);
  const { activeKey } = controller.app.get();
  const from = (files.find((view) => view.params.key === activeKey) ?? files.find((view) => view.selected))?.panelId;
  if (!from) return;
  const shown = ws.views().find((view) => view.panelId === from && view.selected)?.id ?? null;
  controller.tabs.beside({ key, from, shown });
}

/**
 * Answer `ask` for the document `info` App just made active: one that
 * opened (or already sat) in the panel it was asked from moves to the
 * other side, into `besideTarget`'s panel or a new split right of it, and
 * that panel shows again what it showed before. Returns where the document
 * is now.
 */
export function placeBeside(ws: WorkspaceHandle, info: ViewInfo, ask: BesideAsk, isReading: (key: string) => boolean): ViewInfo {
  if (info.panelId !== ask.from) return info;
  const target = besideTarget(ws.views(), ask.from, isReading);
  const alone = ws.views().filter((view) => view.panelId === ask.from).length === 1;
  // Its panel's only tab has no side to leave for but another panel.
  if (!target && alone) return info;
  ws.dock(info.id, target ? { into: target } : { beside: ask.from, edge: "right", share: 0.5 });
  const left = ask.shown && ask.shown !== info.id ? ws.view(ask.shown) : null;
  if (left && !left.selected && left.panelId === ask.from) ws.select(left.id);
  const moved = ws.views().find((view) => view.id === info.id) ?? info;
  if (!moved.selected) ws.select(moved.id);
  return ws.views().find((view) => view.id === info.id) ?? moved;
}
