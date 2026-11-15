import { useEffect, useRef, type MouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { findProjectDropSlot, markProjectDrop } from "./project-tab-hit";
import { createProjectTabFlight, listenForProjectTabDrops, nativeProjectTabWindow } from "./project-tab-drop";
import type { ProjectTabDestination } from "./project-tab-transfer";
import { windowProjects } from "./window-projects";

const DRAG_THRESHOLD = 5;

type MoveProjectTab = (root: string, target: ProjectTabDestination | null) => Promise<unknown>;

function projectTabDragPointer(event: ReactPointerEvent) {
  return event.pointerType === "mouse" && event.button === 0 && event.buttons === 1 && !event.ctrlKey;
}

export function useProjectTabDrag(
  stripRef: RefObject<HTMLDivElement | null>, enabled: boolean, moveProjectTab: MoveProjectTab,
) {
  const active = useRef<(() => void) | undefined>(undefined);
  const suppressClick = useRef(false);
  const dragRevision = useRef(0);
  useEffect(() => {
    const strip = stripRef.current;
    const label = nativeProjectTabWindow();
    const stop = enabled && strip && label ? listenForProjectTabDrops(strip, label) : undefined;
    return () => { active.current?.(); stop?.(); };
  }, [enabled, stripRef]);

  return {
    /** Radix opens the active project's menu on pointerdown. Let a stationary
     * click open it instead when that same pointer can drag the project. */
    canDragTitle(event: ReactPointerEvent) {
      return enabled && projectTabDragPointer(event) && (
        windowProjects.get().length > 1 || Boolean(nativeProjectTabWindow())
      );
    },
    onClickCapture(event: MouseEvent) {
      if (!suppressClick.current || event.detail === 0) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
      if (!enabled || !projectTabDragPointer(event) || active.current) return;
      suppressClick.current = false;
      const revision = ++dragRevision.current;
      const strip = event.currentTarget;
      const target = event.target instanceof Element ? event.target : null;
      const tab = target?.closest<HTMLElement>("[data-project-root]");
      const root = tab?.dataset.projectRoot;
      if (!tab || root === undefined || target?.closest(".project-tab-close")) return;
      const label = nativeProjectTabWindow();
      if (!label && windowProjects.get().length < 2) return;

      const listening = new AbortController();
      const { pointerId, clientX, clientY } = event;
      const start = { x: clientX, y: clientY };
      let dragged = false;
      let flight: ReturnType<typeof createProjectTabFlight> | undefined;
      const end = () => {
        listening.abort();
        active.current = undefined;
        if (!dragged) return;
        flight?.stop();
        markProjectDrop(strip, undefined);
        tab.removeAttribute("data-project-dragging");
        if (strip.hasPointerCapture?.(pointerId)) strip.releasePointerCapture(pointerId);
        // Release or cancellation may still yield a click. Ignore it until
        // the next genuine press, which clears this guard.
        suppressClick.current = true;
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
            if (destination !== undefined && revision === dragRevision.current
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
      active.current = end;
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
    },
  };
}
