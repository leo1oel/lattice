import { useEffect } from "react";
import type { WorkspaceHandle } from "@danfessler/trellis-react";
import type { TrellisController } from "./trellis-controller";

/**
 * Trellis reports focus only when it moves, and App switching documents
 * selects a tab without moving it: a click on the tab of a document that
 * still holds Trellis's focus has to activate that document itself. A click
 * on the tab's close button is not one: Trellis closes that tab without
 * selecting it, and activating it here would reopen the file the close just
 * removed (this listener runs first, its activation lands after the close).
 * A tab the writer chooses, by a click or Enter, also hands its editor the
 * keyboard.
 */
export function useTabPresses(controller: TrellisController, ws: WorkspaceHandle | null) {
  useEffect(() => {
    const root = ws?.element;
    if (!root) return;
    // The document whose tab the event landed on, if any.
    const tabKey = (target: EventTarget | null) => {
      if (!(target instanceof Element) || target.closest("[data-trellis-part=tab-close]")) return null;
      const tab = target.closest<HTMLElement>("[data-trellis-part=tab]");
      const view = tab?.dataset.view ? ws.view(tab.dataset.view) : null;
      if (view?.type !== "file") return null;
      return String(view.params.key ?? "") || null;
    };
    const onPress = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const key = tabKey(event.target);
      if (!key || key === controller.app.get().activeKey) return;
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
      if (key !== controller.app.get().activeKey) {
        controller.holdReading(null);
        controller.activate(key);
      }
      controller.focusDocument(key);
    };
    // A tab the writer chose hands its editor the keyboard, as the GPUI app
    // does: Trellis selects it and leaves focus on the tab itself, where
    // typing goes nowhere. This listens as the click bubbles, so only a click
    // Trellis let through counts: the one ending a drag (or an ⌥-click) it
    // stops at the root, and that tab was moved, not chosen. A document that
    // becomes active any other way (a restore, the Agent opening a file)
    // leaves focus where it is.
    const onChosen = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const key = tabKey(event.target);
      if (key) controller.focusDocument(key);
    };
    const onPointerOver = (event: PointerEvent) => controller.rememberPointerPanel(event.target);
    // Ahead of Trellis's own listeners and of a PDF snapshot's (see AssetSnapshot).
    const releaseReading = () => controller.holdReading(null);
    root.addEventListener("click", onPress, true);
    root.addEventListener("click", onChosen);
    root.addEventListener("keydown", onKeyDown, true);
    root.addEventListener("pointerover", onPointerOver, true);
    root.addEventListener("pointerdown", releaseReading, true);
    root.addEventListener("focusin", releaseReading, true);
    return () => {
      root.removeEventListener("click", onPress, true);
      root.removeEventListener("click", onChosen);
      root.removeEventListener("keydown", onKeyDown, true);
      root.removeEventListener("pointerover", onPointerOver, true);
      root.removeEventListener("pointerdown", releaseReading, true);
      root.removeEventListener("focusin", releaseReading, true);
    };
  }, [controller, ws]);
}
