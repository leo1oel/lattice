/**
 * Settings and layout persistence for the app.
 *
 * This module owns the localStorage-backed preferences and layout state that
 * survive between sessions — recent projects, theme, build preferences, the
 * agent system prompt, split/panel ratios, remembered last-open files, panel
 * open state, and the paper reading width — along with the storage keys and the
 * small `clamp` helper they share. Everything here is pure and free of React or
 * font/panel dependencies, so it can be imported anywhere without pulling in the
 * rest of the app.
 */

import { DEFAULT_UI_FONT, DEFAULT_EDITOR_FONT, UI_FONT_OPTIONS, EDITOR_FONT_OPTIONS, resolveFontValue } from "./available-fonts";

export type Theme = "light" | "dark";
export type RecentProject = { name: string; path: string };
export type AutoBuildMode = "manual" | "automatic";
export type BuildPreferences = { autoBuildMode: AutoBuildMode };
export type PaperReadingWidth = "comfortable" | "wide";

export const RECENT_PROJECTS_KEY = "lattice.recent-projects.v1";
export const THEME_KEY = "lattice.theme.v1";
export const BUILD_PREFERENCES_KEY = "lattice.build-preferences.v2";
export const SPLIT_RATIO_KEY = "lattice.split-ratio.v1";
export const COLUMNS_PDF_RATIO_KEY = "lattice.columns-pdf-ratio.v1";
export const NAVIGATOR_SPLIT_KEY = "lattice.navigator-split.v1";
export const NAVIGATOR_OPEN_KEY = "lattice.navigator-open.v1";
export const AGENT_OPEN_KEY = "lattice.agent-open.v1";
export const LAST_FILE_KEY = "lattice.last-file.v1";
export const LAST_FILE_MAX = 60;
export const AGENT_SYSTEM_PROMPT_KEY = "lattice.agent-system-prompt.v1";
export const PAPER_READING_WIDTH_KEY = "lattice.paper-reading-width";

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function loadPaperReadingWidth(): PaperReadingWidth {
  try {
    return localStorage.getItem(PAPER_READING_WIDTH_KEY) === "wide" ? "wide" : "comfortable";
  } catch {
    return "comfortable";
  }
}

export function loadRecentProjects(): RecentProject[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_PROJECTS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is RecentProject => Boolean(
        item && typeof item === "object" && "name" in item && typeof item.name === "string" &&
        "path" in item && typeof item.path === "string",
      ))
      .slice(0, 8);
  } catch {
    return [];
  }
}

export function persistRecentProjects(projects: RecentProject[]) {
  try {
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(projects));
  } catch {
    // Recent projects are a convenience; project access still works if storage is unavailable.
  }
}

export function loadTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Fall through to the system preference when storage is unavailable.
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function loadBuildPreferences(): BuildPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(BUILD_PREFERENCES_KEY) ?? "null") as { autoBuildMode?: string } | null;
    const autoBuildMode = value?.autoBuildMode;
    return {
      autoBuildMode: autoBuildMode === "manual" ? "manual" : "automatic",
    };
  } catch {
    return { autoBuildMode: "automatic" };
  }
}

export function loadSystemPrompt(): string {
  try {
    return localStorage.getItem(AGENT_SYSTEM_PROMPT_KEY) ?? "";
  } catch {
    return "";
  }
}

export function loadSplitRatio(): number {
  try {
    return clamp(Number(localStorage.getItem(SPLIT_RATIO_KEY)) || 0.46, 0.2, 0.8);
  } catch {
    return 0.46;
  }
}

export function persistSplitRatio(ratio: number) {
  try {
    localStorage.setItem(SPLIT_RATIO_KEY, String(ratio));
  } catch {
    // Split resizing remains available for the current session without storage.
  }
}

export function loadColumnsPdfRatio(): number {
  try {
    return clamp(Number(localStorage.getItem(COLUMNS_PDF_RATIO_KEY)) || 0.38, 0.22, 0.55);
  } catch {
    return 0.38;
  }
}

export function persistColumnsPdfRatio(ratio: number) {
  try {
    localStorage.setItem(COLUMNS_PDF_RATIO_KEY, String(ratio));
  } catch {
    // Columns PDF resizing remains available for the current session without storage.
  }
}

export function loadNavigatorSplit(): number {
  try {
    return clamp(Number(localStorage.getItem(NAVIGATOR_SPLIT_KEY)) || 0.58, 0.2, 0.78);
  } catch {
    return 0.58;
  }
}

export function persistNavigatorSplit(ratio: number) {
  try {
    localStorage.setItem(NAVIGATOR_SPLIT_KEY, String(ratio));
  } catch {
    // Navigator resizing remains available for the current session without storage.
  }
}

export function loadLastFileMap(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(LAST_FILE_KEY) ?? "{}") as unknown;
    if (!value || typeof value !== "object") return {};
    return value as Record<string, string>;
  } catch {
    return {};
  }
}

/** The file the user last had open in a given project, if remembered. */
export function loadLastFile(root: string): string | null {
  const value = loadLastFileMap()[root];
  return typeof value === "string" && value ? value : null;
}

