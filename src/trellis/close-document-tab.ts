import type { TrellisController } from "./trellis-controller";

/**
 * ⌘W, as an editor's or a browser's: close the focused document tab (a
 * source, a preview or a Paper), else the active one, through Trellis as the
 * tab's own close button does, so App saves it and offers to reopen it. A
 * focused panel that is not a document (Project, the Agent) never closes this
 * way. False when no document tab is open, for the window to close instead.
 */
export function closeDocumentTab(controller: Pick<TrellisController, "ws" | "app">): boolean {
  const ws = controller.ws;
  const files = ws?.views({ type: "file" }).filter((view) => view.placement !== "hidden") ?? [];
  if (!ws || files.length === 0) return false;
  const focused = ws.getSnapshot().focusedView;
  const key = controller.app.get().activeKey;
  const target = files.find((view) => view.id === focused) ?? files.find((view) => view.params.key === key) ?? files[0];
  void ws.close(target.id);
  return true;
}
