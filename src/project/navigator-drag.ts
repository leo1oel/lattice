/**
 * The pointer drag-and-drop core of the project file tree.
 *
 * Pierre renders the tree into a shadow root and its own HTML5 drag is
 * disabled (see `PIERRE_TREE_CSS` in `project-tree-css.ts`), so dropping a
 * file is decided here: where the pointer is over the tree, and what moves
 * that implies. Both answers are narrow — one reads only what the engine
 * hit-tested (an event's composed path, or the element at a point), the other
 * only strings — which is what keeps the rules that have no visible
 * failure mode (a folder dropped into its own descendant, a drop that would
 * move nothing) checkable without driving a whole tree.
 */
import type { FileTreeBatchOperation, FileTreeDropTarget } from "@pierre/trees";

export function fromPierrePath(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

export function toPierreDirectoryPath(path: string): string {
  return `${fromPierrePath(path)}/`;
}

/** The app-side directory a drop lands in ("" is the project root). */
export function dropTargetDirectory(target: FileTreeDropTarget): string {
  return fromPierrePath(target.flattenedSegmentPath ?? target.directoryPath ?? "");
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
  return element ? dropLocationAt(element) : null;
}

/**
 * The drop location under a resting pointer. A wheel or trackpad scroll moves
 * the rows beneath it and sends no pointer event, so this asks the engine what
 * is at the point now.
 */
export function pointerDropTargetAt(root: ShadowRoot, x: number, y: number): PointerTreeDropLocation | null {
  const element = root.elementFromPoint(x, y);
  return element && root.contains(element) ? dropLocationAt(element) : null;
}

function dropLocationAt(element: Element): PointerTreeDropLocation | null {
  const row = element.closest<HTMLElement>("[data-type='item']");
  const hoveredPath = row?.dataset.itemPath || null;
  if (row && !hoveredPath) return null;
  const location = (
    directoryPath: string | null,
    flattenedSegment: HTMLElement | null = null,
  ): PointerTreeDropLocation => ({
    flattenedSegment,
    row,
    target: {
      directoryPath,
      flattenedSegmentPath: flattenedSegment ? directoryPath : null,
      hoveredPath,
      kind: directoryPath ? "directory" : "root",
    },
  });
  // Empty space below the rows is still inside the tree: the project root.
  if (!row) return location(null);
  const flattenedSegment = element.closest<HTMLElement>("[data-item-flattened-subitem]");
  const flattenedSegmentPath = flattenedSegment?.dataset.itemFlattenedSubitem;
  if (flattenedSegmentPath?.endsWith("/")) return location(flattenedSegmentPath, flattenedSegment);
  if (row.dataset.itemType === "folder") return location(hoveredPath);
  return location(row.dataset.itemParentPath || null);
}

export function pointerDragBasename(path: string): string {
  const basename = fromPierrePath(path).split("/").pop() ?? "";
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

export type PointerTreeMove = Extract<FileTreeBatchOperation, { type: "move" }>;

export function pointerDropOperations(
  draggedPaths: readonly string[],
  target: FileTreeDropTarget,
): PointerTreeMove[] {
  const directory = target.kind === "root" ? null : target.directoryPath;
  if (directory && draggedPaths.some((path) => path.endsWith("/") && directory.startsWith(path))) {
    return [];
  }
  return draggedPaths.flatMap((path): PointerTreeMove[] => {
    const basename = pointerDragBasename(path);
    if ((directory ? `${directory}${basename}` : basename) === path) return [];
    return [{ from: path, to: directory || basename, type: "move" }];
  });
}
