import {
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useState,
} from "react";
import { clamp, loadSidebarOpen, loadSidebarWidth, persistSidebarOpen, persistSidebarWidth } from "./app-settings";

export type PanelLayout = {
  sidebarOpen: boolean;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  sidebarWidth: number;
  beginSidebarResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  nudgeSidebar: (delta: number) => void;
};

const resizedWidth = (start: number, delta: number) =>
  clamp(start + delta, 300, Math.max(300, Math.min(560, window.innerWidth - 365)));

/** Owns the single workspace sidebar's visibility and width. */
export function usePanelLayout(): PanelLayout {
  const [sidebarOpen, setSidebarOpen] = useState(loadSidebarOpen);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  useEffect(() => persistSidebarOpen(sidebarOpen), [sidebarOpen]);

  const beginSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let latest = sidebarWidth;
    document.body.classList.add("resizing-panels");
    const move = (moveEvent: PointerEvent) => {
      latest = resizedWidth(startWidth, moveEvent.clientX - startX);
      setSidebarWidth(latest);
    };
    const up = () => {
      document.body.classList.remove("resizing-panels");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      persistSidebarWidth(latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }, [sidebarWidth]);

  const nudgeSidebar = useCallback((delta: number) => {
    setSidebarWidth((current) => {
      const next = resizedWidth(current, delta);
      persistSidebarWidth(next);
      return next;
    });
  }, []);

  return { sidebarOpen, setSidebarOpen, sidebarWidth, beginSidebarResize, nudgeSidebar };
}
