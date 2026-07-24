import { type Dispatch, type SetStateAction, useEffect, useState } from "react";

import {
  type AppearanceSettings,
  type Theme,
  APPEARANCE_KEY,
  THEME_KEY,
  loadAppearance,
  loadTheme,
} from "./app-settings";

export type Appearance = {
  theme: Theme;
  setTheme: Dispatch<SetStateAction<Theme>>;
  appearance: AppearanceSettings;
  setAppearance: Dispatch<SetStateAction<AppearanceSettings>>;
};

/**
 * Owns the light/dark theme and the appearance settings (fonts, sizes, zoom),
 * keeping each mirrored to the document and to localStorage. Everything else
 * only reads the returned values, so this stays free of project/agent state.
 */
export function useAppearance(): Appearance {
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [appearance, setAppearance] = useState<AppearanceSettings>(loadAppearance);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Theme changes still apply for the current session without storage.
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty("--ui-font", appearance.uiFont);
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

  return { theme, setTheme, appearance, setAppearance };
}
