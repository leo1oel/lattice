/* eslint lingui/no-unlocalized-strings: "off" -- Geometry uses DOM selectors and storage keys, not UI copy. */
import { useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from "react";

const RATIO_KEY = "lattice.agent-dock-ratio.v1";
const constrain = (value: number) => Math.min(0.65, Math.max(0.2, value));

/** Keep the iframe in one DOM location: reparenting it reloads its browsing context. */
export function useAgentPanelLayout(docked: boolean, visible: boolean, slotRef: RefObject<HTMLDivElement | null>) {
  const panelRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLElement | null>(null);
  const [ratio, setRatio] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(RATIO_KEY));
      return saved > 0 && Number.isFinite(saved) ? constrain(saved) : 0.35;
    } catch { return 0.35; }
  });
  const resize = (next: number) => {
    const value = constrain(next);
    setRatio(value);
    try { localStorage.setItem(RATIO_KEY, String(value)); } catch { /* Session-only preference. */ }
  };

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const workspace = slotRef.current?.closest(".workspace");
    if (!panel || !workspace) return;
    const sidebar = slotRef.current?.closest(".shared-sidebar");
    let host: HTMLElement | null = null;
    const releaseHost = () => {
      host?.classList.remove("agent-dock-host");
      host?.style.removeProperty("--agent-dock-height");
    };
    const findHost = () => docked && visible
      ? workspace.querySelector<HTMLElement>(".canvas-body .dual-primary .source-workspace")
        ?? workspace.querySelector<HTMLElement>(".canvas-body .dual-primary")
        ?? workspace.querySelector<HTMLElement>(".canvas-body .source-workspace")
        ?? workspace.querySelector<HTMLElement>(".canvas-body")
      : null;
    const update = () => {
      // In dual mode the primary column owns the dock whether it contains an
      // editor or a preview. Only single-pane previews fall back to the canvas.
      const next = findHost();
      if (next !== host) {
        if (host) observer.unobserve(host);
        releaseHost();
        host = next;
        hostRef.current = host;
        if (host) observer.observe(host);
      }
      const anchor = docked ? host : sidebar;
      const rect = anchor?.getBoundingClientRect();
      if (!visible || !rect || !rect.width || !rect.height) {
        panel.style.visibility = "hidden";
        return;
      }
      // Keep some writing space even in a short window; the panel scrolls.
      const headerHeight = slotRef.current?.offsetTop ?? 0;
      const height = docked ? Math.min(rect.height * ratio, Math.max(0, rect.height - 120)) : rect.height - headerHeight;
      // Match the sidebar's clipping animation without squeezing the live
      // iframe's controls through every intermediate column width.
      const width = docked ? rect.width : slotRef.current?.offsetWidth || rect.width;
      if (host) {
        host.classList.add("agent-dock-host");
        host.style.setProperty("--agent-dock-height", `${height}px`);
      }
      Object.assign(panel.style, {
        visibility: "visible",
        left: `${rect.left}px`, top: `${rect.bottom - height}px`,
        width: `${width}px`, height: `${height}px`,
        clipPath: docked ? "none" : `inset(0 ${Math.max(0, width - rect.width)}px 0 0)`,
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(workspace);
    if (sidebar) observer.observe(sidebar);
    if (slotRef.current) observer.observe(slotRef.current);
    // Lazy editors and document-mode changes can replace the docking anchor.
    // Ordinary editor mutations must not force a layout read on every keystroke.
    const mutations = new MutationObserver(() => {
      if (findHost() !== host) update();
    });
    mutations.observe(workspace, { childList: true, subtree: true });
    window.addEventListener("resize", update);
    update();
    return () => {
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", update);
      releaseHost();
      hostRef.current = null;
    };
  }, [docked, visible, ratio, slotRef]);

  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveResize = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const rect = hostRef.current?.getBoundingClientRect();
    if (rect?.height) resize((rect.bottom - event.clientY) / rect.height);
  };
  return { panelRef, ratio, resize, beginResize, moveResize };
}
