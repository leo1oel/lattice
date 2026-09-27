/**
 * Settings and layout persistence for the app.
 *
 * This module owns the localStorage-backed preferences and layout state that
 * survive between sessions — recent projects, theme, build preferences,
 * split/panel ratios, remembered last-open files, panel open state, and the
 * appearance settings. Everything here is pure and free of React or
 * font/panel dependencies, so it can be imported anywhere without pulling in the
 * rest of the app.
 */

import type {
  BoardFileViewState,
  CanvasMode,
  DocumentViewMode,
  FileViewState,
  HtmlFileViewState,
  ImageFileViewState,
  OpenSlideFileViewState,
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

export const FIXED_UI_FONT = '"Inter Variable", Inter, "Avenir Next", "Segoe UI", sans-serif';
const FIXED_EDITOR_FONT = '"Ioskeley Mono", Menlo, "SF Mono", ui-monospace, monospace';

export const RECENT_PROJECTS_KEY = "lattice.recent-projects.v1";
export const THEME_KEY = "lattice.theme.v1";
export const THEME_PREFERENCE_KEY = "lattice.theme-preference.v1";
export const BUILD_PREFERENCES_KEY = "lattice.build-preferences.v2";
const SPLIT_RATIO_KEY = "lattice.split-ratio.v1";
const COLUMNS_PDF_RATIO_KEY = "lattice.columns-pdf-ratio.v1";
const SIDEBAR_OPEN_KEY = "lattice.sidebar-open.v1";
const SIDEBAR_WIDTH_KEY = "lattice.sidebar-width.v1";
const LAST_FILE_KEY = "lattice.last-file.v1";
export const WORKSPACE_LAYOUT_KEY = "lattice.workspace-layout.v1";
export const FILE_VIEW_STATES_KEY = "lattice.file-view-states.v1";
export const TUTORIAL_SEEN_KEY = "lattice.tutorial-seen.v1";
export const LOCAL_SEMANTIC_SEARCH_KEY = "lattice.local-semantic-search.v1";
export const APPEARANCE_KEY = "lattice.appearance.v5";
const LEGACY_APPEARANCE_KEYS = ["lattice.appearance.v4", "lattice.appearance.v3"];
const OVERLEAF_SYNC_MODE_KEY = "lattice.overleaf.sync-mode.v1";
const OVERLEAF_REMOTE_DELETE_KEY = "lattice.overleaf.remote-delete.v1";
/** Per-project maps (last file, workspace layout, file views) keep this many projects. */
const PROJECT_HISTORY_MAX = 60;
const FILE_VIEW_STATE_FILE_MAX = 200;
const RECENT_PROJECTS_MAX = 8;
export const MAX_OPEN_TABS = 12;

// Every preference here is a convenience: when storage is unavailable or holds
// something unreadable, reads fall back to the default and writes last only for
// the current session.
function safely<T>(action: () => T, fallback: T): T {
  try {
    return action();
  } catch {
    return fallback;
  }
}

function store(key: string, value: string): void {
  safely(() => localStorage.setItem(key, value), undefined);
}

function readNumber(key: string, fallback: number, minimum: number, maximum: number): number {
  return safely(() => clamp(Number(localStorage.getItem(key)) || fallback, minimum, maximum), fallback);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

function settingsRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readProjectMap(key: string): Record<string, unknown> {
  return settingsRecord(JSON.parse(localStorage.getItem(key) ?? "{}")) ?? {};
}

/** Re-inserts `root` last, so trimming drops the least recently written project. */
function writeProjectEntry(key: string, root: string, value: unknown, map = readProjectMap(key)): void {
  delete map[root];
  const entries = [...Object.entries(map), [root, value]].slice(-PROJECT_HISTORY_MAX);
  localStorage.setItem(key, JSON.stringify(Object.fromEntries(entries)));
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function loadRecentProjects(): RecentProject[] {
  return safely(() => {
    const value = JSON.parse(localStorage.getItem(RECENT_PROJECTS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is RecentProject => Boolean(
        item && typeof item === "object" && "name" in item && typeof item.name === "string" &&
        "path" in item && typeof item.path === "string",
      ))
      .slice(0, RECENT_PROJECTS_MAX);
  }, []);
}

// Windows share one localStorage, so both of the writers below re-read it
// instead of overwriting with the copy this window happened to load at startup.
// Writing a stale copy back is how a project opened in one window disappeared
// from the other window's list.
function persistRecentProjects(projects: RecentProject[]): RecentProject[] {
  store(RECENT_PROJECTS_KEY, JSON.stringify(projects));
  return projects;
}

/// Record a project as the most recently opened one.
export function rememberRecentProject(entry: RecentProject): RecentProject[] {
  return persistRecentProjects([
    entry,
    ...loadRecentProjects().filter((item) => item.path !== entry.path),
  ].slice(0, RECENT_PROJECTS_MAX));
}

/// Drop a project from the list — it could not be opened.
export function forgetRecentProject(path: string): RecentProject[] {
  return persistRecentProjects(loadRecentProjects().filter((item) => item.path !== path));
}

export function hasSeenTutorial(): boolean {
  return safely(() => {
    if (localStorage.getItem(TUTORIAL_SEEN_KEY) === "1") return true;
    const seenInAnEarlierVersion = loadRecentProjects().some((project) => {
      const path = project.path.replaceAll("\\", "/");
      return project.name === "Understanding Attention"
        && path.includes("/Lattice Tutorials/Understanding Attention");
    });
    if (seenInAnEarlierVersion) localStorage.setItem(TUTORIAL_SEEN_KEY, "1");
    return seenInAnEarlierVersion;
  }, false);
}

export const markTutorialSeen = () => store(TUTORIAL_SEEN_KEY, "1");

/**
 * Semantic indexing is privacy-default, not merely local-default: it remains
 * off until the user explicitly opts in. The production provider is the Mac's
 * built-in sentence model and never sends source text to a network service.
 */
export const loadLocalSemanticSearchEnabled = () =>
  safely(() => localStorage.getItem(LOCAL_SEMANTIC_SEARCH_KEY) === "1", false);
export const persistLocalSemanticSearchEnabled = (enabled: boolean) =>
  store(LOCAL_SEMANTIC_SEARCH_KEY, enabled ? "1" : "0");

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
  return safely(() => oneOf<ThemePreference>(
    localStorage.getItem(THEME_PREFERENCE_KEY),
    ["system", "light", "dark"],
    oneOf<ThemePreference>(localStorage.getItem(THEME_KEY), ["light", "dark"], "system"),
  ), "system");
}

export const persistThemePreference = (preference: ThemePreference) =>
  store(THEME_PREFERENCE_KEY, preference);

export function loadBuildPreferences(): BuildPreferences {
  const stored = safely(() => JSON.parse(localStorage.getItem(BUILD_PREFERENCES_KEY) ?? "null"), null);
  return { autoBuildMode: oneOf<AutoBuildMode>(stored?.autoBuildMode, ["manual"], "automatic") };
}

export const loadSplitRatio = () => readNumber(SPLIT_RATIO_KEY, 0.46, 0.2, 0.8);
export const persistSplitRatio = (ratio: number) => store(SPLIT_RATIO_KEY, String(ratio));
export const loadColumnsPdfRatio = () => readNumber(COLUMNS_PDF_RATIO_KEY, 0.38, 0.22, 0.55);
export const persistColumnsPdfRatio = (ratio: number) => store(COLUMNS_PDF_RATIO_KEY, String(ratio));
export const loadSidebarOpen = () => safely(() => localStorage.getItem(SIDEBAR_OPEN_KEY) !== "0", true);
export const persistSidebarOpen = (open: boolean) => store(SIDEBAR_OPEN_KEY, open ? "1" : "0");
export const loadSidebarWidth = () => readNumber(SIDEBAR_WIDTH_KEY, 320, 180, 2400);
export const persistSidebarWidth = (width: number) => store(SIDEBAR_WIDTH_KEY, String(width));

// Unlike the other per-project maps, an unreadable last-file map is replaced
// on the next write rather than preserved.
const loadLastFiles = () => safely(() => readProjectMap(LAST_FILE_KEY), {});

/** The file the user last had open in a given project, if remembered. */
export function loadLastFile(root: string): string | null {
  const value = loadLastFiles()[root];
  return typeof value === "string" && value ? value : null;
}

export function persistLastFile(root: string, path: string) {
  const map = loadLastFiles();
  // Non-fatal: reopening simply falls back to the root document.
  if (map[root] !== path) safely(() => writeProjectEntry(LAST_FILE_KEY, root, path, map), undefined);
}

export type WorkspaceLayout = {
  openTabs: string[];
  pinnedTabs?: string[];
  activeFile: string;
  activeTab: string;
  secondaryFile: string | null;
  focusedPane: "primary" | "secondary";
  canvasMode: CanvasMode;
  documentMode: DocumentViewMode;
  paperView: "blog" | "fulltext";
  tabRecency: string[];
};

const CANVAS_MODES: readonly CanvasMode[] = ["source", "pdf", "split", "dual", "columns", "asset"];
const DOCUMENT_MODES = CANVAS_MODES.filter((mode): mode is DocumentViewMode => mode !== "asset");
// Retired modes and what replaced them: the Markdown and paper previews merged
// into the unified preview, and the three-column layout became two editor panes.
const RETIRED_CANVAS_MODES = new Map<unknown, CanvasMode>([
  ["markdown-preview", "pdf"],
  ["paper", "pdf"],
  ["columns", "dual"],
]);

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item)))];
}

