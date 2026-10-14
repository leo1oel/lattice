import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * Share temporary boundary displacement with the grip and both adjacent panes.
 * The property does not inherit (editor-workspace.css), so each of them gets
 * its own copy.
 */
export function setSplitResizerResistance(grip: HTMLElement, overshoot: number) {
  const split = grip.parentElement;
  if (!split) return;
  const offset = Math.sign(overshoot) * 24 * (1 - Math.exp(-Math.abs(overshoot) / 100));
  for (const child of split.children) (child as HTMLElement).style.setProperty("--split-resizer-offset", `${offset}px`);
}

/**
 * Follow a resizer drag with window listeners until the pointer is released,
 * cancelled, or the window loses focus; then clear the grip's resistance and
 * let the caller commit the final position. The grip holds the pointer, so a
 * drag across an HTML preview's frame keeps moving the split instead of
 * handing its moves to the frame.
 */
export function trackResizeDrag(
  event: ReactPointerEvent<HTMLElement>,
  onMove: (moveEvent: PointerEvent, grip: HTMLElement) => void,
  onEnd: () => void,
) {
  event.preventDefault();
  const grip = event.currentTarget;
  const { pointerId } = event;
  document.body.classList.add("resizing-split");
  const listening = new AbortController();
  const handleUp = () => {
    if (listening.signal.aborted) return;
    document.body.classList.remove("resizing-split");
    setSplitResizerResistance(grip, 0);
    listening.abort();
    if (grip.hasPointerCapture?.(pointerId)) grip.releasePointerCapture(pointerId);
    onEnd();
  };
  const { signal } = listening;
  grip.setPointerCapture?.(pointerId);
  window.addEventListener("pointermove", (moveEvent) => onMove(moveEvent, grip), { signal });
  for (const type of ["pointerup", "pointercancel", "blur"]) window.addEventListener(type, handleUp, { signal });
  grip.addEventListener("lostpointercapture", handleUp, { signal });
}
