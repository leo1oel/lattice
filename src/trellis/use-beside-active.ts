import { useSyncExternalStore } from "react";
import type { TrellisController } from "./trellis-controller";

/**
 * Not in place of the document being worked on: a tab that has just covered
 * the active document in its own panel is merely selected on the way to
 * becoming active (a click, a restore). Anywhere else on screen it is being
 * read, whether or not the active document is on screen too.
 */
export function useBesideActive(controller: TrellisController, panelId: string) {
  return useSyncExternalStore(controller.ui.subscribe, () => {
    if (controller.ui.get().editorVisible) return true;
    const { activeKey } = controller.app.get();
    return controller.ws?.views({ type: "file" }).find((view) => view.params.key === activeKey)?.panelId !== panelId;
  });
}