function normalizeWorkspaceLayout(value: unknown): WorkspaceLayout | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const activeFile = typeof candidate.activeFile === "string" ? candidate.activeFile : "";
  const openTabs = stringList(candidate.openTabs);
  const canvasMode = RETIRED_CANVAS_MODES.get(candidate.canvasMode)
    ?? oneOf(candidate.canvasMode, CANVAS_MODES, "split");
  const documentMode = candidate.documentMode === "columns"
    ? "dual"
    : oneOf(candidate.documentMode, DOCUMENT_MODES, canvasMode === "asset" ? "split" : canvasMode);
  return {
    openTabs,
    pinnedTabs: stringList(candidate.pinnedTabs).filter((path) => openTabs.includes(path)),
    activeFile,
    activeTab: typeof candidate.activeTab === "string" && candidate.activeTab ? candidate.activeTab : activeFile,
    secondaryFile: typeof candidate.secondaryFile === "string" && candidate.secondaryFile
      ? candidate.secondaryFile
      : null,
    focusedPane: oneOf(candidate.focusedPane, ["secondary"], "primary"),
    canvasMode,
    documentMode,
    paperView: oneOf(candidate.paperView, ["fulltext"], "blog"),
    tabRecency: stringList(candidate.tabRecency),
  };
}

/** The complete editor workspace last used in a project. */
export function loadWorkspaceLayout(root: string): WorkspaceLayout | null {
  return safely(() => normalizeWorkspaceLayout(readProjectMap(WORKSPACE_LAYOUT_KEY)[root]), null);
}

