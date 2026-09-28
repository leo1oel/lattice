import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { clamp, loadSidebarOpen, loadSidebarWidth, persistSidebarOpen, persistSidebarWidth } from "../settings/app-settings";

const MIN_TAB_STRIP_WIDTH = 220;
const FALLBACK_MIN_EDITOR_WIDTH = 600;
const COLLAPSE_SLOP = 96;

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
  const tabsWidth = tabs.reduce((width, tab) => width + (Number.parseFloat(window.getComputedStyle(tab).minWidth) || 104), 0);
  return Math.max(MIN_TAB_STRIP_WIDTH, tabsWidth + gap * (tabs.length - 1) + horizontalPadding);
};

const minimumEditorWidth = () => {
  const toolbarWidth = document.querySelector<HTMLElement>(".titlebar-main > .canvas-toolbar")?.offsetWidth ?? 0;
  const titleActionsWidth = document.querySelector<HTMLElement>(".titlebar-main > .title-actions")?.offsetWidth ?? 0;
  const workspaceWidth = window.innerWidth > 1180
    ? Number(document.querySelector<HTMLElement>(".split-canvas[data-minimum-workspace-width]")?.dataset.minimumWorkspaceWidth) || 0
    : 0;
  return Math.max(FALLBACK_MIN_EDITOR_WIDTH, workspaceWidth, toolbarWidth + titleActionsWidth + minimumTabStripWidth());
};

const resizedWidth = (start: number, delta: number, minimumSidebarWidth: number) =>
  clamp(start + delta, minimumSidebarWidth, Math.max(minimumSidebarWidth, window.innerWidth - minimumEditorWidth()));

