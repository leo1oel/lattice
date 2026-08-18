import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  ContextMenuItem as PierreContextMenuItem,
  ContextMenuOpenContext as PierreContextMenuOpenContext,
  FileTreeRenameEvent,
} from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
  BookMarked,
  BookOpen,
  Check,
  Copy,
  Download,
  FilePlus,
  FolderOpen,
  FolderPlus,
  ImagePlus,
  Pencil,
  Plus,
  TriangleAlert,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../components/ui/context-menu";
import { ScrollArea } from "../components/ui/scroll-area";
import { DestructiveButton } from "../components/ui/destructive-button";
import { InfinityLoader } from "../components/ui/activity-icons";
import { ExternalScrollbar } from "../components/ui/external-scrollbar";
import { SearchField } from "../components/ui/search-field";
import { absoluteProjectPath, paperKey, paperSubtitle } from "../app-utils";
import type { FileNode, GitFileStatus, PaperSummary } from "../app-types";
import { baseArxivId } from "../papers/arxiv-id";
import { PROJECT_FILE_TREE_ICONS } from "./project-file-icons";
import {
  fromPierrePath,
  normalizePointerDraggedPaths,
  pointerDropOperations,
  pointerDropTarget,
  toPierreDirectoryPath,
  type PointerTreeDropLocation,
} from "./navigator-drag";
import { toPierreGitStatus } from "./project-tree-git";

// @pierre/trees virtualizes by a numeric item height, so this mirrors the
// design-system `--row-height-tree` / compact 32px row role.
const PROJECT_TREE_ITEM_HEIGHT = 32;

/**
 * Every token must occur somewhere in the paper's local library metadata.
 * arXiv URLs and versioned IDs reduce to the versionless ID stored by imports.
 */
