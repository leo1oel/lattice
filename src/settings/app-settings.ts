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
import type {
  BoardFileViewState,
  FileViewState,
  HtmlFileViewState,
  ImageFileViewState,
  PdfFileViewState,
  ScrollFileViewState,
  SpreadsheetFileViewState,
} from "../app-types";

export type Theme = "light" | "dark";
/** What the user picked; `system` tracks the OS appearance as it changes. */
export type ThemePreference = "system" | Theme;
export type AppLocale = "en" | "zh-CN";
export type InterfaceLanguage = "system" | AppLocale;
export type RecentProject = { name: string; path: string };
export type AutoBuildMode = "manual" | "automatic";
export type BuildPreferences = { autoBuildMode: AutoBuildMode };
export type PaperReadingWidth = "comfortable" | "wide";

export const RECENT_PROJECTS_KEY = "lattice.recent-projects.v1";
export const THEME_KEY = "lattice.theme.v1";
export const THEME_PREFERENCE_KEY = "lattice.theme-preference.v1";
export const BUILD_PREFERENCES_KEY = "lattice.build-preferences.v2";
const SPLIT_RATIO_KEY = "lattice.split-ratio.v1";
const COLUMNS_PDF_RATIO_KEY = "lattice.columns-pdf-ratio.v1";
const SIDEBAR_OPEN_KEY = "lattice.sidebar-open.v1";
const SIDEBAR_WIDTH_KEY = "lattice.sidebar-width.v1";
const LAST_FILE_KEY = "lattice.last-file.v1";
const LAST_FILE_MAX = 60;
export const PAPER_READING_WIDTH_KEY = "lattice.paper-reading-width";
export const WORKSPACE_LAYOUT_KEY = "lattice.workspace-layout.v1";
const WORKSPACE_LAYOUT_MAX = 60;
export const FILE_VIEW_STATES_KEY = "lattice.file-view-states.v1";
const FILE_VIEW_STATE_PROJECT_MAX = 60;
const FILE_VIEW_STATE_FILE_MAX = 200;
export const TUTORIAL_SEEN_KEY = "lattice.tutorial-seen.v1";
export const LOCAL_SEMANTIC_SEARCH_KEY = "lattice.local-semantic-search.v1";

type WorkspaceCanvasMode =
  | "source"
  | "pdf"
  | "split"
  | "dual"
  | "columns"
  | "asset";

export type WorkspaceLayout = {
  openTabs: string[];
  activeFile: string;
  activeTab: string;
  secondaryFile: string | null;
  focusedPane: "primary" | "secondary";
  canvasMode: WorkspaceCanvasMode;
  documentMode: Exclude<WorkspaceCanvasMode, "asset">;
  paperView: "blog" | "fulltext";
  tabRecency: string[];
};

