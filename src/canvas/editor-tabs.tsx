import { useCallback, useEffect, useLayoutEffect, useRef, useState, memo } from "react";
import { createPortal } from "react-dom";
import { PanelLeft, PanelRight, Square, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useLingui } from "@lingui/react/macro";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ScrollArea } from "@/components/ui/scroll-area";

export type EditorTab = {
  path: string;
  dirty?: boolean;
  beside?: boolean;
  kind?: "file" | "paper" | "asset";
  label?: string;
};

function tabLabel(tab: EditorTab): string {
  if (tab.label) return tab.label;
  const parts = tab.path.split("/");
  return parts[parts.length - 1] || tab.path;
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameDropPreview(a: EditorDropPreview | null, b: EditorDropPreview | null): boolean {
  if (!a || !b) return a === b;
  return a.path === b.path
    && a.zone === b.zone
    && a.left === b.left
    && a.top === b.top
    && a.width === b.width
    && a.height === b.height
    && a.dividerLeft === b.dividerLeft
    && a.dividerRight === b.dividerRight;
}

export type EditorDropPreview = {
  path: string;
  zone: EditorDropZone;
  left: number;
  top: number;
  width: number;
  height: number;
  dividerLeft: number | null;
  dividerRight: number | null;
};

export type EditorDropZone = "left" | "center" | "right";

const DROP_ZONE_EDGE_SHARE = 0.28;
const DROP_TARGET_SPRING = {
  type: "spring" as const,
  stiffness: 420,
  damping: 38,
  mass: 0.65,
};

function dropZoneForX(bounds: DOMRect, clientX: number): EditorDropPreview["zone"] {
  const relativeX = (clientX - bounds.left) / bounds.width;
  if (relativeX <= DROP_ZONE_EDGE_SHARE) return "left";
  if (relativeX >= 1 - DROP_ZONE_EDGE_SHARE) return "right";
  return "center";
}

function dropTargetGeometry(preview: EditorDropPreview) {
  const halfWidth = preview.width / 2;
  if (preview.zone === "left") {
    return {
      x: 0,
      width: preview.dividerLeft ?? halfWidth,
    };
  }
  if (preview.zone === "right") {
    const x = preview.dividerRight ?? halfWidth;
    return {
      x,
      width: Math.max(0, preview.width - x),
    };
  }
  return {
    x: 0,
    width: preview.width,
  };
}

// eslint-disable-next-line react-refresh/only-export-components -- project-tree and tab drags share one canvas hit-test.
export function editorDropPreviewAt(
  path: string,
  clientX: number,
  clientY: number,
): EditorDropPreview | null {
  const canvas = document.querySelector<HTMLElement>(".canvas-body");
  if (!canvas) return null;
  const bounds = canvas.getBoundingClientRect();
  const overCanvas = clientX >= bounds.left
    && clientX <= bounds.right
    && clientY >= bounds.top
    && clientY <= bounds.bottom;
  if (!overCanvas || bounds.width <= 0 || bounds.height <= 0) return null;
  const divider = canvas.querySelector<HTMLElement>(".split-canvas > .split-resizer");
  const dividerBounds = divider?.getBoundingClientRect();
  const hasLiveDivider = Boolean(
    dividerBounds
    && dividerBounds.width > 0
    && dividerBounds.left > bounds.left
    && dividerBounds.right < bounds.right,
  );
  return {
    path,
    zone: dropZoneForX(bounds, clientX),
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height,
    dividerLeft: hasLiveDivider ? dividerBounds!.left - bounds.left : null,
    dividerRight: hasLiveDivider ? dividerBounds!.right - bounds.left : null,
  };
}

export function EditorDropPreviewPortal(props: {
  preview: EditorDropPreview | null;
  preferredZone?: "left" | "right";
  preferredLabel?: string;
}) {
  const { t } = useLingui();
  const reduceMotion = useReducedMotion();
  const preview = props.preview;
  if (!preview) return null;
  const targetGeometry = dropTargetGeometry(preview);
  const targetPresentation = preview.zone === "left"
    ? { label: t`Open on left`, icon: PanelLeft }
    : preview.zone === "right"
      ? { label: t`Open on right`, icon: PanelRight }
      : { label: t`Open here`, icon: Square };
  if (preview.zone === props.preferredZone && props.preferredLabel) {
    targetPresentation.label = props.preferredLabel;
  }
  const TargetIcon = targetPresentation.icon;
  return createPortal(
    <motion.div
      className="editor-tab-split-drop-preview"
      data-drop-zone={preview.zone}
      style={{
        left: preview.left,
        top: preview.top,
        width: preview.width,
        height: preview.height,
      }}
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.12 }}
      aria-hidden="true"
    >
      <motion.div
        className="editor-tab-split-drop-target"
        data-drop-target={preview.zone}
        initial={false}
        animate={{
          x: targetGeometry.x,
          y: 0,
          width: targetGeometry.width,
          height: preview.height,
        }}
        transition={reduceMotion ? { duration: 0 } : DROP_TARGET_SPRING}
      >
        <AnimatePresence initial={false} mode="wait">
          <motion.div
            key={preview.zone}
            className="editor-tab-split-drop-label"
            initial={reduceMotion ? false : { opacity: 0, y: 4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0, y: -3, scale: 0.98 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.1 }}
          >
            <div className="editor-tab-split-drop-label-content">
              <TargetIcon size={16} />
              <span>{targetPresentation.label}</span>
            </div>
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </motion.div>,
    document.body,
  );
}

