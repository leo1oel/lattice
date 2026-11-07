/**
 * Settings' window state: whether it is open, on which page, and how it was
 * opened (app-settings-dialog.tsx renders it).
 */
import { useState, useTransition } from "react";
import { isSynaraSettingsTab, loadSettingsTab, persistSettingsTab } from "../settings/app-settings";
import type { SettingsSearchEntry } from "../settings/settings-search-index";
import type { SynaraSettingsTarget } from "./use-synara-host";
import type { SettingsTab } from "../app-types";
import { useLoadingShell } from "./use-loading-shell";

/**
 * Whether Settings is open and on which page. The actions are bodies for
 * App's stable handler map, whose forwarders give them the identity effects
 * and memoized panels rely on.
 */
type SettingsEntry = {
  returnFocus: HTMLElement | null;
  reveal: SettingsSearchEntry | null;
  page: boolean;
  synaraTarget: { target: SynaraSettingsTarget } | null;
};

const CLOSED_ENTRY: SettingsEntry = { returnFocus: null, reveal: null, page: false, synaraTarget: null };

export function useSettingsWindow(requestSynaraRuntime: () => void) {
  // Where Settings returns focus if not to what held it as Settings opened
  // (the project menu's trigger, when Settings is opened from that menu), the
  // row it opens on when the palette found one, whether a section was asked
  // for, and the place on an Agent page the agent panel asked for (a fresh
  // object per request, so asking twice reveals it twice): one state, as each
  // hook is paid on every App render.
  const [entry, setEntry] = useState<SettingsEntry>(CLOSED_ENTRY);
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
      setEntry({ returnFocus, reveal, page: requested !== undefined || reveal !== null, synaraTarget: null });
      startOpen(() => setOpen(true));
    },
    // An urgent update after the opening transition's: it also withdraws a
    // pending open, so a Settings closed from its loading shell stays closed.
    close: () => {
      setOpen(false);
      setEntry(CLOSED_ENTRY);
    },
    /** The agent's provider settings, as the agent panel asks for them; on `target`, if given. */
    openProviderSettings: (target?: SynaraSettingsTarget) => {
      setTab("agent");
      setEntry({ returnFocus: null, reveal: null, page: true, synaraTarget: target ? { target } : null });
      startOpen(() => setOpen(true));
    },
  };
}

export type SettingsWindow = ReturnType<typeof useSettingsWindow>;