export function persistLastFile(root: string, path: string) {
  try {
    const map = loadLastFileMap();
    if (map[root] === path) return;
    // Re-insert at the end so trimming drops the least-recently-opened project.
    delete map[root];
    const entries = [...Object.entries(map), [root, path] as [string, string]];
    const trimmed = entries.slice(Math.max(0, entries.length - LAST_FILE_MAX));
    localStorage.setItem(LAST_FILE_KEY, JSON.stringify(Object.fromEntries(trimmed)));
  } catch {
    // Non-fatal: reopening simply falls back to the root document.
  }
}

/** Panels default open; only an explicit "0" (the user hid it) keeps them hidden. */
export function loadPanelOpen(key: string): boolean {
  try {
    return localStorage.getItem(key) !== "0";
  } catch {
    return true;
  }
}

export function persistPanelOpen(key: string, open: boolean) {
  try {
    localStorage.setItem(key, open ? "1" : "0");
  } catch {
    // Layout still toggles this session without storage.
  }
}

export type PanelKind = "navigator" | "agent";
export type PanelWidths = { navigator: number; agent: number };

type EditorKeymap = "default" | "vim" | "emacs";
export type AppearanceSettings = {
  uiFont: string;
  interfaceScale: number;
  editorFont: string;
  editorFontSize: number;
  editorKeymap: EditorKeymap;
  editorSpellcheck: boolean;
  maxOpenTabs: number;
};

export const PANEL_WIDTHS_KEY = "lattice.panel-widths.v2";
export const APPEARANCE_KEY = "lattice.appearance.v4";
export const LEGACY_APPEARANCE_KEY = "lattice.appearance.v3";

export function loadPanelWidths(): PanelWidths {
  // Keep navigator/agent narrower so the editor + PDF canvas get more room by default.
  const defaults = { navigator: 200, agent: 280 };
  // A panel may have been dragged out to half the window; honour that on reload,
  // re-clamped to this screen's half so a saved width never dwarfs a smaller one.
  const half = typeof window !== "undefined" ? window.innerWidth / 2 : 600;
  try {
    const value = JSON.parse(localStorage.getItem(PANEL_WIDTHS_KEY) ?? "null") as Partial<PanelWidths> | null;
    return {
      navigator: clamp(Number(value?.navigator) || defaults.navigator, 160, Math.max(160, half)),
      agent: clamp(Number(value?.agent) || defaults.agent, 260, Math.max(260, half)),
    };
  } catch {
    return defaults;
  }
}

export function loadAppearance(): AppearanceSettings {
  const defaults: AppearanceSettings = {
    uiFont: DEFAULT_UI_FONT,
    interfaceScale: 1.1,
    editorFont: DEFAULT_EDITOR_FONT,
    editorFontSize: 14,
    editorKeymap: "default",
    editorSpellcheck: false,
    maxOpenTabs: 5,
  };
  try {
    const current = localStorage.getItem(APPEARANCE_KEY);
    const legacy = localStorage.getItem(LEGACY_APPEARANCE_KEY);
    const value = JSON.parse(current ?? legacy ?? "null") as Partial<AppearanceSettings> | null;
    return {
      uiFont: resolveFontValue(
        typeof value?.uiFont === "string" ? value.uiFont : undefined,
        UI_FONT_OPTIONS,
        defaults.uiFont,
      ),
      interfaceScale: clamp(Number(value?.interfaceScale) || defaults.interfaceScale, 0.9, 1.35),
      editorFont: resolveFontValue(
        typeof value?.editorFont === "string" ? value.editorFont : undefined,
        EDITOR_FONT_OPTIONS,
        defaults.editorFont,
      ),
      editorFontSize: clamp(Number(value?.editorFontSize) || defaults.editorFontSize, 10, 24),
      editorKeymap: value?.editorKeymap === "vim"
        ? "vim"
        : value?.editorKeymap === "emacs"
          ? "emacs"
          : "default",
      editorSpellcheck: value?.editorSpellcheck === true,
      maxOpenTabs: clamp(Math.round(Number(value?.maxOpenTabs) || defaults.maxOpenTabs), 1, 20),
    };
  } catch {
    return defaults;
  }
}

export function persistPanelWidths(widths: PanelWidths) {
  try {
    localStorage.setItem(PANEL_WIDTHS_KEY, JSON.stringify(widths));
  } catch {
    // Panel resizing remains available for the current session without storage.
  }
}

export function resizePanelWidths(
  panel: PanelKind,
  start: PanelWidths,
  delta: number,
  navigatorOpen: boolean,
  agentOpen: boolean,
): PanelWidths {
  const canvasMinimum = 360;
  // One 5px handle per visible side panel.
  const handles = (navigatorOpen ? 5 : 0) + (agentOpen ? 5 : 0);
  // A side panel may grow to half the window — wide enough for tables, file
  // trees, and long agent replies — as long as the canvas keeps its minimum.
  const halfWindow = window.innerWidth / 2;
  if (panel === "navigator") {
    const agentWidth = agentOpen ? start.agent : 0;
    const maximum = Math.max(160, Math.min(halfWindow, window.innerWidth - agentWidth - canvasMinimum - handles));
    return { ...start, navigator: clamp(start.navigator + delta, 160, maximum) };
  }
  const navigatorWidth = navigatorOpen ? start.navigator : 0;
  const maximum = Math.max(260, Math.min(halfWindow, window.innerWidth - navigatorWidth - canvasMinimum - handles));
  return { ...start, agent: clamp(start.agent + delta, 260, maximum) };
}
