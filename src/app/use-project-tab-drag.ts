import { useEffect, useRef, type MouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { chunk } from "../lib/lazy-chunk";
import type { ProjectTabDestination } from "./project-tab-transfer";
import { nativeProjectTabWindow } from "./project-tab-window";
import { windowProjects } from "./window-projects";

export type MoveProjectTab = (root: string, target: ProjectTabDestination | null) => Promise<unknown>;
export type ProjectTabDragState = {
  /** Ends the drag in progress. */
  active: { current: (() => void) | undefined };
  suppressClick: { current: boolean };
  /** Bumped by every press, so a drop answered late can't act on a newer one. */
  revision: { current: number };
};

// Only the press test below runs at startup. The drag itself and the listener
// that shows another window's tab hovering over this strip load on demand
// (docs/architecture.md §4).
const loadDragSession = chunk(() => import("./project-tab-drag-session"));
const loadDrops = chunk(() => import("./project-tab-drop"));

function projectTabDragPointer(event: ReactPointerEvent) {
  return event.pointerType === "mouse" && event.button === 0 && event.buttons === 1 && !event.ctrlKey;
}

export function useProjectTabDrag(
  stripRef: RefObject<HTMLDivElement | null>, enabled: boolean, moveProjectTab: MoveProjectTab,
) {
  const active = useRef<(() => void) | undefined>(undefined);
  const suppressClick = useRef(false);
  const revision = useRef(0);
  const state: ProjectTabDragState = { active, suppressClick, revision };
  useEffect(() => {
    const strip = stripRef.current;
    const label = nativeProjectTabWindow();
    let disposed = false;
    let stop: (() => void) | undefined;
    if (enabled && strip && label) {
      void loadDrops().then(({ listenForProjectTabDrops }) => {
        if (!disposed) stop = listenForProjectTabDrops(strip, label);
      }, () => {});
    }
    return () => {
      disposed = true;
      // End whichever drag is running when the strip goes, not the one at setup.
      // eslint-disable-next-line react-hooks-js/exhaustive-deps
      active.current?.();
      stop?.();
    };
  }, [enabled, stripRef]);

  return {
    /** Radix opens the active project's menu on pointerdown. Let a stationary
     * click open it instead when that same pointer can drag the project. */
    canDragTitle(event: ReactPointerEvent) {
      return enabled && projectTabDragPointer(event) && (
        windowProjects.get().length > 1 || Boolean(nativeProjectTabWindow())
      );
    },
    onPointerEnter() {
      if (enabled) void loadDragSession().catch(() => {});
    },
    onClickCapture(event: MouseEvent) {
      if (!state.suppressClick.current || event.detail === 0) return;
      state.suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
      if (!enabled || !projectTabDragPointer(event) || state.active.current) return;
      state.suppressClick.current = false;
      const target = event.target instanceof Element ? event.target : null;
      const tab = target?.closest<HTMLElement>("[data-project-root]");
      const root = tab?.dataset.projectRoot;
      if (!tab || root === undefined || target?.closest(".project-tab-close")) return;
      const label = nativeProjectTabWindow();
      if (!label && windowProjects.get().length < 2) return;
      const { pointerId, clientX, clientY } = event;
      const press = { strip: event.currentTarget, tab, root, label, pointerId, start: { x: clientX, y: clientY } };
      const session = loadDragSession.loaded();
      if (session) {
        session.beginProjectTabDrag(press, state, moveProjectTab);
        return;
      }
      // A press before the strip was ever hovered: the controller is still on
      // its way. Keep the latest move and the release, and hand them over.
      const pending = new AbortController();
      let lastMove: PointerEvent | undefined;
      let release: PointerEvent | undefined;
      const opts = { capture: true, signal: pending.signal };
      window.addEventListener("pointermove", (pointer) => { if (pointer.pointerId === pointerId) lastMove = pointer; }, opts);
      window.addEventListener("pointerup", (pointer) => { if (pointer.pointerId === pointerId) release ??= pointer; }, opts);
      void loadDragSession().then(({ beginProjectTabDrag }) => {
        pending.abort();
        if (state.active.current || !press.strip.isConnected) return;
        const handlers = beginProjectTabDrag(press, state, moveProjectTab);
        if (lastMove) handlers.move(lastMove);
        if (release) handlers.release(release);
      }, () => pending.abort());
    },
  };
}
