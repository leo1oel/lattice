import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react/macro";
import { MessageSquareText } from "lucide-react";
import type { AnnotationRounds } from "../app/annotation-rounds";
import { Tip } from "../components/icon-tip";
import { Button } from "../components/ui/button";
import { PanelHeader } from "../components/ui/panel-header";
import { CommentPreview } from "../editor/comments/comment-card";
import { useDismissOnOutsidePointer } from "../hooks/use-dismiss-on-outside-pointer";
import { formatCount } from "../i18n";
import type { PdfAnnotationMark } from "./pdf-annotations";
import { PdfCommentThread } from "./pdf-comment-popups";
import { layoutMarginCards, type MarginCard } from "./pdf-comment-margin";
import { addListeners } from "./pdf-viewer-utils";
import { pdfPageView } from "./pdf-slick";
import type { PlacedMark } from "./pdf-source-marks";
import type { ActiveViewerRef } from "./use-pdf-view";
import "./pdf-comment-column.css";

/** The meta line's middle, from the card's top: what stands level with the pin. */
function leadOf(slot: HTMLElement) {
  const meta = slot.querySelector<HTMLElement>(".comment-card-meta");
  if (!meta) return 0;
  const box = meta.getBoundingClientRect();
  return box.top - slot.getBoundingClientRect().top + box.height / 2;
}

/** Light a comment's passage on the PDF while the pointer rests on its card. */
function lightMark(root: HTMLElement | undefined, id: string | null) {
  for (const layer of root?.querySelectorAll<HTMLElement>(".pdf-annotation-mark") ?? []) {
    layer.toggleAttribute("data-hovered", layer.dataset.annotationId === id);
  }
}

/**
 * The PDF's comments beside its pages, Word's review margin: each card level
 * with its numbered mark (pdf-comment-margin.ts), following the pages as
 * they scroll and zoom. A card reads as the comment's preview; choosing it
 * (or its pin on the page) opens it in place as the card the source editor
 * shows, with Resolve, Reply and the way to its source. The comments are the
 * project's own (the same list the source and the Annotations panel draw),
 * so what is written on either side shows on the other.
 */
