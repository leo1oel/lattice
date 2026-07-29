import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type {
  ContextMenuItem as PierreContextMenuItem,
  ContextMenuOpenContext as PierreContextMenuOpenContext,
  FileTreeBatchOperation,
  FileTreeDropTarget,
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
  LoaderCircle,
  Pencil,
  Plus,
  Quote,
  Trash2,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./components/ui/context-menu";
import { ScrollArea } from "./components/ui/scroll-area";
import { paperKey, paperSubtitle, CITE_COMMANDS } from "./app-utils";
import type { FileNode, GitFileStatus, PaperSummary, CiteCommand } from "./app-types";
import { toPierreGitStatus } from "./project-tree-git";

function readExpandedDirectories(key: string): Set<string> {
  try {
    const stored = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return new Set(Array.isArray(stored) ? stored.filter((path): path is string => typeof path === "string") : []);
  } catch {
    return new Set();
  }
}

function fromPierrePath(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function toPierreDirectoryPath(path: string): string {
  return `${fromPierrePath(path)}/`;
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

button[data-type="item"] {
  background: transparent;
  letter-spacing: -0.005em;
  transition:
    background-color 140ms cubic-bezier(.2, .8, .2, 1),
    box-shadow 140ms cubic-bezier(.2, .8, .2, 1),
    color 120ms ease,
    opacity 100ms ease;
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
  z-index: 10000;
  margin: 0;
  overflow: visible;
  border: 1px solid color-mix(in srgb, var(--text) 9%, transparent);
  border-radius: 7px;
  background: color-mix(in srgb, var(--panel-strong) 54%, transparent);
  box-shadow:
    0 8px 22px color-mix(in srgb, #000 11%, transparent),
    0 2px 6px color-mix(in srgb, #000 7%, transparent);
  opacity: 0;
  pointer-events: none;
  transform-origin: center;
  will-change: transform, opacity;
  backdrop-filter: blur(10px) saturate(92%);
  -webkit-backdrop-filter: blur(10px) saturate(92%);
  transition:
    opacity 70ms ease-out,
    box-shadow 90ms ease;
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
  border: 1px solid color-mix(in srgb, var(--panel-strong) 80%, transparent);
  border-radius: 999px;
  background: var(--accent);
  box-shadow: 0 2px 6px color-mix(in srgb, #000 18%, transparent);
  color: var(--accent-contrast);
  font-size: 9px;
  font-weight: 650;
  line-height: 1;
}

button[data-type="item"]:hover:not([data-item-selected="true"]),
button[data-type="item"][data-item-context-hover="true"]:not([data-item-selected="true"]) {
  background: var(--trees-bg-muted);
}

button[data-type="item"][data-item-selected="true"] {
  background: var(--trees-selected-bg);
  font-weight: 500;
}

button[data-type="item"][data-item-focused="true"]::before {
  outline-color: transparent;
}

button[data-type="item"]:focus-visible::before {
  outline: 1px solid color-mix(in srgb, var(--text) 24%, transparent);
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
  background: color-mix(in srgb, var(--text) 9%, transparent);
  color: var(--text);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 18%, transparent);
}

[data-item-drag-target="true"] {
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 18%, transparent);
}

button[data-type="item"][data-lattice-pointer-drop-target="true"] {
  background: var(--accent-soft);
  color: var(--text);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--accent) 27%, transparent),
    0 1px 4px color-mix(in srgb, #000 4%, transparent);
}

[data-item-flattened-subitem][data-lattice-pointer-flattened-drop-target="true"] {
  border-radius: 4px;
  background: var(--accent-soft);
}

@media (prefers-reduced-motion: reduce) {
  button[data-type="item"],
  button[data-type="item"][data-lattice-pointer-drag-preview="true"] {
    transition: none;
  }
}

[data-file-tree-search-container] {
  margin: 0 2px 7px;
}

[data-file-tree-search-container][data-open="false"] {
  display: none;
}

[data-file-tree-search-input] {
  box-sizing: border-box;
  height: 28px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: color-mix(in srgb, var(--text) 5%, transparent);
  box-shadow: inset 0 0 0 0.5px color-mix(in srgb, var(--text) 5%, transparent);
  color: var(--text);
  font-size: 11px;
  font-weight: 400;
  line-height: 28px;
  transition:
    background-color 120ms ease,
    border-color 120ms ease,
    box-shadow 120ms ease;
}

[data-file-tree-search-input]::placeholder {
  color: var(--faint);
}

[data-file-tree-search-input]:focus-visible,
[data-file-tree-search-input][data-file-tree-search-input-fake-focus="true"] {
  border-color: color-mix(in srgb, var(--text) 14%, transparent);
  outline: none;
  background: color-mix(in srgb, var(--panel-strong) 92%, transparent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--text) 5%, transparent);
}

[data-item-rename-input] {
  height: 20px;
  padding: 0 5px;
  border: 1px solid color-mix(in srgb, var(--text) 18%, transparent);
  border-radius: 5px;
  background: var(--panel-strong);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--text) 5%, transparent);
}
`;

type ProjectFileTreeProps = {
  projectKey: string;
  searchOpen: boolean;
  onSearchOpenChange: (open: boolean) => void;
  files: FileNode[];
  gitStatus: GitFileStatus[];
  activeFile: string;
  activeAssetPath: string;
  protectedPaths: string[];
  onFile: (path: string) => void;
  onAsset: (path: string) => void;
  onBeginFigureDrag: (path: string, label: string, event: React.PointerEvent) => void;
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

type PointerTreeDropLocation = {
  flattenedSegment: HTMLElement | null;
  row: HTMLElement | null;
  target: FileTreeDropTarget;
};

function pointerDropTarget(
  root: ShadowRoot,
  event: PointerEvent,
): PointerTreeDropLocation | null {
  const element = event.composedPath().find(
    (target): target is Element => target instanceof Element && root.contains(target),
  );
  if (!element) return null;
  const row = element.closest<HTMLElement>("[data-type='item']");
  if (!row) {
    return {
      flattenedSegment: null,
      row: null,
      target: {
        directoryPath: null,
        flattenedSegmentPath: null,
        hoveredPath: null,
        kind: "root",
      },
    };
  }
  const hoveredPath = row.dataset.itemPath ?? null;
  if (!hoveredPath) return null;
  const flattenedSegment = element.closest<HTMLElement>("[data-item-flattened-subitem]");
  const flattenedSegmentPath = flattenedSegment?.dataset.itemFlattenedSubitem ?? null;
  if (flattenedSegmentPath?.endsWith("/")) {
    return {
      flattenedSegment,
      row,
      target: {
        directoryPath: flattenedSegmentPath,
        flattenedSegmentPath,
        hoveredPath,
        kind: "directory",
      },
    };
  }
  if (row.dataset.itemType === "folder") {
    return {
      flattenedSegment: null,
      row,
      target: {
        directoryPath: hoveredPath,
        flattenedSegmentPath: null,
        hoveredPath,
        kind: "directory",
      },
    };
  }
  const parentPath = row.dataset.itemParentPath ?? null;
  if (!parentPath) {
    return {
      flattenedSegment: null,
      row,
      target: {
        directoryPath: null,
        flattenedSegmentPath: null,
        hoveredPath,
        kind: "root",
      },
    };
  }
  return {
    flattenedSegment: null,
    row,
    target: {
      directoryPath: parentPath,
      flattenedSegmentPath: null,
      hoveredPath,
      kind: "directory",
    },
  };
}

function pointerDragBasename(path: string): string {
  const trimmedPath = fromPierrePath(path);
  const basename = trimmedPath.split("/").at(-1) ?? trimmedPath;
  return path.endsWith("/") ? toPierreDirectoryPath(basename) : basename;
}

function normalizePointerDraggedPaths(paths: readonly string[]): string[] {
  const uniquePaths = [...new Set(paths)];
  const directoryPaths = new Set(uniquePaths.filter((path) => path.endsWith("/")));
  return uniquePaths.filter((path) => {
    const segments = fromPierrePath(path).split("/");
    for (let index = 1; index < segments.length; index += 1) {
      if (directoryPaths.has(`${segments.slice(0, index).join("/")}/`)) return false;
    }
    return true;
  });
}

function pointerDropOperations(
  draggedPaths: readonly string[],
  target: FileTreeDropTarget,
): FileTreeBatchOperation[] {
  const targetDirectoryPath = target.directoryPath;
  if (
    target.kind === "directory"
    && targetDirectoryPath
    && draggedPaths.some(
      (path) => path.endsWith("/")
        && (targetDirectoryPath === path || targetDirectoryPath.startsWith(path)),
    )
  ) {
    return [];
  }
  return draggedPaths.flatMap((path): FileTreeBatchOperation[] => {
    const basename = pointerDragBasename(path);
    const finalPath = target.kind === "root" || !targetDirectoryPath
      ? basename
      : `${targetDirectoryPath}${basename}`;
    if (finalPath === path) return [];
    return [{
      from: path,
      to: target.kind === "root" || !targetDirectoryPath
        ? basename
        : targetDirectoryPath,
      type: "move",
    }];
  });
}

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
  const tree = useMemo(() => projectTreeEntries(props.files), [props.files]);
  const gitStatus = useMemo(() => toPierreGitStatus(props.gitStatus), [props.gitStatus]);
  const expansionStorageKey = `lattice:expanded-directories:${props.projectKey}`;
  const propsRef = useRef(props);
  const treeRef = useRef(tree);
  const modelRef = useRef<ReturnType<typeof useFileTree>["model"] | null>(null);
  const syncingSelectionRef = useRef(false);
  const pendingCreationsRef = useRef(new Map<string, "file" | "folder">());
  const pendingCleanupTimersRef = useRef(new Map<string, number>());
  const pointerTreeDragRef = useRef<PointerTreeDragSession | null>(null);
  const suppressTreeClickRef = useRef(false);
  const clearPendingCreation = useCallback((path: string) => {
    const normalizedPath = fromPierrePath(path);
    const kind = pendingCreationsRef.current.get(normalizedPath);
    if (!kind) return false;
    pendingCreationsRef.current.delete(normalizedPath);
    const currentModel = modelRef.current;
    const modelPath = kind === "folder"
      ? toPierreDirectoryPath(normalizedPath)
      : normalizedPath;
    if (currentModel?.getItem(modelPath)) {
      currentModel.remove(modelPath, kind === "folder" ? { recursive: true } : undefined);
    }
    return true;
  }, []);
  const persistPendingCreation = useCallback((
    sourcePath: string,
    destinationPath: string,
    isFolder: boolean,
  ) => {
    const source = fromPierrePath(sourcePath);
    const destination = fromPierrePath(destinationPath);
    const kind = pendingCreationsRef.current.get(source);
    if (!kind) return false;
    pendingCreationsRef.current.delete(source);
    void propsRef.current
      .onCreateEntry(destination, kind)
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
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    gitStatus,
    icons: "complete",
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
      if (node.kind === "figure") propsRef.current.onAsset(node.path);
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
                const kind = pendingCreationsRef.current.get(path);
                if (kind) persistPendingCreation(path, path, kind === "folder");
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
    const unsubscribe = model.subscribe(scheduleCleanup);
    return () => {
      unsubscribe();
      for (const timer of pendingCleanupTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      pendingCleanupTimersRef.current.clear();
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
  const beginInlineCreate = (targetDirectory: string, kind: "file" | "folder") => {
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
    pendingCreationsRef.current.set(placeholderPath, kind);
    if (!model.startRenaming(modelPath, { removeIfCanceled: true })) {
      pendingCreationsRef.current.delete(placeholderPath);
      model.remove(modelPath, kind === "folder" ? { recursive: true } : undefined);
    }
  };
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
    return (
      <div className="file-tree-context-menu" data-file-tree-context-menu-root="true" role="menu">
        <button role="menuitem" onClick={() => closeThen(context, () => beginInlineCreate(targetDirectory, "file"))}>
          <FilePlus size={14} />New file
        </button>
        <button role="menuitem" onClick={() => closeThen(context, () => beginInlineCreate(targetDirectory, "folder"))}>
          <FolderPlus size={14} />New folder
        </button>
        <button role="menuitem" onClick={() => closeThen(context, () => model.startRenaming(item.path))}>
          <Pencil size={14} />Rename
        </button>
        <button role="menuitem" onClick={() => closeThen(context, () => void writeText(path))}>
          <Copy size={14} />Copy path
        </button>
        <button role="menuitem" onClick={() => closeThen(context, () => props.onReveal(path))}>
          <FolderOpen size={14} />Show in Finder
        </button>
        {item.kind === "directory" && (
          <button
            role="menuitem"
            disabled={props.assetImporting}
            onClick={() => closeThen(context, () => props.onImportAssets(path))}
          >
            <ImagePlus size={14} />Import images here
          </button>
        )}
        {!protectedEntry && (
          <button
            className="destructive"
            role="menuitem"
            onClick={() => closeThen(context, () => {
              if (!clearPendingCreation(path)) props.onDeleteEntry(path);
            })}
          >
            <Trash2 size={14} />{pendingCreation ? "Cancel creation" : "Delete"}
          </button>
        )}
      </div>
    );
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="project-file-tree-surface" aria-label="Project files">
          <FileTree
            className="lattice-file-tree"
            model={model}
            renderContextMenu={renderContextMenu}
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
              if (node?.kind === "figure") {
                props.onBeginFigureDrag(node.path, node.name, event);
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
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
        <ContextMenuItem onSelect={() => afterMenuClose(() => beginInlineCreate("", "file"))}>
          <FilePlus size={14} />New file
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => afterMenuClose(() => beginInlineCreate("", "folder"))}>
          <FolderPlus size={14} />New folder
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
  files: FileNode[];
  gitStatus: GitFileStatus[];
  activeFile: string;
  activeAssetPath: string;
  protectedPaths: string[];
  papers: PaperSummary[];
  activePaper: PaperSummary | null;
  onFile: (path: string, line?: number) => void;
  onAsset: (path: string) => void;
  onBeginFigureDrag: (path: string, label: string, event: React.PointerEvent) => void;
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
  onCitePaper: (paper: PaperSummary, command: CiteCommand) => void;
  onFetchFullText: (paper: PaperSummary) => void;
  paperFetchStates: Record<string, "loading" | "success">;
  onDeletePaper: (paper: PaperSummary) => void;
  onEditBibEntry: (paper: PaperSummary) => void;
  importInput: string;
  setImportInput: (value: string) => void;
  onImport: () => void;
  importing: boolean;
}) {
  const paperImportRef = useRef<HTMLInputElement | null>(null);
  const [citeMenuId, setCiteMenuId] = useState<string | null>(null);
  useEffect(() => {
    if (!citeMenuId) return;
    const close = () => setCiteMenuId(null);
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeWithEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeWithEscape);
    };
  }, [citeMenuId]);
  const renderPaperContextMenu = (
    path: string,
    children: React.ReactElement,
  ) => {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
          <ContextMenuItem onSelect={() => props.onReveal(path)}><FolderOpen size={14} />Show in Finder</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };
  return (
    <aside className={`navigator ${props.assetDropTarget ? "asset-drag-active" : ""}`}>
      {props.mode === "project" && <div className="navigator-section project-section">
        <ProjectFileTree
          key={`project-tree:${props.projectKey}:default-complete-context-v4`}
          projectKey={props.projectKey}
          searchOpen={props.searchOpen}
          onSearchOpenChange={props.onSearchOpenChange}
          files={props.files}
          gitStatus={props.gitStatus}
          activeFile={props.activeFile}
          activeAssetPath={props.activeAssetPath}
          protectedPaths={props.protectedPaths}
          onFile={props.onFile}
          onAsset={props.onAsset}
          onBeginFigureDrag={props.onBeginFigureDrag}
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
        <div className="import-box">
          <input
            ref={paperImportRef}
            aria-label="Import paper"
            placeholder="arXiv id, DOI, URL, or title"
            value={props.importInput}
            onChange={(event) => props.setImportInput(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && props.onImport()}
          />
          <button onClick={props.onImport} disabled={props.importing || !props.importInput.trim()} title="Import paper">
            {props.importing ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}
          </button>
        </div>
        <ScrollArea
          className="paper-list"
          orientation="both"
          contentClassName="paper-list-content"
          viewportProps={{ role: "list", "aria-label": "Papers" }}
        >
          {/* Matched on the arXiv id when there is one, on the title when
              there is not: a cited-only work carries an empty id, so comparing
              ids alone returned the same first paper for every one of them —
              the list showed that paper once per match and the others could
              not be reached while a filter was active. */}
          {props.papers.map((paper) => {
            const fetchState = props.paperFetchStates[paperKey(paper)];
            const locallyReadable = paper.hasFullText || paper.hasBlog;
            const row = (
              <div className={`paper-row ${paper.hasFullText ? "" : "cited-only "}${props.activePaper && paperKey(props.activePaper) === paperKey(paper) ? "active" : ""}`}>
              <button
                title={locallyReadable
                  ? paper.title
                  : paper.arxivId
                    ? `Download arXiv ${paper.arxivId}`
                    : `${paper.title} — no local reading available`}
                className="paper-open"
                // Knowing the preprint is as good as having it: clicking fetches.
                disabled={fetchState === "loading" || (!locallyReadable && !paper.arxivId)}
                onClick={() => locallyReadable ? props.onPaper(paper) : props.onFetchFullText(paper)}
              >
                <span className={`paper-state-icon ${fetchState ?? (locallyReadable ? "available" : "idle")}`}>
                  {fetchState === "loading"
                    ? <LoaderCircle className="spin" size={14} />
                    : fetchState === "success"
                      ? <Check size={14} />
                      : locallyReadable
                        ? <BookOpen size={14} />
                        : paper.arxivId
                          ? <Download size={14} />
                          : <BookMarked size={14} />}
                </span>
                <span><strong>{paper.title}</strong><small>{paperSubtitle(paper)}</small></span>
              </button>
              {paper.citationKey && (
                <div className="cite-menu-wrap">
                  <button
                    className="row-cite"
                    title={`Insert citation for ${paper.citationKey}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setCiteMenuId((current) => current === paperKey(paper) ? null : paperKey(paper));
                    }}
                  >
                    <Quote size={12} />
                  </button>
                  {citeMenuId === paperKey(paper) && (
                    <div className="cite-command-menu" onPointerDown={(event) => event.stopPropagation()}>
                      {CITE_COMMANDS.map((command) => (
                        <button
                          key={command}
                          type="button"
                          onClick={() => {
                            props.onCitePaper(paper, command);
                            setCiteMenuId(null);
                          }}
                        >
                          \{command}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {paper.citationKey && (
                <button className="row-edit-bib" title="Edit bibliography entry" onClick={() => props.onEditBibEntry(paper)}><Pencil size={12} /></button>
              )}
              <button className="row-delete" title={`Remove ${paper.title}`} onClick={() => props.onDeletePaper(paper)}><Trash2 size={12} /></button>
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
              <strong>Add your first paper</strong>
              <p>Paste an arXiv ID, DOI, URL, or title above to ground the agent in project evidence.</p>
              <button type="button" onClick={() => paperImportRef.current?.focus()}>Focus search</button>
            </div>
          )}
          {!!props.papers.length && <p className="paper-list-end">{props.papers.length} paper{props.papers.length === 1 ? "" : "s"}</p>}
        </ScrollArea>
      </div>}
    </aside>
  );
}
