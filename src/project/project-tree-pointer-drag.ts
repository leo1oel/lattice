/**
 * Mouse drags of project-tree rows. Tauri's native file-drop bridge and HTML5
 * row dragging do not share a reliable coordinate space when the WKWebView is
 * zoomed, so the gesture runs on pointer events (see `PIERRE_TREE_CSS`) and
 * Pierre's public model owns the actual move.
 */
import { useEffect, useRef } from "react";
import type { FileTreeDropTarget } from "@pierre/trees";
import type { useFileTree } from "@pierre/trees/react";
import {
  normalizePointerDraggedPaths,
  pointerDropOperations,
  pointerDropTarget,
  type PointerTreeDropLocation,
} from "./navigator-drag";

export type ProjectTreeModel = ReturnType<typeof useFileTree>["model"];

/** The dragged set: the whole selection when it includes `path`, minus paths a dragged folder carries. */
export function selectionIncluding(model: ProjectTreeModel, path: string): string[] {
  const selectedPaths = model.getSelectedPaths();
  return normalizePointerDraggedPaths(selectedPaths.includes(path) ? selectedPaths : [path]);
}

export function afterNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
  });
}

function clearPointerDragAppearance(root: ShadowRoot | null | undefined) {
  if (!root) return;
  if (root.host instanceof HTMLElement) delete root.host.dataset.latticePointerDragActive;
  for (const row of root.querySelectorAll<HTMLElement>(
    "[data-lattice-pointer-dragging], [data-lattice-pointer-drop-target]",
  )) {
    delete row.dataset.latticePointerDragging;
    delete row.dataset.latticePointerDropTarget;
  }
  for (const segment of root.querySelectorAll<HTMLElement>("[data-lattice-pointer-flattened-drop-target]")) {
    delete segment.dataset.latticePointerFlattenedDropTarget;
  }
}

const PREVIEW_STRIPPED_ATTRIBUTES = [
  "aria-expanded", "aria-haspopup", "aria-level", "aria-posinset", "aria-selected", "aria-setsize",
  "data-item-context-hover", "data-item-drag-target", "data-item-focused", "data-item-parent-path",
  "data-item-path", "data-item-selected", "id", "role",
];

type DragPreview = { moveTo: (x: number, y: number) => void; finish: () => void };

/** An inert clone of the source row that follows the pointer, with a count badge for batches. */
function createDragPreview(
  root: ShadowRoot,
  sourcePath: string,
  draggedCount: number,
  startX: number,
  startY: number,
): DragPreview | null {
  const source = Array.from(root.querySelectorAll<HTMLElement>("[data-type='item'][data-item-path]"))
    .find((row) => row.dataset.itemPath === sourcePath && row.dataset.fileTreeStickyRow !== "true");
  if (!source) return null;
  const rect = source.getBoundingClientRect();
  const preview = source.cloneNode(true) as HTMLElement;
  for (const attribute of PREVIEW_STRIPPED_ATTRIBUTES) preview.removeAttribute(attribute);
  preview.dataset.latticePointerDragPreview = "true";
  preview.setAttribute("aria-hidden", "true");
  // Keep the clone in Pierre's shadow root so it retains the row styles, but
  // promote it out of the sidebar's stacking context while crossing editors.
  // WKWebView and current browsers support manual popovers; the guard keeps
  // jsdom and older webviews on the previous (stacking-context-bound) fallback.
  preview.setAttribute("popover", "manual");
  preview.tabIndex = -1;
  preview.style.width = `${rect.width}px`;
  preview.style.height = `${rect.height}px`;
  if (draggedCount > 1) {
    const count = document.createElement("span");
    count.dataset.latticePointerDragCount = "true";
    count.textContent = String(draggedCount);
    preview.append(count);
  }
  const offsetX = Math.max(0, Math.min(rect.width, startX - rect.left));
  const offsetY = Math.max(0, Math.min(rect.height, startY - rect.top));
  root.append(preview);
  try {
    preview.showPopover?.();
  } catch {
    // A disconnected or unsupported popover can still serve as a local ghost.
  }
  // The browser-hosted app applies the interface scale as CSS `zoom` on the
  // root element, and the ghost inherits it: every pixel length set below
  // renders multiplied by that zoom, while the pointer and row coordinates it
  // is placed from are already zoomed client pixels. Left alone, the ghost
  // drifts rows away from the pointer (and the drop target, which is
  // hit-tested under the pointer), further the lower and further right the
  // pointer is. Measure the rendered scale once and divide it out. WKWebView's
  // page zoom keeps client pixels and CSS pixels equal, so it measures 1.
  const renderedScale = preview.getBoundingClientRect().width / rect.width;
  const scale = Number.isFinite(renderedScale) && renderedScale > 0 ? renderedScale : 1;
  if (scale !== 1) {
    preview.style.width = `${rect.width / scale}px`;
    preview.style.height = `${rect.height / scale}px`;
  }
  let frame: number | null = null;
  let point = { x: startX, y: startY };
  return {
    moveTo(x, y) {
      point = { x, y };
      if (frame != null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const left = (point.x - offsetX) / scale;
        const top = (point.y - offsetY) / scale;
        const nextTransform = `translate3d(${left}px, ${top}px, 0) scale(1)`;
        preview.style.transform = nextTransform;
        preview.style.opacity = "0.76";
      });
    },
    finish() {
      if (frame != null) window.cancelAnimationFrame(frame);
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true) {
        preview.remove();
        return;
      }
      // The fast tier's exit; the removal below waits it out.
      // eslint-disable-next-line lingui/no-unlocalized-strings -- a CSS transition value
      preview.style.transition = "opacity var(--motion-fast-exit), box-shadow var(--motion-fast-exit)";
      preview.style.opacity = "0";
      // It settles from the floating level to the raised one as it fades.
      preview.style.boxShadow = "var(--elevation-raised-shadow)";
      window.setTimeout(() => preview.remove(), 70);
    },
  };
}

