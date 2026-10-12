import { useEffect, useMemo, useState, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import { MessageSquareText } from "lucide-react";
import type { AnnotationRounds } from "../app/annotation-rounds";
import { PdfAnnotationComposer } from "../canvas/pdf-annotation-composer";
import { annotationStatus, type AnnotationStatus, type EditorComment, type PdfRect } from "../editor/comments/editor-comment-data";
import { addListeners } from "./pdf-viewer-utils";
import { pdfPageView } from "./pdf-slick";
import { pdfSelectedPlainTextWithin } from "./pdf-text-layer-selection";
import type { ActiveViewerRef } from "./use-pdf-view";
import { useLatestRef } from "../hooks/use-latest-ref";

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

/**
 * Annotating the compiled PDF: after text is selected on a page, an Annotate
 * button appears at the selection's end; choosing it opens the note, which
 * maps the selection to the source with SyncTeX. Every annotation made on the
 * PDF is drawn on its page as an amber highlight with its pin, which opens it.
 *
 * Loaded and mounted by the preview only once the PDF holds such a mark or
 * the writer has selected text on it, so a PDF nobody annotates runs none of it.
 */
export default function PdfAnnotationLayer({
  recordRef, previewRef, rounds, annotations, generation, pageRenderGeneration, textLayerGeneration, scale,
}: {
  recordRef: ActiveViewerRef;
  previewRef: RefObject<HTMLDivElement | null>;
  rounds: AnnotationRounds;
  annotations: readonly EditorComment[];
  generation: number;
  pageRenderGeneration: number;
  textLayerGeneration: number;
  scale: number;
}) {
  const { t } = useLingui();
  /** Where Annotate stands, for the zoom and viewer it was measured in; a zoom or a new viewer retires it. */
  const [placed, setOffer] = useState<{ left: number; top: number; selection: PdfTextSelection; scale: number; generation: number } | null>(null);
  const offer = placed && placed.scale === scale && placed.generation === generation ? placed : null;
  const scaleRef = useLatestRef(scale);
  /** The selection being annotated, keyed so a new one starts a fresh note. */
  const [composing, setComposing] = useState<{ selection: PdfTextSelection; nonce: string } | null>(null);
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
        Object.assign(pin.style, { left: `${first.x * 100}%`, top: `${(first.y + first.height / 2) * 100}%` });
        pin.addEventListener("click", (event) => {
          event.stopPropagation();
          rounds.openById(mark.id);
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
  }, [generation, marks, pageRenderGeneration, recordRef, rounds, scale, t, textLayerGeneration]);

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
          onDone={() => setComposing(null)}
        />
      )}
    </>
  );
}
