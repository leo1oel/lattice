/**
 * Settings and layout persistence for the app.
 *
 * This module owns the localStorage-backed preferences and layout state that
 * survive between sessions — recent projects, theme, build preferences,
 * split/panel ratios, remembered last-open files, panel open state, and the
 * paper reading width — along with the storage keys and the
 * small `clamp` helper they share. Everything here is pure and free of React or
 * font/panel dependencies, so it can be imported anywhere without pulling in the
 * rest of the app.
 */

import { DEFAULT_UI_FONT, DEFAULT_EDITOR_FONT, EDITOR_FONT_OPTIONS, resolveFontValue } from "./available-fonts";

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
export const SIDEBAR_OPEN_KEY = "lattice.sidebar-open.v1";
export const SIDEBAR_WIDTH_KEY = "lattice.sidebar-width.v1";
export const LAST_FILE_KEY = "lattice.last-file.v1";
export const LAST_FILE_MAX = 60;
export const PAPER_READING_WIDTH_KEY = "lattice.paper-reading-width";
export const WORKSPACE_LAYOUT_KEY = "lattice.workspace-layout.v1";
export const WORKSPACE_LAYOUT_MAX = 60;

export type WorkspaceCanvasMode =
  | "source"
  | "pdf"
  | "split"
  | "dual"
  | "columns"
  | "markdown-preview"
  | "paper"
  | "asset";

export type WorkspaceLayout = {
  openTabs: string[];
  activeFile: string;
  activeTab: string;
  secondaryFile: string | null;
  focusedPane: "primary" | "secondary";
  canvasMode: WorkspaceCanvasMode;
  paperView: "blog" | "fulltext";
  tabRecency: string[];
};

const WORKSPACE_CANVAS_MODES = new Set<WorkspaceCanvasMode>([
  "source",
  "pdf",
  "split",
  "dual",
  "columns",
  "markdown-preview",
  "paper",
  "asset",
]);

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item)))];
}

function normalizeWorkspaceLayout(value: unknown): WorkspaceLayout | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<WorkspaceLayout>;
  const activeFile = typeof candidate.activeFile === "string" ? candidate.activeFile : "";
  const openTabs = stringList(candidate.openTabs);
  const activeTab = typeof candidate.activeTab === "string" && candidate.activeTab
    ? candidate.activeTab
    : activeFile;
  const secondaryFile = typeof candidate.secondaryFile === "string" && candidate.secondaryFile
    ? candidate.secondaryFile
    : null;
  const canvasMode = WORKSPACE_CANVAS_MODES.has(candidate.canvasMode as WorkspaceCanvasMode)
    ? candidate.canvasMode as WorkspaceCanvasMode
    : "split";
  return {
    openTabs,
    activeFile,
    activeTab,
    secondaryFile,
    focusedPane: candidate.focusedPane === "secondary" ? "secondary" : "primary",
    canvasMode,
    paperView: candidate.paperView === "fulltext" ? "fulltext" : "blog",
    tabRecency: stringList(candidate.tabRecency),
  };
}

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

/** The complete editor workspace last used in a project. */
export function loadWorkspaceLayout(root: string): WorkspaceLayout | null {
  try {
    const value = JSON.parse(localStorage.getItem(WORKSPACE_LAYOUT_KEY) ?? "{}") as unknown;
    if (!value || typeof value !== "object") return null;
    return normalizeWorkspaceLayout((value as Record<string, unknown>)[root]);
  } catch {
    return null;
  }
}

export function persistWorkspaceLayout(root: string, layout: WorkspaceLayout) {
  if (!root) return;
  try {
    const stored = JSON.parse(localStorage.getItem(WORKSPACE_LAYOUT_KEY) ?? "{}") as unknown;
    const map = stored && typeof stored === "object"
      ? { ...(stored as Record<string, unknown>) }
      : {};
    delete map[root];
    const entries = [
      ...Object.entries(map),
      [root, normalizeWorkspaceLayout(layout) ?? layout] as [string, WorkspaceLayout],
    ];
    const trimmed = entries.slice(Math.max(0, entries.length - WORKSPACE_LAYOUT_MAX));
    localStorage.setItem(WORKSPACE_LAYOUT_KEY, JSON.stringify(Object.fromEntries(trimmed)));
  } catch {
    // Workspace restoration is a convenience; the current session remains usable.
  }
}

