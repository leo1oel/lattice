import { openUrl } from "@tauri-apps/plugin-opener";
import { createStore } from "zustand/vanilla";
import { nativeProjectTabWindow } from "../app/project-tab-window";
import { loadChoice } from "../settings/app-settings";
import { sharedSetting } from "../settings/shared-setting";
import { hostPlatform } from "../platform/host-platform";

export type LinkDestination = "external" | "panel";
const KEY = "lattice.link-destination.v1";

export function supportsBrowserPanel() {
  return hostPlatform() === "mac" && Boolean(nativeProjectTabWindow());
}

export const linkDestination = sharedSetting<LinkDestination>(
  KEY, () => loadChoice(KEY, ["external", "panel"], "external"), { serialize: (value) => value },
);

export const browserPanel = createStore<{ request: { url?: string } | null }>()(() => ({ request: null }));

export function showBrowserPanel(url?: string) {
  if (supportsBrowserPanel()) browserPanel.setState({ request: { url } });
}

export function openAgentWebLink(value: unknown, target: unknown) {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return;
  const destination = target === "external" || target === "panel" ? target : linkDestination.get();
  if (destination === "panel" && supportsBrowserPanel()) {
    showBrowserPanel(value);
    return;
  }
  void openUrl(value).catch(() => undefined);
}
