import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { resolveSidebarModeTier, type SidebarModeTier } from "./sidebar-mode-layout";
import { usePanelLayout } from "./use-panel-layout";

export type SidebarMode = "project" | "papers" | "agent";

const SYNARA_SIDEBAR_INITIAL_MINIMUM = 310;

/** State persisted to localStorage; storage failures keep it session-only. */
export function useStoredState<T>(
  key: string,
  read: (raw: string | null) => T,
  write: (value: T) => string,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState(() => {
    try {
      return read(localStorage.getItem(key));
    } catch {
      return read(null);
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, write(value));
    } catch {
      // The preference still applies for the current session without storage.
    }
  }, [key, value, write]);
  return [value, setValue];
}

const readDocked = (raw: string | null) => raw === "1";
const writeDocked = (docked: boolean) => (docked ? "1" : "0");
const readSidebarMode = (raw: string | null): SidebarMode => (raw === "papers" || raw === "agent" ? raw : "project");
const writeSidebarMode = (mode: SidebarMode) => mode;

/**
 * The left sidebar: its resizable panel, which mode it shows, whether the
 * Agent is docked beside the canvas instead, and how many mode tabs fit.
 */
export function useWorkspaceSidebar(remeasureKey: string | undefined) {
  // Synara reports the intrinsic width of its composer controls; the panel
  // never shrinks below it.
  const [minimumSidebarWidth, setMinimumSidebarWidth] = useState(SYNARA_SIDEBAR_INITIAL_MINIMUM);
  const panel = usePanelLayout(minimumSidebarWidth);
  const [agentDocked, setAgentDocked] = useStoredState("lattice.agent-docked.v1", readDocked, writeDocked);
  const [sidebarMode, setSidebarMode] = useStoredState("lattice.sidebar-mode.v1", readSidebarMode, writeSidebarMode);
  const sidebarModeHeaderRef = useRef<HTMLDivElement>(null);
  const sidebarModeActionsRef = useRef<HTMLDivElement>(null);
  const [sidebarModeTier, setSidebarModeTier] = useState<SidebarModeTier>(4);
  const { sidebarOpen } = panel;
  useEffect(() => {
    const header = sidebarModeHeaderRef.current;
    const actions = sidebarModeActionsRef.current;
    const tabs = header?.querySelector<HTMLElement>(".sidebar-mode-tabs");
    if (!header || !actions || !tabs) return;
    let frameId: number | null = null;
    const measure = () => {
      frameId = null;
      const styles = getComputedStyle(header);
      const [collapsedWidth, expandedWidth, tabGap, actionsGap] = [
        "--navigation-control-height",
        "--navigation-tab-expanded-width",
        "--navigation-tab-gap",
        "--navigation-mode-actions-gap",
      ].map((property) => Number.parseFloat(styles.getPropertyValue(property)));
      if (![collapsedWidth, expandedWidth, tabGap, actionsGap].every(Number.isFinite)) return;
      const tabCount = tabs.querySelectorAll<HTMLElement>("[role=tab]").length;
      if (tabCount === 0) return;
      const availableWidth = Math.max(
        0,
        actions.getBoundingClientRect().left - tabs.getBoundingClientRect().left - actionsGap,
      );
      const nextTier = resolveSidebarModeTier({ availableWidth, collapsedWidth, expandedWidth, tabCount, tabGap });
      setSidebarModeTier((current) => (current === nextTier ? current : nextTier));
    };
    const scheduleMeasure = () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(measure);
    };
    scheduleMeasure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
    observer?.observe(header);
    observer?.observe(actions);
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, [remeasureKey, sidebarMode, sidebarOpen]);
  return {
    ...panel,
    minimumSidebarWidth, setMinimumSidebarWidth,
    agentDocked, setAgentDocked,
    sidebarMode, setSidebarMode,
    sidebarModeHeaderRef, sidebarModeActionsRef, sidebarModeTier,
  };
}
