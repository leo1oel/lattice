import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import {
  type AppearanceSettings,
  type Theme,
  type ThemePreference,
  FIXED_UI_FONT,
  SYSTEM_DARK_QUERY,
  loadAppearance,
  loadThemePreference,
  persistAppearance,
  persistThemePreference,
  resolveAppLocale,
  systemTheme,
} from "./app-settings";
import { activateAppLocale, i18n } from "../i18n";
import { syncNativeLocaleIfChanged } from "../app/native-locale";

export type Appearance = {
  /** The resolved light/dark value everything else renders against. */
  theme: Theme;
  themePreference: ThemePreference;
  setThemePreference: Dispatch<SetStateAction<ThemePreference>>;
  appearance: AppearanceSettings;
  setAppearance: Dispatch<SetStateAction<AppearanceSettings>>;
};

/**
 * Owns the light/dark theme and the appearance settings (fonts, sizes, zoom),
 * keeping each mirrored to the document and to localStorage. Everything else
 * only reads the returned values, so this stays free of project/agent state.
 */
export function useAppearance(): Appearance {
  const [themePreference, setThemePreference] = useState<ThemePreference>(loadThemePreference);
  const [osTheme, setOsTheme] = useState<Theme>(systemTheme);
  const [appearance, setAppearance] = useState<AppearanceSettings>(loadAppearance);
  const appLocale = resolveAppLocale(appearance.interfaceLanguage);
  const theme = themePreference === "system" ? osTheme : themePreference;

  useEffect(() => {
    const media = window.matchMedia(SYSTEM_DARK_QUERY);
    const update = () => setOsTheme(media.matches ? "dark" : "light");
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => { persistThemePreference(themePreference); }, [themePreference]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    void invoke("set_window_background", { dark: theme === "dark" }).catch(() => {
      // Browser-based tests and previews do not expose a native window.
    });
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = appLocale;
    if (i18n.locale !== appLocale) {
      void activateAppLocale(appLocale);
    }
  }, [appLocale]);

  useEffect(() => {
    document.documentElement.style.setProperty("--ui-font", FIXED_UI_FONT);
    document.documentElement.style.setProperty("--editor-font", appearance.editorFont);
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

  return { theme, themePreference, setThemePreference, appearance, setAppearance };
}
