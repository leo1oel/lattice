import { useCallback, useEffect, useLayoutEffect, useRef, useState, memo } from "react";
import { createPortal } from "react-dom";
import { PanelLeft, PanelRight, Pin, Square, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useLingui } from "@lingui/react/macro";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tip } from "@/components/icon-tip";
import { useLatest } from "../app/effect-helpers";

export type EditorTab = {
  path: string;
  dirty?: boolean;
  beside?: boolean;
  kind?: "file" | "paper" | "asset";
  label?: string;
  pinned?: boolean;
};

function tabLabel(tab: EditorTab): string {
  return tab.label || tab.path.split("/").at(-1) || tab.path;
}

function sameDropPreview(a: EditorDropPreview | null, b: EditorDropPreview | null): boolean {
  if (!a || !b) return a === b;
  return (Object.keys(a) as (keyof EditorDropPreview)[]).every((key) => a[key] === b[key]);
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
const DROP_TARGET_SPRING = { type: "spring" as const, stiffness: 420, damping: 38, mass: 0.65 };

/** The highlighted part of the canvas: the half (or live split side) a drop opens into, else all of it. */
function dropTargetGeometry({ zone, width, dividerLeft, dividerRight }: EditorDropPreview) {
  if (zone === "left") return { x: 0, width: dividerLeft ?? width / 2 };
  if (zone === "center") return { x: 0, width };
  const x = dividerRight ?? width / 2;
  return { x, width: Math.max(0, width - x) };
}

// eslint-disable-next-line react-refresh/only-export-components -- project-tree and tab drags share one canvas hit-test.
export function editorDropPreviewAt(path: string, clientX: number, clientY: number): EditorDropPreview | null {
  const canvas = document.querySelector<HTMLElement>(".canvas-body");
  if (!canvas) return null;
  const { left, top, right, bottom, width, height } = canvas.getBoundingClientRect();
  const overCanvas = clientX >= left && clientX <= right && clientY >= top && clientY <= bottom;
  if (!overCanvas || width <= 0 || height <= 0) return null;
  const divider = canvas.querySelector<HTMLElement>(".split-canvas > .split-resizer")?.getBoundingClientRect();
  const liveDivider = divider && divider.width > 0 && divider.left > left && divider.right < right ? divider : null;
  const relativeX = (clientX - left) / width;
  const zone = relativeX <= DROP_ZONE_EDGE_SHARE ? "left" : relativeX >= 1 - DROP_ZONE_EDGE_SHARE ? "right" : "center";
  return {
    path, zone, left, top, width, height,
    dividerLeft: liveDivider ? liveDivider.left - left : null,
    dividerRight: liveDivider ? liveDivider.right - left : null,
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
  const TargetIcon = { left: PanelLeft, center: Square, right: PanelRight }[preview.zone];
  const label = preview.zone === props.preferredZone && props.preferredLabel
    ? props.preferredLabel
    : { left: t`Open on left`, center: t`Open here`, right: t`Open on right` }[preview.zone];
  return createPortal(
    <motion.div
      className="editor-tab-split-drop-preview"
      data-drop-zone={preview.zone}
      style={{ left: preview.left, top: preview.top, width: preview.width, height: preview.height }}
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.12 }}
      aria-hidden="true"
    >
      <motion.div
        className="editor-tab-split-drop-target"
        data-drop-target={preview.zone}
        initial={false}
        animate={{ x: targetGeometry.x, y: 0, width: targetGeometry.width, height: preview.height }}
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
              <span>{label}</span>
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
 * keystroke, yet it depends only on which tabs are open, active and dirty.
 */
export const EditorTabs = memo(function EditorTabs(props: {
  tabs: EditorTab[];
  activePath: string;
  animateLayout?: boolean;
  canCloseLast?: boolean;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onSetPinned?: (path: string, pinned: boolean) => void;
  onReorder: (nextPaths: string[]) => void;
  onDropTab?: (path: string, zone: EditorDropZone) => void;
}) {
  const { t } = useLingui();
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [splitDropPreview, setSplitDropPreview] = useState<EditorDropPreview | null>(null);
  const tabsViewportRef = useRef<HTMLDivElement | null>(null);

  // The window-level pointer handlers read the latest props through these while
  // the drag reorders the list mid-gesture. Written after commit, not during
  // render, which would make the React Compiler bail out of the component.
  const tabsRef = useLatest(props.tabs);
  const onReorderRef = useLatest(props.onReorder);
  const onDropTabRef = useLatest(props.onDropTab);
  const splitDropPreviewRef = useRef<EditorDropPreview | null>(null);
  const tabEls = useRef(new Map<string, HTMLElement>());
  const dragRef = useRef<{ path: string; pointerId: number; startX: number; startY: number; active: boolean } | null>(null);
  /** The window listeners of the drag in progress; aborting an ended drag's is a no-op. */
  const dragListeningRef = useRef<AbortController | null>(null);
  const suppressClick = useRef(false);

  // Keep the active tab visible when the bar overflows.
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      const activeTab = tabEls.current.get(props.activePath);
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
    const tabs = tabsRef.current;
    const paths = tabs.map((tab) => tab.path);
    const from = paths.indexOf(state.path);
    const splitTarget = onDropTabRef.current && from >= 0 ? editorDropPreviewAt(state.path, event.clientX, event.clientY) : null;
    updateSplitDropPreview(splitTarget);
    if (splitTarget || from < 0) return;
    // The insertion gap (0..len) for the cursor: how many tabs sit left of it,
    // measured against each tab's horizontal midpoint in the current order.
    let gap = 0;
    tabs.forEach((tab, index) => {
      const rect = tabEls.current.get(tab.path)?.getBoundingClientRect();
      if (rect && event.clientX > rect.left + rect.width / 2) gap = index + 1;
    });
    const without = paths.filter((path) => path !== state.path);
    const requestedIndex = Math.max(0, Math.min(without.length, gap > from ? gap - 1 : gap));
    const draggedPinned = tabs[from].pinned === true;
    const pinnedCount = tabs.filter((tab) => tab.pinned && tab.path !== state.path).length;
    const insertAt = draggedPinned ? Math.min(requestedIndex, pinnedCount) : Math.max(requestedIndex, pinnedCount);
    without.splice(insertAt, 0, state.path);
    // Same length as `paths`: the dragged tab only moved.
    if (without.some((path, index) => path !== paths[index])) onReorderRef.current(without);
  }, [onDropTabRef, onReorderRef, tabsRef, updateSplitDropPreview]);

  const completeDrag = useCallback((commitSplit: boolean) => {
    document.body.classList.remove("reordering-tabs");
    const state = dragRef.current;
    const splitTarget = splitDropPreviewRef.current;
    dragRef.current = null;
    updateSplitDropPreview(null);
    // A drag that moved must not also fire the tab's click (which would select).
    suppressClick.current = Boolean(state?.active);
    setDragPath(null);
    if (commitSplit && state?.active && splitTarget) onDropTabRef.current?.(state.path, splitTarget.zone);
  }, [onDropTabRef, updateSplitDropPreview]);

  const startDrag = useCallback((path: string, event: React.PointerEvent<HTMLDivElement>) => {
    // The close button stops its own pointerdown, so a press there never starts a drag.
    if (event.button !== 0) return;
    dragListeningRef.current?.abort();
    const pointerId = event.pointerId;
    dragRef.current = { path, pointerId, startX: event.clientX, startY: event.clientY, active: false };
    const listening = new AbortController();
    dragListeningRef.current = listening;
    const end = (commitSplit: boolean) => {
      listening.abort();
      completeDrag(commitSplit);
    };
    const { signal } = listening;
    window.addEventListener("pointermove", moveDrag, { passive: false, signal });
    window.addEventListener("pointerup", (pointerEvent) => pointerEvent.pointerId === pointerId && end(true), { signal });
    window.addEventListener("pointercancel", (pointerEvent) => pointerEvent.pointerId === pointerId && end(false), { signal });
    window.addEventListener("blur", () => end(false), { signal });
  }, [completeDrag, moveDrag]);

  // Clean up window listeners if unmounted mid-drag.
  useEffect(() => () => {
    dragListeningRef.current?.abort();
    document.body.classList.remove("reordering-tabs");
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
          "aria-label": t`Open files`,
          onWheel: (event) => {
            // A plain mouse wheel (deltaY only) still scrolls the tab strip.
            if (event.deltaX === 0 && event.deltaY !== 0) event.currentTarget.scrollLeft += event.deltaY;
          },
        }}
      >
        {props.tabs.map((tab) => {
          const active = tab.path === props.activePath;
          const canClose = !tab.pinned && (props.tabs.length > 1 || props.canCloseLast);
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
                  <Tip label={
                    <div className="max-w-[min(32rem,calc(100vw-2rem))] break-all">
                      {tab.kind === "paper" ? tab.label ?? tab.path : tab.path}
                      <div className="mt-1 opacity-70">{canClose ? t`Middle-click to close · ⌘⇧T to reopen` : t`⌘⇧T to reopen`}</div>
                    </div>
                  }>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => {
                        // Swallow the click that ends a drag so it doesn't re-select.
                        if (!suppressClick.current) props.onSelect(tab.path);
                        suppressClick.current = false;
                      }}
                    >
                      {tab.pinned && <Pin className="editor-tab-pin" size={11} aria-label={t`Pinned`} />}
                      <span>{tabLabel(tab)}</span>
                      {tab.dirty && <i aria-label={t`Unsaved changes`} />}
                    </button>
                  </Tip>
                  {canClose && (
                    <button
                      type="button"
                      className="editor-tab-close"
                      data-hit-area
                      aria-label={t({ message: `Close ${tabLabel(tab)}` })}
                      title={t({ message: `Close ${tabLabel(tab)}` })}
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
                <ContextMenuItem onSelect={() => props.onSelect(tab.path)}>{t`Open`}</ContextMenuItem>
                <ContextMenuItem onSelect={() => props.onSetPinned?.(tab.path, !tab.pinned)}>
                  {tab.pinned ? t`Unpin tab` : t`Pin tab`}
                </ContextMenuItem>
                <ContextMenuItem disabled={!canClose} variant="destructive" onSelect={() => props.onClose(tab.path)}>{t`Close`}</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </ScrollArea>
      <EditorDropPreviewPortal preview={props.onDropTab ? splitDropPreview : null} />
    </div>
  );
});
