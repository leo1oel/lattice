import { useEffect } from "react";
import type { ActiveViewerRef } from "./use-pdf-view";

/** Middle-click scrolling belongs to the PDF pane, including in webviews without native autoscroll. */
export function usePdfAutoscroll(recordRef: ActiveViewerRef, generation: number) {
  useEffect(() => {
    const area = recordRef.current?.root;
    if (!generation || !area) return;
    let frame = 0;
    let active = false;
    let blockedUp: number | null = null;
    let origin = 0;
    let pointer = 0;
    let previous = 0;
    const stop = () => {
      if (!active) return;
      active = false;
      cancelAnimationFrame(frame);
      area.classList.remove("pdf-autoscrolling");
    };
    const tick = (time: number) => {
      if (!active) return;
      const distance = pointer - origin;
      // A quiet center makes it possible to pause; speed follows distance,
      // not elapsed time, so returning towards the center always slows down.
      const outside = Math.max(0, Math.abs(distance) - 12);
      const speed = Math.sign(distance) * Math.min(1800, outside ** 1.4 * 2);
      area.scrollTop += speed * Math.min(32, time - previous) / 1000;
      previous = time;
      frame = requestAnimationFrame(tick);
    };
    const down = (event: MouseEvent) => {
      if (active) {
        blockedUp = event.button;
        event.preventDefault();
        event.stopPropagation();
        stop();
        return;
      }
      if (event.button !== 1 || !area.contains(event.target as Node)) return;
      // Middle-click links keeps its normal open-in-another-tab meaning.
      if ((event.target as Element).closest("a, button, input, textarea, select, [contenteditable=true]")) return;
      event.preventDefault();
      event.stopPropagation();
      active = true;
      blockedUp = 1;
      origin = pointer = event.clientY;
      previous = performance.now();
      area.classList.add("pdf-autoscrolling");
      frame = requestAnimationFrame(tick);
    };
    const up = (event: MouseEvent) => {
      if (blockedUp === event.button) {
        blockedUp = null;
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const move = (event: MouseEvent) => { pointer = event.clientY; };
    const key = (event: KeyboardEvent) => {
      if (active && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        stop();
      }
    };
    const auxiliary = (event: MouseEvent) => {
      if (event.button === 1 && area.contains(event.target as Node)
        && !(event.target as Element).closest("a, button, input, textarea, select, [contenteditable=true]")) event.preventDefault();
    };
    const visibility = () => { if (document.hidden) stop(); };
    document.addEventListener("mousedown", down, true);
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up, true);
    document.addEventListener("keydown", key, true);
    area.addEventListener("auxclick", auxiliary);
    area.addEventListener("wheel", stop, { passive: true });
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stop();
      document.removeEventListener("mousedown", down, true);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up, true);
      document.removeEventListener("keydown", key, true);
      area.removeEventListener("auxclick", auxiliary);
      area.removeEventListener("wheel", stop);
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [generation, recordRef]);
}
