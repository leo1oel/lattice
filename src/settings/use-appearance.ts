import { type Dispatch, type SetStateAction, useEffect, useLayoutEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import {
  type AppearanceSettings,
  type Theme,
  type ThemePreference,
  SYSTEM_DARK_QUERY,
  loadAppearance,
  loadThemePreference,
  persistAppearance,
  persistThemePreference,
  resolveAppLocale,
  systemTheme,
} from "./app-settings";
import { fitAccent, isCustomAccent } from "./theme-customization";
import { activateAppLocale, i18n } from "../i18n";
import { syncNativeLocaleIfChanged } from "../app/native-locale";

export type Appearance = {
  /** The resolved light/dark value everything else renders against. */
  theme: Theme;
  themePreference: ThemePreference;
  setThemePreference: Dispatch<SetStateAction<ThemePreference>>;
  appearance: AppearanceSettings;
  setAppearance: Dispatch<SetStateAction<AppearanceSettings>>;
  /** What is behind the page: macOS vibrancy, or why not. */
  windowBacking: WindowBacking;
};

/**
 * The native window's answer to `set_window_material`; `unsupported` where
 * there is no native window (a browser tab, tests).
 */
export type WindowBacking = "translucent" | "opaque" | "reducedTransparency" | "unsupported";

/**
 * Owns the light/dark theme and the appearance settings (fonts, sizes, zoom,
 * tint, accent, translucency), keeping each mirrored to the document, to the
 * native window and to localStorage. Everything else only reads the returned
 * values, so this stays free of project/agent state.
 */
export function useAppearance(): Appearance {
  const [themePreference, setThemePreference] = useState<ThemePreference>(loadThemePreference);
  const [osTheme, setOsTheme] = useState<Theme>(systemTheme);
  const [appearance, setAppearance] = useState<AppearanceSettings>(loadAppearance);
  const [windowBacking, setWindowBacking] = useState<WindowBacking>("unsupported");
  const appLocale = resolveAppLocale(appearance.interfaceLanguage);
  const theme = themePreference === "system" ? osTheme : themePreference;
  const { tint, accent, translucency } = appearance;

  useEffect(() => {
    const media = window.matchMedia(SYSTEM_DARK_QUERY);
    const update = () => setOsTheme(media.matches ? "dark" : "light");
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => { persistThemePreference(themePreference); }, [themePreference]);

  // Before paint, so a theme change never shows one frame of the old palette.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.tint = tint;
    root.dataset.accent = isCustomAccent(accent) ? "custom" : accent;
    if (isCustomAccent(accent)) root.style.setProperty("--accent", fitAccent(accent, theme));
    else root.style.removeProperty("--accent");
  }, [theme, tint, accent]);

  // The native window follows: its appearance (so vibrancy and native menus
  // match the page), the color behind a live resize, and its material. The
  // answer says whether vibrancy is really behind the page. Reduce
  // transparency turns it off, and the system only reports that setting when
  // asked, so ask again whenever the window comes forward.
  useEffect(() => {
    let current = true;
    const apply = () => {
      const background = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
      void invoke<WindowBacking>("set_window_material", {
        material: {
          appearance: themePreference === "system" ? null : theme,
          background,
          translucent: translucency !== "off",
        },
      })
        .then((backing) => { if (current) setWindowBacking(backing); })
        .catch(() => { if (current) setWindowBacking("unsupported"); });
    };
    apply();
    window.addEventListener("focus", apply);
    return () => {
      current = false;
      window.removeEventListener("focus", apply);
    };
  }, [theme, themePreference, tint, translucency]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    if (windowBacking === "translucent" && translucency !== "off") root.dataset.glass = translucency;
    else delete root.dataset.glass;
  }, [windowBacking, translucency]);

  useEffect(() => {
    document.documentElement.lang = appLocale;
    if (i18n.locale !== appLocale) {
      void activateAppLocale(appLocale);
    }
  }, [appLocale]);

  useEffect(() => {
    document.documentElement.style.setProperty("--editor-font-size", `${appearance.editorFontSize}px`);
    persistAppearance(appearance);
  }, [appearance]);

  useEffect(() => { syncNativeLocaleIfChanged(); }, [appearance.interfaceLanguage]);

  useEffect(() => {
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().setZoom(appearance.interfaceScale))
      .catch(() => {
        // Browser-based tests and previews do not expose native webview zoom.
      });
  }, [appearance.interfaceScale]);

  return { theme, themePreference, setThemePreference, appearance, setAppearance, windowBacking };
}