function filterPapers(papers: readonly PaperSummary[], query: string): PaperSummary[] {
  const tokens = query.toLocaleLowerCase().split(/\s+/).filter(Boolean).map((token) => {
    const arxivId = /\b(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?\/\d{7}(?:v\d+)?)\b/i
      .exec(token)?.[1];
    return arxivId ? baseArxivId(arxivId) : token;
  });
  if (!tokens.length) return [...papers];
  return papers.filter((paper) => {
    const haystack = [
      paper.title,
      paper.authors,
      paper.citationKey,
      paper.arxivId,
      paper.doi,
      paper.url,
    ].filter(Boolean).join(" ").toLocaleLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

type CitationHealthLabels = Record<"retracted" | "concern" | "corrected" | "replaced" | "retractionWatch" | "publisher" | "cached" | "crossrefType" | "unavailable" | "reportsUpdate" | "noUpdate" | "checked", string>;

function citationHealthLabel(paper: PaperSummary, labels: CitationHealthLabels): string | null {
  const health = paper.citationHealth;
  if (!health || health.kind === "unknown" || health.kind === "unavailable") return null;
  const kind = {
    retracted: labels.retracted,
    expressionOfConcern: labels.concern,
    corrected: labels.corrected,
    replaced: labels.replaced,
  }[health.kind];
  const source = health.source === "retraction-watch"
    ? labels.retractionWatch
    : health.source === "publisher"
      ? labels.publisher
      : health.source;
  return [kind, source, health.date, health.stale ? labels.cached : null].filter(Boolean).join(" · ");
}

function citationHealthTitle(paper: PaperSummary, labels: CitationHealthLabels): string | undefined {
  const health = paper.citationHealth;
  if (!health) return undefined;
  const warning = citationHealthLabel(paper, labels);
  if (warning) {
    const updateType = health.updateType?.replaceAll("_", " ");
    return [warning, updateType && `${labels.crossrefType}: ${updateType}`].filter(Boolean).join(". ");
  }
  if (health.kind === "unavailable") return labels.unavailable;
  if (health.updateType) return `${labels.reportsUpdate}: ${health.updateType.replaceAll("_", " ")}`;
  return `${labels.noUpdate} (${labels.checked} ${health.checkedAt.slice(0, 10)})`;
}

type PaperLibrarySearchHit = {
  arxivId?: string | null;
  title: string;
  snippet: string;
};

function paperSearchIdentity(arxivId: string | null | undefined, title: string): string {
  return arxivId || `title:${title.trim().toLocaleLowerCase()}`;
}

function readExpandedDirectories(key: string): Set<string> {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return new Set(Array.isArray(stored) ? stored.filter((path): path is string => typeof path === "string") : []);
  } catch {
    return new Set();
  }
}

function isDirectoryNode(node: FileNode): boolean {
  // Older project snapshots used "folder"; accept both while Pierre becomes
  // the canonical tree renderer.
  return node.kind === "directory" || (node.kind as string) === "folder";
}

function projectTreeEntries(files: FileNode[]): {
  directoryPaths: string[];
  nodes: Map<string, FileNode>;
  paths: string[];
} {
  const directories = new Set<string>();
  const nodes = new Map<string, FileNode>();
  const paths: string[] = [];
  const visit = (node: FileNode) => {
    const directory = isDirectoryNode(node);
    const path = directory ? toPierreDirectoryPath(node.path) : node.path;
    const segments = fromPierrePath(path).split("/");
    const directorySegmentCount = directory ? segments.length : segments.length - 1;
    for (let index = 1; index <= directorySegmentCount; index += 1) {
      directories.add(`${segments.slice(0, index).join("/")}/`);
    }
    nodes.set(path, node);
    paths.push(path);
    node.children.forEach(visit);
  };
  files.forEach(visit);
  return { directoryPaths: [...directories], nodes, paths };
}

function findPierreItemPath(event: { nativeEvent: Event }): string | null {
  for (const target of event.nativeEvent.composedPath()) {
    if (target instanceof HTMLElement && target.dataset.itemPath) {
      return target.dataset.itemPath;
    }
  }
  return null;
}

const PIERRE_TREE_CSS = `
:host {
  display: block;
  min-height: 0;
  height: 100%;
}

/* Pierre must retain this scroll owner for virtualization, keyboard focus, and
   scroll-to-selection. Hide both of its native scrollbar paths; the outer
   ExternalScrollbar paints the same single Lattice scrollbar as ScrollArea. */
[data-file-tree-virtualized-scroll="true"],
[data-file-tree-scrollbar-measure="true"] {
  -ms-overflow-style: none;
  scrollbar-gutter: auto;
  scrollbar-width: none;
}

[data-file-tree-virtualized-scroll="true"]::-webkit-scrollbar,
[data-file-tree-scrollbar-measure="true"]::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}

button[data-type="item"] {
  background: transparent;
  letter-spacing: -0.005em;
  transition: background-color var(--duration-base) var(--ease-emphasized),
    box-shadow var(--duration-base) var(--ease-emphasized),
    color var(--duration-quick) var(--ease-default),
    opacity var(--duration-quick) var(--ease-default);
}

/* Tauri's native file-drop bridge and HTML5 row dragging do not share a
   reliable coordinate space when the WKWebView is zoomed. Keep the gesture in
   pointer events and let Pierre's public model own the actual move. */
button[data-type="item"][draggable="true"] {
  -webkit-user-drag: none;
  user-select: none;
  cursor: grab;
}

button[data-type="item"][data-item-dragging="true"],
button[data-type="item"][data-lattice-pointer-dragging="true"] {
  cursor: grabbing;
  opacity: 0.38;
}

:host([data-lattice-pointer-drag-active="true"]),
:host([data-lattice-pointer-drag-active="true"]) * {
  cursor: grabbing !important;
}

button[data-type="item"][data-lattice-pointer-drag-preview="true"] {
  position: fixed;
  inset: 0 auto auto 0;
  z-index: var(--z-drag-ghost);
  margin: 0;
  overflow: visible;
  border: 1px solid color-mix(in srgb, var(--text-primary) 9%, transparent);
  border-radius: 7px;
  background: color-mix(in srgb, var(--surface-panel-raised) 54%, transparent);
  box-shadow:
    0 8px 22px color-mix(in srgb, #000 11%, transparent),
    0 2px 6px color-mix(in srgb, #000 7%, transparent);
  opacity: 0;
  pointer-events: none;
  transform-origin: center;
  will-change: transform, opacity;
  backdrop-filter: blur(10px) saturate(92%);
  -webkit-backdrop-filter: blur(10px) saturate(92%);
  transition: opacity var(--duration-quick) var(--ease-out),
    box-shadow var(--duration-quick) var(--ease-default);
}

[data-lattice-pointer-drag-count="true"] {
  position: absolute;
  top: -6px;
  right: -6px;
  display: grid;
  min-width: 17px;
  height: 17px;
  padding: 0 5px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--surface-panel-raised) 80%, transparent);
  border-radius: 999px;
  background: var(--control-active);
  box-shadow: 0 2px 6px color-mix(in srgb, #000 18%, transparent);
  color: var(--control-active-contrast);
  font-size: var(--type-nano-size);
  font-weight: var(--weight-semibold);
  line-height: 1;
}

button[data-type="item"]:hover:not([data-item-selected="true"]),
button[data-type="item"][data-item-context-hover="true"]:not([data-item-selected="true"]) {
  background: var(--trees-bg-muted);
}

button[data-type="item"][data-item-selected="true"] {
  background: var(--trees-selected-bg);
  font-weight: var(--type-project-tree-selected-weight);
}

button[data-type="item"][data-item-focused="true"]::before {
  outline-color: transparent;
}

button[data-type="item"]:focus-visible::before {
  outline: 1px solid var(--navigation-focus-ring);
  outline-offset: -1px;
}

button[data-type="item"][data-item-selected="true"] [data-item-section="icon"] {
  color: var(--trees-fg-muted);
}

[data-item-section="icon"] {
  opacity: 0.76;
}

[data-icon-name="file-tree-icon-chevron"] {
  width: 12px;
  height: 12px;
}

[data-icon-name="file-tree-icon-file"] {
  width: 14px;
  height: 14px;
}

[data-item-section="content"] {
  flex: 1 1 auto;
}

[data-truncate-group-container="middle"] {
  width: max-content;
  max-width: 100%;
  min-width: 0;
  display: flex;
  overflow: hidden;
}

[data-truncate-group-container="middle"] > div:first-child {
  min-width: 0;
  flex: 0 1 auto;
}

[data-truncate-group-container="middle"] > div:last-child {
  min-width: 0;
  flex: 0 0 auto;
}

[data-truncate-container] {
  height: auto;
  min-width: 0;
  margin: 0;
  overflow: hidden;
}

[data-truncate-grid] {
  min-width: 0;
  display: block;
}

[data-truncate-content="visible"] {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

[data-truncate-container="fruncate"] [data-truncate-content] {
  direction: ltr;
}

[data-truncate-content="overflow"],
[data-truncate-marker-cell],
[data-truncate-fill] {
  display: none;
}

button[data-type="item"][data-lattice-native-drop-target="true"] {
  background: color-mix(in srgb, var(--text-primary) 9%, transparent);
  color: var(--text-primary);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text-primary) 18%, transparent);
}

[data-item-drag-target="true"] {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text-primary) 18%, transparent);
}

button[data-type="item"][data-lattice-pointer-drop-target="true"] {
  background: var(--control-active-soft);
  color: var(--text-primary);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--control-active) 27%, transparent),
    0 1px 4px color-mix(in srgb, #000 4%, transparent);
}

[data-item-flattened-subitem][data-lattice-pointer-flattened-drop-target="true"] {
  border-radius: 4px;
  background: var(--control-active-soft);
}

@media (prefers-reduced-motion: reduce) {
  button[data-type="item"],
  button[data-type="item"][data-lattice-pointer-drag-preview="true"] {
    transition: none;
  }
}

[data-file-tree-search-container] {
  margin: 0 0 7px;
  padding-inline: var(--space-1);
}

[data-file-tree-search-container][data-open="false"] {
  display: none;
}

[data-file-tree-search-input] {
  box-sizing: border-box;
  height: var(--navigation-search-height);
  padding: 0 var(--search-control-padding-inline) 0 14px;
  border: var(--search-control-border-width) solid var(--search-control-border-color);
  border-radius: var(--search-control-radius);
  outline: none !important;
  background: var(--search-control-background);
  color: var(--text-primary);
  font-size: var(--navigation-search-font-size);
  font-weight: var(--navigation-search-font-weight);
  line-height: var(--navigation-search-line-height);
  transition: background-color var(--duration-quick) var(--ease-default),
    border-color var(--duration-quick) var(--ease-default);
}

[data-file-tree-search-input]::placeholder {
  color: var(--text-tertiary);
}

[data-file-tree-search-input]::-webkit-search-cancel-button,
[data-file-tree-search-input]::-webkit-search-decoration,
[data-file-tree-search-input]::-webkit-search-results-button,
[data-file-tree-search-input]::-webkit-search-results-decoration {
  -webkit-appearance: none;
  appearance: none;
}

[data-file-tree-search-input]:hover:not(:focus-visible):not(
  [data-file-tree-search-input-fake-focus="true"]
) {
  border-color: var(--search-control-interactive-border-color);
}

[data-file-tree-search-input]:focus,
[data-file-tree-search-input]:focus-visible,
[data-file-tree-search-input][data-file-tree-search-input-fake-focus="true"] {
  border-color: var(--search-control-interactive-border-color);
  outline: none !important;
  background: var(--search-control-background);
  box-shadow: none;
}

[data-item-rename-input] {
  height: 20px;
  padding: 0 5px;
  border: var(--field-control-border-width) solid var(--field-control-interactive-border-color);
  border-radius: var(--radius-compact);
  outline: none;
  background: var(--field-control-background);
  box-shadow: none;
  overflow-x: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`;

type ProjectFileTreeProps = {
  projectKey: string;
  searchOpen: boolean;
  /** Incrementing signal from the header "New board" button. */
  boardCreateRequest?: number;
  /** Incrementing signal from the header "New spreadsheet" button. */
  spreadsheetCreateRequest?: number;
  onSearchOpenChange: (open: boolean) => void;
  files: FileNode[];
  gitStatus: GitFileStatus[];
  activeFile: string;
  activeAssetPath: string;
  protectedPaths: string[];
  onFile: (path: string) => void;
  onLikelyFile?: (path: string) => void;
  onAsset: (path: string) => void;
  onBeginFigureDrag: (path: string, label: string, event: React.PointerEvent) => void;
  onBeginFileDrag: (path: string, label: string, event: React.PointerEvent) => void;
  onCreateEntry: (path: string, kind: "file" | "folder") => Promise<string>;
  onDeleteEntry: (path: string) => void;
  onRenameEntry: (path: string, name: string) => Promise<string>;
  onMoveEntries: (paths: string[], targetDirectory: string) => Promise<string[]>;
  onReveal: (path: string) => void;
  onImportAssets: (targetDirectory?: string) => void;
  onError: (message: string) => void;
  assetDropTarget: string | null;
  assetImporting: boolean;
};

type PointerTreeDragSession = {
  active: boolean;
  cancel: () => void;
  draggedPaths: readonly string[];
  pointerId: number;
  preview: HTMLElement | null;
  previewFrame: number | null;
  previewOffset: { x: number; y: number };
  previewPoint: { x: number; y: number } | null;
  target: PointerTreeDropLocation | null;
};

function clearPointerDragAppearance(root: ShadowRoot | null | undefined) {
  if (!root) return;
  if (root.host instanceof HTMLElement) {
    delete root.host.dataset.latticePointerDragActive;
  }
  for (const row of root.querySelectorAll<HTMLElement>(
    "[data-lattice-pointer-dragging], [data-lattice-pointer-drop-target]",
  )) {
    delete row.dataset.latticePointerDragging;
    delete row.dataset.latticePointerDropTarget;
  }
  for (const segment of root.querySelectorAll<HTMLElement>(
    "[data-lattice-pointer-flattened-drop-target]",
  )) {
    delete segment.dataset.latticePointerFlattenedDropTarget;
  }
}

function pointerDragFrame(callback: () => void): number {
  return typeof window.requestAnimationFrame === "function"
    ? window.requestAnimationFrame(callback)
    : window.setTimeout(callback, 16);
}

function afterNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    pointerDragFrame(() => {
      window.setTimeout(resolve, 0);
    });
  });
}

