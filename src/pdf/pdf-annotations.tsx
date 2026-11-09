import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { MessageSquareText } from "lucide-react";
import type { AnnotationRounds } from "../app/annotation-rounds";
import { PdfAnnotationComposer } from "../canvas/pdf-annotation-composer";
import {
  annotationStatus, editorCommentAuthorDisplayName, resolveCommentAnchor, type AnnotationIntent, type AnnotationStatus, type EditorComment, type PdfRect,
} from "../editor/comments/editor-comment-data";
import { notifyInfo } from "../telemetry/app-notify";
import { addListeners } from "./pdf-viewer-utils";
import { pdfPageView } from "./pdf-slick";
import { isPdfCopyField, pdfSelectedPlainTextWithin } from "./pdf-text-layer-selection";
import { usePdfRenderCount, type PdfRenderCount } from "./use-pdf-document";
import type { ActiveViewerRef } from "./use-pdf-view";
import { useLatestRef } from "../hooks/use-latest-ref";
import { PdfCommentCard, PdfCommentPreview } from "./pdf-comment-popups";
import { PdfCommentColumn, PdfCommentToggle } from "./pdf-comment-column";
import { usePdfCommentColumn } from "./use-pdf-comment-column";
import type { PdfPassage } from "./use-pdf-anchored-popup";
import { selectedLines } from "./pdf-selected-lines";
import { drawnOnPdf, lightMark } from "./pdf-drawn-annotations";
import { placePdfMark } from "./pdf-annotation-place";
import { linesAsBuilt, placeSourceMark, type PlacedMark, type SourceMarkReader } from "./pdf-source-marks";
import type { PageText, SyncBox, TextRun } from "./review-pdf";

/**
 * A comment as the PDF draws it: an amber highlight over the words it
 * quotes and its pin, numbered for an annotation (`number` 0 for an
 * Overleaf thread, whose pin is a dot). One made on the PDF is drawn where
 * it was made; one made in a .tex file where SyncTeX puts its lines in the
 * last build (pdf-source-marks.ts).
 */
export type PdfAnnotationMark = { id: string; number: number; status: AnnotationStatus; annotation: EditorComment };

/**
 * Text selected on a page to annotate: the page, the selection's line boxes
 * as fractions of the page, its text, and the point SyncTeX maps to the
 * source (the first line's start, in PDF units from the page's top left).
 */
export type PdfTextSelection = { page: number; rects: PdfRect[]; text: string; point: { x: number; y: number } };

/** How long source notes wait after a change before SyncTeX looks them up, so typing in a passage runs no process per key. */
const SOURCE_PLACE_DELAY_MS = 250;

type PdfDocument = NonNullable<NonNullable<ActiveViewerRef["current"]>["slick"]["document"]>;

/**
 * What one document's marks are measured from, read once per document (a
 * rebuild that redraws only its changed pages swaps the document under the
 * same viewer, pdf-page-swap.ts, so it is keyed by document): each
 * page's text, and the text of each annotated source file when the PDF
 * arrived, which is what it was built from; and where each source note was
 * placed, by note and quote, so typing elsewhere in the file looks nothing up again.
 */
type DocumentReads = {
  document: PdfDocument;
  pages: Map<number, Promise<PageText | null>>;
  built: Map<string, Promise<string | null>>;
  sourcePlaces: Map<string, Promise<PlacedMark | null>>;
};

function pageTextOf(reads: DocumentReads, document: PdfDocument, number: number) {
  let text = reads.pages.get(number);
  if (!text) {
    text = number > document.numPages ? Promise.resolve(null) : document.getPage(number).then(async (page) => {
      const content = await page.getTextContent();
      return { view: page.view, runs: content.items.filter((item): item is TextRun & typeof item => "str" in item) };
    }).catch(() => null);
    reads.pages.set(number, text);
  }
  return text;
}

