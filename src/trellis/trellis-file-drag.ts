/**
 * Dragging a project file out of the Project panel into the workspace, where
 * Trellis's own drop targets place it. Eager, as the controller it drives.
 */
import type { TrellisController } from "./trellis-controller";

/**
 * Hand a pointer drag of a project file that left the Project panel to
 * Trellis, so the file lands where Trellis's own drop targets say: beside a
 * panel's edge, in a seam, or on a tab strip. The file
 * joins the Project panel as a tab and a press on that tab starts Trellis's
 * tab drag; the pointer is already away, so the tab lifts out at once.
 * Released without a target, the tab falls back into the Project panel and
 * is closed again. Returns false when there is no workspace to drag into.
 */
export function beginFileDrag(controller: TrellisController, key: string, pointer: PointerEvent): boolean {
  const ws = controller.ws;
  const project = ws?.view("project");
  if (!ws || !project || project.placement === "hidden") return false;
  const existing = ws.views({ type: "file" }).find((view) => view.params.key === key);
  if (existing?.placement === "hidden") return false;
  const opened = !existing;
  // The tab the Project panel shows now (Project, or a tool beside it) stays
  // selected: the dragged file only passes through that panel.
  const shown = ws.views().find((view) => view.panelId === project.panelId && view.selected)?.id ?? project.id;
  controller.pendingDrops.add(key);
  const info = existing ?? ws.open("file", {
    params: { key },
    focus: false,
    reuse: (view) => view.type === "file" && view.params.key === key,
    placement: { into: project.panelId },
  });
  if (opened) ws.select(shown);
  const tab = controller.tabOf(info.id);
  if (tab?.dataset.trellisPart !== "tab") {
    if (opened) void ws.close(info.id, { force: true });
    controller.pendingDrops.delete(key);
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
      controller.pendingDrops.delete(key);
      if (!cancelled) controller.activate(key);
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
