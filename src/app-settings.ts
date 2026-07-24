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
