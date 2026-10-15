import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import { ArrowUpRight, MessageSquareText } from "lucide-react";
import type { AnnotationRounds } from "../app/annotation-rounds";
import { PdfAnnotationComposer } from "../canvas/pdf-annotation-composer";
import { Button } from "../components/ui/button";
import { CommentCard, CommentPreview } from "../editor/comments/comment-card";
import {
  annotationStatus, type AnnotationIntent, type AnnotationStatus, type EditorComment, type PdfRect,
} from "../editor/comments/editor-comment-data";
import { useDismissOnOutsidePointer } from "../hooks/use-dismiss-on-outside-pointer";
import { notifyInfo } from "../telemetry/app-notify";
import { addListeners } from "./pdf-viewer-utils";
import { pdfPageView } from "./pdf-slick";
import { pdfSelectedPlainTextWithin } from "./pdf-text-layer-selection";
import { usePdfRenderCount, type PdfRenderCount } from "./use-pdf-document";
import type { ActiveViewerRef } from "./use-pdf-view";
import { useLatestRef } from "../hooks/use-latest-ref";
import { usePdfAnchoredPopup } from "./use-pdf-anchored-popup";

/** An annotation made on the PDF, as its page draws it: an amber highlight and its numbered pin. */
export type PdfAnnotationMark = { id: string; number: number; page: number; rects: PdfRect[]; status: AnnotationStatus };

/**
 * Text selected on a page to annotate: the page, the selection's line boxes
 * as fractions of the page, its text, and the point SyncTeX maps to the
 * source (the first line's start, in PDF units from the page's top left).
 */
export type PdfTextSelection = { page: number; rects: PdfRect[]; text: string; point: { x: number; y: number } };

const percent = (value: string) => Number.parseFloat(value) / 100;

/**
 * The selection's line boxes on its first page, read from the highlight the
 * text layer draws (`.pdf-sel-rect`, in fractions of the page): after a drag
 * WebKit parks the selection in a hidden copy field, but the highlight stays.
 * Glyph boxes on one line join into one box.
 */
function selectedLines(root: HTMLElement): { page: number; pageElement: HTMLElement; rects: PdfRect[] } | null {
  const marks = [...root.querySelectorAll<HTMLElement>(".textLayer .pdf-sel-rect")];
  const pageElement = marks[0]?.closest<HTMLElement>("[data-page-number]");
  if (!pageElement) return null;
  const page = Number.parseInt(pageElement.dataset.pageNumber ?? "", 10);
  const boxes = marks.filter((mark) => pageElement.contains(mark)).map((mark) => ({
    x: percent(mark.style.left), y: percent(mark.style.top), width: percent(mark.style.width), height: percent(mark.style.height),
  })).filter((box) => [box.x, box.y, box.width, box.height].every(Number.isFinite));
  const lines: PdfRect[] = [];
  for (const box of boxes.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const line = lines.find((item) => Math.abs(item.y + item.height / 2 - (box.y + box.height / 2)) < Math.min(item.height, box.height) / 2);
    if (!line) {
      lines.push({ ...box });
      continue;
    }
    const right = Math.max(line.x + line.width, box.x + box.width);
    const bottom = Math.max(line.y + line.height, box.y + box.height);
    line.x = Math.min(line.x, box.x);
    line.y = Math.min(line.y, box.y);
    line.width = right - line.x;
    line.height = bottom - line.y;
  }
  const round = (value: number) => Math.round(value * 10_000) / 10_000;
  return Number.isFinite(page) && lines.length
    ? { page, pageElement, rects: lines.map((line) => ({ x: round(line.x), y: round(line.y), width: round(line.width), height: round(line.height) })) }
    : null;
}

/** How long the pointer rests on a passage before its preview shows, as on the source editor's comments. */
const PREVIEW_DELAY_MS = 300;

const CARD_PLACE = { side: "above", width: 320 } as const;
const PREVIEW_PLACE = { side: "above" } as const;

/** The annotation whose highlight on the PDF is under the point, if any. */
function annotationAt(root: HTMLElement, x: number, y: number): string | null {
  for (const box of root.querySelectorAll<HTMLElement>(".pdf-annotation-highlight")) {
    const rect = box.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return box.closest<HTMLElement>("[data-annotation-id]")?.dataset.annotationId ?? null;
    }
  }
  return null;
}

