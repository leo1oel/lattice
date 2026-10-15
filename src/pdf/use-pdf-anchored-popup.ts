import { useLayoutEffect, type RefObject } from "react";
import type { PdfRect } from "../editor/comments/editor-comment-data";
import { clamp } from "../settings/app-settings";

/** A passage on a page, as fractions of the page. */
export type PdfPassage = { page: number; rects: readonly PdfRect[] };

/** The gap between a popup and its passage, and its least margin from the preview's edges. */
const GAP = 8;

/**
 * Keep a popup beside a passage on the PDF while the PDF scrolls or zooms:
 * under it (the note being written), or above it like the source editor's
 * card (a comment's card and preview), flipping under when there is more
 * room there. The popup is absolutely placed in the element that holds the
 * pages, its parent; `width` fixes its width (to the room there is), else it
 * keeps its own. It hides while its passage is out of view.
 */
export function usePdfAnchoredPopup(
  popupRef: RefObject<HTMLElement | null>,
  passage: PdfPassage | null,
  { side, width }: { side: "above" | "below"; width?: number },
) {
  useLayoutEffect(() => {
    const popup = popupRef.current;
    const column = popup?.parentElement;
    if (!popup || !column || !passage) return;
    const place = () => {
      const page = column.querySelector<HTMLElement>(`[data-page-number="${passage.page}"]`);
      if (!page || !passage.rects.length) {
        popup.style.visibility = "hidden";
        return;
      }
      const pageBox = page.getBoundingClientRect();
      const bounds = column.getBoundingClientRect();
      const room = Math.max(0, bounds.width - 2 * GAP);
      if (width === undefined) popup.style.maxWidth = `${room}px`;
      else popup.style.width = `${Math.min(width, room)}px`;
      const top = pageBox.top - bounds.top + Math.min(...passage.rects.map((rect) => rect.y)) * pageBox.height;
      const bottom = pageBox.top - bounds.top + Math.max(...passage.rects.map((rect) => rect.y + rect.height)) * pageBox.height;
      const left = pageBox.left - bounds.left + Math.min(...passage.rects.map((rect) => rect.x)) * pageBox.width;
      const roomAbove = top - GAP;
      const roomBelow = bounds.height - bottom - GAP;
      const above = side === "above" && (roomAbove >= popup.scrollHeight || roomAbove > roomBelow);
      const visible = above ? top > 0 && top < bounds.height : bottom > 0 && bottom < bounds.height;
      popup.dataset.side = above ? "top" : "bottom";
      Object.assign(popup.style, {
        visibility: visible ? "visible" : "hidden",
        left: `${clamp(left, GAP, Math.max(GAP, bounds.width - popup.offsetWidth - GAP))}px`,
        top: `${above ? top - GAP : bottom + GAP}px`,
        translate: above ? "0 -100%" : "none",
        maxHeight: `${Math.max(0, above ? roomAbove - GAP : roomBelow - GAP)}px`,
      });
    };
    place();
    column.addEventListener("scroll", place, { capture: true, passive: true });
    const observer = new ResizeObserver(place);
    observer.observe(column);
    return () => {
      column.removeEventListener("scroll", place, { capture: true });
      observer.disconnect();
    };
  }, [passage, popupRef, side, width]);
}
