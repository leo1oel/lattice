/**
 * What every island page shares, so it looks and behaves as the same surface
 * did inside the Tauri app's window:
 *
 * - the app's own stylesheets and faces (`src/index.css`, `src/App.css`, the
 *   fonts `src/main.tsx` loads), so every token resolves as it does there, the
 *   host's theme arriving as the root element's `data-theme`, `data-tint` and
 *   `data-accent` (`host:theme`, applied by the bridge);
 * - the interface language, activated from the app's own catalog;
 * - the app's confirmations, asked through GPUI's confirm dialog
 *   (`island:confirm`), and its toasts, shown by GPUI's toast stack
 *   (`island:notify`), so both stay above every page;
 * - the pointer-focus convention (`data-pointer-focus`), so a click leaves no
 *   keyboard focus ring.
 */
import "@fontsource-variable/inter";
import "../../../src/assets/fonts/ioskeley-mono/ioskeley-mono.css";
import "@fontsource/instrument-serif/400.css";
import "virtual:lattice-private-fonts.css";
import "../../../src/index.css";
import "../../../src/App.css";
import "./island.css";
import { useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@lingui/react";
import { registerConfirmActionHandler, type ConfirmActionChoice, type ConfirmActionOptions } from "../../../src/app-utils";
import { activateAppLocale, i18n } from "../../../src/i18n";
import { installPointerFocus } from "../../../src/components/ui/pointer-focus";
import { dismissAppToast, useAppToastsSnapshot, type AppLogEntry } from "../../../src/telemetry/app-log-store";
import { host } from "./host";

export type MountOptions = {
  /** Whether a toast the page raised goes to the host; one it keeps is only dropped. Every toast by default. */
  relayToast?: (entry: AppLogEntry) => boolean;
};

/** Forwards each toast the page raises to the host once, then drops it here. */
function ToastRelay({ relay }: { relay?: (entry: AppLogEntry) => boolean }) {
  const toasts = useAppToastsSnapshot();
  useEffect(() => {
    for (const { entry } of toasts) {
      if (relay?.(entry) ?? true) {
        host().post("island:notify", { level: entry.level, title: entry.title, detail: entry.detail });
      }
      dismissAppToast(entry.id, false);
    }
  }, [relay, toasts]);
  return null;
}

let localeActivated: Promise<void> | null = null;

/** Activate `locale` from the app's catalog; resolves once its messages are loaded. */
export function activateLocale(locale: "en" | "zh-CN"): Promise<void> {
  if (i18n.locale !== locale || !localeActivated) localeActivated = activateAppLocale(locale);
  return localeActivated;
}

/**
 * Mount `render`'s tree in the page's root, inside the app's providers.
 * Lingui's provider renders nothing until a language is active, and the host
 * names the writer's only once the page is listening (`doc:open`), so the
 * tree starts in English and switches when the host's language arrives.
 */
export function mount(render: () => ReactNode, options: MountOptions = {}): void {
  installPointerFocus();
  registerConfirmActionHandler((options: ConfirmActionOptions) =>
    host().request<ConfirmActionChoice | boolean>("island:confirm", options).catch(() => false));
  const root = createRoot(document.getElementById("root")!);
  const draw = () => root.render(
    <I18nProvider i18n={i18n}>
      <ToastRelay relay={options.relayToast} />
      {render()}
    </I18nProvider>,
  );
  void activateLocale("en").then(draw);
  // A new language re-renders the tree under the provider.
  i18n.on("change", draw);
}
