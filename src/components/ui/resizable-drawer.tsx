import {
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type UIEventHandler,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react/macro";
import { beginWindowDrag, toggleWindowFullscreen } from "../../app-utils";
import { toolKindForDrawer, useTrellisController, type TrellisController, type TrellisToolKind } from "../../trellis/trellis-controller";
import "./scroll-area.css";

const MIN_DRAWER_WIDTH = 320;
const MIN_WORKSPACE_WIDTH = 320;

function clampDrawerWidth(width: number) {
  return Math.min(
    Math.max(MIN_DRAWER_WIDTH, window.innerWidth - MIN_WORKSPACE_WIDTH),
    Math.max(MIN_DRAWER_WIDTH, width),
  );
}

const defaultDrawerWidth = () => clampDrawerWidth(window.innerWidth / 3);

type ResizableDrawerProps = {
  children: ReactNode;
  className?: string;
  dataTour?: string;
  ariaLabel?: string;
  closeDisabled?: boolean;
  onClose: () => void;
  onScroll?: UIEventHandler<HTMLElement>;
};

/**
 * A right-hand drawer over the workspace. In the Trellis workspace,
 * drawers that have a tool panel (history, comments, TODOs, …) render into
 * that dockable panel instead; the rest stay overlays.
 */
export function ResizableDrawer(props: ResizableDrawerProps) {
  const trellis = useTrellisController();
  const kind = trellis ? toolKindForDrawer(props.className) : null;
  return trellis && kind ? <DockedDrawer {...props} trellis={trellis} kind={kind} /> : <OverlayDrawer {...props} />;
}

function DockedDrawer({ trellis, kind, ...props }: ResizableDrawerProps & { trellis: TrellisController; kind: TrellisToolKind }) {
  const onCloseRef = useRef(props.onClose);
  useLayoutEffect(() => { onCloseRef.current = props.onClose; });
  useEffect(() => {
    const close = () => onCloseRef.current();
    trellis.openDrawer(kind, close);
    // After the commit's other effects: a drawer that takes this one's place
    // in the same commit (a tool replacing its loading shell) has registered
    // by then, and the panel stays.
    return () => queueMicrotask(() => trellis.closeDrawer(kind, close));
  }, [kind, trellis]);
  return createPortal(
    <aside
      className={`history-drawer resizable-drawer native-hover-scrollbar trellis-docked-drawer ${props.className ?? ""}`.trim()}
      data-tour={props.dataTour}
      aria-label={props.ariaLabel}
      onScroll={props.onScroll}
    >
      {props.children}
    </aside>,
    trellis.toolHost(kind),
  );
}

function OverlayDrawer(props: ResizableDrawerProps) {
  const { t } = useLingui();
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
  const { closeDisabled, onClose } = props;
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !closeDisabled) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeDisabled, onClose]);
  useEffect(() => () => finishResizeRef.current?.(), []);

  const beginResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    finishResizeRef.current?.();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = width;
    const listening = new AbortController();
    const { signal } = listening;

    setResizing(true);
    document.body.classList.add("resizing-panels");
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      setWidth(clampDrawerWidth(startWidth - (moveEvent.clientX - startX)));
    };
    const finish = () => {
      if (signal.aborted) return;
      listening.abort();
      setResizing(false);
      document.body.classList.remove("resizing-panels");
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      if (finishResizeRef.current === finish) finishResizeRef.current = null;
    };

    finishResizeRef.current = finish;
    target.setPointerCapture(pointerId);
    window.addEventListener("pointermove", move, { signal });
    for (const type of ["pointerup", "pointercancel", "blur"]) window.addEventListener(type, finish, { signal });
    target.addEventListener("lostpointercapture", finish, { signal });
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
          aria-label={t`Resize right panel`}
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
