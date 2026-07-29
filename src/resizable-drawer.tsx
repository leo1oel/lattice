import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type UIEventHandler,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import "./components/ui/scroll-area.css";

const DRAWER_WIDTH_KEY = "lattice.right-drawer-width.v1";
const DEFAULT_DRAWER_WIDTH = 460;
const MIN_DRAWER_WIDTH = 320;
const MIN_WORKSPACE_WIDTH = 320;

function clampDrawerWidth(width: number) {
  return Math.min(
    Math.max(MIN_DRAWER_WIDTH, window.innerWidth - MIN_WORKSPACE_WIDTH),
    Math.max(MIN_DRAWER_WIDTH, width),
  );
}

function loadDrawerWidth() {
  try {
    return clampDrawerWidth(Number(localStorage.getItem(DRAWER_WIDTH_KEY)) || DEFAULT_DRAWER_WIDTH);
  } catch {
    return clampDrawerWidth(DEFAULT_DRAWER_WIDTH);
  }
}

function persistDrawerWidth(width: number) {
  try {
    localStorage.setItem(DRAWER_WIDTH_KEY, String(width));
  } catch {
    // Resizing remains available for the current session when storage is unavailable.
  }
}

export function ResizableDrawer(props: {
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
  closeDisabled?: boolean;
  onClose: () => void;
  onScroll?: UIEventHandler<HTMLElement>;
}) {
  const [width, setWidth] = useState(loadDrawerWidth);
  const [resizing, setResizing] = useState(false);
  const finishResizeRef = useRef<(() => void) | null>(null);

  const fitToWindow = useCallback(() => {
    setWidth((current) => {
      const next = clampDrawerWidth(current);
      if (next !== current) persistDrawerWidth(next);
      return next;
    });
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
      persistDrawerWidth(latest);
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
      <aside
        className={`history-drawer resizable-drawer native-hover-scrollbar ${props.className ?? ""}`.trim()}
        style={{ width }}
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
            persistDrawerWidth(next);
          }}
        />
        {props.children}
      </aside>
    </div>
  );
}
