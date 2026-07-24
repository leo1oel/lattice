import {
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useState,
} from "react";

import {
  type PanelKind,
  type PanelWidths,
  AGENT_OPEN_KEY,
  NAVIGATOR_OPEN_KEY,
  loadPanelOpen,
  loadPanelWidths,
  persistPanelOpen,
  persistPanelWidths,
  resizePanelWidths,
} from "./app-settings";

export type PanelLayout = {
  navigatorOpen: boolean;
  setNavigatorOpen: Dispatch<SetStateAction<boolean>>;
  agentOpen: boolean;
  setAgentOpen: Dispatch<SetStateAction<boolean>>;
  panelWidths: PanelWidths;
  beginPanelResize: (panel: PanelKind, event: ReactPointerEvent<HTMLDivElement>) => void;
  nudgePanel: (panel: PanelKind, delta: number) => void;
};

/**
 * Owns whether each side panel is collapsed and how wide it is, mirroring both
 * to localStorage. The resize handlers only touch layout state, so this stays
 * independent of project/agent/collab concerns.
 */
export function usePanelLayout(): PanelLayout {
  const [navigatorOpen, setNavigatorOpen] = useState(() => loadPanelOpen(NAVIGATOR_OPEN_KEY));
  const [agentOpen, setAgentOpen] = useState(() => loadPanelOpen(AGENT_OPEN_KEY));
  // Remember whether each side panel is collapsed so the layout survives a restart.
  useEffect(() => persistPanelOpen(NAVIGATOR_OPEN_KEY, navigatorOpen), [navigatorOpen]);
  useEffect(() => persistPanelOpen(AGENT_OPEN_KEY, agentOpen), [agentOpen]);
  const [panelWidths, setPanelWidths] = useState<PanelWidths>(loadPanelWidths);

  const beginPanelResize = useCallback(
    (panel: PanelKind, event: ReactPointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidths = panelWidths;
      let latest = panelWidths;
      document.body.classList.add("resizing-panels");
      const handleMove = (moveEvent: PointerEvent) => {
        latest = resizePanelWidths(panel, startWidths, moveEvent.clientX - startX, navigatorOpen, agentOpen);
        setPanelWidths(latest);
      };
      const handleUp = () => {
        document.body.classList.remove("resizing-panels");
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        persistPanelWidths(latest);
      };
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
    },
    [agentOpen, navigatorOpen, panelWidths],
  );

  const nudgePanel = useCallback(
    (panel: PanelKind, delta: number) => {
      setPanelWidths((current) => {
        const next = resizePanelWidths(panel, current, delta, navigatorOpen, agentOpen);
        persistPanelWidths(next);
        return next;
      });
    },
    [agentOpen, navigatorOpen],
  );

  return {
    navigatorOpen,
    setNavigatorOpen,
    agentOpen,
    setAgentOpen,
    panelWidths,
    beginPanelResize,
    nudgePanel,
  };
}
