/**
 * The pointer drag-and-drop core of the project file tree.
 *
 * Pierre renders the tree into a shadow root and its own HTML5 drag is
 * disabled (see `PIERRE_TREE_CSS` in `navigator.tsx`), so dropping a file is
 * decided here: where the pointer is over the tree, and what moves that
 * implies. Both answers are pure — one reads a composed event path, the other
 * only strings — which is what keeps the rules that have no visible failure
 * mode (a folder dropped into its own descendant, a drop that would move
 * nothing) checkable without driving a whole tree.
 */
import type { FileTreeBatchOperation, FileTreeDropTarget } from "@pierre/trees";

export function fromPierrePath(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

export function toPierreDirectoryPath(path: string): string {
  return `${fromPierrePath(path)}/`;
}

export type PointerTreeDropLocation = {
  flattenedSegment: HTMLElement | null;
  row: HTMLElement | null;
  target: FileTreeDropTarget;
};

export function pointerDropTarget(
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

export function pointerDragBasename(path: string): string {
  const trimmedPath = fromPierrePath(path);
  const basename = trimmedPath.split("/").at(-1) ?? trimmedPath;
  return path.endsWith("/") ? toPierreDirectoryPath(basename) : basename;
}

export function normalizePointerDraggedPaths(paths: readonly string[]): string[] {
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

export function pointerDropOperations(
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