function cancelPointerDragFrame(frame: number | null) {
  if (frame == null) return;
  if (typeof window.cancelAnimationFrame === "function") {
    window.cancelAnimationFrame(frame);
  } else {
    window.clearTimeout(frame);
  }
}

function createPointerDragPreview(
  root: ShadowRoot,
  sourcePath: string,
  draggedCount: number,
  startX: number,
  startY: number,
): {
  element: HTMLElement;
  offset: { x: number; y: number };
} | null {
  const source = Array.from(
    root.querySelectorAll<HTMLElement>("[data-type='item'][data-item-path]"),
  ).find(
    (row) => row.dataset.itemPath === sourcePath
      && row.dataset.fileTreeStickyRow !== "true",
  );
  if (!source) return null;
  const rect = source.getBoundingClientRect();
  const preview = source.cloneNode(true) as HTMLElement;
  for (const attribute of [
    "aria-expanded",
    "aria-haspopup",
    "aria-level",
    "aria-posinset",
    "aria-selected",
    "aria-setsize",
    "data-item-context-hover",
    "data-item-drag-target",
    "data-item-focused",
    "data-item-parent-path",
    "data-item-path",
    "data-item-selected",
    "id",
    "role",
  ]) {
    preview.removeAttribute(attribute);
  }
  preview.dataset.latticePointerDragPreview = "true";
  preview.setAttribute("aria-hidden", "true");
  preview.tabIndex = -1;
  preview.style.width = `${rect.width}px`;
  preview.style.height = `${rect.height}px`;
  if (draggedCount > 1) {
    const count = document.createElement("span");
    count.dataset.latticePointerDragCount = "true";
    count.textContent = String(draggedCount);
    preview.append(count);
  }
  const offset = {
    x: Math.max(0, Math.min(rect.width, startX - rect.left)),
    y: Math.max(0, Math.min(rect.height, startY - rect.top)),
  };
  root.append(preview);
  return { element: preview, offset };
}

function updatePointerDragPreview(
  session: PointerTreeDragSession,
  clientX: number,
  clientY: number,
) {
  if (!session.preview) return;
  session.previewPoint = { x: clientX, y: clientY };
  if (session.previewFrame != null) return;
  session.previewFrame = pointerDragFrame(() => {
    session.previewFrame = null;
    const preview = session.preview;
    const point = session.previewPoint;
    if (!preview || !point) return;
    const left = point.x - session.previewOffset.x;
    const top = point.y - session.previewOffset.y;
    // eslint-disable-next-line lingui/no-unlocalized-strings -- CSS transform syntax, not UI copy.
    preview.style.transform = `translate3d(${left}px, ${top}px, 0) scale(1)`;
    preview.style.opacity = "0.76";
  });
}

function finishPointerDragPreview(session: PointerTreeDragSession) {
  cancelPointerDragFrame(session.previewFrame);
  session.previewFrame = null;
  const preview = session.preview;
  session.preview = null;
  if (!preview) return;
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  if (reducedMotion) {
    preview.remove();
    return;
  }
  preview.style.transition = [
    "opacity 60ms ease-out",
    "box-shadow 60ms ease-out",
  ].join(", ");
  preview.style.opacity = "0";
  preview.style.boxShadow = "0 1px 3px color-mix(in srgb, #000 5%, transparent)";
  window.setTimeout(() => preview.remove(), 70);
}