export function loadSidebarOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_OPEN_KEY) !== "0";
  } catch { return true; }
}

export function persistSidebarOpen(open: boolean) {
  try { localStorage.setItem(SIDEBAR_OPEN_KEY, open ? "1" : "0"); } catch { /* session only */ }
}

export function loadSidebarWidth(): number {
  try {
    return clamp(Number(localStorage.getItem(SIDEBAR_WIDTH_KEY)) || 320, 180, 2400);
  } catch { return 320; }
}

export function persistSidebarWidth(width: number) {
  try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width)); } catch { /* session only */ }
}

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

export const APPEARANCE_KEY = "lattice.appearance.v5";
export const LEGACY_APPEARANCE_KEY = "lattice.appearance.v4";
export const MAX_OPEN_TABS = 12;
const OLDER_APPEARANCE_KEY = "lattice.appearance.v3";

export function loadAppearance(): AppearanceSettings {
  const defaults: AppearanceSettings = {
    uiFont: DEFAULT_UI_FONT,
    interfaceScale: 1,
    editorFont: DEFAULT_EDITOR_FONT,
    editorFontSize: 14,
    editorKeymap: "default",
    editorSpellcheck: false,
    maxOpenTabs: 5,
  };
  try {
    const current = localStorage.getItem(APPEARANCE_KEY);
    const legacy = localStorage.getItem(LEGACY_APPEARANCE_KEY)
      ?? localStorage.getItem(OLDER_APPEARANCE_KEY);
    const value = JSON.parse(current ?? legacy ?? "null") as Partial<AppearanceSettings> | null;
    const storedInterfaceScale = clamp(
      Number(value?.interfaceScale) || defaults.interfaceScale,
      0.9,
      1.35,
    );
    return {
      // Keep the field in the persisted shape for backwards compatibility, but
      // normalize every old preference to the bundled application UI face.
      uiFont: defaults.uiFont,
      // v4 shipped with 110% as its implicit default. Migrate that value once,
      // while preserving every other legacy choice and all future v5 choices.
      interfaceScale: current === null && storedInterfaceScale === 1.1
        ? defaults.interfaceScale
        : storedInterfaceScale,
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
      maxOpenTabs: clamp(Math.round(Number(value?.maxOpenTabs) || defaults.maxOpenTabs), 1, MAX_OPEN_TABS),
    };
  } catch {
    return defaults;
  }
}

/**
 * How a project linked to Overleaf stays in step with it.
 *
 * "live" keeps both sides close to current on their own; "manual" leaves every
 * exchange to an explicit press of the sync button, for people who would
 * rather review incoming work the way they would review a pull.
 */
export type OverleafSyncMode = "live" | "manual";

export const OVERLEAF_SYNC_MODE_KEY = "lattice.overleaf.sync-mode.v1";

export function loadOverleafSyncMode(): OverleafSyncMode {
  try {
    return localStorage.getItem(OVERLEAF_SYNC_MODE_KEY) === "manual" ? "manual" : "live";
  } catch {
    return "live";
  }
}

/**
 * What happens to a file on Overleaf when it is deleted here.
 *
 * Deleting from a shared project is not an edit that can be merged away, so
 * the default asks. "never" is what the app did before this existed: the file
 * stays on Overleaf and the two sides quietly differ forever.
 */
export type OverleafRemoteDelete = "never" | "ask" | "always";

export const OVERLEAF_REMOTE_DELETE_KEY = "lattice.overleaf.remote-delete.v1";

export function loadOverleafRemoteDelete(): OverleafRemoteDelete {
  try {
    const stored = localStorage.getItem(OVERLEAF_REMOTE_DELETE_KEY);
    return stored === "never" || stored === "always" ? stored : "ask";
  } catch {
    return "ask";
  }
}

export function persistOverleafRemoteDelete(mode: OverleafRemoteDelete) {
  try {
    localStorage.setItem(OVERLEAF_REMOTE_DELETE_KEY, mode);
  } catch {
    // The choice still applies for this session without storage.
  }
}

export function persistOverleafSyncMode(mode: OverleafSyncMode) {
  try {
    localStorage.setItem(OVERLEAF_SYNC_MODE_KEY, mode);
  } catch {
    // The choice still applies for this session without storage.
  }
}