/** Owns the single workspace sidebar's visibility and width. */
export function usePanelLayout(minimumSidebarWidth = 180) {
  const [sidebarOpen, setSidebarOpen] = useState(loadSidebarOpen);
  const [initialSidebarWidth] = useState(loadSidebarWidth);
  const preferredSidebarWidthRef = useRef(initialSidebarWidth);
  const [sidebarWidth, setSidebarWidth] = useState(() => resizedWidth(initialSidebarWidth, 0, minimumSidebarWidth));
  const [sidebarResizing, setSidebarResizing] = useState(false);
  // Visual overshoot never becomes the saved width or squeezes sidebar content.
  const [sidebarDragWidth, setSidebarDragWidth] = useState<number | null>(null);
  const [sidebarCollapsePreview, setSidebarCollapsePreview] = useState(false);
  const [sidebarRestoring, setSidebarRestoring] = useState(false);
  const [sidebarRebounding, setSidebarRebounding] = useState(false);
  const finishSidebarRestore = useCallback(() => {
    setSidebarRestoring(false);
    setSidebarRebounding(false);
  }, []);
  const finishResizeRef = useRef<(() => void) | null>(null);
  // Synara can report a new intrinsic minimum mid-drag; the active resize
  // reads it here. Refreshed after commit (both readers are pointer handlers):
  // a render-phase write would make the React Compiler skip this hook.
  const minimumSidebarWidthRef = useRef(minimumSidebarWidth);
  useLayoutEffect(() => {
    minimumSidebarWidthRef.current = minimumSidebarWidth;
  });
  useEffect(() => persistSidebarOpen(sidebarOpen), [sidebarOpen]);
  useEffect(() => () => finishResizeRef.current?.(), []);
  const fitSidebarToContent = useCallback(() => {
    // The gesture owns both widths until release; move/finish read the latest constraints.
    if (finishResizeRef.current) return;
    // Minimums constrain the display, not the saved preference: reapply it when space returns.
    setSidebarWidth(resizedWidth(preferredSidebarWidthRef.current, 0, minimumSidebarWidth));
  }, [minimumSidebarWidth]);
  useEffect(() => fitSidebarToContent(), [fitSidebarToContent]);
  useEffect(() => {
    let timer: number | undefined;
    const fitAfterWindowResize = () => {
      window.clearTimeout(timer);
      // This reads several rendered widths; once per native resize event it can
      // make WKWebView fall behind the window server during a fast drag.
      timer = window.setTimeout(fitSidebarToContent, 80);
    };
    window.addEventListener("resize", fitAfterWindowResize);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", fitAfterWindowResize);
    };
  }, [fitSidebarToContent]);

  const beginSidebarResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    finishResizeRef.current?.();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    // Freeze the collapse boundary: a new Agent minimum must not turn a small move into a collapse.
    const collapseBoundary = Math.min(startWidth, minimumSidebarWidthRef.current) - COLLAPSE_SLOP;
    const pointerId = event.pointerId;
    const target = event.currentTarget;
    let latest = sidebarWidth;
    let finished = false;
    let moved = false;
    let collapse = false;
    let rescued = false;
    let overshoot = 0;
    setSidebarRebounding(false);
    setSidebarResizing(true);
    document.body.classList.add("resizing-panels");
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const delta = moveEvent.clientX - startX;
      if (!moved && Math.abs(delta) < 2) return;
      moved = true;
      const nextCollapse = startWidth + delta < collapseBoundary + (collapse ? COLLAPSE_SLOP / 2 : 0);
      if (nextCollapse !== collapse) {
        collapse = nextCollapse;
        setSidebarCollapsePreview(collapse);
        if (!collapse) rescued = true;
        // Keep direct tracking off until the returning sidebar finishes its transition.
        setSidebarRestoring(!collapse);
      }
      // Pulling back rescues the sidebar; releasing commits the close at its prior width.
      if (collapse) return;
      latest = resizedWidth(startWidth, delta, minimumSidebarWidthRef.current);
      // A rescued panel opens straight to a valid width, with no rebound on release.
      overshoot = rescued ? 0 : startWidth + delta - latest;
      setSidebarDragWidth(latest + Math.sign(overshoot) * 48 * (1 - Math.exp(-Math.abs(overshoot) / 120)));
      setSidebarWidth(latest);
    };
    const finish = (endEvent?: Event) => {
      if (endEvent instanceof PointerEvent && endEvent.pointerId !== pointerId) return;
      if (finished) return;
      finished = true;
      const commit = endEvent?.type === "pointerup";
      if (collapse) latest = startWidth;
      latest = resizedWidth(latest, 0, minimumSidebarWidthRef.current);
      setSidebarWidth(latest);
      setSidebarDragWidth(null);
      setSidebarRebounding(!collapse && overshoot !== 0);
      setSidebarResizing(false);
      setSidebarCollapsePreview(false);
      setSidebarRestoring(false);
      if (commit && (collapse || !moved)) setSidebarOpen(false);
      document.body.classList.remove("resizing-panels");
      listening.abort();
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      if (moved && !collapse) {
        preferredSidebarWidthRef.current = latest;
        persistSidebarWidth(latest);
      }
      if (finishResizeRef.current === finish) finishResizeRef.current = null;
    };
    const listening = new AbortController();
    const { signal } = listening;
    finishResizeRef.current = finish;
    target.setPointerCapture(pointerId);
    window.addEventListener("pointermove", move, { signal });
    for (const type of ["pointerup", "pointercancel", "blur"]) window.addEventListener(type, finish, { signal });
    target.addEventListener("lostpointercapture", finish, { signal });
  }, [sidebarWidth]);

  const nudgeSidebar = useCallback((delta: number) => {
    setSidebarWidth((current) => {
      const next = resizedWidth(current, delta, minimumSidebarWidth);
      preferredSidebarWidthRef.current = next;
      persistSidebarWidth(next);
      return next;
    });
  }, [minimumSidebarWidth]);

  return {
    sidebarOpen,
    setSidebarOpen,
    sidebarWidth,
    sidebarDragWidth,
    sidebarResizing,
    sidebarCollapsePreview,
    sidebarRestoring,
    sidebarRebounding,
    finishSidebarRestore,
    beginSidebarResize,
    nudgeSidebar,
    fitSidebarToContent,
  };
}