export function PdfCommentColumn({
  area, docked, recordRef, marks, places, rounds, active, onActivate, onClose, onResolving, onHide, redraw,
}: {
  area: HTMLElement;
  docked: boolean;
  recordRef: ActiveViewerRef;
  marks: readonly PdfAnnotationMark[];
  places: ReadonlyMap<string, PlacedMark> | null;
  rounds: AnnotationRounds;
  /** The open card, and whether it was opened from the keyboard (which then moves focus into it). */
  active: { id: string; keyboard: boolean } | null;
  onActivate: (id: string, keyboard: boolean) => void;
  onClose: () => void;
  onResolving: (id: string) => void;
  onHide: () => void;
  /** Changes whenever the pages are drawn again or zoomed, which moves the marks. */
  redraw: string;
}) {
  const { t } = useLingui();
  const bodyRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const activeSlotRef = useRef<HTMLDivElement>(null);
  // In reading order, as the keyboard walks them: by page, then down it.
  const placedMarks = places
    ? marks.filter((mark) => places.has(mark.id)).sort((left, right) => {
      const [a, b] = [places.get(left.id)!, places.get(right.id)!];
      return a.page - b.page || a.pin.y - b.pin.y;
    })
    : [];
  const activeId = active && placedMarks.some((mark) => mark.id === active.id) ? active.id : null;

  // Stand each card level with its mark, again whenever a card, the pages or
  // the pane change size; scrolling the pages only slides the whole track.
  useLayoutEffect(() => {
    const record = recordRef.current;
    const body = bodyRef.current;
    const track = trackRef.current;
    if (!record || !body || !track || !places) return;
    const root = record.root;
    let shift = 0;
    let frame: number | null = null;
    const slide = () => {
      // Where overflow: clip is unknown the body still scrolls a typed caret into view; the track alone moves.
      body.scrollTop = 0;
      track.style.transform = `translateY(${shift - root.scrollTop}px)`;
    };
    const place = () => {
      frame = null;
      const rootTop = root.getBoundingClientRect().top;
      shift = rootTop - body.getBoundingClientRect().top;
      const cards: MarginCard[] = [];
      const slots = new Map<string, HTMLElement>();
      for (const slot of track.querySelectorAll<HTMLElement>(":scope > .pdf-comment-slot")) {
        const id = slot.dataset.commentId ?? "";
        const at = places.get(id);
        const page = at && pdfPageView(record.slick, at.page)?.div;
        if (!at || !page) continue;
        const box = page.getBoundingClientRect();
        cards.push({ id, anchor: box.top - rootTop + root.scrollTop + at.pin.y * box.height - leadOf(slot), height: slot.offsetHeight });
        slots.set(id, slot);
      }
      for (const [id, top] of layoutMarginCards(cards, activeId)) slots.get(id)!.style.top = `${top}px`;
      slide();
    };
    const schedule = () => {
      frame ??= window.requestAnimationFrame(place);
    };
    place();
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    for (const slot of track.children) observer.observe(slot);
    const removeScroll = addListeners(root, { scroll: slide }, { passive: true });
    const removeBodyScroll = addListeners(body, { scroll: slide }, { passive: true });
    return () => {
      removeBodyScroll();
      if (frame !== null) window.cancelAnimationFrame(frame);
      observer.disconnect();
      removeScroll();
    };
  }, [activeId, marks, places, recordRef, redraw]);

  const keyboard = active?.keyboard ?? false;
  useEffect(() => {
    if (activeId && keyboard) activeSlotRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [activeId, keyboard]);
  // A press anywhere else closes the open card; its pin and the other cards act for themselves.
  useDismissOnOutsidePointer(activeId ? activeSlotRef : null, onClose, (target) => Boolean(
    target.closest(".pdf-comment-column") || (activeId && target.closest(`[data-annotation-id="${CSS.escape(activeId)}"]`)),
  ));

  const light = (id: string | null) => lightMark(recordRef.current?.root, id);
  return createPortal(
    <aside className="pdf-comment-column" data-docked={docked ? "" : undefined} aria-label={t`Comments`}>
      <PanelHeader
        className="pdf-comment-column-head"
        title={t`Comments`}
        titleAfter={<span className="pdf-comment-column-count">{formatCount(marks.length)}</span>}
        onClose={onHide}
        closeLabel={t`Hide comments`}
      />
      <div ref={bodyRef} className="pdf-comment-column-body" onMouseLeave={() => light(null)}>
        <div ref={trackRef} className="pdf-comment-column-track">
          {placedMarks.map(({ id, annotation }) => (
            <div
              key={id}
              ref={id === activeId ? activeSlotRef : undefined}
              className="pdf-comment-slot"
              data-comment-id={id}
              data-active={id === activeId ? "" : undefined}
              onMouseEnter={() => light(id)}
            >
              {id === activeId ? (
                <PdfCommentThread still annotation={annotation} rounds={rounds} onResolving={onResolving} onClose={onClose} />
              ) : (
                <div
                  role="button"
                  tabIndex={0}
                  className="pdf-comment-slot-preview"
                  onClick={() => onActivate(id, false)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onActivate(id, true);
                  }}
                >
                  <CommentPreview comments={[annotation]} />
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </aside>,
    area,
  );
}

/** Brings the folded column back: its icon and how many comments it holds, in the pages' top corner. */
export function PdfCommentToggle({ area, count, onShow }: { area: HTMLElement; count: number; onShow: () => void }) {
  const { t } = useLingui();
  const label = t`Show comments`;
  return createPortal(
    <Tip label={label}>
      <Button size="compact" className="pdf-comment-toggle" aria-label={label} onClick={onShow}>
        <MessageSquareText size={14} aria-hidden="true" />
        {formatCount(count)}
      </Button>
    </Tip>,
    area,
  );
}
