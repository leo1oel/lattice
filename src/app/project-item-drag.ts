/** Dragging a Project-tree row: the tree moves files until the drag leaves its panel, then Trellis takes it. */
import type { TrellisController } from "../trellis/trellis-controller";

/**
 * Follow a pointer drag of a project-tree row. Past a 5px threshold,
 * `handOff` gets each pointer position until it takes the drag over (the
 * Trellis workspace, once the pointer leaves the Project panel); the click
 * that ends a handed-off drag is swallowed through `suppressClick`. A drag
 * that never leaves the panel belongs to the tree, which moves files.
 */
export function trackProjectItemDrag(
  path: string,
  event: React.PointerEvent,
  suppressClick: { current: string | null },
  handOff: (pointer: PointerEvent) => boolean,
) {
  if (event.button !== 0) return;
  const { clientX: startX, clientY: startY, pointerId } = event;
  let dragging = false;
  const listening = new AbortController();
  const end = () => {
    listening.abort();
    document.body.classList.remove("dragging-project-item");
  };
  const onMove = (pointer: PointerEvent) => {
    if (pointer.pointerId !== pointerId) return;
    if (!dragging && Math.hypot(pointer.clientX - startX, pointer.clientY - startY) < 5) return;
    if (!dragging) document.body.classList.add("dragging-project-item");
    dragging = true;
    if (!handOff(pointer)) return;
    end();
    suppressClick.current = path;
    window.setTimeout(() => {
      if (suppressClick.current === path) suppressClick.current = null;
    }, 400);
  };
  window.addEventListener("pointermove", onMove, { passive: false, signal: listening.signal });
  window.addEventListener("pointerup", end, { signal: listening.signal });
  window.addEventListener("pointercancel", end, { signal: listening.signal });
  window.addEventListener("blur", end, { signal: listening.signal });
}

/**
 * Once a tree drag leaves the Project panel, cancel the tree's own drag (it
 * moves files between folders) and let Trellis drag the file as a panel.
 */
export function trellisTakesProjectDrag(trellis: TrellisController, path: string, pointer: PointerEvent) {
  const panel = trellis.panelRect("project");
  if (!panel) return false;
  const inside = pointer.clientX >= panel.left && pointer.clientX <= panel.right
    && pointer.clientY >= panel.top && pointer.clientY <= panel.bottom;
  if (inside) return false;
  window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: pointer.pointerId, pointerType: pointer.pointerType }));
  return trellis.beginFileDrag(path, pointer);
}
