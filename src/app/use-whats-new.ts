import { useEffect, useState } from "react";
import { subscribeTauriEvent } from "./effect-helpers";
import { announceUpdate } from "./whats-new";
import { listenInThisWindow } from "./window-events";

/** What Help ▸ What's New sends to the window it was used in (native_locale.rs). */
const MENU_EVENT = "whats-new";

/**
 * Whether the release notes sheet is open. The first launch after an update
 * announces it with a toast that opens the sheet; Help ▸ What's New and the
 * palette open it any time.
 */
export function useWhatsNew() {
  const [open, setOpen] = useState(false);
  useEffect(() => announceUpdate(() => setOpen(true)), []);
  useEffect(() => subscribeTauriEvent<string>((handler) => listenInThisWindow(MENU_EVENT, handler), () => setOpen(true)), []);
  return { open, setOpen };
}