export function persistWorkspaceLayout(root: string, layout: WorkspaceLayout) {
  if (!root) return;
  // Workspace restoration is a convenience; the current session remains usable.
  safely(() => writeProjectEntry(WORKSPACE_LAYOUT_KEY, root, normalizeWorkspaceLayout(layout) ?? layout), undefined);
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

function normalizeOpenSlideFileViewState(value: unknown): OpenSlideFileViewState | null {
  const page = finiteNumber(settingsRecord(value)?.page);
  return page !== null && page >= 1 ? { page: Math.floor(page) } : null;
}

function normalizeTextFileViewState(value: unknown): FileViewState["text"] | null {
  const text = settingsRecord(value);
  const cursor = finiteNumber(text?.cursor);
  const scrollTop = finiteNumber(text?.scrollTop);
  return cursor !== null && cursor >= 0 && scrollTop !== null && scrollTop >= 0
    ? { cursor: Math.floor(cursor), scrollTop }
    : null;
}

const FILE_VIEW_NORMALIZERS: { [Kind in keyof FileViewState]-?: (value: unknown) => FileViewState[Kind] | null } = {
  text: normalizeTextFileViewState,
  spreadsheet: normalizeSpreadsheetFileViewState,
  pdf: normalizePdfFileViewState,
  board: normalizeBoardFileViewState,
  image: normalizeImageFileViewState,
  html: normalizeHtmlFileViewState,
  openSlide: normalizeOpenSlideFileViewState,
  visualMarkdown: normalizeScrollFileViewState,
};

/** Keeps each view kind that still validates, so one corrupt field spares its siblings. */
function normalizeFileViewState(value: unknown): FileViewState | null {
  const candidate = settingsRecord(value);
  if (!candidate) return null;
  const normalized = Object.fromEntries(Object.entries(FILE_VIEW_NORMALIZERS).flatMap(([kind, normalize]) => {
    const state = normalize(candidate[kind]);
    return state ? [[kind, state]] : [];
  })) as FileViewState;
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeFileViewStates(states: unknown): Record<string, FileViewState> {
  return Object.fromEntries(Object.entries(settingsRecord(states) ?? {}).flatMap(([path, state]) => {
    const normalized = normalizeFileViewState(state);
    return path && normalized ? [[path, normalized]] : [];
  }).slice(-FILE_VIEW_STATE_FILE_MAX));
}

/** Local, per-user view state for files in one project. */
export function loadFileViewStates(root: string): Record<string, FileViewState> {
  if (!root) return {};
  return safely(() => normalizeFileViewStates(readProjectMap(FILE_VIEW_STATES_KEY)[root]), {});
}

export function persistFileViewStates(root: string, states: Record<string, FileViewState>): void {
  if (!root) return;
  // View restoration is a convenience; editing remains available without storage.
  safely(() => writeProjectEntry(FILE_VIEW_STATES_KEY, root, normalizeFileViewStates(states)), undefined);
}

export type AppearanceSettings = {
  interfaceLanguage: InterfaceLanguage;
  uiFont: string;
  interfaceScale: number;
  editorFont: string;
  editorFontSize: number;
  editorKeymap: "default" | "vim" | "emacs";
  editorSpellcheck: boolean;
  interfaceSounds: boolean;
  maxOpenTabs: number;
};

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
  // `navigator.languages` is ordered by preference. Falling through the whole
  // list made a secondary Chinese input/reading language override an English
  // system language; only the system's first preference chooses the UI locale.
  const normalized = languages[0]?.toLowerCase() ?? "";
  return normalized === "zh" || normalized.startsWith("zh-")
    ? "zh-CN"
    : "en";
}

export function loadAppearance(): AppearanceSettings {
  const defaults: AppearanceSettings = {
    interfaceLanguage: "system",
    uiFont: FIXED_UI_FONT,
    interfaceScale: 1,
    editorFont: FIXED_EDITOR_FONT,
    editorFontSize: 14,
    editorKeymap: "default",
    editorSpellcheck: true,
    interfaceSounds: true,
    maxOpenTabs: 5,
  };
  return safely(() => {
    const current = localStorage.getItem(APPEARANCE_KEY);
    const legacy = LEGACY_APPEARANCE_KEYS.map((key) => localStorage.getItem(key)).find((value) => value !== null);
    const value = JSON.parse(current ?? legacy ?? "null") as Partial<AppearanceSettings> | null;
    const storedInterfaceScale = clamp(Number(value?.interfaceScale) || defaults.interfaceScale, 0.9, 1.35);
    return {
      interfaceLanguage: oneOf(value?.interfaceLanguage, ["en", "zh-CN"], defaults.interfaceLanguage),
      // Keep the field in the persisted shape for backwards compatibility, but
      // normalize every old preference to the bundled application UI face.
      uiFont: defaults.uiFont,
      // v4 shipped with 110% as its implicit default. Migrate that value once,
      // while preserving every other legacy choice and all future v5 choices.
      interfaceScale: current === null && storedInterfaceScale === 1.1
        ? defaults.interfaceScale
        : storedInterfaceScale,
      editorFont: defaults.editorFont,
      editorFontSize: clamp(Number(value?.editorFontSize) || defaults.editorFontSize, 10, 24),
      editorKeymap: oneOf(value?.editorKeymap, ["vim", "emacs"], defaults.editorKeymap),
      // Absent means "never chose", which now inherits the on-by-default
      // behavior; only an explicit false keeps Harper quiet. Harper reports
      // lints on Latin-letter spans only (see harper-spellcheck.ts), so
      // non-English prose sees nothing from it.
      editorSpellcheck: value?.editorSpellcheck !== false,
      interfaceSounds: value?.interfaceSounds !== false,
      maxOpenTabs: clamp(Math.round(Number(value?.maxOpenTabs) || defaults.maxOpenTabs), 1, MAX_OPEN_TABS),
    };
  }, defaults);
}

export const persistAppearance = (appearance: AppearanceSettings) =>
  store(APPEARANCE_KEY, JSON.stringify(appearance));

/**
 * How a project linked to Overleaf stays in step with it.
 *
 * "live" keeps both sides close to current on their own; "manual" leaves every
 * exchange to an explicit press of the sync button, for people who would
 * rather review incoming work the way they would review a pull.
 */
export type OverleafSyncMode = "live" | "manual";

/**
 * What happens to a file on Overleaf when it is deleted here.
 *
 * Deleting from a shared project is not an edit that can be merged away, so
 * the default asks. "never" is what the app did before this existed: the file
 * stays on Overleaf and the two sides quietly differ forever.
 */
export type OverleafRemoteDelete = "never" | "ask" | "always";

export const loadOverleafSyncMode = () =>
  safely(() => oneOf<OverleafSyncMode>(localStorage.getItem(OVERLEAF_SYNC_MODE_KEY), ["manual"], "live"), "live");
export const persistOverleafSyncMode = (mode: OverleafSyncMode) => store(OVERLEAF_SYNC_MODE_KEY, mode);
export const loadOverleafRemoteDelete = () => safely(
  () => oneOf<OverleafRemoteDelete>(localStorage.getItem(OVERLEAF_REMOTE_DELETE_KEY), ["never", "always"], "ask"),
  "ask",
);
export const persistOverleafRemoteDelete = (mode: OverleafRemoteDelete) => store(OVERLEAF_REMOTE_DELETE_KEY, mode);
