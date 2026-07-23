import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

export type EditorTab = {
  path: string;
  dirty?: boolean;
  beside?: boolean;
  kind?: "file" | "paper";
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

export function EditorTabs(props: {
  tabs: EditorTab[];
  activePath: string;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onReorder: (nextPaths: string[]) => void;
}) {
  const [dragPath, setDragPath] = useState<string | null>(null);
  const activeTabRef = useRef<HTMLDivElement | null>(null);

  // Refs so the window-level pointer handlers always see the latest props even
  // though the drag reorders the list (and re-renders) many times mid-gesture.
  const tabsRef = useRef(props.tabs);
  tabsRef.current = props.tabs;
  const onReorderRef = useRef(props.onReorder);
  onReorderRef.current = props.onReorder;
  const tabEls = useRef(new Map<string, HTMLElement>());
  const dragRef = useRef<{ path: string; startX: number; active: boolean } | null>(null);
  const suppressClick = useRef(false);

  // Keep the active tab visible when the bar overflows (the scrollbar is hidden).
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [props.activePath]);

  // The insertion gap (0..len) for the cursor: how many tabs sit left of it,
  // measured against each tab's horizontal midpoint in the current order.
  const gapIndexForX = (clientX: number): number => {
    let gap = 0;
    tabsRef.current.forEach((tab, index) => {
      const el = tabEls.current.get(tab.path);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (clientX > rect.left + rect.width / 2) gap = index + 1;
    });
    return gap;
  };

  // Native HTML5 drag-and-drop drops unreliably in WKWebView (Tauri on macOS),
  // so tab reordering runs on pointer events instead: dragging live-reorders the
  // list so a tab can be moved anywhere, including from the end to the front.
  const onPointerMove = useCallback((event: PointerEvent) => {
    const state = dragRef.current;
    if (!state) return;
    if (!state.active) {
      if (Math.abs(event.clientX - state.startX) < 4) return;
      state.active = true;
      setDragPath(state.path);
      document.body.classList.add("reordering-tabs");
    }
    event.preventDefault();
    const paths = tabsRef.current.map((tab) => tab.path);
    const from = paths.indexOf(state.path);
    if (from < 0) return;
    const gap = gapIndexForX(event.clientX);
    const without = paths.filter((path) => path !== state.path);
    const insertAt = Math.max(0, Math.min(without.length, gap > from ? gap - 1 : gap));
    without.splice(insertAt, 0, state.path);
    if (!sameOrder(without, paths)) onReorderRef.current(without);
  }, []);

  const endDrag = useCallback(() => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", endDrag);
    document.body.classList.remove("reordering-tabs");
    const state = dragRef.current;
    dragRef.current = null;
    // A drag that moved must not also fire the tab's click (which would select).
    suppressClick.current = Boolean(state?.active);
    setDragPath(null);
  }, [onPointerMove]);

  const startDrag = useCallback((path: string, event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".editor-tab-close")) return;
    dragRef.current = { path, startX: event.clientX, active: false };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endDrag);
  }, [onPointerMove, endDrag]);

  // Clean up window listeners if unmounted mid-drag.
  useEffect(() => () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", endDrag);
    document.body.classList.remove("reordering-tabs");
  }, [onPointerMove, endDrag]);

  if (props.tabs.length <= 1) return null;

  return (
    <div className="editor-tabs">
      <div
        className="editor-tabs-scroll"
        role="tablist"
        aria-label="Open files"
        onWheel={(event) => {
          // A plain mouse wheel (deltaY only) still scrolls the tab strip.
          if (event.deltaX === 0 && event.deltaY !== 0) {
            event.currentTarget.scrollLeft += event.deltaY;
          }
        }}
      >
        {props.tabs.map((tab) => {
          const active = tab.path === props.activePath;
          return (
            <ContextMenu key={tab.path}>
              <ContextMenuTrigger asChild>
                <div
                  data-tab-path={tab.path}
                  ref={(el) => {
                    if (el) tabEls.current.set(tab.path, el);
                    else tabEls.current.delete(tab.path);
                    if (active) activeTabRef.current = el;
                  }}
                  className={`editor-tab ${active ? "active" : ""}${tab.beside ? " beside" : ""}${dragPath === tab.path ? " dragging" : ""}`}
                  role="presentation"
                  onPointerDown={(event) => startDrag(tab.path, event)}
                  onAuxClick={(event) => {
                    if (event.button !== 1) return;
                    event.preventDefault();
                    props.onClose(tab.path);
                  }}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    title={`${tab.label ?? tab.path} · middle-click close · ⌘⇧T reopen`}
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
                  <button
                    type="button"
                    className="editor-tab-close"
                    title={`Close ${tabLabel(tab)}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onClose(tab.path);
                    }}
                  >
                    <X size={11} />
                  </button>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => props.onSelect(tab.path)}>Open</ContextMenuItem>
                <ContextMenuItem variant="destructive" onSelect={() => props.onClose(tab.path)}>Close</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>
    </div>
  );
}