type DragSession = {
  active: boolean;
  cancel: () => void;
  draggedPaths: readonly string[];
  preview: DragPreview | null;
  target: PointerTreeDropLocation | null;
};

/**
 * Returns the row pointerdown entry point plus the capture handlers that keep
 * Pierre's HTML5 drag and the post-drop click out of an active gesture.
 */
export function useProjectTreePointerDrag(
  model: ProjectTreeModel,
  options: {
    canDrag: (paths: readonly string[]) => boolean;
    onError: (message: string) => void;
    onDropped: (draggedPaths: readonly string[], target: FileTreeDropTarget) => void;
    resetTree: () => void;
  },
) {
  const sessionRef = useRef<DragSession | null>(null);
  const suppressClickRef = useRef(false);
  useEffect(() => () => sessionRef.current?.cancel(), []);

  const begin = (path: string, event: React.PointerEvent) => {
    if (event.button !== 0 || (event.pointerType && event.pointerType !== "mouse") || sessionRef.current) {
      return;
    }
    const { clientX: startX, clientY: startY, pointerId } = event;
    const treeRoot = () => model.getFileTreeContainer()?.shadowRoot;
    const finish = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
      clearPointerDragAppearance(treeRoot());
      session.preview?.finish();
      session.preview = null;
      if (sessionRef.current === session) sessionRef.current = null;
    };
    const session: DragSession = { active: false, cancel: finish, draggedPaths: [], preview: null, target: null };
    const updateTarget = (pointerEvent: PointerEvent) => {
      const root = treeRoot();
      if (!root) {
        session.target = null;
        return;
      }
      const location = pointerDropTarget(root, pointerEvent);
      session.target = location && pointerDropOperations(session.draggedPaths, location.target).length > 0
        ? location
        : null;
      clearPointerDragAppearance(root);
      if (root.host instanceof HTMLElement) root.host.dataset.latticePointerDragActive = "true";
      for (const row of root.querySelectorAll<HTMLElement>("[data-item-path]")) {
        if (session.draggedPaths.includes(row.dataset.itemPath ?? "")) row.dataset.latticePointerDragging = "true";
      }
      if (session.target?.row) session.target.row.dataset.latticePointerDropTarget = "true";
      if (session.target?.flattenedSegment) {
        session.target.flattenedSegment.dataset.latticePointerFlattenedDropTarget = "true";
      }
    };
    const onPointerMove = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      if (!session.active) {
        if (Math.hypot(pointerEvent.clientX - startX, pointerEvent.clientY - startY) < 5) return;
        const draggedPaths = selectionIncluding(model, path);
        if (model.getSearchValue().length > 0 || !options.canDrag(draggedPaths)) {
          finish();
          return;
        }
        session.active = true;
        session.draggedPaths = draggedPaths;
        model.focusPath(path);
        const root = treeRoot();
        if (root) session.preview = createDragPreview(root, path, draggedPaths.length, startX, startY);
      }
      pointerEvent.preventDefault();
      session.preview?.moveTo(pointerEvent.clientX, pointerEvent.clientY);
      updateTarget(pointerEvent);
    };
    const onPointerUp = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      const { active, draggedPaths } = session;
      if (active) updateTarget(pointerEvent);
      const location = session.target;
      finish();
      if (!active || !location) return;
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
      const operations = pointerDropOperations(draggedPaths, location.target);
      if (operations.length === 0) return;
      try {
        if (operations.length === 1) model.move(operations[0].from, operations[0].to);
        else model.batch(operations);
      } catch (reason) {
        options.resetTree();
        options.onError(reason instanceof Error ? reason.message : String(reason));
        return;
      }
      options.onDropped(draggedPaths, location.target);
    };
    sessionRef.current = session;
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
  };

  const swallow = (active: boolean, event: React.SyntheticEvent) => {
    if (!active) return;
    event.preventDefault();
    event.stopPropagation();
  };
  return {
    begin,
    onDragStartCapture: (event: React.DragEvent) => swallow(sessionRef.current !== null, event),
    onClickCapture: (event: React.MouseEvent) => swallow(suppressClickRef.current, event),
  };
}