const WORKSPACE_CANVAS_MODES = new Set<WorkspaceCanvasMode>([
  "source",
  "pdf",
  "split",
  "dual",
  "columns",
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
  const storedCanvasModeValue = (candidate as { canvasMode?: unknown }).canvasMode;
  const storedCanvasMode = typeof storedCanvasModeValue === "string" ? storedCanvasModeValue : "";
  const canvasMode: WorkspaceCanvasMode = storedCanvasMode === "markdown-preview" || storedCanvasMode === "paper"
    ? "pdf"
    : storedCanvasMode === "columns"
      ? "dual"
    : WORKSPACE_CANVAS_MODES.has(storedCanvasMode as WorkspaceCanvasMode)
      ? storedCanvasMode as WorkspaceCanvasMode
      : "split";
  const storedDocumentModeValue = (candidate as { documentMode?: unknown }).documentMode;
  const storedDocumentMode = typeof storedDocumentModeValue === "string"
    ? storedDocumentModeValue
    : "";
  const documentMode = storedDocumentMode === "columns"
    ? "dual"
    : WORKSPACE_CANVAS_MODES.has(storedDocumentMode as WorkspaceCanvasMode)
    && storedDocumentMode !== "asset"
    ? storedDocumentMode as Exclude<WorkspaceCanvasMode, "asset">
    : canvasMode === "asset"
      ? "split"
      : canvasMode;
  return {
    openTabs,
    activeFile,
    activeTab,
    secondaryFile,
    focusedPane: candidate.focusedPane === "secondary" ? "secondary" : "primary",
    canvasMode,
    documentMode,
    paperView: candidate.paperView === "fulltext" ? "fulltext" : "blog",
    tabRecency: stringList(candidate.tabRecency),
  };
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
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

function persistRecentProjects(projects: RecentProject[]) {
  try {
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(projects));
  } catch {
    // Recent projects are a convenience; project access still works if storage is unavailable.
  }
}

// Windows share one localStorage, so both of the writers below re-read it
// instead of overwriting with the copy this window happened to load at startup.
// Writing a stale copy back is how a project opened in one window disappeared
// from the other window's list.

/// Record a project as the most recently opened one.
export function rememberRecentProject(entry: RecentProject): RecentProject[] {
  const next = [
    entry,
    ...loadRecentProjects().filter((item) => item.path !== entry.path),
  ].slice(0, 8);
  persistRecentProjects(next);
  return next;
}

/// Drop a project from the list — it could not be opened.
export function forgetRecentProject(path: string): RecentProject[] {
  const next = loadRecentProjects().filter((item) => item.path !== path);
  persistRecentProjects(next);
  return next;
}

export function hasSeenTutorial(): boolean {
  try {
    if (localStorage.getItem(TUTORIAL_SEEN_KEY) === "1") return true;
    const seenInAnEarlierVersion = loadRecentProjects().some((project) => {
      const path = project.path.replaceAll("\\", "/");
      return project.name === "Understanding Attention"
        && path.includes("/Lattice Tutorials/Understanding Attention");
    });
    if (seenInAnEarlierVersion) localStorage.setItem(TUTORIAL_SEEN_KEY, "1");
    return seenInAnEarlierVersion;
  } catch {
    return false;
  }
}

export function markTutorialSeen() {
  try {
    localStorage.setItem(TUTORIAL_SEEN_KEY, "1");
  } catch {
    // The tutorial still works for this session when preferences cannot persist.
  }
}

/**
 * Semantic indexing is privacy-default, not merely local-default: it remains
 * off until the user explicitly opts in. The production provider is the Mac's
 * built-in sentence model and never sends source text to a network service.
 */
export function loadLocalSemanticSearchEnabled(): boolean {
  try {
    return localStorage.getItem(LOCAL_SEMANTIC_SEARCH_KEY) === "1";
  } catch {
    return false;
  }
}

export function persistLocalSemanticSearchEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(LOCAL_SEMANTIC_SEARCH_KEY, enabled ? "1" : "0");
  } catch {
    // The explicit choice still applies for this session without storage.
  }
}

export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

export function systemTheme(): Theme {
  return window.matchMedia(SYSTEM_DARK_QUERY).matches ? "dark" : "light";
}

/**
 * Fresh installs follow the OS appearance. Builds before the `system` option
 * existed persisted a resolved light/dark value on every launch, so that older
 * key is migrated as an explicit choice rather than dropped — flipping those
 * users to `system` could change the appearance they have been looking at.
 */
export function loadThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_PREFERENCE_KEY);
    if (stored === "system" || stored === "light" || stored === "dark") return stored;
    const legacy = localStorage.getItem(THEME_KEY);
    if (legacy === "light" || legacy === "dark") return legacy;
  } catch {
    // Fall through to the system preference when storage is unavailable.
  }
  return "system";
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

