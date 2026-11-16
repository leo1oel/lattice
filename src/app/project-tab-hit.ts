export type Point = { x: number; y: number };

type DropSlot = { beforeRoot: string | null; offset: number };

/** Insert at the nearest boundary, ignoring the tab that's already being moved. */
export function findProjectDropSlot(strip: HTMLElement, point: Point, exclude?: string): DropSlot | undefined {
  const stripBox = strip.getBoundingClientRect();
  const { x, y } = point;
  if (!stripBox.width || x < stripBox.left || x >= stripBox.right || y < stripBox.top || y >= stripBox.bottom) {
    return;
  }
  // A modal or a floating control can cover the strip even though its bounds
  // match. Pointer capture itself doesn't affect elementFromPoint.
  const top = document.elementFromPoint?.(x, y);
  if (top && !strip.contains(top)) return;
  const offset = (edge: number) => (edge - stripBox.left) / stripBox.width * 100;
  let end = stripBox.left;
  for (const tab of strip.querySelectorAll<HTMLElement>("[data-project-root]")) {
    const root = tab.dataset.projectRoot;
    if (root === undefined || root === exclude) continue;
    const box = tab.getBoundingClientRect();
    if (x < (box.left + box.right) / 2) return { beforeRoot: root, offset: offset(box.left) };
    end = box.right;
  }
  return { beforeRoot: null, offset: offset(end) };
}

/** The insertion line is shared by local reorder and a drag over from another window. */
export function markProjectDrop(strip: HTMLElement, slot: DropSlot | undefined) {
  if (slot) strip.style.setProperty("--project-tab-drop-offset", `${slot.offset}%`);
  else strip.style.removeProperty("--project-tab-drop-offset");
  strip.toggleAttribute("data-project-drop", Boolean(slot));
}
