import { type Dispatch, type SetStateAction, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import {
  type AppearanceSettings,
  type Theme,
  type ThemePreference,
  APPEARANCE_KEY,
  FIXED_UI_FONT,
  SYSTEM_DARK_QUERY,
  THEME_PREFERENCE_KEY,
  loadAppearance,
  loadThemePreference,
  resolveAppLocale,
  systemTheme,
} from "./app-settings";
import { activateAppLocale, i18n } from "../i18n";

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

  useEffect(() => {
    try {
      localStorage.setItem(THEME_PREFERENCE_KEY, themePreference);
    } catch {
      // Theme changes still apply for the current session without storage.
    }
  }, [themePreference]);

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
    try {
      localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance));
    } catch {
      // Appearance changes still apply for the current session without storage.
    }
  }, [appearance]);

  useEffect(() => {
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().setZoom(appearance.interfaceScale))
      .catch(() => {
        // Browser-based tests and previews do not expose native webview zoom.
      });
  }, [appearance.interfaceScale]);

  return { theme, themePreference, setThemePreference, appearance, setAppearance };
}