function ProjectFileTree(props: ProjectFileTreeProps) {
  const { t } = useLingui();
  const tree = useMemo(() => projectTreeEntries(props.files), [props.files]);
  const gitStatus = useMemo(() => toPierreGitStatus(props.gitStatus), [props.gitStatus]);
  const expansionStorageKey = `lattice:expanded-directories:${props.projectKey}`;
  const propsRef = useRef(props);
  const treeRef = useRef(tree);
  const modelRef = useRef<ReturnType<typeof useFileTree>["model"] | null>(null);
  const syncingSelectionRef = useRef(false);
  const pendingCreationsRef = useRef(new Map<string, { kind: "file" | "folder"; extension?: string }>());
  const pendingCleanupTimersRef = useRef(new Map<string, number>());
  const pointerTreeDragRef = useRef<PointerTreeDragSession | null>(null);
  const suppressTreeClickRef = useRef(false);
  const lastLikelyFileRef = useRef<string | null>(null);
  const reportLikelyFile = (event: React.SyntheticEvent) => {
    const path = findPierreItemPath(event);
    const node = path ? tree.nodes.get(path) : null;
    if (!node || isDirectoryNode(node) || !/\.mdx?$/i.test(node.path)) return;
    if (lastLikelyFileRef.current === node.path) return;
    lastLikelyFileRef.current = node.path;
    props.onLikelyFile?.(node.path);
  };
  const clearPendingCreation = useCallback((path: string) => {
    const normalizedPath = fromPierrePath(path);
    const pending = pendingCreationsRef.current.get(normalizedPath);
    if (!pending) return false;
    pendingCreationsRef.current.delete(normalizedPath);
    const currentModel = modelRef.current;
    const modelPath = pending.kind === "folder"
      ? toPierreDirectoryPath(normalizedPath)
      : normalizedPath;
    if (currentModel?.getItem(modelPath)) {
      currentModel.remove(modelPath, pending.kind === "folder" ? { recursive: true } : undefined);
    }
    return true;
  }, []);
  const persistPendingCreation = useCallback((
    sourcePath: string,
    destinationPath: string,
    isFolder: boolean,
  ) => {
    const source = fromPierrePath(sourcePath);
    const pending = pendingCreationsRef.current.get(source);
    if (!pending) return false;
    pendingCreationsRef.current.delete(source);
    // Creation modes may pin an extension (e.g. boards → .tldr) so the inline
    // name stays extension-free; an explicit user-typed extension wins.
    let destination = fromPierrePath(destinationPath);
    if (pending.extension && !/\.[^./\\]+$/.test(destination.split("/").at(-1) ?? "")) {
      destination = `${destination}.${pending.extension}`;
    }
    void propsRef.current
      .onCreateEntry(destination, pending.kind)
      .then((createdPath) => {
        const currentModel = modelRef.current;
        const optimisticPath = isFolder
          ? toPierreDirectoryPath(destination)
          : destination;
        const actualPath = isFolder
          ? toPierreDirectoryPath(createdPath)
          : createdPath;
        if (
          optimisticPath !== actualPath
          && currentModel?.getItem(optimisticPath)
          && !currentModel.getItem(actualPath)
        ) {
          currentModel.move(optimisticPath, actualPath);
        }
      })
      .catch(() => {
        modelRef.current?.resetPaths(treeRef.current.paths);
      });
    return true;
  }, []);

  const initialExpandedPaths = useMemo(
    () => [...readExpandedDirectories(expansionStorageKey)].map(toPierreDirectoryPath),
    [expansionStorageKey],
  );
  const initialActivePath = props.activeAssetPath || props.activeFile;
  const { model } = useFileTree({
    paths: tree.paths,
    initialExpansion: "closed",
    initialExpandedPaths,
    initialSelectedPaths: initialActivePath ? [initialActivePath] : [],
    composition: {
      contextMenu: {
        triggerMode: "right-click",
      },
    },
    density: "default",
    itemHeight: PROJECT_TREE_ITEM_HEIGHT,
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    gitStatus,
    icons: PROJECT_FILE_TREE_ICONS,
    search: true,
    searchBlurBehavior: "retain",
    stickyFolders: true,
    unsafeCSS: PIERRE_TREE_CSS,
    onSelectionChange: (selectedPaths) => {
      if (syncingSelectionRef.current) return;
      const selected = selectedPaths.at(-1);
      if (!selected) return;
      const node = treeRef.current.nodes.get(selected);
      if (!node || isDirectoryNode(node)) return;
      if (node.kind === "figure" || node.contentKind === "binary" || node.contentKind === "symlink") propsRef.current.onAsset(node.path);
      else propsRef.current.onFile(node.path);
    },
    renaming: {
      canRename: ({ path }) => {
        const normalizedPath = fromPierrePath(path);
        return (
          pendingCreationsRef.current.has(normalizedPath)
          || treeRef.current.nodes.has(path)
          || treeRef.current.nodes.has(toPierreDirectoryPath(normalizedPath))
        );
      },
      onError: (message) => propsRef.current.onError(message),
      onRename: (event: FileTreeRenameEvent) => {
        const source = fromPierrePath(event.sourcePath);
        const destination = fromPierrePath(event.destinationPath);
        const name = destination.split("/").at(-1);
        if (!name) return;
        if (persistPendingCreation(source, destination, event.isFolder)) return;
        void propsRef.current
          .onRenameEntry(source, name)
          .then((renamedPath) => {
            const actualPath = event.isFolder ? toPierreDirectoryPath(renamedPath) : renamedPath;
            const currentModel = modelRef.current;
            if (
              actualPath !== event.destinationPath
              && currentModel?.getItem(event.destinationPath)
              && !currentModel.getItem(actualPath)
            ) {
              currentModel.move(event.destinationPath, actualPath);
            }
          })
          .catch(() => {
            modelRef.current?.resetPaths(treeRef.current.paths);
          });
      },
    },
    dragAndDrop: {
      canDrag: (paths) => paths.length > 0 && paths.every((path) => {
        const normalizedPath = fromPierrePath(path);
        return (
          treeRef.current.nodes.has(path)
          || treeRef.current.nodes.has(toPierreDirectoryPath(normalizedPath))
        );
      }),
      onDropComplete: ({ draggedPaths, target }) => {
        const targetDirectory = fromPierrePath(
          target.flattenedSegmentPath ?? target.directoryPath ?? "",
        );
        void afterNextPaint()
          .then(() => propsRef.current.onMoveEntries(
            draggedPaths.map(fromPierrePath),
            targetDirectory,
          ))
          .catch(() => {
            modelRef.current?.resetPaths(treeRef.current.paths);
          });
      },
      onDropError: (message) => propsRef.current.onError(message),
    },
  });
  const getTreeScrollViewport = useCallback(
    () => model
      .getFileTreeContainer()
      ?.shadowRoot
      ?.querySelector<HTMLElement>('[data-file-tree-virtualized-scroll="true"]')
      ?? null,
    [model],
  );
  useLayoutEffect(() => {
    propsRef.current = props;
    treeRef.current = tree;
    modelRef.current = model;
  }, [model, props, tree]);

  const treeSignature = tree.paths.join("\u0000");
  const lastTreeIdentityRef = useRef(`${props.projectKey}\u0000${treeSignature}`);
  useEffect(() => {
    const identity = `${props.projectKey}\u0000${treeSignature}`;
    if (lastTreeIdentityRef.current === identity) return;
    lastTreeIdentityRef.current = identity;
    model.resetPaths(tree.paths, {
      initialExpandedPaths: [...readExpandedDirectories(expansionStorageKey)].map(toPierreDirectoryPath),
    });
  }, [expansionStorageKey, model, props.projectKey, tree.paths, treeSignature]);

  const activePath = props.activeAssetPath || props.activeFile;
  useEffect(() => {
    syncingSelectionRef.current = true;
    try {
      for (const selected of model.getSelectedPaths()) {
        if (selected !== activePath) model.getItem(selected)?.deselect();
      }
      if (activePath) {
        const item = model.getItem(activePath);
        if (item && !item.isSelected()) item.select();
        model.focusPath(activePath);
        model.scrollToPath(activePath, { focus: false, offset: "nearest" });
      }
    } finally {
      syncingSelectionRef.current = false;
    }
  }, [activePath, model, treeSignature]);

  useEffect(() => {
    if (props.searchOpen) model.openSearch();
    else model.closeSearch();
  }, [model, props.searchOpen]);

  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [gitStatus, model]);

  useEffect(
    () => model.onMutation("remove", (event) => {
      pendingCreationsRef.current.delete(fromPierrePath(event.path));
    }),
    [model],
  );

  useEffect(() => {
    const scheduleCleanup = () => {
      for (const path of pendingCreationsRef.current.keys()) {
        if (pendingCleanupTimersRef.current.has(path)) continue;
        const timer = window.setTimeout(() => {
          pendingCleanupTimersRef.current.delete(path);
          if (!pendingCreationsRef.current.has(path)) return;
          const root = model.getFileTreeContainer()?.shadowRoot;
          const input = root?.querySelector<HTMLInputElement>("[data-item-rename-input]");
          const inputPath = input?.closest<HTMLElement>("[data-item-path]")?.dataset.itemPath;
          if (input && inputPath && fromPierrePath(inputPath) === path) {
            if (input.dataset.latticePendingCreationBound !== "true") {
              input.dataset.latticePendingCreationBound = "true";
              input.addEventListener("keydown", (event) => {
                if (event.key !== "Enter" || !pendingCreationsRef.current.has(path)) return;
                const originalName = path.split("/").at(-1) ?? "";
                if (input.value.trim() !== originalName) return;
                // Pierre treats an unchanged rename as a no-op and therefore
                // skips onRename. Enter still means "create".
                const pending = pendingCreationsRef.current.get(path);
                if (pending) persistPendingCreation(path, path, pending.kind === "folder");
              }, { capture: true });
            }
            return;
          }
          // No input and no persistence callback means Pierre completed an
          // unchanged rename on blur. The path is still only an optimistic UI
          // draft, so remove it instead of exposing a non-existent file.
          clearPendingCreation(path);
        }, 0);
        pendingCleanupTimersRef.current.set(path, timer);
      }
    };
    const cleanupTimers = pendingCleanupTimersRef.current;
    const unsubscribe = model.subscribe(scheduleCleanup);
    return () => {
      unsubscribe();
      for (const timer of cleanupTimers.values()) {
        window.clearTimeout(timer);
      }
      cleanupTimers.clear();
    };
  }, [clearPendingCreation, model, persistPendingCreation]);

  useEffect(() => {
    let expandedSignature = "";
    let searchOpen = model.isSearchOpen();
    return model.subscribe(() => {
      const expanded = treeRef.current.directoryPaths
        .filter((path) => {
          const item = model.getItem(path);
          if (!item || !("isExpanded" in item)) return false;
          return item.isExpanded();
        })
        .map(fromPierrePath);
      const nextExpandedSignature = expanded.join("\u0000");
      if (nextExpandedSignature !== expandedSignature) {
        expandedSignature = nextExpandedSignature;
        try {
          localStorage.setItem(expansionStorageKey, JSON.stringify(expanded));
        } catch {
          // Expansion still works in memory when persistence is unavailable.
        }
      }
      const nextSearchOpen = model.isSearchOpen();
      if (nextSearchOpen !== searchOpen) {
        searchOpen = nextSearchOpen;
        propsRef.current.onSearchOpenChange(nextSearchOpen);
      }
    });
  }, [expansionStorageKey, model]);

  useEffect(() => {
    const markNativeDropTarget = () => {
      const root = model.getFileTreeContainer()?.shadowRoot;
      if (!root) return;
      for (const row of root.querySelectorAll<HTMLElement>("[data-lattice-native-drop-target]")) {
        delete row.dataset.latticeNativeDropTarget;
      }
      if (!props.assetDropTarget) return;
      const path = toPierreDirectoryPath(props.assetDropTarget);
      for (const row of root.querySelectorAll<HTMLElement>("[data-item-type='folder'][data-item-path]")) {
        if (row.dataset.itemPath === path) row.dataset.latticeNativeDropTarget = "true";
      }
    };
    markNativeDropTarget();
    return model.subscribe(markNativeDropTarget);
  }, [model, props.assetDropTarget]);

  const beginPointerTreeDrag = useCallback((
    path: string,
    event: React.PointerEvent,
  ) => {
    if (
      event.button !== 0
      || (event.pointerType && event.pointerType !== "mouse")
      || pointerTreeDragRef.current
    ) {
      return;
    }
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    const clearSession = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", cancelSession);
      window.removeEventListener("blur", cancelSession);
      clearPointerDragAppearance(model.getFileTreeContainer()?.shadowRoot);
      finishPointerDragPreview(session);
      if (pointerTreeDragRef.current === session) pointerTreeDragRef.current = null;
    };
    const updateTarget = (pointerEvent: PointerEvent) => {
      const root = model.getFileTreeContainer()?.shadowRoot;
      if (!root) {
        session.target = null;
        return;
      }
      const location = pointerDropTarget(root, pointerEvent);
      const validLocation = location
        && pointerDropOperations(session.draggedPaths, location.target).length > 0
        ? location
        : null;
      clearPointerDragAppearance(root);
      if (root.host instanceof HTMLElement) {
        root.host.dataset.latticePointerDragActive = "true";
      }
      for (const row of root.querySelectorAll<HTMLElement>("[data-item-path]")) {
        if (session.draggedPaths.includes(row.dataset.itemPath ?? "")) {
          row.dataset.latticePointerDragging = "true";
        }
      }
      if (validLocation?.row) {
        validLocation.row.dataset.latticePointerDropTarget = "true";
      }
      if (validLocation?.flattenedSegment) {
        validLocation.flattenedSegment.dataset.latticePointerFlattenedDropTarget = "true";
      }
      session.target = validLocation;
    };
    const cancelSession = () => {
      clearSession();
    };
    const onPointerMove = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      if (
        !session.active
        && Math.hypot(pointerEvent.clientX - startX, pointerEvent.clientY - startY) < 5
      ) {
        return;
      }
      if (!session.active) {
        const selectedPaths = model.getSelectedPaths();
        const draggedPaths = normalizePointerDraggedPaths(
          selectedPaths.includes(path) ? selectedPaths : [path],
        );
        if (
          model.getSearchValue().length > 0
          || draggedPaths.length === 0
          || draggedPaths.some((draggedPath) => {
            const normalizedPath = fromPierrePath(draggedPath);
            return !(
              treeRef.current.nodes.has(draggedPath)
              || treeRef.current.nodes.has(toPierreDirectoryPath(normalizedPath))
            );
          })
        ) {
          clearSession();
          return;
        }
        session.active = true;
        session.draggedPaths = draggedPaths;
        model.focusPath(path);
        const root = model.getFileTreeContainer()?.shadowRoot;
        if (root) {
          if (root.host instanceof HTMLElement) {
            root.host.dataset.latticePointerDragActive = "true";
          }
          const preview = createPointerDragPreview(
            root,
            path,
            draggedPaths.length,
            startX,
            startY,
          );
          if (preview) {
            session.preview = preview.element;
            session.previewOffset = preview.offset;
          }
        }
      }
      pointerEvent.preventDefault();
      updatePointerDragPreview(session, pointerEvent.clientX, pointerEvent.clientY);
      updateTarget(pointerEvent);
    };
    const onPointerUp = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      const active = session.active;
      if (active) updateTarget(pointerEvent);
      const location = session.target;
      const draggedPaths = session.draggedPaths;
      clearSession();
      if (!active || !location) return;
      suppressTreeClickRef.current = true;
      window.setTimeout(() => {
        suppressTreeClickRef.current = false;
      }, 0);
      const operations = pointerDropOperations(draggedPaths, location.target);
      if (operations.length === 0) return;
      try {
        if (operations.length === 1) {
          const operation = operations[0];
          if (operation?.type !== "move") return;
          model.move(operation.from, operation.to);
        } else {
          model.batch(operations);
        }
      } catch (reason) {
        model.resetPaths(treeRef.current.paths);
        propsRef.current.onError(
          reason instanceof Error ? reason.message : String(reason),
        );
        return;
      }
      const targetDirectory = fromPierrePath(
        location.target.flattenedSegmentPath
          ?? location.target.directoryPath
          ?? "",
      );
      void afterNextPaint()
        .then(() => propsRef.current.onMoveEntries(
          draggedPaths.map(fromPierrePath),
          targetDirectory,
        ))
        .catch(() => {
          model.resetPaths(treeRef.current.paths);
        });
    };
    const session: PointerTreeDragSession = {
      active: false,
      cancel: cancelSession,
      draggedPaths: [],
      pointerId,
      preview: null,
      previewFrame: null,
      previewOffset: { x: 0, y: 0 },
      previewPoint: null,
      target: null,
    };
    pointerTreeDragRef.current = session;
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", cancelSession);
    window.addEventListener("blur", cancelSession);
  }, [model]);
  useEffect(() => () => {
    pointerTreeDragRef.current?.cancel();
  }, []);

  const afterMenuClose = (action: () => void) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(action);
    });
  };
  const closeThen = (context: PierreContextMenuOpenContext, action: () => void) => {
    context.close({ restoreFocus: false });
    afterMenuClose(action);
  };
  const beginInlineCreate = (targetDirectory: string, kind: "file" | "folder", extension?: string) => {
    // A context-menu click blurs any previous draft. Remove that draft before
    // choosing a placeholder so a canceled creation never leaks into the next
    // name as "untitled-2".
    for (const path of [...pendingCreationsRef.current.keys()]) {
      clearPendingCreation(path);
    }
    const directory = fromPierrePath(targetDirectory);
    let suffix = 1;
    let basename = "untitled";
    let placeholderPath = directory ? `${directory}/${basename}` : basename;
    let modelPath = kind === "folder"
      ? toPierreDirectoryPath(placeholderPath)
      : placeholderPath;
    while (model.getItem(modelPath)) {
      suffix += 1;
      basename = `untitled-${suffix}`;
      placeholderPath = directory ? `${directory}/${basename}` : basename;
      modelPath = kind === "folder"
        ? toPierreDirectoryPath(placeholderPath)
        : placeholderPath;
    }

    model.add(modelPath);
    pendingCreationsRef.current.set(placeholderPath, { kind, extension });
    if (!model.startRenaming(modelPath, { removeIfCanceled: true })) {
      pendingCreationsRef.current.delete(placeholderPath);
      model.remove(modelPath, kind === "folder" ? { recursive: true } : undefined);
    }
  };
  // Header actions (e.g. "New board") request an inline creation at the root
  // through a monotonically increasing signal; each new value starts one draft.
  const boardCreateRequest = props.boardCreateRequest ?? 0;
  const handledBoardCreateRequestRef = useRef(boardCreateRequest);
  useEffect(() => {
    if (boardCreateRequest === handledBoardCreateRequestRef.current) return;
    handledBoardCreateRequestRef.current = boardCreateRequest;
    beginInlineCreate("", "file", "tldr");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- beginInlineCreate reads live refs/model
  }, [boardCreateRequest]);
  const spreadsheetCreateRequest = props.spreadsheetCreateRequest ?? 0;
  const handledSpreadsheetCreateRequestRef = useRef(spreadsheetCreateRequest);
  useEffect(() => {
    if (spreadsheetCreateRequest === handledSpreadsheetCreateRequestRef.current) return;
    handledSpreadsheetCreateRequestRef.current = spreadsheetCreateRequest;
    beginInlineCreate("", "file", "lattice-sheet");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- beginInlineCreate reads live refs/model
  }, [spreadsheetCreateRequest]);
  const renderContextMenu = (
    item: PierreContextMenuItem,
    context: PierreContextMenuOpenContext,
  ) => {
    const path = fromPierrePath(item.path);
    const pendingCreation = pendingCreationsRef.current.has(path);
    const targetDirectory = item.kind === "directory"
      ? path
      : path.includes("/")
        ? path.slice(0, path.lastIndexOf("/"))
        : "";
    const protectedEntry = props.protectedPaths.some(
      (protectedPath) => protectedPath === path || protectedPath.startsWith(`${path}/`),
    );
    const menuLeft = context.anchorRect.right + 4;
    const menuTop = context.anchorRect.top;
    // Pierre normally mounts this menu inside the tree's Shadow DOM. Portal it
    // out of the sidebar stacking context so older WKWebViews cannot composite
    // the neighbouring editor above the part that extends past the sidebar.
    return createPortal(
      <div
        ref={(menu) => {
          const bounds = menu?.getBoundingClientRect();
          if (!menu || !bounds) return;
          const viewportInset = 8;
          const maxLeft = Math.max(viewportInset, window.innerWidth - bounds.width - viewportInset);
          const maxTop = Math.max(viewportInset, window.innerHeight - bounds.height - viewportInset);
          menu.style.left = `${Math.min(Math.max(viewportInset, menuLeft), maxLeft)}px`;
          menu.style.top = `${Math.min(Math.max(viewportInset, menuTop), maxTop)}px`;
        }}
        className="file-tree-context-menu"
        data-file-tree-context-menu-root="true"
        role="menu"
        style={{
          left: menuLeft,
          position: "fixed",
          top: menuTop,
          zIndex: "var(--z-radix-popper)",
        }}
      >
        <button role="menuitem" onClick={() => closeThen(context, () => beginInlineCreate(targetDirectory, "file"))}>
          <FilePlus size={14} />{t`New file`}
        </button>
        <button role="menuitem" onClick={() => closeThen(context, () => beginInlineCreate(targetDirectory, "folder"))}>
          <FolderPlus size={14} />{t`New folder`}
        </button>
        <button role="menuitem" onClick={() => closeThen(context, () => model.startRenaming(item.path))}>
          <Pencil size={14} />{t`Rename`}
        </button>
        <button
          role="menuitem"
          onClick={() => closeThen(context, () => void writeText(absoluteProjectPath(props.projectKey, path)))}
        >
          <Copy size={14} />{t`Copy path`}
        </button>
        <button role="menuitem" onClick={() => closeThen(context, () => props.onReveal(path))}>
          <FolderOpen size={14} />{t`Show in Finder`}
        </button>
        {item.kind === "directory" && (
          <button
            role="menuitem"
            disabled={props.assetImporting}
            onClick={() => closeThen(context, () => props.onImportAssets(path))}
          >
            <ImagePlus size={14} />{t`Import images here`}
          </button>
        )}
        {!protectedEntry && (
          <DestructiveButton
            className="destructive"
            role="menuitem"
            iconSize={14}
            onClick={() => closeThen(context, () => {
              if (!clearPendingCreation(path)) props.onDeleteEntry(path);
            })}
          >
            {pendingCreation ? t`Cancel creation` : t`Delete`}
          </DestructiveButton>
        )}
      </div>,
      document.body,
    );
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="project-file-tree-surface" aria-label={t`Project files`}>
          <FileTree
            className="lattice-file-tree"
            model={model}
            renderContextMenu={renderContextMenu}
            onPointerOverCapture={reportLikelyFile}
            onFocusCapture={reportLikelyFile}
            onContextMenu={(event) => {
              const path = findPierreItemPath(event);
              const textInput = event.nativeEvent.composedPath().some(
                (target) => target instanceof HTMLInputElement,
              );
              if (path || textInput) event.stopPropagation();
            }}
            onPointerDown={(event) => {
              const interactiveControl = event.nativeEvent.composedPath().some(
                (target) => target instanceof HTMLInputElement
                  || (
                    target instanceof HTMLElement
                    && target.dataset.type === "context-menu-trigger"
                  ),
              );
              if (interactiveControl) return;
              const path = findPierreItemPath(event);
              if (!path) return;
              beginPointerTreeDrag(path, event);
              const node = tree.nodes.get(path);
              if (node?.kind === "figure" || node?.contentKind === "binary") {
                props.onBeginFigureDrag(node.path, node.name, event);
              } else if (node && !isDirectoryNode(node)) {
                props.onBeginFileDrag(node.path, node.name, event);
              }
            }}
            onDragStartCapture={(event) => {
              if (!pointerTreeDragRef.current) return;
              event.preventDefault();
              event.stopPropagation();
            }}
            onClickCapture={(event) => {
              if (!suppressTreeClickRef.current) return;
              event.preventDefault();
              event.stopPropagation();
            }}
          />
          <ExternalScrollbar getViewport={getTreeScrollViewport} />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
        <ContextMenuItem onSelect={() => afterMenuClose(() => beginInlineCreate("", "file"))}>
          <FilePlus size={14} />{t`New file`}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => afterMenuClose(() => beginInlineCreate("", "folder"))}>
          <FolderPlus size={14} />{t`New folder`}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function Navigator(props: {
  mode: "project" | "papers";
  projectKey: string;
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  boardCreateRequest?: number;
  spreadsheetCreateRequest?: number;
  files: FileNode[];
  gitStatus: GitFileStatus[];
  activeFile: string;
  activeAssetPath: string;
  protectedPaths: string[];
  papers: PaperSummary[];
  activePaper: PaperSummary | null;
  onFile: (path: string, line?: number) => void;
  onLikelyFile?: (path: string) => void;
  onAsset: (path: string) => void;
  onBeginFigureDrag: (path: string, label: string, event: React.PointerEvent) => void;
  onBeginFileDrag: (path: string, label: string, event: React.PointerEvent) => void;
  onCreateEntry: (path: string, kind: "file" | "folder") => Promise<string>;
  onDeleteEntry: (path: string) => void;
  onRenameEntry: (path: string, name: string) => Promise<string>;
  onMoveEntries: (paths: string[], targetDirectory: string) => Promise<string[]>;
  onError: (message: string) => void;
  onReveal: (path: string) => void;
  onImportAssets: (targetDirectory?: string) => void;
  assetDropTarget: string | null;
  assetImporting: boolean;
  onPaper: (paper: PaperSummary) => void;
  onLikelyPaper?: (paper: PaperSummary) => void;
  onFetchFullText: (paper: PaperSummary) => void;
  paperFetchStates: Record<string, "loading" | "success">;
  onDeletePaper: (paper: PaperSummary) => void;
  onEditBibEntry: (paper: PaperSummary) => void;
  importInput: string;
  setImportInput: (value: string) => void;
  onImport: () => void;
  importing: boolean;
  /** Human-readable pipeline stage while an import or fetch is running. */
  importStage?: string | null;
}) {
  const { t } = useLingui();
  const paperImportRef = useRef<HTMLInputElement | null>(null);
  const trimmedPaperQuery = props.importInput.trim();
  const [paperTextSearch, setPaperTextSearch] = useState<{
    query: string;
    hits: PaperLibrarySearchHit[];
  }>({ query: "", hits: [] });
  useEffect(() => {
    if (props.mode !== "papers" || !trimmedPaperQuery) {
      return;
    }
    let disposed = false;
    const timer = window.setTimeout(() => {
      void invoke<PaperLibrarySearchHit[]>("search_paper_library", { query: trimmedPaperQuery })
        .then((hits) => {
          if (!disposed) {
            setPaperTextSearch({
              query: trimmedPaperQuery,
              hits: Array.isArray(hits) ? hits : [],
            });
          }
        })
        .catch(() => {
          // Metadata filtering remains useful if the cache cannot be read.
          if (!disposed) setPaperTextSearch({ query: trimmedPaperQuery, hits: [] });
        });
    }, 120);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [props.mode, trimmedPaperQuery]);
  const textHitByPaper = useMemo(() => {
    const hits = paperTextSearch.query === trimmedPaperQuery ? paperTextSearch.hits : [];
    const firstHit = new Map<string, PaperLibrarySearchHit>();
    for (const hit of hits) {
      const identity = paperSearchIdentity(hit.arxivId, hit.title);
      if (!firstHit.has(identity)) firstHit.set(identity, hit);
    }
    return firstHit;
  }, [paperTextSearch, trimmedPaperQuery]);
  const filteredPapers = useMemo(() => {
    const metadataMatches = new Set(filterPapers(props.papers, props.importInput).map(paperKey));
    return props.papers.filter((paper) => (
      metadataMatches.has(paperKey(paper))
      || textHitByPaper.has(paperSearchIdentity(paper.arxivId, paper.title))
    ));
  }, [props.importInput, props.papers, textHitByPaper]);
  const matchingSnippet = (paper: PaperSummary) => (
    textHitByPaper.get(paperSearchIdentity(paper.arxivId, paper.title))?.snippet.trim()
  );
  const activatePaper = (paper: PaperSummary) => {
    if (paper.hasFullText || paper.hasBlog) props.onPaper(paper);
    else if (paper.arxivId || paper.url) props.onFetchFullText(paper);
  };
  const renderPaperContextMenu = (
    path: string,
    children: React.ReactElement,
  ) => {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
          <ContextMenuItem onSelect={() => props.onReveal(path)}><FolderOpen size={14} />{t`Show in Finder`}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };
  // assetDropTarget "" targets the project root; only null means "no asset drag".
  return (
    <aside className={`navigator ${props.assetDropTarget != null ? "asset-drag-active" : ""}`}>
      {props.mode === "project" && <div className="navigator-section project-section">
        <ProjectFileTree
          key={`project-tree:${props.projectKey}:default-complete-context-v4`}
          projectKey={props.projectKey}
          searchOpen={props.searchOpen}
          boardCreateRequest={props.boardCreateRequest}
          spreadsheetCreateRequest={props.spreadsheetCreateRequest}
          onSearchOpenChange={props.onSearchOpenChange}
          files={props.files}
          gitStatus={props.gitStatus}
          activeFile={props.activeFile}
          activeAssetPath={props.activeAssetPath}
          protectedPaths={props.protectedPaths}
          onFile={props.onFile}
          onLikelyFile={props.onLikelyFile}
          onAsset={props.onAsset}
          onBeginFigureDrag={props.onBeginFigureDrag}
          onBeginFileDrag={props.onBeginFileDrag}
          onCreateEntry={props.onCreateEntry}
          onDeleteEntry={props.onDeleteEntry}
          onRenameEntry={props.onRenameEntry}
          onMoveEntries={props.onMoveEntries}
          onReveal={props.onReveal}
          onImportAssets={props.onImportAssets}
          onError={props.onError}
          assetDropTarget={props.assetDropTarget}
          assetImporting={props.assetImporting}
        />
      </div>}
      {props.mode === "papers" && <div className="navigator-section papers-section">
        <SearchField
          ref={paperImportRef}
          aria-label={t`Search or import papers`}
          containerClassName="import-box"
          controlSize="compact"
          placeholder={t`Search or add by title, arXiv ID, DOI, or URL`}
          value={props.importInput}
          onChange={(event) => props.setImportInput(event.target.value)}
          onClear={() => props.setImportInput("")}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            const localMatch = filteredPapers[0];
            if (localMatch) activatePaper(localMatch);
            else props.onImport();
          }}
          showIcon={false}
          trailing={(
            <button onClick={props.onImport} disabled={props.importing || !props.importInput.trim()} title={t`Import paper`}>
              {props.importing ? <InfinityLoader size={14} /> : <Plus size={14} />}
            </button>
          )}
        />
        {props.importStage && (
          <div className="paper-import-stage" role="status">
            <InfinityLoader size={12} />
            <span>{props.importStage}</span>
          </div>
        )}
        <ScrollArea
          className="paper-list"
          orientation="both"
          contentClassName="paper-list-content"
          viewportProps={{ role: "list", "aria-label": t`Papers` }}
        >
          {filteredPapers.map((paper) => {
            const fetchState = props.paperFetchStates[paperKey(paper)];
            const locallyReadable = paper.hasFullText || paper.hasBlog;
            const healthLabels: CitationHealthLabels = {
              retracted: t`Retracted`, concern: t`Expression of concern`, corrected: t`Correction/update`,
              replaced: t`Replacement/new version`, retractionWatch: t`Retraction Watch`, publisher: t`Publisher`,
              cached: t`cached`, crossrefType: t`Crossref type`, unavailable: t`Crossref citation-health metadata is currently unavailable`,
              reportsUpdate: t`Crossref reports update type`, noUpdate: t`No Crossref update metadata found`, checked: t`checked`,
            };
            const healthLabel = citationHealthLabel(paper, healthLabels);
            const healthTitle = citationHealthTitle(paper, healthLabels);
            const row = (
              <div
                className={`paper-row ${paper.hasFullText ? "" : "cited-only "}${healthLabel ? `citation-${paper.citationHealth?.kind} ` : ""}${props.activePaper && paperKey(props.activePaper) === paperKey(paper) ? "active" : ""}`}
                data-citation-health={paper.citationHealth?.kind}
              >
              <button
                data-tour={paper.arxivId === "2010.11929" ? "tutorial-vit-paper" : undefined}
                title={locallyReadable
                  ? paper.title
                  : paper.arxivId
                    ? t({ message: `Download arXiv ${{ id: paper.arxivId }}` })
                    : paper.url
                      ? t({ message: `Download ${{ url: paper.url }}` })
                      : t({ message: `${{ title: paper.title }} — no local reading available` })}
                className="paper-open"
                // Knowing the preprint is as good as having it: clicking
                // fetches. A cited webpage is fetchable the same way.
                disabled={fetchState === "loading" || (!locallyReadable && !paper.arxivId && !paper.url)}
                onPointerEnter={() => {
                  if (locallyReadable) props.onLikelyPaper?.(paper);
                }}
                onFocus={() => {
                  if (locallyReadable) props.onLikelyPaper?.(paper);
                }}
                onClick={() => activatePaper(paper)}
              >
                <span className={`paper-state-icon ${fetchState ?? (locallyReadable ? "available" : "idle")}`}>
                  {fetchState === "loading"
                    ? <InfinityLoader size={14} />
                    : fetchState === "success"
                      ? <Check size={14} />
                      : locallyReadable
                        ? <BookOpen size={14} />
                        : paper.arxivId || paper.url
                          ? <Download size={14} />
                          : <BookMarked size={14} />}
                </span>
                <span>
                  <strong>{paper.title}</strong>
                  <small>{matchingSnippet(paper) || paperSubtitle(paper)}</small>
                  {healthLabel && <small className="paper-citation-health" role="status">{healthLabel}</small>}
                </span>
              </button>
              <div className="paper-row-actions">
                {healthLabel && paper.citationHealth?.link && (
                  <button
                    className="row-citation-health"
                    title={t({ message: `${{ notice: healthTitle }}. Open notice` })}
                    aria-label={t({ message: `${{ notice: healthLabel }}. Open notice` })}
                    onClick={() => void openUrl(paper.citationHealth!.link!).catch(() => undefined)}
                  >
                    <TriangleAlert size={12} />
                  </button>
                )}
                {paper.citationKey && (
                  <button className="row-edit-bib" title={t`Edit bibliography entry`} onClick={() => props.onEditBibEntry(paper)}><Pencil size={12} /></button>
                )}
                <DestructiveButton
                  className="row-delete"
                  title={t({ message: `Remove ${{ title: paper.title }}` })}
                  iconSize={12}
                  onClick={() => props.onDeletePaper(paper)}
                />
              </div>
              {!healthLabel && healthTitle && <span className="sr-only">{healthTitle}</span>}
              </div>
            );
            // A cited-only paper has no local file to act on, so it stays bare;
            // one with full text gets the same right-click menu as a tree file.
            return (
              <Fragment key={paperKey(paper)}>
                {locallyReadable
                  ? renderPaperContextMenu(`.research/papers/${paper.arxivId}/${paper.hasFullText ? "paper.md" : "blog.md"}`, row)
                  : row}
              </Fragment>
            );
          })}
          {!props.papers.length && (
            <div className="papers-empty-state">
              <strong>{t`Add your first paper`}</strong>
              <p>{t`Paste an arXiv ID, DOI, URL, or title above to ground the agent in project evidence.`}</p>
            </div>
          )}
          {!!props.papers.length && !filteredPapers.length && (
            <div className="papers-empty-state">
              <strong>{t`No matching papers`}</strong>
              <p>{t`Use the + button to import this query if it isn't in your library yet.`}</p>
            </div>
          )}
          {!!props.papers.length && (
            <p className="paper-list-end">
              {filteredPapers.length !== props.papers.length
                ? filteredPapers.length === 1
                  ? t({ message: `1 of ${{ total: props.papers.length }} papers` })
                  : t({ message: `${{ filtered: filteredPapers.length }} of ${{ total: props.papers.length }} papers` })
                : props.papers.length === 1
                  ? t`1 paper`
                  : t({ message: `${{ count: props.papers.length }} papers` })}
            </p>
          )}
        </ScrollArea>
      </div>}
    </aside>
  );
}
