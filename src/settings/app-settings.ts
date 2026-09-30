/**
 * The localStorage-backed preferences and layout state that survive between
 * sessions. Pure and free of React or font/panel dependencies, so it can be
 * imported anywhere without pulling in the rest of the app.
 */

import type { CanvasMode, DocumentViewMode, FileViewState } from "../app-types";

export type Theme = "light" | "dark";
/** What the user picked; `system` tracks the OS appearance as it changes. */
export type ThemePreference = "system" | Theme;
export type AppLocale = "en" | "zh-CN";
export type InterfaceLanguage = "system" | AppLocale;
export type RecentProject = { name: string; path: string };
type AutoBuildMode = "manual" | "automatic";
export type BuildPreferences = { autoBuildMode: AutoBuildMode };

/* eslint-disable lingui/no-unlocalized-strings -- CSS font stacks */
export const FIXED_UI_FONT = '"Inter Variable", Inter, "Avenir Next", "Segoe UI", sans-serif';
const FIXED_EDITOR_FONT = '"Ioskeley Mono", Menlo, "SF Mono", ui-monospace, monospace';
/* eslint-enable lingui/no-unlocalized-strings */

export const RECENT_PROJECTS_KEY = "lattice.recent-projects.v1";
export const THEME_KEY = "lattice.theme.v1";
export const THEME_PREFERENCE_KEY = "lattice.theme-preference.v1";
export const BUILD_PREFERENCES_KEY = "lattice.build-preferences.v2";
const SPLIT_RATIO_KEY = "lattice.split-ratio.v1";
const LAST_FILE_KEY = "lattice.last-file.v1";
export const WORKSPACE_LAYOUT_KEY = "lattice.workspace-layout.v1";
export const FILE_VIEW_STATES_KEY = "lattice.file-view-states.v1";
export const TUTORIAL_SEEN_KEY = "lattice.tutorial-seen.v1";
export const APPEARANCE_KEY = "lattice.appearance.v5";
const LEGACY_APPEARANCE_KEYS = ["lattice.appearance.v4", "lattice.appearance.v3"];
const OVERLEAF_SYNC_MODE_KEY = "lattice.overleaf.sync-mode.v1";
const OVERLEAF_REMOTE_DELETE_KEY = "lattice.overleaf.remote-delete.v1";
/** Per-project maps (last file, workspace layout, file views) keep this many projects. */
const PROJECT_HISTORY_MAX = 60;
const FILE_VIEW_STATE_FILE_MAX = 200;
const RECENT_PROJECTS_MAX = 8;

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

export function persistSetting(key: string, value: string): void {
  safely(() => localStorage.setItem(key, value), undefined);
}

function readNumber(key: string, fallback: number, minimum: number, maximum: number): number {
  return safely(() => clamp(Number(localStorage.getItem(key)) || fallback, minimum, maximum), fallback);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

/** A string preference: anything unrecognized, or storage that cannot be read, yields `fallback`. */
export function loadChoice<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  return safely(() => oneOf(localStorage.getItem(key), allowed, fallback), fallback);
}

function settingsRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
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
  persistSetting(RECENT_PROJECTS_KEY, JSON.stringify(projects));
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
        // eslint-disable-next-line lingui/no-unlocalized-strings -- on-disk path of the tutorial project
        && path.includes("/Lattice Tutorials/Understanding Attention");
    });
    if (seenInAnEarlierVersion) localStorage.setItem(TUTORIAL_SEEN_KEY, "1");
    return seenInAnEarlierVersion;
  }, false);
}

export const markTutorialSeen = () => persistSetting(TUTORIAL_SEEN_KEY, "1");

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
  const legacy = loadChoice<ThemePreference>(THEME_KEY, ["light", "dark"], "system");
  return loadChoice(THEME_PREFERENCE_KEY, ["system", "light", "dark"], legacy);
}

export const persistThemePreference = (preference: ThemePreference) =>
  persistSetting(THEME_PREFERENCE_KEY, preference);