function loadLastFileMap(): Record<string, string> {
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

function settingsRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeScrollFileViewState(value: unknown): ScrollFileViewState | null {
  const candidate = settingsRecord(value);
  const scrollTop = finiteNumber(candidate?.scrollTop);
  if (scrollTop === null || scrollTop < 0) return null;
  const scrollLeft = finiteNumber(candidate?.scrollLeft);
  const scrollRange = finiteNumber(candidate?.scrollRange);
  return {
    scrollTop,
    ...(scrollLeft !== null && scrollLeft >= 0 ? { scrollLeft } : {}),
    ...(scrollRange !== null && scrollRange >= 0 ? { scrollRange } : {}),
  };
}

function normalizeSpreadsheetFileViewState(value: unknown): SpreadsheetFileViewState | null {
  const candidate = settingsRecord(value);
  if (!candidate || typeof candidate.activeSheetId !== "string" || !candidate.activeSheetId) return null;
  const rawSheets = settingsRecord(candidate.sheets);
  if (!rawSheets) return null;
  const sheets = Object.fromEntries(Object.entries(rawSheets).flatMap(([sheetId, rawSheet]) => {
    const sheet = settingsRecord(rawSheet);
    const zoomRatio = finiteNumber(sheet?.zoomRatio);
    const scrollTop = finiteNumber(sheet?.scrollTop);
    const scrollLeft = finiteNumber(sheet?.scrollLeft);
    return sheetId && zoomRatio !== null && zoomRatio > 0
      && scrollTop !== null && scrollTop >= 0
      && scrollLeft !== null && scrollLeft >= 0
      ? [[sheetId, { zoomRatio, scrollTop, scrollLeft }]]
      : [];
  }).slice(-100));
  return {
    activeSheetId: candidate.activeSheetId,
    ...(typeof candidate.activeRange === "string" ? { activeRange: candidate.activeRange } : {}),
    ...(typeof candidate.activeCell === "string" ? { activeCell: candidate.activeCell } : {}),
    sheets,
  };
}

function normalizePdfFileViewState(value: unknown): PdfFileViewState | null {
  const candidate = settingsRecord(value);
  const page = finiteNumber(candidate?.page);
  const scale = finiteNumber(candidate?.scale);
  const scrollTop = finiteNumber(candidate?.scrollTop);
  const scrollLeft = finiteNumber(candidate?.scrollLeft);
  const fitMode = candidate?.fitMode === "width" || candidate?.fitMode === "height" || candidate?.fitMode === null
    ? candidate.fitMode
    : undefined;
  if (page === null || page < 1 || scale === null || scale <= 0 || fitMode === undefined
    || scrollTop === null || scrollTop < 0 || scrollLeft === null || scrollLeft < 0) return null;
  return { page: Math.floor(page), scale, fitMode, scrollTop, scrollLeft };
}

function normalizeBoardFileViewState(value: unknown): BoardFileViewState | null {
  const candidate = settingsRecord(value);
  const camera = settingsRecord(candidate?.camera);
  const x = finiteNumber(camera?.x);
  const y = finiteNumber(camera?.y);
  const z = finiteNumber(camera?.z);
  if (!candidate || typeof candidate.pageId !== "string" || !candidate.pageId
    || x === null || y === null || z === null || z <= 0) return null;
  return { pageId: candidate.pageId, camera: { x, y, z } };
}

function normalizeImageFileViewState(value: unknown): ImageFileViewState | null {
  const scroll = normalizeScrollFileViewState(value);
  const scale = finiteNumber(settingsRecord(value)?.scale);
  return scroll && scale !== null && scale > 0 ? { ...scroll, scale } : null;
}

function normalizeHtmlFileViewState(value: unknown): HtmlFileViewState | null {
  const scroll = normalizeScrollFileViewState(value);
  const candidate = settingsRecord(value);
  const scale = finiteNumber(candidate?.scale);
  if (!scroll || (candidate?.scale !== undefined && (scale === null || scale <= 0))) return null;
  return { ...scroll, scale: scale ?? 1 };
}

function normalizeFileViewState(value: unknown): FileViewState | null {
  const candidate = settingsRecord(value);
  if (!candidate) return null;
  const text = settingsRecord(candidate.text);
  const cursor = finiteNumber(text?.cursor);
  const textScrollTop = finiteNumber(text?.scrollTop);
  const spreadsheet = normalizeSpreadsheetFileViewState(candidate.spreadsheet);
  const pdf = normalizePdfFileViewState(candidate.pdf);
  const board = normalizeBoardFileViewState(candidate.board);
  const image = normalizeImageFileViewState(candidate.image);
  const html = normalizeHtmlFileViewState(candidate.html);
  const visualMarkdown = normalizeScrollFileViewState(candidate.visualMarkdown);
  const normalized: FileViewState = {
    ...(cursor !== null && cursor >= 0 && textScrollTop !== null && textScrollTop >= 0
      ? { text: { cursor: Math.floor(cursor), scrollTop: textScrollTop } }
      : {}),
    ...(spreadsheet ? { spreadsheet } : {}),
    ...(pdf ? { pdf } : {}),
    ...(board ? { board } : {}),
    ...(image ? { image } : {}),
    ...(html ? { html } : {}),
    ...(visualMarkdown ? { visualMarkdown } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : null;
}

/** Local, per-user view state for files in one project. */
export function loadFileViewStates(root: string): Record<string, FileViewState> {
  if (!root) return {};
  try {
    const stored = settingsRecord(JSON.parse(localStorage.getItem(FILE_VIEW_STATES_KEY) ?? "{}"));
    const projectStates = settingsRecord(stored?.[root]);
    if (!projectStates) return {};
    return Object.fromEntries(Object.entries(projectStates).flatMap(([path, state]) => {
      const normalized = normalizeFileViewState(state);
      return path && normalized ? [[path, normalized]] : [];
    }).slice(-FILE_VIEW_STATE_FILE_MAX));
  } catch {
    return {};
  }
}

export function persistFileViewStates(root: string, states: Record<string, FileViewState>): void {
  if (!root) return;
  try {
    const stored = settingsRecord(JSON.parse(localStorage.getItem(FILE_VIEW_STATES_KEY) ?? "{}")) ?? {};
    const normalizedStates = Object.fromEntries(Object.entries(states).flatMap(([path, state]) => {
      const normalized = normalizeFileViewState(state);
      return path && normalized ? [[path, normalized]] : [];
    }).slice(-FILE_VIEW_STATE_FILE_MAX));
    delete stored[root];
    const projects = [...Object.entries(stored), [root, normalizedStates] as [string, typeof normalizedStates]]
      .slice(-FILE_VIEW_STATE_PROJECT_MAX);
    localStorage.setItem(FILE_VIEW_STATES_KEY, JSON.stringify(Object.fromEntries(projects)));
  } catch {
    // View restoration is a convenience; editing remains available without storage.
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
  interfaceLanguage: InterfaceLanguage;
  uiFont: string;
  interfaceScale: number;
  editorFont: string;
  editorFontSize: number;
  editorKeymap: EditorKeymap;
  editorSpellcheck: boolean;
  interfaceSounds: boolean;
  maxOpenTabs: number;
};

export const APPEARANCE_KEY = "lattice.appearance.v5";
const LEGACY_APPEARANCE_KEY = "lattice.appearance.v4";
export const MAX_OPEN_TABS = 12;
const OLDER_APPEARANCE_KEY = "lattice.appearance.v3";

export function resolveAppLocale(
  preference: InterfaceLanguage,
  systemLanguages?: readonly string[],
): AppLocale {
  if (preference !== "system") return preference;
  const languages = systemLanguages ?? (typeof navigator === "undefined"
    ? []
    : navigator.languages.length > 0
      ? navigator.languages
      : [navigator.language]);
  return languages.some((language) => {
    const normalized = language.toLowerCase();
    return normalized === "zh" || normalized.startsWith("zh-");
  })
    ? "zh-CN"
    : "en";
}

export function loadAppearance(): AppearanceSettings {
  const defaults: AppearanceSettings = {
    interfaceLanguage: "system",
    uiFont: DEFAULT_UI_FONT,
    interfaceScale: 1,
    editorFont: DEFAULT_EDITOR_FONT,
    editorFontSize: 14,
    editorKeymap: "default",
    editorSpellcheck: true,
    interfaceSounds: true,
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
      interfaceLanguage: value?.interfaceLanguage === "en" || value?.interfaceLanguage === "zh-CN"
        ? value.interfaceLanguage
        : "system",
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
      // Absent means "never chose", which now inherits the on-by-default
      // behavior; only an explicit false keeps Harper quiet. Harper reports
      // lints on Latin-letter spans only (see harper-spellcheck.ts), so
      // non-English prose sees nothing from it.
      editorSpellcheck: value?.editorSpellcheck !== false,
      interfaceSounds: value?.interfaceSounds !== false,
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

const OVERLEAF_SYNC_MODE_KEY = "lattice.overleaf.sync-mode.v1";

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

const OVERLEAF_REMOTE_DELETE_KEY = "lattice.overleaf.remote-delete.v1";

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
