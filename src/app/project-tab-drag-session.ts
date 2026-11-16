/** One press on the title bar's project strip, from the first pointer move
 * past the threshold to release. Loaded on the first press (or hover) of the
 * strip, so a window that never drags a tab never pays for it. */
import { findProjectDropSlot, markProjectDrop, type Point } from "./project-tab-hit";
import { createProjectTabFlight } from "./project-tab-drop";
import type { MoveProjectTab, ProjectTabDragState } from "./use-project-tab-drag";
import { windowProjects } from "./window-projects";

const DRAG_THRESHOLD = 5;

export type ProjectTabPress = {
  strip: HTMLElement;
  tab: HTMLElement;
  root: string;
  /** The native window label, absent when only an in-strip reorder is possible. */
  label: string | undefined;
  pointerId: number;
  start: Point;
};

/** Returns the pointer handlers, so a press that arrived before this module
 * can replay the moves and release it saw meanwhile. */
export function beginProjectTabDrag(press: ProjectTabPress, state: ProjectTabDragState, moveProjectTab: MoveProjectTab) {
  const { strip, tab, root, label, pointerId, start } = press;
  const revision = ++state.revision.current;
  const listening = new AbortController();
  let dragged = false;
  let flight: ReturnType<typeof createProjectTabFlight> | undefined;
  const end = () => {
    listening.abort();
    state.active.current = undefined;
    if (!dragged) return;
    flight?.stop();
    markProjectDrop(strip, undefined);
    tab.removeAttribute("data-project-dragging");
    if (strip.hasPointerCapture?.(pointerId)) strip.releasePointerCapture(pointerId);
    // Release or cancellation may still yield a click. Ignore it until
    // the next genuine press, which clears this guard.
    state.suppressClick.current = true;
  };
  const move = (pointer: PointerEvent) => {
    if (pointer.pointerId !== pointerId) return;
    const point = { x: pointer.clientX, y: pointer.clientY };
    if (!dragged) {
      if (Math.hypot(point.x - start.x, point.y - start.y) < DRAG_THRESHOLD) return;
      dragged = true;
      tab.setAttribute("data-project-dragging", "");
      strip.setPointerCapture?.(pointerId);
      if (label) flight = createProjectTabFlight(label);
    }
    const slot = findProjectDropSlot(strip, point, root);
    flight?.preview(!slot);
    markProjectDrop(strip, slot);
  };
  const release = (pointer: PointerEvent) => {
    if (pointer.pointerId !== pointerId) return;
    end();
    if (!dragged) return;
    const point = { x: pointer.clientX, y: pointer.clientY };
    const slot = findProjectDropSlot(strip, point, root);
    if (slot) windowProjects.reorder(root, slot.beforeRoot);
    else if (flight) {
      void flight.drop().then((destination) => {
        if (destination !== undefined && revision === state.revision.current
          && strip.isConnected && strip.hasAttribute("data-project-drop-enabled")) {
          void moveProjectTab(root, destination);
        }
      });
    }
  };
  const cancel = (pointer: PointerEvent) => {
    if (pointer.pointerId === pointerId) end();
  };
  const opts = { signal: listening.signal, capture: true };
  state.active.current = end;
  window.addEventListener("pointermove", move, opts);
  window.addEventListener("pointerup", release, opts);
  window.addEventListener("pointercancel", cancel, opts);
  strip.addEventListener("lostpointercapture", cancel, opts);
  // Taking focus from the editor or another tab isn't a window blur.
  window.addEventListener("blur", end, { signal: listening.signal });
  window.addEventListener("keydown", (key) => {
    if (key.key !== "Escape" || !dragged) return;
    key.preventDefault();
    key.stopPropagation();
    end();
  }, opts);
  return { move, release };
}