/**
 * Annotating the compiled PDF: after text is selected on a page, an Annotate
 * button appears at the selection's end; choosing it opens the note, which
 * maps the selection to the source with SyncTeX. Every annotation made on the
 * PDF is drawn on its page as an amber highlight with its pin. Resting the
 * pointer on either previews the note; clicking opens its card, the one the
 * source editor shows, with Resolve, Reply and the way to its source.
 *
 * Loaded and mounted by the preview only once the PDF holds such a mark or
 * the writer has selected text on it, so a PDF nobody annotates runs none of it.
 */
export default function PdfAnnotationLayer({
  recordRef, previewRef, rounds, annotations, generation, renderCount, scale,
}: {
  recordRef: ActiveViewerRef;
  previewRef: RefObject<HTMLDivElement | null>;
  rounds: AnnotationRounds;
  annotations: readonly EditorComment[];
  generation: number;
  renderCount: PdfRenderCount;
  scale: number;
}) {
  const { t } = useLingui();
  const pageRenderGeneration = usePdfRenderCount(renderCount, "pages");
  const textLayerGeneration = usePdfRenderCount(renderCount, "textLayers");
  /** Where Annotate stands, for the zoom and viewer it was measured in; a zoom or a new viewer retires it. */
  const [placed, setOffer] = useState<{ left: number; top: number; selection: PdfTextSelection; scale: number; generation: number } | null>(null);
  const offer = placed && placed.scale === scale && placed.generation === generation ? placed : null;
  const scaleRef = useLatestRef(scale);
  /** The selection being annotated, keyed so a new one starts a fresh note; a note offered back opens with its words. */
  const [composing, setComposing] = useState<{
    selection: PdfTextSelection;
    nonce: string;
    initial?: { body: string; intent?: AnnotationIntent };
  } | null>(null);
  /** The annotation whose preview shows, its passage under the pointer. */
  const [previewId, setPreviewId] = useState<string | null>(null);
  /** The annotation whose card is open; `keyboard` when its pin was pressed from the keyboard. */
  const [card, setCard] = useState<{ id: string; keyboard: boolean } | null>(null);
  const cardRef = useLatestRef(card);
  const marks = useMemo((): PdfAnnotationMark[] => annotations.flatMap((annotation) => annotation.pdf && annotation.number && !annotation.resolved
    ? [{ id: annotation.id, number: annotation.number, page: annotation.pdf.page, rects: annotation.pdf.rects, status: annotationStatus(annotation) }]
    : []), [annotations]);
  const annotatable = rounds.canAnnotatePdf();

  // A finished drag offers Annotate where the selection ends.
  useEffect(() => {
    const record = recordRef.current;
    const preview = previewRef.current;
    if (!record || !preview || !annotatable || !generation) return;
    let frame: number | null = null;
    const read = () => {
      frame = null;
      const text = pdfSelectedPlainTextWithin(record.root).trim();
      const lines = text ? selectedLines(record.root) : null;
      const pageView = lines && pdfPageView(record.slick, lines.page);
      const viewport = pageView?.viewport as { width?: number; height?: number; scale?: number } | undefined;
      if (!lines || !viewport?.width || !viewport.height || !viewport.scale) {
        setOffer(null);
        return;
      }
      const first = lines.rects[0]!;
      const last = lines.rects.at(-1)!;
      const page = lines.pageElement.getBoundingClientRect();
      const bounds = preview.getBoundingClientRect();
      setOffer({
        scale: scaleRef.current,
        generation,
        left: page.left - bounds.left + (last.x + last.width) * page.width,
        top: page.top - bounds.top + (last.y + last.height) * page.height,
        selection: {
          page: lines.page,
          rects: lines.rects,
          text,
          point: {
            x: Number(((first.x + Math.min(first.width, 0.02)) * viewport.width / viewport.scale).toFixed(3)),
            y: Number(((first.y + first.height / 2) * viewport.height / viewport.scale).toFixed(3)),
          },
        },
      });
    };
    const schedule = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      // The text layer paints its highlight on the frame after the drag ends.
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(read);
      });
    };
    const dismiss = () => setOffer(null);
    const removeRoot = addListeners(record.root, {
      mouseup: schedule,
      mousedown: (event: MouseEvent) => {
        if (!(event.target instanceof Element) || !event.target.closest(".pdf-annotate-offer")) dismiss();
      },
    });
    const removeScroll = addListeners(record.root, { scroll: dismiss }, { passive: true });
    // Mounted by the drag that just ended: offer for its selection too.
    schedule();
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      removeRoot();
      removeScroll();
    };
  }, [annotatable, generation, previewRef, recordRef, scaleRef]);

  // Each annotation's highlight and pin, drawn again whenever a page re-renders.
  useEffect(() => {
    const record = recordRef.current;
    if (!record || !marks.length) return;
    const drawn: HTMLElement[] = [];
    for (const mark of marks) {
      const pageDiv = pdfPageView(record.slick, mark.page)?.div;
      if (!pageDiv) continue;
      const layer = document.createElement("div");
      layer.className = "pdf-annotation-mark";
      layer.dataset.annotationStatus = mark.status;
      layer.dataset.annotationId = mark.id;
      for (const rect of mark.rects) {
        const box = document.createElement("div");
        box.className = "pdf-annotation-highlight";
        Object.assign(box.style, {
          left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%`,
        });
        layer.append(box);
      }
      // The pin stands at the selection's leftmost line start: left of the column for a passage
      // across lines, just before the words for one inside a line.
      const first = mark.rects[0] && { ...mark.rects[0], x: Math.min(...mark.rects.map((rect) => rect.x)) };
      if (first) {
        const pin = document.createElement("button");
        pin.type = "button";
        pin.className = "annotation-pin pdf-annotation-pin";
        pin.dataset.annotationStatus = mark.status;
        pin.textContent = String(mark.number);
        pin.setAttribute("aria-label", t`Annotation ${mark.number}`);
        pin.setAttribute("aria-haspopup", "dialog");
        Object.assign(pin.style, { left: `${first.x * 100}%`, top: `${(first.y + first.height / 2) * 100}%` });
        pin.addEventListener("click", (event) => {
          event.stopPropagation();
          // Pressed from the keyboard (no pointer, so no click count), the card takes focus.
          setCard({ id: mark.id, keyboard: event.detail === 0 });
        });
        layer.append(pin);
      }
      // A page not drawn yet is not a positioned box (the PDF.js patch marks
      // only pages with layers): position this one for the marks.
      pageDiv.classList.add("latticeLayered");
      pageDiv.append(layer);
      drawn.push(layer);
    }
    return () => {
      for (const layer of drawn) layer.remove();
    };
  }, [generation, marks, pageRenderGeneration, recordRef, scale, t, textLayerGeneration]);

  // The passage under the pointer, its highlight or its pin, previews after a
  // short rest and lights while it does; a click on it (not a drag that
  // selects) opens its card.
  useEffect(() => {
    const record = recordRef.current;
    if (!record || !marks.length) return;
    const root = record.root;
    let timer: number | null = null;
    let under: string | null = null;
    const light = (id: string | null) => {
      for (const layer of root.querySelectorAll<HTMLElement>(".pdf-annotation-mark")) {
        layer.toggleAttribute("data-hovered", layer.dataset.annotationId === id);
      }
      root.toggleAttribute("data-annotation-hover", id !== null);
    };
    const settle = (id: string | null) => {
      if (id === under) return;
      under = id;
      light(id);
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      if (id === null) setPreviewId(null);
      else timer = window.setTimeout(() => setPreviewId(id), PREVIEW_DELAY_MS);
    };
    const pinOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>(".pdf-annotation-pin") : null);
    const move = (event: MouseEvent) => {
      const pin = pinOf(event.target);
      settle(pin
        ? pin.closest<HTMLElement>("[data-annotation-id]")?.dataset.annotationId ?? null
        : event.buttons ? null : annotationAt(root, event.clientX, event.clientY));
    };
    const click = (event: MouseEvent) => {
      if (pinOf(event.target) || pdfSelectedPlainTextWithin(root).trim()) return;
      const id = annotationAt(root, event.clientX, event.clientY);
      if (id) setCard({ id, keyboard: false });
    };
    const removeRoot = addListeners(root, { mousemove: move, mouseleave: () => settle(null), click });
    const removeScroll = addListeners(root, { scroll: () => settle(null) }, { passive: true });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      light(null);
      removeRoot();
      removeScroll();
    };
  }, [generation, marks, recordRef]);

  const closeCard = () => {
    const open = cardRef.current;
    setCard(null);
    if (open?.keyboard) {
      recordRef.current?.root
        .querySelector<HTMLElement>(`[data-annotation-id="${CSS.escape(open.id)}"] .pdf-annotation-pin`)
        ?.focus({ preventScroll: true });
    }
  };
  // An open card leaves on Esc wherever focus is, and gives a keyboard user back their pin.
  useEffect(() => {
    if (!card) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) closeCard();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  });
  const fade = (id: string) => {
    recordRef.current?.root
      .querySelector<HTMLElement>(`[data-annotation-id="${CSS.escape(id)}"]`)
      ?.setAttribute("data-resolving", "");
  };
  /** A note closed with words in it is offered back, on the same selection. */
  const dismissNote = (selection: PdfTextSelection, written: { body: string; intent?: AnnotationIntent }) => {
    setComposing(null);
    if (!written.body.trim()) return;
    notifyInfo(t`Annotations`, t`Note discarded`, {
      dedupeKey: "annotation-draft-discarded",
      primaryAction: {
        label: t`Undo`,
        onClick: () => setComposing({ selection, nonce: crypto.randomUUID(), initial: written }),
      },
    });
  };

  const cardAnnotation = card ? annotations.find((annotation) => annotation.id === card.id) ?? null : null;
  const previewAnnotation = previewId && previewId !== card?.id
    ? annotations.find((annotation) => annotation.id === previewId && annotation.pdf) ?? null
    : null;

  return (
    <>
      {offer && (
        <button
          type="button"
          className="pdf-annotate-offer"
          style={{ left: offer.left, top: offer.top }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setComposing({ selection: offer.selection, nonce: crypto.randomUUID() });
            setOffer(null);
          }}
        >
          <MessageSquareText size={13} />
          {t`Annotate`}
        </button>
      )}
      {composing && (
        <PdfAnnotationComposer
          key={composing.nonce}
          selection={composing.selection}
          rounds={rounds}
          initial={composing.initial}
          onDone={() => setComposing(null)}
          onDismiss={(written) => dismissNote(composing.selection, written)}
        />
      )}
      {previewAnnotation?.pdf && <PdfCommentPreview key={previewAnnotation.id} annotation={previewAnnotation} />}
      {cardAnnotation?.pdf && (
        <PdfCommentCard
          key={cardAnnotation.id}
          annotation={cardAnnotation}
          rounds={rounds}
          keyboard={card?.keyboard ?? false}
          onResolving={fade}
          onClose={closeCard}
        />
      )}
    </>
  );
}

/** The preview over a passage the pointer rests on: lines only, never in the pointer's way. */
function PdfCommentPreview({ annotation }: { annotation: EditorComment }) {
  const ref = useRef<HTMLDivElement>(null);
  const passage = useMemo(() => annotation.pdf ? { page: annotation.pdf.page, rects: annotation.pdf.rects } : null, [annotation.pdf]);
  usePdfAnchoredPopup(ref, passage, PREVIEW_PLACE);
  return (
    <div ref={ref} role="tooltip" className="pdf-comment-popup pdf-comment-preview">
      <CommentPreview comments={[annotation]} />
    </div>
  );
}

/** An annotation's card on the PDF, above its passage, until Esc or a click elsewhere. */
function PdfCommentCard({ annotation, rounds, keyboard, onResolving, onClose }: {
  annotation: EditorComment;
  rounds: AnnotationRounds;
  keyboard: boolean;
  onResolving: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const ref = useRef<HTMLDivElement>(null);
  const passage = useMemo(() => annotation.pdf ? { page: annotation.pdf.page, rects: annotation.pdf.rects } : null, [annotation.pdf]);
  usePdfAnchoredPopup(ref, passage, CARD_PLACE);
  // Its own pin opened it: pressing the pin again is not a click elsewhere.
  useDismissOnOutsidePointer(ref, onClose, (target) => Boolean(target.closest(`[data-annotation-id="${CSS.escape(annotation.id)}"]`)));
  useEffect(() => {
    if (keyboard) ref.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [keyboard]);
  const proposed = annotation.revision?.state === "proposed";
  return (
    <div ref={ref} className="pdf-comment-popup">
      <CommentCard
        comments={[annotation]}
        author={rounds.author()}
        onResolve={rounds.resolve}
        onReply={rounds.reply}
        onResolving={onResolving}
        onClose={onClose}
        footer={(
          <Button
            size="compact"
            variant="ghost"
            onClick={() => {
              onClose();
              rounds.openById(annotation.id);
            }}
          >
            <ArrowUpRight size={13} aria-hidden="true" />
            {proposed ? t`Review the proposal` : t`Show in the source`}
          </Button>
        )}
      />
    </div>
  );
}
