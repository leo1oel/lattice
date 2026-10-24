/**
 * Settings' window state: whether it is open, on which page, and how it was
 * opened (app-settings-dialog.tsx renders it).
 */
import { useState, useTransition } from "react";
import { isSynaraSettingsTab, loadSettingsTab, persistSettingsTab } from "../settings/app-settings";
import type { SettingsSearchEntry } from "../settings/settings-search-index";
import type { SettingsTab } from "../app-types";
import { useLoadingShell } from "./use-loading-shell";

/**
 * Whether Settings is open and on which page. The actions are bodies for
 * App's stable handler map, whose forwarders give them the identity effects
 * and memoized panels rely on.
 */
export function useSettingsWindow(requestSynaraRuntime: () => void) {
  // Where Settings returns focus if not to what held it as Settings opened
  // (the project menu's trigger, when Settings is opened from that menu), the
  // row it opens on when the palette found one, and whether a section was
  // asked for: one state, as each hook is paid on every App render.
  const [entry, setEntry] = useState<{ returnFocus: HTMLElement | null; reveal: SettingsSearchEntry | null; page: boolean }>(
    { returnFocus: null, reveal: null, page: false },
  );
  const [open, setOpen] = useState(false);
  // Opening Settings is a transition for the reason opening a lazy tool
  // drawer is (`useToolDrawers`), with the same loading shell.
  const [opening, startOpen] = useTransition();
  const late = useLoadingShell(opening, opening || open);
  const [tab, setTab] = useState<SettingsTab>(loadSettingsTab);
  const showTab = (next: SettingsTab) => {
    if (isSynaraSettingsTab(next)) requestSynaraRuntime();
    setTab(next);
    persistSettingsTab(next);
  };
  return {
    open, late, entry, tab, showTab,
    /** Opens on `tab`, or without one on the page Settings was last left on; on `reveal`'s row, if given. */
    openSettings: (requested?: SettingsTab, returnFocus: HTMLElement | null = null, reveal: SettingsSearchEntry | null = null) => {
      showTab(requested ?? loadSettingsTab());
      setEntry({ returnFocus, reveal, page: requested !== undefined || reveal !== null });
      startOpen(() => setOpen(true));
    },
    // An urgent update after the opening transition's: it also withdraws a
    // pending open, so a Settings closed from its loading shell stays closed.
    close: () => {
      setOpen(false);
      setEntry({ returnFocus: null, reveal: null, page: false });
    },
    /** The agent's provider settings, as the agent panel asks for them. */
    openProviderSettings: () => {
      setTab("agent");
      setEntry({ returnFocus: null, reveal: null, page: true });
      startOpen(() => setOpen(true));
    },
  };
}

export type SettingsWindow = ReturnType<typeof useSettingsWindow>;
