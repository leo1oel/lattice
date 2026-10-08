import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import { isBrowserHosted } from "../platform/browser-runtime";
import { loadAppearance, type InterfaceLanguage } from "../settings/app-settings";
import { disposeWhenSettled } from "./effect-helpers";

/** Titles for the macOS menu bar, in the shape `set_native_locale` accepts. */
export type NativeMenuLabels = {
  about: string;
  services: string;
  hide: string;
  hideOthers: string;
  showAll: string;
  quit: string;
  file: string;
  edit: string;
  undo: string;
  redo: string;
  cut: string;
  copy: string;
  paste: string;
  selectAll: string;
  view: string;
  fullscreen: string;
  window: string;
  minimize: string;
  zoom: string;
  closeWindow: string;
  help: string;
};

// The menu keeps Apple's own wording (which can differ from the same English
// word inside the app), so each title has its own catalog context. The context
// must be a literal: Lingui extracts it statically.

/** The menu bar titles in the active locale. */
export function nativeMenuLabels(): NativeMenuLabels {
  const name = "Lattice";
  return {
    about: i18n._(msg({ context: "macOS menu bar", message: `About ${name}` })),
    services: i18n._(msg({ context: "macOS menu bar", message: "Services" })),
    hide: i18n._(msg({ context: "macOS menu bar", message: `Hide ${name}` })),
    hideOthers: i18n._(msg({ context: "macOS menu bar", message: "Hide Others" })),
    showAll: i18n._(msg({ context: "macOS menu bar", message: "Show All" })),
    quit: i18n._(msg({ context: "macOS menu bar", message: `Quit ${name}` })),
    file: i18n._(msg({ context: "macOS menu bar", message: "File" })),
    edit: i18n._(msg({ context: "macOS menu bar", message: "Edit" })),
    undo: i18n._(msg({ context: "macOS menu bar", message: "Undo" })),
    redo: i18n._(msg({ context: "macOS menu bar", message: "Redo" })),
    cut: i18n._(msg({ context: "macOS menu bar", message: "Cut" })),
    copy: i18n._(msg({ context: "macOS menu bar", message: "Copy" })),
    paste: i18n._(msg({ context: "macOS menu bar", message: "Paste" })),
    selectAll: i18n._(msg({ context: "macOS menu bar", message: "Select All" })),
    view: i18n._(msg({ context: "macOS menu bar", message: "View" })),
    fullscreen: i18n._(msg({ context: "macOS menu bar", message: "Enter Full Screen" })),
    window: i18n._(msg({ context: "macOS menu bar", message: "Window" })),
    minimize: i18n._(msg({ context: "macOS menu bar", message: "Minimize" })),
    zoom: i18n._(msg({ context: "macOS menu bar", message: "Zoom" })),
    closeWindow: i18n._(msg({ context: "macOS menu bar", message: "Close Window" })),
    help: i18n._(msg({ context: "macOS menu bar", message: "Help" })),
  };
}

/**
 * The bundle localization AppKit should use for this app, or `null` to follow
 * the system. Matches `CFBundleLocalizations` in src-tauri/Info.plist.
 */
export function bundleLanguage(preference: InterfaceLanguage): "en" | "zh-Hans" | null {
  if (preference === "system") return null;
  // eslint-disable-next-line lingui/no-unlocalized-strings -- Apple localization identifier
  return preference === "zh-CN" ? "zh-Hans" : "en";
}

/**
 * Hand the active locale to the native host: menu bar titles now, and the
 * language of AppKit/WebKit panels and context menus from the next launch.
 * A browser-hosted page has no menu bar of its own, but the file panels it
 * opens are still drawn by the Lattice process.
 */
export function syncNativeLocale(preference: InterfaceLanguage = loadAppearance().interfaceLanguage): Promise<void> {
  const menu = isBrowserHosted() ? null : nativeMenuLabels();
  return invoke("set_native_locale", { menu, bundleLanguage: bundleLanguage(preference) });
}

function syncQuietly(): void {
  void syncNativeLocale().catch(() => {
    // Tests and browser previews have no native host.
  });
}

const currentLocaleKey = () => `${i18n.locale}|${loadAppearance().interfaceLanguage}`;

// The last locale and preference sent while the sync is installed; `null`
// when it is not.
let lastSentLocaleKey: string | null = null;

/**
 * Resend when the locale or the saved preference moved since the last send.
 * Switching between "system" and an explicit language that resolves to the
 * same locale changes only the preference, so no catalog change reports it.
 */
export function syncNativeLocaleIfChanged(): void {
  if (lastSentLocaleKey === null) return;
  const key = currentLocaleKey();
  if (key === lastSentLocaleKey) return;
  lastSentLocaleKey = key;
  syncQuietly();
}

/**
 * Keep the native locale in step with the interface language. Call after the
 * startup catalog is active. The menu bar is app-wide while each window holds
 * its own locale, so a window that gains focus reapplies its labels.
 */
export function installNativeLocaleSync(): () => void {
  // Lingui also reports catalog loads as changes; only a new locale or
  // preference needs a rebuild.
  lastSentLocaleKey = currentLocaleKey();
  syncQuietly();
  const stopLocale = i18n.on("change", syncNativeLocaleIfChanged);
  let stopFocus = () => {};
  if (!isBrowserHosted()) {
    try {
      const focusChanges = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (focused) syncQuietly();
      });
      stopFocus = disposeWhenSettled(focusChanges.catch(() => () => {}));
    } catch {
      // No native window outside the desktop shell.
    }
  }
  return () => {
    lastSentLocaleKey = null;
    stopLocale();
    stopFocus();
  };
}
