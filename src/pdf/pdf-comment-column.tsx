import { useEffect, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react/macro";
import { MessageSquareText } from "lucide-react";
import type { AnnotationRounds } from "../app/annotation-rounds";
import { Tip } from "../components/icon-tip";
import { Button } from "../components/ui/button";
import { PanelHeader } from "../components/ui/panel-header";
import { ScrollArea } from "../components/ui/scroll-area";
import { CommentPreview } from "../editor/comments/comment-card";
import { trackResizeDrag } from "../canvas/split-resizer";
import { useDismissOnOutsidePointer } from "../hooks/use-dismiss-on-outside-pointer";
import { formatCount } from "../i18n";
import { clamp } from "../lib/clamp";
import { PDF_COMMENT_COLUMN_WIDTH } from "../settings/app-settings";
import type { PdfAnnotationMark } from "./pdf-annotations";
import { PdfCommentThread } from "./pdf-comment-popups";
import { lightMark } from "./pdf-drawn-annotations";
import { layoutMarginCards, type MarginCard } from "./pdf-comment-margin";
import { addListeners } from "./pdf-viewer-utils";
import { pdfPageView } from "./pdf-slick";
import type { PlacedMark } from "./pdf-source-marks";
import type { ActiveViewerRef } from "./use-pdf-view";
import "./pdf-comment-column.css";

/** The room a docked column leaves the pages; pdf-comment-column.css caps its width the same way. */
const PAGES_MIN_WIDTH = 360;
/** What a folded column leaves of the pages it opens over (--space-12). */
const FOLDED_PAGES_MARGIN = 48;
const KEY_STEP = 16;

/**
 * The column's left-edge grip, as the app's drawers have: dragged or moved
 * with the arrow keys, it widens the column into the pages. The drag writes
 * the width to the scroll area outside React and letting go commits it.
 */
function ColumnResizer({ area, docked, width, onResize }: {
  area: HTMLElement;
  docked: boolean;
  width: number;
  onResize: (width: number) => void;
}) {
  const { t } = useLingui();
  // The widest the column may be drawn here, and what it is drawn at now (a narrow PDF caps the chosen width).
  const widest = () => Math.min(PDF_COMMENT_COLUMN_WIDTH.max, area.clientWidth - (docked ? PAGES_MIN_WIDTH : FOLDED_PAGES_MARGIN));
  const fit = (next: number) => clamp(next, PDF_COMMENT_COLUMN_WIDTH.min, Math.max(PDF_COMMENT_COLUMN_WIDTH.min, widest()));
  const drawn = (grip: HTMLElement) => grip.parentElement?.getBoundingClientRect().width || width;
  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startWidth = drawn(event.currentTarget);
    let next = startWidth;
    trackResizeDrag(event, (move) => {
      next = fit(startWidth - (move.clientX - startX));
      area.style.setProperty("--pdf-comment-column-chosen-width", `${next}px`);
    }, () => onResize(next));
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    onResize(fit(drawn(event.currentTarget) + (event.key === "ArrowLeft" ? KEY_STEP : -KEY_STEP)));
  };
  return (
    <div
      className="pdf-comment-column-resizer panel-resizer"
      role="separator"
      aria-label={t`Resize comments`}
      aria-orientation="vertical"
      aria-valuemin={PDF_COMMENT_COLUMN_WIDTH.min}
      aria-valuemax={PDF_COMMENT_COLUMN_WIDTH.max}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onPointerDown={beginResize}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onResize(PDF_COMMENT_COLUMN_WIDTH.default)}
    />
  );
}

/** The meta line's middle, from the card's top: what stands level with the pin. */
function leadOf(slot: HTMLElement) {
  const meta = slot.querySelector<HTMLElement>(".comment-card-meta");
  if (!meta) return 0;
  const box = meta.getBoundingClientRect();
  return box.top - slot.getBoundingClientRect().top + box.height / 2;
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
  area, docked, width, onResize, recordRef, marks, places, rounds, active, onActivate, onClose, onResolving, onHide, redraw,
}: {
  area: HTMLElement;
  docked: boolean;
  /** The writer's chosen width, and where a drag of the left edge commits a new one. */
  width: number;
  onResize: (width: number) => void;
  recordRef: ActiveViewerRef;
  /** The marks drawn on the pages, each one in `places`. */
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
    ? [...marks].sort((left, right) => {
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
    if (!docked || !record || !body || !track || !places) return;
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
      if (frame === null) frame = window.requestAnimationFrame(place);
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
  }, [activeId, docked, marks, places, recordRef, redraw]);

  const keyboard = active?.keyboard ?? false;
  useEffect(() => {
    if (activeId && keyboard) activeSlotRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [activeId, keyboard]);
  // A press anywhere else closes the open card; its pin and the other cards act for themselves.
  useDismissOnOutsidePointer(activeId ? activeSlotRef : null, onClose, (target) => Boolean(
    target.closest(".pdf-comment-column") || (activeId && target.closest(`[data-annotation-id="${CSS.escape(activeId)}"]`)),
  ));

  const light = (id: string | null) => lightMark(recordRef.current?.root, id);
  // Docked, each card stands level with its mark on the pages beside it.
  // Opened over the pages, which hide the marks, they list down from the top.
  const slots = (
    <>
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
    </>
  );
  return createPortal(
    <aside className="pdf-comment-column" data-docked={docked ? "" : undefined} aria-label={t`Comments`}>
      <ColumnResizer area={area} docked={docked} width={width} onResize={onResize} />
      <PanelHeader
        className="pdf-comment-column-head"
        title={t`Comments`}
        titleAfter={<span className="pdf-comment-column-count">{formatCount(marks.length)}</span>}
        onClose={onHide}
        closeLabel={t`Hide comments`}
      />
      {docked ? (
        <div ref={bodyRef} className="pdf-comment-column-body" onMouseLeave={() => light(null)}>
          <div ref={trackRef} className="pdf-comment-column-track">{slots}</div>
        </div>
      ) : (
        <ScrollArea className="pdf-comment-column-list" contentClassName="pdf-comment-column-list-content" fadeEdges={false} onMouseLeave={() => light(null)}>
          {slots}
        </ScrollArea>
      )}
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
