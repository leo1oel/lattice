import { type Dispatch, type SetStateAction, useEffect, useLayoutEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import {
  type AppearanceSettings,
  type Theme,
  type ThemePreference,
  APPEARANCE_KEY,
  SYSTEM_DARK_QUERY,
  THEME_PREFERENCE_KEY,
  loadAppearance,
  loadThemePreference,
  resolveAppLocale,
  systemTheme,
} from "./app-settings";
import { changedFields, sharedSetting, useSharedSetting } from "./shared-setting";
import { fitAccent, isCustomAccent } from "./theme-customization";
import { codeThemeProperties, resolveCodeThemeKind } from "./code-themes";
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

// Shared by every window: a choice made in one shows in all of them, and one
// window's change never writes back another's older choices (shared-setting.ts).
const themePreferenceSetting = sharedSetting(THEME_PREFERENCE_KEY, loadThemePreference, {
  serialize: (preference) => preference,
});
const appearanceSetting = sharedSetting(APPEARANCE_KEY, loadAppearance, { merge: changedFields });

/**
 * Owns the light/dark theme and the appearance settings (fonts, sizes, zoom,
 * tint, accent, translucency, code theme), keeping each mirrored to the document, to the
 * native window and, through localStorage, to the other windows. Everything else only
 * reads the returned values, so this stays free of project/agent state.
 */
export function useAppearance(): Appearance {
  const [themePreference, setThemePreference] = useSharedSetting(themePreferenceSetting);
  const [osTheme, setOsTheme] = useState<Theme>(systemTheme);
  const [appearance, setAppearance] = useSharedSetting(appearanceSetting);
  const [windowBacking, setWindowBacking] = useState<WindowBacking>("unsupported");
  const appLocale = resolveAppLocale(appearance.interfaceLanguage);
  const theme = themePreference === "system" ? osTheme : themePreference;
  const { tint, accent, translucency, codeTheme, codeThemeVariant } = appearance;
  const codeThemeKind = resolveCodeThemeKind(codeTheme, codeThemeVariant, theme);

  useEffect(() => {
    const media = window.matchMedia(SYSTEM_DARK_QUERY);
    const update = () => setOsTheme(media.matches ? "dark" : "light");
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  // Before paint, so a theme change never shows one frame of the old palette.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.tint = tint;
    root.dataset.accent = isCustomAccent(accent) ? "custom" : accent;
    if (isCustomAccent(accent)) root.style.setProperty("--accent", fitAccent(accent, theme));
    else root.style.removeProperty("--accent");
  }, [theme, tint, accent]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.codeTheme = codeTheme;
    // Whether the source editor's ground is light or dark, which a dark-only
    // code theme makes independent of the app's appearance.
    root.dataset.codeThemeKind = codeThemeKind;
    for (const [name, value] of Object.entries(codeThemeProperties(codeTheme, codeThemeKind, theme))) {
      root.style.setProperty(name, value);
    }
  }, [codeTheme, codeThemeKind, theme]);

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
  }, [appearance.editorFontSize]);

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
