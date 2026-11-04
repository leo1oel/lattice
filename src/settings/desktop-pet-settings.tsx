import { useEffect, useReducer } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { listenInThisWindow } from "../app/window-events";
import { open } from "@tauri-apps/plugin-dialog";
import { SettingsGroup, SettingsRow } from "../components/ui/settings-row";
import { SwitchField } from "../components/ui/switch-field";
import { Button } from "../components/ui/button";
import { isBrowserHosted } from "../platform/browser-runtime";
import { toMessage } from "../app-utils";

type Snapshot = { enabled: boolean; name: string | null };
type State = { snapshot: Snapshot | null; busy: boolean; error: string | null };
type Action = { type: "loaded" | "synced"; snapshot: Snapshot } | { type: "busy" } | { type: "failed"; error: string };
function reduce(state: State, action: Action): State {
  if (action.type === "loaded" || action.type === "synced") return { snapshot: action.snapshot, busy: action.type === "synced" ? state.busy : false, error: null };
  if (action.type === "busy") return { ...state, busy: true, error: null };
  if (action.type === "failed") return { ...state, busy: false, error: action.error };
  return state;
}

export function DesktopPetSettings() {
  const { t, i18n } = useLingui();
  const [state, dispatch] = useReducer(reduce, { snapshot: null, busy: false, error: null });
  const browser = isBrowserHosted();
  useEffect(() => {
    if (browser) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const refresh = () => {
      void invoke<Snapshot>("desktop_pet_status").then((snapshot) => {
        if (!disposed) dispatch({ type: "synced", snapshot });
      }).catch((reason) => { if (!disposed) dispatch({ type: "failed", error: toMessage(reason) }); });
    };
    refresh();
    void listenInThisWindow("desktop-pet-changed", refresh).then((stop) => {
      if (disposed) stop(); else unlisten = stop;
    }).catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, [browser]);
  if (browser) return null;
  const refresh = async () => dispatch({ type: "loaded", snapshot: await invoke<Snapshot>("desktop_pet_status") });
  const enable = async (enabled: boolean) => {
    dispatch({ type: "busy" });
    try {
      await invoke("desktop_pet_set_enabled", { enabled, locale: i18n.locale });
      await refresh();
    } catch (reason) { dispatch({ type: "failed", error: toMessage(reason) }); }
  };
  const importPet = async () => {
    dispatch({ type: "busy" });
    try {
      const path = await open({ title: t`Import desktop pet`, multiple: false, filters: [{ name: t`Pet manifest`, extensions: ["json"] }] });
      if (typeof path === "string") await invoke("desktop_pet_import", { path });
      await refresh();
    } catch (reason) { dispatch({ type: "failed", error: toMessage(reason) }); }
  };
  return (
    <SettingsGroup title={t`Desktop companion`} data-setting="desktop-companion">
      <SwitchField label={t`Show desktop companion`} description={t`A draggable pet follows builds and agent work. Reduced motion keeps it still.`}
        checked={state.snapshot?.enabled ?? false} disabled={state.busy || !state.snapshot?.name} onChange={(enabled) => { void enable(enabled); }} />
      <SettingsRow label={state.snapshot?.name ?? t`Choose a pet`} description={t`Import a local pet.json package with a PNG or WebP spritesheet. Codex-style sprite versions 1 and 2 are supported.`}>
        <Button disabled={state.busy} onClick={() => { void importPet(); }}>{t`Import pet`}</Button>
      </SettingsRow>
      {state.error && <SettingsRow label={t`Companion unavailable`} description={<span role="alert">{state.error}</span>} />}
    </SettingsGroup>
  );
}