/**
 * Where each mark is drawn, from the text of its page: a PDF note's on the
 * page it was made (pdf-annotation-place.ts), a source note's where SyncTeX
 * and its words put it (pdf-source-marks.ts). Null until the first PDF
 * notes' placement is known; source notes arrive one by one after it, each
 * SyncTeX lookup a process of its own, so the PDF never waits on them.
 * Measured again whenever the pages are redrawn from another document or
 * viewer (`pageRenders`, `generation`): a rebuild moves the words its marks
 * cover. Each note keeps its last place until it is placed on the new
 * document, so a rebuild never takes the comment column away and back.
 */
function usePdfMarkPlaces(
  recordRef: ActiveViewerRef, rounds: AnnotationRounds, marks: readonly PdfAnnotationMark[], generation: number, pageRenders: number,
): ReadonlyMap<string, PlacedMark> | null {
  const [placed, setPlaced] = useState<ReadonlyMap<string, PlacedMark> | null>(null);
  const [sourcePlaced, setSourcePlaced] = useState<ReadonlyMap<string, PlacedMark | null>>(() => new Map());
  const readsRef = useRef<DocumentReads | null>(null);
  useEffect(() => {
    const document = recordRef.current?.slick.document;
    if (!document) return;
    if (readsRef.current?.document !== document) {
      readsRef.current = { document, pages: new Map(), built: new Map(), sourcePlaces: new Map() };
    }
    const reads = readsRef.current;
    let live = true;
    const onPdf = marks.flatMap((mark) => (mark.annotation.pdf ? [{ mark, pdf: mark.annotation.pdf }] : []));
    void Promise.all(onPdf.map(async ({ mark, pdf }) => {
      const place = placePdfMark(await pageTextOf(reads, document, pdf.page), mark.annotation);
      return [mark.id, place && { page: pdf.page, ...place }] as const;
    })).then((entries) => {
      if (!live) return;
      setPlaced(new Map(entries.flatMap(([id, place]) => (place ? [[id, place] as const] : []))));
    });

    const inSource = marks.filter((mark) => !mark.annotation.pdf);
    if (!inSource.length) return () => { live = false; };
    const reader: SourceMarkReader = {
      pageCount: document.numPages,
      page: async (number) => {
        const text = await pageTextOf(reads, document, number);
        // Unreadable: the note is left without a mark.
        if (!text) throw new RangeError(String(number));
        return text;
      },
      sync: (path, line, column) => invoke<SyncBox | null>("synctex_view", { path, line, column }),
    };
    const builtText = (path: string) => {
      let text = reads.built.get(path);
      if (!text) {
        text = rounds.readSource(path);
        reads.built.set(path, text);
      }
      return text;
    };
    // Snapshot the files as they were when this PDF arrived, before any wait.
    for (const mark of inSource) void builtText(mark.annotation.path);
    const timer = window.setTimeout(() => {
      void (async () => {
        for (const { id, annotation } of inSource) {
          if (!live) return;
          const key = `${id}\u0000${annotation.quote}`;
          let place = reads.sourcePlaces.get(key);
          if (!place) {
            place = Promise.all([rounds.readSource(annotation.path), builtText(annotation.path)]).then(([source, built]) => {
              // Where the note is in the file now: its stored range is where it was made, as the editor finds it.
              const range = source === null ? null : resolveCommentAnchor(source, annotation);
              if (!source || !range) return null;
              const here = { ...annotation, ...range };
              return placeSourceMark(here, source, linesAsBuilt(here, source, built), reader);
            }).catch(() => null);
            reads.sourcePlaces.set(key, place);
          }
          const result = await place;
          if (!live) return;
          setSourcePlaced((current) => (current.has(id) && current.get(id) === result ? current : new Map(current).set(id, result)));
        }
      })();
    }, SOURCE_PLACE_DELAY_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [generation, marks, pageRenders, recordRef, rounds]);
  return useMemo(() => {
    if (!placed || !sourcePlaced.size) return placed;
    const places = new Map(placed);
    for (const [id, place] of sourcePlaced) if (place) places.set(id, place);
    return places;
  }, [placed, sourcePlaced]);
}

/** How long the pointer rests on a passage before its preview shows, as on the source editor's comments. */
const PREVIEW_DELAY_MS = 300;

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
  const marks = useMemo((): PdfAnnotationMark[] => annotations.flatMap((annotation) => (
    drawnOnPdf(annotation)
      ? [{ id: annotation.id, number: annotation.number ?? 0, status: annotationStatus(annotation), annotation }]
      : []
  )), [annotations]);
  const places = usePdfMarkPlaces(recordRef, rounds, marks, generation, pageRenderGeneration);
  // The column holds, and counts, only the comments drawn on the pages.
  const placedMarks = useMemo(() => (places ? marks.filter((mark) => places.has(mark.id)) : []), [marks, places]);
  const column = usePdfCommentColumn(previewRef, placedMarks.length > 0, generation);
  const columnOpen = column.open;
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
    // Work anywhere else ends the offer too: a double-click's SyncTeX jump
    // into the source and typing there, a build, another panel. Only a press
    // inside the PDF used to, so Annotate stood over the page for minutes.
    // The hidden copy field takes focus after a drag; it is still the PDF's.
    const away = (target: EventTarget | null) => target instanceof Node && !record.root.contains(target)
      && !(target instanceof Element && target.closest(".pdf-annotate-offer"));
    const removeAway = addListeners(document, {
      pointerdown: (event: PointerEvent) => {
        if (away(event.target)) dismiss();
      },
      focusin: (event: FocusEvent) => {
        if (!isPdfCopyField(event.target) && away(event.target)) dismiss();
      },
    }, { capture: true });
    // Mounted by the drag that just ended: offer for its selection too.
    schedule();
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      removeRoot();
      removeScroll();
      removeAway();
    };
  }, [annotatable, generation, previewRef, recordRef, scaleRef]);

  // Each annotation's highlight and pin, drawn again whenever a page re-renders,
  // once its words are found on the page.
  useEffect(() => {
    const record = recordRef.current;
    if (!record || !marks.length || !places) return;
    const drawn: HTMLElement[] = [];
    // Pins of passages that start on one line stand side by side, outward from the column.
    const stacked = new Map<string, number>();
    for (const mark of marks) {
      const place = places.get(mark.id);
      const pageDiv = place && pdfPageView(record.slick, place.page)?.div;
      if (!pageDiv || !place) continue;
      const layer = document.createElement("div");
      layer.className = "pdf-annotation-mark";
      layer.dataset.annotationStatus = mark.status;
      layer.dataset.annotationId = mark.id;
      for (const rect of place.rects) {
        const box = document.createElement("div");
        box.className = "pdf-annotation-highlight";
        Object.assign(box.style, {
          left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%`,
        });
        layer.append(box);
      }
      {
        const { pin: at } = place;
        const row = `${place.page}:${at.side}:${Math.round(at.y * 200)}`;
        const stack = stacked.get(row) ?? 0;
        stacked.set(row, stack + 1);
        const pin = document.createElement("button");
        pin.type = "button";
        pin.className = "annotation-pin pdf-annotation-pin";
        pin.dataset.annotationStatus = mark.status;
        pin.dataset.side = at.side;
        pin.style.setProperty("--pin-stack", String(stack));
        if (mark.number) {
          pin.textContent = String(mark.number);
          pin.setAttribute("aria-label", t`Annotation ${mark.number}`);
        } else {
          const name = editorCommentAuthorDisplayName(mark.annotation.authorName, t`Anonymous`);
          pin.dataset.kind = "thread";
          pin.style.setProperty("--pin-color", mark.annotation.authorColor?.color ?? "");
          pin.setAttribute("aria-label", t`Comment by ${name}`);
        }
        pin.setAttribute("aria-haspopup", "dialog");
        Object.assign(pin.style, { left: `${at.x * 100}%`, top: `${at.y * 100}%` });
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
  }, [generation, marks, pageRenderGeneration, places, recordRef, scale, t, textLayerGeneration]);
  // The open card's passage stays lit, as Word keeps a comment's words marked while it is read.
  const cardId = card?.id ?? null;
  useEffect(() => {
    for (const layer of recordRef.current?.root.querySelectorAll<HTMLElement>(".pdf-annotation-mark") ?? []) {
      layer.toggleAttribute("data-active", layer.dataset.annotationId === cardId);
    }
  }, [cardId, generation, marks, pageRenderGeneration, places, recordRef, scale, textLayerGeneration]);

  // The passage under the pointer, its highlight or its pin, previews after a
  // short rest and lights while it does, with its card in the comment column;
  // a click on it (not a drag that selects) opens its card.
  useEffect(() => {
    const record = recordRef.current;
    if (!record || !marks.length) return;
    const root = record.root;
    let timer: number | null = null;
    let under: string | null = null;
    const light = (id: string | null) => {
      lightMark(root, id);
      root.toggleAttribute("data-annotation-hover", id !== null);
      for (const slot of previewRef.current?.querySelectorAll<HTMLElement>(".pdf-comment-slot") ?? []) {
        slot.toggleAttribute("data-hovered", slot.dataset.commentId === id);
      }
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
  }, [generation, marks, previewRef, recordRef]);

  // A card opened from the keyboard gives focus back where it was opened: its card's preview in the column, or its pin.
  const closeCard = () => {
    const open = cardRef.current;
    flushSync(() => setCard(null));
    if (!open?.keyboard) return;
    const id = CSS.escape(open.id);
    const back = columnOpen
      ? previewRef.current?.querySelector<HTMLElement>(`.pdf-comment-slot[data-comment-id="${id}"] .pdf-comment-slot-preview`)
      : recordRef.current?.root.querySelector<HTMLElement>(`[data-annotation-id="${id}"] .pdf-annotation-pin`);
    back?.focus({ preventScroll: true });
  };
  // An open card leaves on Esc wherever focus is.
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
  // With the column open, a comment's card stands there and its preview is the card itself.
  const previewAnnotation = previewId && previewId !== card?.id && !columnOpen
    ? annotations.find((annotation) => annotation.id === previewId) ?? null
    : null;
  const previewPassage = previewAnnotation && passageOf(previewAnnotation, places);
  const cardPassage = cardAnnotation && passageOf(cardAnnotation, places);

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
      {previewAnnotation && previewPassage && (
        <PdfCommentPreview key={previewAnnotation.id} annotation={previewAnnotation} passage={previewPassage} />
      )}
      {column.area && columnOpen && (
        <PdfCommentColumn
          area={column.area}
          docked={column.docked}
          width={column.width}
          onResize={column.resize}
          recordRef={recordRef}
          marks={placedMarks}
          places={places}
          rounds={rounds}
          active={card}
          onActivate={(id, keyboard) => setCard({ id, keyboard })}
          onClose={closeCard}
          onResolving={fade}
          onHide={() => {
            setCard(null);
            column.setOpen(false);
          }}
          redraw={`${generation}:${pageRenderGeneration}:${scale}`}
        />
      )}
      {column.area && !columnOpen && placedMarks.length > 0 && (
        <PdfCommentToggle area={column.area} count={placedMarks.length} onShow={() => column.setOpen(true)} />
      )}
      {cardAnnotation && cardPassage && !columnOpen && (
        <PdfCommentCard
          key={cardAnnotation.id}
          annotation={cardAnnotation}
          passage={cardPassage}
          rounds={rounds}
          keyboard={card?.keyboard ?? false}
          onResolving={fade}
          onClose={closeCard}
        />
      )}
    </>
  );
}

/** The passage a popup stands over: where its highlight is drawn, or a PDF note's selection as saved. */
function passageOf(annotation: EditorComment, places: ReadonlyMap<string, PlacedMark> | null): PdfPassage | null {
  const place = places?.get(annotation.id);
  if (place) return place;
  return annotation.pdf ?? null;
}
