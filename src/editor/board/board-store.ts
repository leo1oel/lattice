import { defaultLang, languages, reconcileElements, restore, serializeAsJSON } from "@excalidraw/excalidraw";
import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

/**
 * A board is an `.excalidraw` file: an Excalidraw scene, loaded from the
 * file's text, serialized back after edits, and merged with what an outside
 * change (a disk reload, git, Overleaf) wrote to it.
 */

export type BoardScene = {
  elements: OrderedExcalidrawElement[];
  files: BinaryFiles;
  /** The grid the board was saved with; the rest of a scene's appState is per user. */
  grid: { gridSize: number; gridStep: number; gridModeEnabled: boolean };
};

const DEFAULT_GRID: BoardScene["grid"] = { gridSize: 20, gridStep: 5, gridModeEnabled: false };

/**
 * The background a board file stores. Lattice draws every board on its own
 * sheet (the canvas is transparent), so the colour is not a board setting.
 */
const FILE_BACKGROUND = "#ffffff";

/** The scene in `.excalidraw` text; empty text is an empty board, invalid text null. */
export function parseBoardScene(source: string): BoardScene | null {
  const trimmed = source.trim();
  if (!trimmed) return { elements: [], files: {}, grid: DEFAULT_GRID };
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const scene = data as { type?: unknown; elements?: unknown; appState?: Partial<AppState>; files?: BinaryFiles };
  if (scene.type !== "excalidraw" || !Array.isArray(scene.elements)) return null;
  const restored = restore(
    { elements: scene.elements, appState: scene.appState ?? null, files: scene.files ?? {} },
    null,
    null,
    { repairBindings: true },
  );
  return {
    elements: restored.elements,
    files: restored.files ?? {},
    grid: {
      gridSize: restored.appState.gridSize ?? DEFAULT_GRID.gridSize,
      gridStep: restored.appState.gridStep ?? DEFAULT_GRID.gridStep,
      gridModeEnabled: restored.appState.gridModeEnabled ?? DEFAULT_GRID.gridModeEnabled,
    },
  };
}

/**
 * `.excalidraw` text for a scene, as Excalidraw saves a file (deleted
 * elements and unused files left out), keeping only the grid of its appState:
 * scroll and zoom are per user, and the background is Lattice's.
 */
export function serializeBoardScene(
  elements: readonly OrderedExcalidrawElement[], appState: Partial<AppState>, files: BinaryFiles,
): string {
  const saved = JSON.parse(serializeAsJSON(elements, appState, files, "local")) as Record<string, unknown>;
  return JSON.stringify({
    ...saved,
    source: "lattice",
    appState: {
      gridSize: appState.gridSize ?? DEFAULT_GRID.gridSize,
      gridStep: appState.gridStep ?? DEFAULT_GRID.gridStep,
      gridModeEnabled: appState.gridModeEnabled ?? DEFAULT_GRID.gridModeEnabled,
      viewBackgroundColor: FILE_BACKGROUND,
    },
  }, null, 2);
}

/** Each element's version as last written to or read from the file. */
export function savedVersions(elements: readonly OrderedExcalidrawElement[]): Map<string, number> {
  return new Map(elements.filter((element) => !element.isDeleted).map((element) => [element.id, element.version]));
}

/**
 * The board after an outside change to its file. The file wins for every
 * element the board has not changed since it last matched the file, so a
 * restore to an older version (git, Overleaf history) comes back as it was,
 * and an element the file no longer has is gone. An element edited here and
 * not yet saved is reconciled with the file's copy by Excalidraw's own rule
 * (the higher version wins), so neither side's edit is dropped silently.
 */
export function mergeExternalElements(
  local: readonly OrderedExcalidrawElement[],
  remote: readonly OrderedExcalidrawElement[],
  saved: ReadonlyMap<string, number>,
  appState: AppState,
): OrderedExcalidrawElement[] {
  const remoteById = new Map(remote.map((element) => [element.id, element]));
  const prepared = local.flatMap((element) => {
    const fromFile = remoteById.get(element.id);
    const unchanged = saved.get(element.id) === element.version || (element.isDeleted && !saved.has(element.id));
    if (unchanged) return fromFile ? [fromFile] : [];
    return [element];
  });
  return reconcileElements(prepared, remote as readonly RemoteExcalidrawElement[], appState);
}

/** The Excalidraw interface language for a Lattice locale, English when Excalidraw has none. */
export const excalidrawLangCode = (locale: string) => (
  languages.some((language) => language.code === locale) ? locale : defaultLang.code
);
