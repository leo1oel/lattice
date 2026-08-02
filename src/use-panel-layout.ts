import {
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { clamp, loadSidebarOpen, loadSidebarWidth, persistSidebarOpen, persistSidebarWidth } from "./app-settings";

export type PanelLayout = {
  sidebarOpen: boolean;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  sidebarWidth: number;
  sidebarResizing: boolean;
  beginSidebarResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
  nudgeSidebar: (delta: number) => void;
  fitSidebarToContent: () => void;
};

const MIN_TAB_STRIP_WIDTH = 220;
const FALLBACK_MIN_EDITOR_WIDTH = 600;

const minimumTabStripWidth = () => {
  const strip = document.querySelector<HTMLElement>(".titlebar-main > .editor-tabs .editor-tabs-scroll");
  if (!strip) return MIN_TAB_STRIP_WIDTH;
  const tabs = Array.from(strip.querySelectorAll<HTMLElement>(".editor-tab"));
  if (!tabs.length) return MIN_TAB_STRIP_WIDTH;
  const content = strip.querySelector<HTMLElement>(".editor-tabs-content") ?? strip;
  const contentStyle = window.getComputedStyle(content);
  const gap = Number.parseFloat(contentStyle.columnGap || contentStyle.gap) || 4;
  const horizontalPadding = (Number.parseFloat(contentStyle.paddingLeft) || 0)
    + (Number.parseFloat(contentStyle.paddingRight) || 0);
  const tabsWidth = tabs.reduce((width, tab) => {
    const minWidth = Number.parseFloat(window.getComputedStyle(tab).minWidth) || 104;
    return width + minWidth;
  }, 0);
  return Math.max(MIN_TAB_STRIP_WIDTH, tabsWidth + gap * (tabs.length - 1) + horizontalPadding);
};

const minimumEditorWidth = () => {
  const toolbarWidth = document.querySelector<HTMLElement>(".titlebar-main > .canvas-toolbar")?.offsetWidth ?? 0;
  const titleActionsWidth = document.querySelector<HTMLElement>(".titlebar-main > .title-actions")?.offsetWidth ?? 0;
  const workspaceWidth = window.innerWidth > 1180
    ? Number(
      document.querySelector<HTMLElement>(".split-canvas[data-minimum-workspace-width]")
        ?.dataset.minimumWorkspaceWidth,
    ) || 0
    : 0;
  return Math.max(
    FALLBACK_MIN_EDITOR_WIDTH,
    workspaceWidth,
    toolbarWidth + titleActionsWidth + minimumTabStripWidth(),
  );
};

const resizedWidth = (start: number, delta: number, minimumSidebarWidth: number) =>
  clamp(
    start + delta,
    minimumSidebarWidth,
    Math.max(minimumSidebarWidth, window.innerWidth - minimumEditorWidth()),
  );

/** Owns the single workspace sidebar's visibility and width. */
export function usePanelLayout(minimumSidebarWidth = 180): PanelLayout {
  const [sidebarOpen, setSidebarOpen] = useState(loadSidebarOpen);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    resizedWidth(loadSidebarWidth(), 0, minimumSidebarWidth),
  );
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const finishResizeRef = useRef<(() => void) | null>(null);
  // Synara discovers its intrinsic minimum while the pointer is already moving.
  // A ref lets that active resize session use the new limit immediately instead
  // of keeping the value captured when the drag began.
  const minimumSidebarWidthRef = useRef(minimumSidebarWidth);
  minimumSidebarWidthRef.current = minimumSidebarWidth;
  useEffect(() => persistSidebarOpen(sidebarOpen), [sidebarOpen]);
  useEffect(() => () => finishResizeRef.current?.(), []);
  const fitSidebarToContent = useCallback(() => {
    setSidebarWidth((current) => {
      const next = resizedWidth(current, 0, minimumSidebarWidth);
      if (next !== current) persistSidebarWidth(next);
      return next;
    });
  }, [minimumSidebarWidth]);
  useEffect(() => fitSidebarToContent(), [fitSidebarToContent]);
  useEffect(() => {
    let timer: number | undefined;
    const fitAfterWindowResize = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      // This calculation deliberately reads several rendered widths. Doing it
      // once per native resize event forces repeated synchronous layouts and
      // can make WKWebView fall behind the window server during a fast drag.
      timer = window.setTimeout(() => {
        timer = undefined;
        fitSidebarToContent();
      }, 80);
    };
    window.addEventListener("resize", fitAfterWindowResize);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("resize", fitAfterWindowResize);
    };
  }, [fitSidebarToContent]);

  const beginSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    finishResizeRef.current?.();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const pointerId = event.pointerId;
    const target = event.currentTarget;
    let latest = sidebarWidth;
    let finished = false;
    setSidebarResizing(true);
    document.body.classList.add("resizing-panels");
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      latest = resizedWidth(
        startWidth,
        moveEvent.clientX - startX,
        minimumSidebarWidthRef.current,
      );
      setSidebarWidth(latest);
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      latest = resizedWidth(latest, 0, minimumSidebarWidthRef.current);
      setSidebarWidth(latest);
      setSidebarResizing(false);
      document.body.classList.remove("resizing-panels");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
      target.removeEventListener("lostpointercapture", finish);
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      persistSidebarWidth(latest);
      if (finishResizeRef.current === finish) finishResizeRef.current = null;
    };
    finishResizeRef.current = finish;
    target.setPointerCapture(pointerId);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
    target.addEventListener("lostpointercapture", finish);
  }, [sidebarWidth]);

  const nudgeSidebar = useCallback((delta: number) => {
    setSidebarWidth((current) => {
      const next = resizedWidth(current, delta, minimumSidebarWidth);
      persistSidebarWidth(next);
      return next;
    });
  }, [minimumSidebarWidth]);

  return {
    sidebarOpen,
    setSidebarOpen,
    sidebarWidth,
    sidebarResizing,
    beginSidebarResize,
    nudgeSidebar,
    fitSidebarToContent,
  };
}