export function loadBuildPreferences(): BuildPreferences {
  const stored = safely(() => JSON.parse(localStorage.getItem(BUILD_PREFERENCES_KEY) ?? "null"), null);
  return { autoBuildMode: oneOf<AutoBuildMode>(stored?.autoBuildMode, ["manual"], "automatic") };
}

export const loadSplitRatio = () => readNumber(SPLIT_RATIO_KEY, 0.46, 0.2, 0.8);
export const persistSplitRatio = (ratio: number) => persistSetting(SPLIT_RATIO_KEY, String(ratio));

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

const CANVAS_MODES: readonly CanvasMode[] = ["source", "pdf", "split", "asset"];
const DOCUMENT_MODES = CANVAS_MODES.filter((mode): mode is DocumentViewMode => mode !== "asset");
// Retired modes and what replaced them: the Markdown and paper previews merged
// into the unified preview, and the two-editor view (and the three-column
// layout before it) became the plain editor, since each document has its own
// panel now.
const RETIRED_CANVAS_MODES = new Map<unknown, DocumentViewMode>([
  ["markdown-preview", "pdf"],
  ["paper", "pdf"],
  ["columns", "source"],
  ["dual", "source"],
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
  const documentMode = RETIRED_CANVAS_MODES.get(candidate.documentMode)
    ?? oneOf(candidate.documentMode, DOCUMENT_MODES, canvasMode === "asset" ? "split" : canvasMode);
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

/** A stored field's normalized value, or undefined when it is missing or unusable. */
type Field = { (value: unknown): unknown; optional?: boolean };
type Shape = Record<string, Field>;

/** A field whose missing or unusable value is left out instead of rejecting the record. */
const optional = (field: Field): Field => Object.assign((value: unknown) => field(value), { optional: true });

/** Normalizes the fields in `fields` order, which is also the persisted key order. */
const shape = (fields: Shape): Field => (value) => {
  const candidate = settingsRecord(value);
  if (!candidate) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    const normalized = field(candidate[key]);
    if (normalized !== undefined) result[key] = normalized;
    else if (!field.optional) return undefined;
  }
  return result;
};

const finiteWhere = (accept: (value: number) => boolean, floor = false): Field => (value) =>
  typeof value === "number" && Number.isFinite(value) && accept(value) ? (floor ? Math.floor(value) : value) : undefined;
const finite = finiteWhere(() => true);
const nonNegative = finiteWhere((value) => value >= 0);
const positive = finiteWhere((value) => value > 0);
const pageNumber = finiteWhere((value) => value >= 1, true);
const text: Field = (value) => typeof value === "string" ? value : undefined;
const nonEmptyText: Field = (value) => typeof value === "string" && value ? value : undefined;

const SCROLL: Shape = { scrollTop: nonNegative, scrollLeft: optional(nonNegative), scrollRange: optional(nonNegative) };
const spreadsheetSheet = shape({ zoomRatio: positive, scrollTop: nonNegative, scrollLeft: nonNegative });

/** Keeps the last 100 sheets that still validate. */
const spreadsheetSheets: Field = (value) => {
  const sheets = settingsRecord(value);
  return sheets ? Object.fromEntries(Object.entries(sheets).flatMap(([sheetId, sheet]) => {
    const normalized = spreadsheetSheet(sheet);
    return sheetId && normalized ? [[sheetId, normalized]] : [];
  }).slice(-100)) : undefined;
};

const FILE_VIEW_SHAPES: Record<keyof FileViewState, Field> = {
  text: shape({ cursor: finiteWhere((value) => value >= 0, true), scrollTop: nonNegative }),
  spreadsheet: shape({ activeSheetId: nonEmptyText, activeRange: optional(text), activeCell: optional(text), sheets: spreadsheetSheets }),
  pdf: shape({
    page: pageNumber,
    scale: positive,
    fitMode: (value) => value === "width" || value === "height" || value === null ? value : undefined,
    scrollTop: nonNegative,
    scrollLeft: nonNegative,
  }),
  board: shape({ pageId: nonEmptyText, camera: shape({ x: finite, y: finite, z: positive }) }),
  image: shape({ ...SCROLL, scale: positive }),
  // Older HTML views were saved before zoom existed; they open at 100%.
  html: shape({ ...SCROLL, scale: (value) => value === undefined ? 1 : positive(value) }),
  openSlide: shape({ page: pageNumber }),
  visualMarkdown: shape(SCROLL),
};

/** Keeps each view kind that still validates, so one corrupt field spares its siblings. */
function normalizeFileViewState(value: unknown): FileViewState | null {
  const candidate = settingsRecord(value);
  if (!candidate) return null;
  const normalized = Object.fromEntries(Object.entries(FILE_VIEW_SHAPES).flatMap(([kind, normalize]) => {
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
  /** Title-bar tool buttons the writer chose to hide (Settings → Appearance). */
  hiddenTitlebarTools: TitlebarTool[];
};

/** The tool buttons at the right of the title bar, each of which can be hidden. */
const TITLEBAR_TOOLS = ["comments", "overleaf", "paper-lookup", "git", "history"] as const;
export type TitlebarTool = typeof TITLEBAR_TOOLS[number];

export function resolveAppLocale(preference: InterfaceLanguage, systemLanguages?: readonly string[]): AppLocale {
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
  // eslint-disable-next-line lingui/no-unlocalized-strings -- locale code
  return normalized === "zh" || normalized.startsWith("zh-") ? "zh-CN" : "en";
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
    hiddenTitlebarTools: [],
  };
  return safely(() => {
    const current = localStorage.getItem(APPEARANCE_KEY);
    const legacy = LEGACY_APPEARANCE_KEYS.map((key) => localStorage.getItem(key)).find((value) => value !== null);
    const value = JSON.parse(current ?? legacy ?? "null") as Partial<AppearanceSettings> | null;
    const storedInterfaceScale = clamp(Number(value?.interfaceScale) || defaults.interfaceScale, 0.9, 1.35);
    return {
      // eslint-disable-next-line lingui/no-unlocalized-strings -- locale codes
      interfaceLanguage: oneOf(value?.interfaceLanguage, ["en", "zh-CN"], defaults.interfaceLanguage),
      // Keep the field in the persisted shape for backwards compatibility, but
      // normalize every old preference to the bundled application UI face.
      uiFont: defaults.uiFont,
      // v4 shipped with 110% as its implicit default. Migrate that value once,
      // while preserving every other legacy choice and all future v5 choices.
      interfaceScale: current === null && storedInterfaceScale === 1.1 ? defaults.interfaceScale : storedInterfaceScale,
      editorFont: defaults.editorFont,
      editorFontSize: clamp(Number(value?.editorFontSize) || defaults.editorFontSize, 10, 24),
      editorKeymap: oneOf(value?.editorKeymap, ["vim", "emacs"], defaults.editorKeymap),
      // Absent means "never chose", which now inherits the on-by-default
      // behavior; only an explicit false keeps Harper quiet. Harper reports
      // lints on Latin-letter spans only (see harper-spellcheck.ts), so
      // non-English prose sees nothing from it.
      editorSpellcheck: value?.editorSpellcheck !== false,
      interfaceSounds: value?.interfaceSounds !== false,
      hiddenTitlebarTools: Array.isArray(value?.hiddenTitlebarTools)
        ? TITLEBAR_TOOLS.filter((tool) => value.hiddenTitlebarTools?.includes(tool))
        : defaults.hiddenTitlebarTools,
    };
  }, defaults);
}

export const persistAppearance = (appearance: AppearanceSettings) =>
  persistSetting(APPEARANCE_KEY, JSON.stringify(appearance));

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

export const loadOverleafSyncMode = () => loadChoice<OverleafSyncMode>(OVERLEAF_SYNC_MODE_KEY, ["manual"], "live");
export const persistOverleafSyncMode = (mode: OverleafSyncMode) => persistSetting(OVERLEAF_SYNC_MODE_KEY, mode);
export const loadOverleafRemoteDelete = () =>
  loadChoice<OverleafRemoteDelete>(OVERLEAF_REMOTE_DELETE_KEY, ["never", "always"], "ask");
export const persistOverleafRemoteDelete = (mode: OverleafRemoteDelete) => persistSetting(OVERLEAF_REMOTE_DELETE_KEY, mode);

