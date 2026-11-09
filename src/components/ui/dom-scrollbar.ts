import { calculateScrollAxisGeometry, EXTERNAL_THUMB, type ScrollAxisGeometry } from "./external-scrollbar-geometry";
import "./scroll-area.css";

const SCROLLING_HIDE_DELAY_MS = 500;

/**
 * `ExternalScrollbar` for DOM that CodeMirror builds outside React, such as a
 * hover card's list: the same `.lattice-scrollbar` track and thumb, revealed
 * while the pointer is over the list or it scrolls, over a viewport whose
 * native bar the owner's stylesheet hides. The track spans `viewport`'s
 * nearest positioned ancestor, which must be `surface`. Its listeners live on
 * these elements, so the card's removal is the teardown.
 */
export function appendVerticalScrollbar(viewport: HTMLElement, surface: HTMLElement): HTMLElement {
  const track = document.createElement("div");
  track.className = "lattice-scrollbar external-scrollbar";
  track.setAttribute("aria-hidden", "true");
  track.dataset.orientation = "vertical";
  const thumb = document.createElement("div");
  thumb.className = "lattice-scrollbar-thumb";
  thumb.dataset.slot = "scroll-area-thumb";
  track.append(thumb);
  surface.append(track);

  let axis: ScrollAxisGeometry | null = null;
  const measure = () => {
    const height = viewport.clientHeight;
    axis = calculateScrollAxisGeometry(
      { content: viewport.scrollHeight, offset: viewport.scrollTop, track: height, viewport: height },
      EXTERNAL_THUMB,
    );
    track.style.top = `${viewport.offsetTop}px`;
    track.style.height = `${height}px`;
    track.toggleAttribute("data-overflow-y-start", axis.canScrollStart);
    track.toggleAttribute("data-overflow-y-end", axis.canScrollEnd);
    thumb.style.height = `${axis.thumbSize}px`;
    thumb.style.transform = `translate3d(-2px, ${axis.thumbOffset}px, 0)`;
  };

  let idle: ReturnType<typeof setTimeout> | undefined;
  let drag: { pointerId: number; origin: number; start: number } | null = null;
  const settle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => { if (!drag) track.removeAttribute("data-scrolling"); }, SCROLLING_HIDE_DELAY_MS);
  };
  viewport.addEventListener("scroll", () => {
    measure();
    track.setAttribute("data-scrolling", "");
    settle();
  }, { passive: true });
  const hover = (on: boolean) => () => {
    if (on) measure();
    track.toggleAttribute("data-hovering", on);
  };
  for (const area of [viewport, track]) {
    area.addEventListener("pointerenter", hover(true));
    area.addEventListener("pointerleave", hover(false));
  }
  // The bar covers the list's edge, so a wheel over it still scrolls the list.
  track.addEventListener("wheel", (event) => {
    if (!axis?.overflow) return;
    event.preventDefault();
    viewport.scrollTop += event.deltaY;
  });
  track.addEventListener("pointerdown", (event) => {
    if (!axis?.overflow || event.target !== thumb) return;
    event.preventDefault();
    event.stopPropagation();
    track.setPointerCapture(event.pointerId);
    drag = { pointerId: event.pointerId, origin: event.clientY, start: viewport.scrollTop };
  });
  track.addEventListener("pointermove", (event) => {
    if (!drag || !axis || event.pointerId !== drag.pointerId || axis.travel <= 0) return;
    viewport.scrollTop = drag.start + (event.clientY - drag.origin) * (axis.maxOffset / axis.travel);
  });
  const end = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    settle();
  };
  track.addEventListener("pointerup", end);
  track.addEventListener("pointercancel", end);

  // Sized once the card is laid out, and again when its rows change.
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => {
      if (!viewport.isConnected) return observer.disconnect();
      measure();
    });
    observer.observe(viewport);
  }
  return track;
}
