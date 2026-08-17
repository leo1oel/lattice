import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type UIEventHandler,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { beginWindowDrag, toggleWindowFullscreen } from "./app-utils";
import "./components/ui/scroll-area.css";

const MIN_DRAWER_WIDTH = 320;
const MIN_WORKSPACE_WIDTH = 320;

function clampDrawerWidth(width: number) {
  return Math.min(
    Math.max(MIN_DRAWER_WIDTH, window.innerWidth - MIN_WORKSPACE_WIDTH),
    Math.max(MIN_DRAWER_WIDTH, width),
  );
}

const defaultDrawerWidth = () => clampDrawerWidth(window.innerWidth / 3);

export function ResizableDrawer(props: {
  children: ReactNode;
  className?: string;
  dataTour?: string;
  ariaLabel?: string;
  closeDisabled?: boolean;
  onClose: () => void;
  onScroll?: UIEventHandler<HTMLElement>;
}) {
  const [width, setWidth] = useState(defaultDrawerWidth);
  const [resizing, setResizing] = useState(false);
  const finishResizeRef = useRef<(() => void) | null>(null);

  const fitToWindow = useCallback(() => {
    setWidth((current) => clampDrawerWidth(current));
  }, []);

  useEffect(() => {
    window.addEventListener("resize", fitToWindow);
    return () => window.removeEventListener("resize", fitToWindow);
  }, [fitToWindow]);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !props.closeDisabled) props.onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [props.closeDisabled, props.onClose]);
  useEffect(() => () => finishResizeRef.current?.(), []);

  const beginResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    finishResizeRef.current?.();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = width;
    let latest = width;
    let finished = false;

    setResizing(true);
    document.body.classList.add("resizing-panels");
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      latest = clampDrawerWidth(startWidth - (moveEvent.clientX - startX));
      setWidth(latest);
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      setResizing(false);
      document.body.classList.remove("resizing-panels");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
      target.removeEventListener("lostpointercapture", finish);
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      if (finishResizeRef.current === finish) finishResizeRef.current = null;
    };

    finishResizeRef.current = finish;
    target.setPointerCapture(pointerId);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
    target.addEventListener("lostpointercapture", finish);
  }, [width]);

  return (
    <div
      className="drawer-backdrop"
      onMouseDown={() => {
        if (!props.closeDisabled) props.onClose();
      }}
    >
      {resizing && <div className="drawer-resize-shield" aria-hidden="true" />}
      {/* The backdrop sits above the titlebar, so the window-drag strip has to
          be re-declared here: without it a press near the top of the window
          reads as an outside click and dismisses the drawer instead of moving
          the window. Stops short of the drawer so its own header keeps the
          pointer. */}
      <div
        className="drawer-window-drag-strip"
        aria-hidden="true"
        style={{ right: width }}
        onMouseDown={(event) => {
          event.stopPropagation();
          beginWindowDrag(event);
        }}
        onDoubleClick={toggleWindowFullscreen}
      />
      <aside
        className={`history-drawer resizable-drawer native-hover-scrollbar ${props.className ?? ""}`.trim()}
        style={{ width }}
        data-tour={props.dataTour}
        aria-label={props.ariaLabel}
        onMouseDown={(event) => event.stopPropagation()}
        onScroll={props.onScroll}
      >
        <div
          className="drawer-resizer panel-resizer"
          role="separator"
          aria-label="Resize right panel"
          aria-orientation="vertical"
          aria-valuemin={MIN_DRAWER_WIDTH}
          aria-valuemax={Math.max(MIN_DRAWER_WIDTH, window.innerWidth - MIN_WORKSPACE_WIDTH)}
          aria-valuenow={Math.round(width)}
          tabIndex={0}
          onPointerDown={beginResize}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const next = clampDrawerWidth(width + (event.key === "ArrowLeft" ? 16 : -16));
            setWidth(next);
          }}
        />
        {props.children}
      </aside>
    </div>
  );
}