/**
 * Memoized: the tab strip is inside the titlebar, which App re-renders on every
 * keystroke. Nothing here depends on the document text — only on which tabs are
 * open, which is active, and whether each is dirty.
 */
export const EditorTabs = memo(function EditorTabs(props: {
  tabs: EditorTab[];
  activePath: string;
  animateLayout?: boolean;
  canCloseLast?: boolean;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onReorder: (nextPaths: string[]) => void;
  onDropTab?: (path: string, zone: EditorDropZone) => void;
}) {
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [splitDropPreview, setSplitDropPreview] = useState<EditorDropPreview | null>(null);
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  const tabsViewportRef = useRef<HTMLDivElement | null>(null);

  // Refs so the window-level pointer handlers always see the latest props even
  // though the drag reorders the list (and re-renders) many times mid-gesture.
  // Written from an every-commit effect (not during render): pointer events
  // only arrive after the commit, and render-phase ref writes make the React
  // Compiler bail out of the whole component.
  const tabsRef = useRef(props.tabs);
  const onReorderRef = useRef(props.onReorder);
  const onDropTabRef = useRef(props.onDropTab);
  const splitDropPreviewRef = useRef<EditorDropPreview | null>(null);
  useEffect(() => {
    tabsRef.current = props.tabs;
    onReorderRef.current = props.onReorder;
    onDropTabRef.current = props.onDropTab;
  });
  const tabEls = useRef(new Map<string, HTMLElement>());
  const dragRef = useRef<{
    path: string;
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);

  // Keep the active tab visible when the bar overflows.
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      const activeTab = activeTabRef.current;
      const viewport = tabsViewportRef.current;
      if (!activeTab || !viewport) return;
      const tabRect = activeTab.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      if (tabRect.left < viewportRect.left) {
        viewport.scrollLeft -= viewportRect.left - tabRect.left;
      } else if (tabRect.right > viewportRect.right) {
        viewport.scrollLeft += tabRect.right - viewportRect.right;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [props.activePath, props.tabs.length]);

  // The insertion gap (0..len) for the cursor: how many tabs sit left of it,
  // measured against each tab's horizontal midpoint in the current order.
  const gapIndexForX = useCallback((clientX: number): number => {
    let gap = 0;
    tabsRef.current.forEach((tab, index) => {
      const el = tabEls.current.get(tab.path);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (clientX > rect.left + rect.width / 2) gap = index + 1;
    });
    return gap;
  }, []);

  const splitTargetAt = useCallback((path: string, clientX: number, clientY: number): EditorDropPreview | null => {
    if (!onDropTabRef.current) return null;
    const tab = tabsRef.current.find((item) => item.path === path);
    if (!tab) return null;
    return editorDropPreviewAt(path, clientX, clientY);
  }, []);

  const updateSplitDropPreview = useCallback((next: EditorDropPreview | null) => {
    splitDropPreviewRef.current = next;
    setSplitDropPreview((current) => sameDropPreview(current, next) ? current : next);
  }, []);

  // Native HTML5 drag-and-drop drops unreliably in WKWebView (Tauri on macOS),
  // so tab reordering runs on pointer events instead: dragging live-reorders the
  // list so a tab can be moved anywhere, including from the end to the front.
  const moveDrag = useCallback((event: PointerEvent) => {
    const state = dragRef.current;
    if (!state || event.pointerId !== state.pointerId) return;
    if (!state.active) {
      if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < 4) return;
      state.active = true;
      setDragPath(state.path);
      document.body.classList.add("reordering-tabs");
    }
    event.preventDefault();
    const splitTarget = splitTargetAt(state.path, event.clientX, event.clientY);
    updateSplitDropPreview(splitTarget);
    if (splitTarget) return;
    const paths = tabsRef.current.map((tab) => tab.path);
    const from = paths.indexOf(state.path);
    if (from < 0) return;
    const gap = gapIndexForX(event.clientX);
    const without = paths.filter((path) => path !== state.path);
    const insertAt = Math.max(0, Math.min(without.length, gap > from ? gap - 1 : gap));
    without.splice(insertAt, 0, state.path);
    if (!sameOrder(without, paths)) onReorderRef.current(without);
  }, [gapIndexForX, splitTargetAt, updateSplitDropPreview]);

  const completeDrag = useCallback((commitSplit: boolean) => {
    document.body.classList.remove("reordering-tabs");
    const state = dragRef.current;
    const splitTarget = splitDropPreviewRef.current;
    dragRef.current = null;
    updateSplitDropPreview(null);
    // A drag that moved must not also fire the tab's click (which would select).
    suppressClick.current = Boolean(state?.active);
    setDragPath(null);
    if (
      commitSplit
      && state?.active
      && splitTarget
    ) onDropTabRef.current?.(state.path, splitTarget.zone);
  }, [updateSplitDropPreview]);

  const startDrag = useCallback((path: string, event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".editor-tab-close")) return;
    dragCleanupRef.current?.();
    const pointerId = event.pointerId;
    dragRef.current = {
      path,
      pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", moveDrag);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancelPointer);
      window.removeEventListener("blur", cancel);
      if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null;
    };
    const finish = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      cleanup();
      completeDrag(true);
    };
    const cancelPointer = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      cleanup();
      completeDrag(false);
    };
    const cancel = () => {
      cleanup();
      completeDrag(false);
    };
    dragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", moveDrag, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancelPointer);
    window.addEventListener("blur", cancel);
  }, [completeDrag, moveDrag]);

  // Clean up window listeners if unmounted mid-drag.
  useEffect(() => () => {
    dragCleanupRef.current?.();
    document.body.classList.remove("reordering-tabs");
    dragRef.current = null;
    splitDropPreviewRef.current = null;
  }, []);

  return (
    <div className="editor-tabs" data-window-drag-exclude-on-overflow>
      <ScrollArea
        className="editor-tabs-scroll"
        orientation="horizontal"
        fadeEdges={false}
        viewportRef={tabsViewportRef}
        viewportClassName="editor-tabs-viewport"
        contentClassName="editor-tabs-content"
        viewportProps={{
          role: "tablist",
          "aria-label": "Open files",
          onWheel: (event) => {
            // A plain mouse wheel (deltaY only) still scrolls the tab strip.
            if (event.deltaX === 0 && event.deltaY !== 0) {
              event.currentTarget.scrollLeft += event.deltaY;
            }
          },
        }}
      >
        {props.tabs.map((tab) => {
          const active = tab.path === props.activePath;
          const canClose = props.tabs.length > 1 || props.canCloseLast;
          return (
            <ContextMenu key={tab.path}>
              <ContextMenuTrigger asChild>
                <motion.div
                  layout={props.animateLayout !== false}
                  // Snappy so a dragged tab tracks the cursor closely while the
                  // others slide out of its way instead of jumping.
                  transition={{ layout: { type: "spring", stiffness: 700, damping: 46, mass: 0.5 } }}
                  data-tab-path={tab.path}
                  ref={(el) => {
                    if (el) tabEls.current.set(tab.path, el);
                    else tabEls.current.delete(tab.path);
                    if (active) activeTabRef.current = el;
                  }}
                  className={`editor-tab ${active ? "active" : ""}${canClose ? " closable" : ""}${tab.beside ? " beside" : ""}${dragPath === tab.path ? " dragging" : ""}`}
                  role="presentation"
                  onPointerDown={(event) => startDrag(tab.path, event)}
                  onAuxClick={(event) => {
                    if (event.button !== 1 || !canClose) return;
                    event.preventDefault();
                    props.onClose(tab.path);
                  }}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    title={`${tab.label ?? tab.path}${canClose ? " · middle-click close" : ""} · ⌘⇧T reopen`}
                    onClick={() => {
                      // Swallow the click that ends a drag so it doesn't re-select.
                      if (suppressClick.current) {
                        suppressClick.current = false;
                        return;
                      }
                      props.onSelect(tab.path);
                    }}
                  >
                    <span>{tabLabel(tab)}</span>
                    {tab.dirty && <i aria-label="Unsaved changes" />}
                  </button>
                  {canClose && (
                    <button
                      type="button"
                      className="editor-tab-close"
                      data-hit-area
                      aria-label={`Close ${tabLabel(tab)}`}
                      title={`Close ${tabLabel(tab)}`}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        props.onClose(tab.path);
                      }}
                    >
                      <X size={12} />
                    </button>
                  )}
                </motion.div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => props.onSelect(tab.path)}>Open</ContextMenuItem>
                <ContextMenuItem disabled={!canClose} variant="destructive" onSelect={() => props.onClose(tab.path)}>Close</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </ScrollArea>
      <EditorDropPreviewPortal preview={props.onDropTab ? splitDropPreview : null} />
    </div>
  );
});
