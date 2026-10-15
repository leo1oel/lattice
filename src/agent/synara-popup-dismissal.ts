import { useEffect, type RefObject } from "react";
import { isRecord } from "../app-utils";
import { listenToSynaraFrame } from "./agent-protocol";

export const SYNARA_POPUP_OPEN = "synara:popup-open";
export const LATTICE_OUTSIDE_POINTER_DOWN = "lattice:outside-pointerdown";

/** The rest of a press whose pointerdown only dismissed a Synara popup. */
const PRESS_EVENTS = ["mousedown", "pointerup", "mouseup", "click", "auxclick", "contextmenu"] as const;

/**
 * A menu, select or popover in a Synara frame closes on a press Base UI hears
 * in the frame's own document, and a press anywhere else in Lattice never
 * reaches that cross-origin document, so the popup stayed open until an item
 * was chosen. The frame reports while one is open (`synara:popup-open`); a
 * press outside it then goes to the frame as `lattice:outside-pointerdown`,
 * which Synara replays as an outside press. Like Base UI's modal backdrop
 * inside the frame, that press only closes the popup: the whole press is
 * swallowed before any Lattice handler sees it.
 *
 * The open flag is spent on that press. Synara reports again for the next
 * popup it opens, so a popup that ignores outside presses costs one press.
 */
export function useSynaraPopupDismissalBridge(options: {
  frameRef: RefObject<HTMLIFrameElement | null>;
  origin: string | null;
}) {
  const { frameRef, origin } = options;
  useEffect(() => {
    if (!origin) return;
    let popupOpen = false;
    let swallowingPress = false;
    const stopListening = listenToSynaraFrame(frameRef, origin, (data) => {
      if (!isRecord(data)) return;
      if (data.type === SYNARA_POPUP_OPEN && typeof data.open === "boolean") popupOpen = data.open;
      // A reloaded frame starts with nothing open.
      else if (data.type === "synara:embed-ready") popupOpen = false;
    });
    const swallow = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onPointerDown = (event: PointerEvent) => {
      swallowingPress = false;
      const frameWindow = frameRef.current?.contentWindow;
      if (!popupOpen || !frameWindow) return;
      popupOpen = false;
      frameWindow.postMessage({ type: LATTICE_OUTSIDE_POINTER_DOWN }, origin);
      swallowingPress = true;
      swallow(event);
    };
    const onRestOfPress = (event: Event) => {
      if (!swallowingPress) return;
      swallow(event);
      // A press without a click (released elsewhere) ends at the next pointerdown.
      if (event.type === "click" || event.type === "auxclick") swallowingPress = false;
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    for (const type of PRESS_EVENTS) window.addEventListener(type, onRestOfPress, true);
    return () => {
      stopListening();
      window.removeEventListener("pointerdown", onPointerDown, true);
      for (const type of PRESS_EVENTS) window.removeEventListener(type, onRestOfPress, true);
    };
  }, [frameRef, origin]);
}
