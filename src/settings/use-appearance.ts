import { type Dispatch, type SetStateAction, useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { subscribeTauriEvent } from "../app/effect-helpers";
import { isCustomAccent, type ThemeAccent } from "./theme-customization";
import {
  type ResolvedTheme,
  type ThemeRequest,
  THEMES_CHANGED_EVENT,
  applyThemeVariables,
  cachedTheme,
  rememberTheme,
  resolveTheme,
} from "./themes";
import { codeThemeProperties, resolveCodeThemeKind } from "./code-themes";
import { PROSE_FONT_SIZE, PROSE_LINE_HEIGHT, SOURCE_LINE_HEIGHT, cssFontFamily, editorFontStack } from "./editor-fonts";
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
  const { tint, accent, translucency, codeTheme, codeThemeVariant, tabStyle, theme: themeId } = appearance;
  const codeThemeKind = resolveCodeThemeKind(codeTheme, codeThemeVariant, theme);
  // Bumped when the installed themes change (one reinstalled, the chosen one
  // removed), and once the resolved theme is on the page, so what reads the
  // page's colors (the native window's background) reads them again.
  const [themesVersion, setThemesVersion] = useState(0);
  const [appliedTheme, setAppliedTheme] = useState(0);
  const themeVariables = useRef<Set<string>>(new Set());

  useEffect(() => subscribeTauriEvent(THEMES_CHANGED_EVENT, () => setThemesVersion((version) => version + 1)), []);

  useEffect(() => {
    const media = window.matchMedia(SYSTEM_DARK_QUERY);
    const update = () => setOsTheme(media.matches ? "dark" : "light");
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  // Before paint, so a theme change never shows one frame of the old palette.
  // The code theme's properties go first and the theme's on top: a theme
  // that colors the syntax wins over the code theme while it is chosen.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.codeTheme = codeTheme;
    // Whether the source editor's ground is light or dark, which a dark-only
    // code theme makes independent of the app's appearance.
    root.dataset.codeThemeKind = codeThemeKind;
    const codeProperties = codeThemeProperties(codeTheme, codeThemeKind, theme);
    for (const [name, value] of Object.entries(codeProperties)) root.style.setProperty(name, value);
    const keep = new Set(Object.keys(codeProperties));

    const request: ThemeRequest = { theme: themeId, appearance: theme, accent, presetColor: presetColor(themeId, accent) };
    const apply = (resolved: ResolvedTheme | undefined) => {
      root.dataset.tint = resolved?.theme ? "graphite" : tint;
      root.dataset.accent = accentAttribute(accent, resolved);
      themeVariables.current = applyThemeVariables(root.style, resolved?.variables ?? [], themeVariables.current, keep);
    };
    // A custom accent with no answer yet shows as picked for a moment
    // rather than in the previous accent.
    const pending: ResolvedTheme | undefined = isCustomAccent(accent) && !themeId
      ? { theme: null, variables: [["--accent", accent]], accent }
      : undefined;
    apply(cachedTheme(request) ?? pending);

    let current = true;
    resolveTheme(request)
      .then((resolved) => {
        if (!current) return;
        rememberTheme(request, resolved);
        apply(resolved);
        setAppliedTheme((count) => count + 1);
      })
      .catch(() => {
        // A browser preview has no Rust side: no theme, and a custom accent
        // as picked.
        if (current) apply(pending);
      });
    return () => {
      current = false;
    };
  }, [theme, tint, accent, themeId, codeTheme, codeThemeKind, themesVersion]);

  useLayoutEffect(() => {
    document.documentElement.dataset.tabStyle = tabStyle;
  }, [tabStyle]);

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
  }, [theme, themePreference, tint, translucency, appliedTheme]);

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

  const { editorFontSize, sourceFont, sourceLineHeight, proseFont, proseFontSize, proseLineHeight } = appearance;
  // Before paint, and before a document waits for its faces
  // (lib/document-fonts.ts reads these tokens). A default leaves its token to
  // theme.css, so nothing changes for anyone who never chose.
  const firstEditorType = useRef(true);
  useLayoutEffect(() => {
    const style = document.documentElement.style;
    const set = (name: string, value: string | false) => value ? style.setProperty(name, value) : style.removeProperty(name);
    style.setProperty("--editor-font-size", `${editorFontSize}px`);
    set("--source-font", Boolean(sourceFont) && editorFontStack(sourceFont, "--editor-font"));
    set("--source-line-height", sourceLineHeight !== SOURCE_LINE_HEIGHT && String(sourceLineHeight));
    set("--prose-font", Boolean(proseFont) && editorFontStack(proseFont, "--reading-font"));
    set("--prose-font-size", proseFontSize !== PROSE_FONT_SIZE && `${proseFontSize}px`);
    set("--prose-line-height", proseLineHeight !== PROSE_LINE_HEIGHT && String(proseLineHeight));
    set("--prose-reading-line-height", proseLineHeight !== PROSE_LINE_HEIGHT && String(proseLineHeight));
    if (firstEditorType.current) {
      firstEditorType.current = false;
      return;
    }
    // CodeMirror and the visual editor's block window keep the line heights
    // they measured, and a token change resizes nothing they observe. Both
    // measure again on a window resize; send one now and once more when the
    // chosen faces have arrived and swapped in (a bundled one loads on first
    // use, which this asks for rather than waiting on).
    const remeasure = () => window.dispatchEvent(new Event("resize"));
    remeasure();
    const faces = [sourceFont, proseFont].filter(Boolean).map((name) => document.fonts?.load(`16px ${cssFontFamily(name)}`).catch(() => []));
    if (faces.length) void Promise.all(faces).then(remeasure);
  }, [editorFontSize, sourceFont, sourceLineHeight, proseFont, proseFontSize, proseLineHeight]);

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

/**
 * `data-accent` for the stylesheet: the preset's name, `custom` for a color
 * set inline (one the writer picked, or the theme's own), or `graphite` when
 * "Theme default" finds no theme accent.
 */
function accentAttribute(accent: ThemeAccent, resolved: ResolvedTheme | undefined): string {
  if (accent === "theme") return resolved?.accent ? "custom" : "graphite";
  return isCustomAccent(accent) ? "custom" : accent;
}

/**
 * A preset accent's color in the current appearance, which a theme's
 * surfaces may need it fitted to: read from theme.css through a probe
 * element under the root, so the presets stay defined in one place.
 */
function presetColor(themeId: string, accent: ThemeAccent): string | null {
  if (!themeId || accent === "theme" || isCustomAccent(accent)) return null;
  const probe = document.createElement("span");
  probe.dataset.accent = accent;
  probe.hidden = true;
  document.documentElement.append(probe);
  const value = getComputedStyle(probe).getPropertyValue("--accent").trim();
  probe.remove();
  return normalizeHex(value);
}

/** A computed color as `#rrggbb`, or null. */
function normalizeHex(value: string): string | null {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(value);
  if (!rgb) return null;
  return `#${rgb.slice(1).map((channel) => Number(channel).toString(16).padStart(2, "0")).join("")}`;
}
