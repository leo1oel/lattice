import type { PointerEvent as ReactPointerEvent } from "react";

/** Share temporary boundary displacement with the grip and both adjacent panes. */
export function setSplitResizerResistance(grip: HTMLElement, overshoot: number) {
  const split = grip.parentElement;
  if (!split) return;
  const offset = Math.sign(overshoot) * 24 * (1 - Math.exp(-Math.abs(overshoot) / 100));
  // eslint-disable-next-line lingui/no-unlocalized-strings -- CSS custom property names, not user-facing text.
  const property = split.classList.contains("columns-canvas") && grip === split.children[3] ? "--split-pdf-offset" : "--split-resizer-offset";
  split.style.setProperty(property, `${offset}px`);
}

/**
 * Follow a resizer drag with window listeners until the pointer is released,
 * cancelled, or the window loses focus; then clear the grip's resistance and
 * let the caller commit the final position.
 */
export function trackResizeDrag(
  event: ReactPointerEvent<HTMLElement>,
  onMove: (moveEvent: PointerEvent, grip: HTMLElement) => void,
  onEnd: () => void,
) {
  event.preventDefault();
  const grip = event.currentTarget;
  document.body.classList.add("resizing-split");
  const handleMove = (moveEvent: PointerEvent) => onMove(moveEvent, grip);
  const handleUp = () => {
    document.body.classList.remove("resizing-split");
    setSplitResizerResistance(grip, 0);
    window.removeEventListener("pointermove", handleMove);
    window.removeEventListener("pointerup", handleUp);
    window.removeEventListener("pointercancel", handleUp);
    window.removeEventListener("blur", handleUp);
    onEnd();
  };
  window.addEventListener("pointermove", handleMove);
  window.addEventListener("pointerup", handleUp);
  window.addEventListener("pointercancel", handleUp);
  window.addEventListener("blur", handleUp);
}
