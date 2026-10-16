import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { AppearanceSettings } from "../settings/app-settings";
import { zoomedInterfaceScale, type InterfaceZoomChange } from "../settings/interface-scale";
import { subscribeTauriEvent } from "./effect-helpers";
import { listenInThisWindow } from "./window-events";

/** What View ▸ Bigger, Smaller and Actual Size send to the window they were used in (native_locale.rs). */
const MENU_EVENT = "interface-zoom";

/**
 * ⌘+, ⌘− and ⌘0 (the command table binds them) and the View menu's items step
 * the stored interface size; each change bumps `revealKey`, which raises the
 * size pill (interface-zoom-hud.tsx). The page sees the keys before the menu
 * does, so the menu items run for a click, or for a key no page listener
 * took (focus in the Agent frame).
 */
export function useInterfaceZoom(setAppearance: Dispatch<SetStateAction<AppearanceSettings>>) {
  const [revealKey, setRevealKey] = useState(0);
  const zoom = useCallback((change: InterfaceZoomChange) => {
    setAppearance((current) => ({ ...current, interfaceScale: zoomedInterfaceScale(current.interfaceScale, change) }));
    setRevealKey((key) => key + 1);
  }, [setAppearance]);
  useEffect(() => subscribeTauriEvent<string>(
    (handler) => listenInThisWindow(MENU_EVENT, handler),
    (change) => {
      if (change === "in" || change === "out" || change === "reset") zoom(change);
    },
  ), [zoom]);
  return { zoom, revealKey };
}
