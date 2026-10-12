import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { toMessage } from "../app-utils";
import type { AcceptedRevision } from "../app/use-annotation-rounds";
import type { AnnotationIntent, EditorComment } from "../editor/comments/editor-comment-data";
import type { PdfAnnotationMark, PdfTextSelection } from "../pdf/pdf-viewer";
import { clamp } from "../settings/app-settings";
import { AnnotationForm } from "./annotation-composer";

/** A PDF selection placed in the source: the file and span SyncTeX and its text led to. */
export type MappedPdfSelection = { path: string; line: number; from: number; to: number; source: string };

/** What the canvas shows and asks of local annotations and their revision rounds. */
export type CanvasAnnotations = {
  /** Every local annotation. */
  local: readonly EditorComment[];
  /** Proposals waiting for the writer, in review order. */
  proposals: readonly EditorComment[];
  /** Annotations the agent is answering now. */
  running: ReadonlySet<string>;
  /** The proposal to review in the editor. */
  review: { id: string; nonce: string } | null;
  /** The agent can be asked now (a project the writer can edit). */
  canRevise: boolean;
  /** Text on the compiled PDF can be annotated. */
  canAnnotatePdf: boolean;
  /** Annotations made on the PDF, as its pages draw them. */
  pdfMarks: readonly PdfAnnotationMark[];
  onRevise: () => void;
  /** Show an annotation: its card in the panel, its passage in the editor. */
  onOpen: (comment: EditorComment) => void;
  onOpenById: (id: string) => void;
  onAccepted: (id: string, applied: AcceptedRevision) => void;
  onRejected: (id: string) => void;
  onRetry: (id: string, guidance: string) => void;
  onNavigate: (from: string, step: 1 | -1) => void;
  onCloseReview: () => void;
  /** Find a PDF selection's place in the source; rejects with why it cannot. */
  mapPdfSelection: (selection: PdfTextSelection) => Promise<MappedPdfSelection>;
};

/**
 * The note for text selected on the PDF: it maps the selection to the source
 * with SyncTeX first, says where (`PDF p.1 → main.tex:35`), and stays pinned
 * under the selection on its page while the PDF scrolls.
 */
export function PdfAnnotationComposer(props: {
  selection: PdfTextSelection;
  map: (selection: PdfTextSelection) => Promise<MappedPdfSelection>;
  canRevise: boolean;
  onCancel: () => void;
  onSave: (mapped: MappedPdfSelection, body: string, intent: AnnotationIntent | undefined, revise: boolean) => boolean;
}) {
  const { t } = useLingui();
  const { selection } = props;
  const popupRef = useRef<HTMLDivElement>(null);
  const [mapped, setMapped] = useState<MappedPdfSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [intent, setIntent] = useState<AnnotationIntent | undefined>();
  const { map } = props;

  useEffect(() => {
    let cancelled = false;
    map(selection).then(
      (place) => {
        if (!cancelled) setMapped(place);
      },
      (reason: unknown) => {
        if (!cancelled) setError(toMessage(reason));
      },
    );
    return () => { cancelled = true; };
  }, [map, selection]);

  // Under the selection on its page, kept there as the PDF scrolls or zooms.
  useLayoutEffect(() => {
    const popup = popupRef.current;
    const column = popup?.parentElement;
    if (!popup || !column) return;
    const place = () => {
      const page = column.querySelector<HTMLElement>(`.pdf-preview [data-page-number="${selection.page}"]`);
      const last = selection.rects.at(-1);
      const first = selection.rects[0];
      if (!page || !last || !first) {
        popup.style.visibility = "hidden";
        return;
      }
      const pageBox = page.getBoundingClientRect();
      const bounds = column.getBoundingClientRect();
      const width = Math.min(360, Math.max(0, bounds.width - 16));
      const below = pageBox.top - bounds.top + (last.y + last.height) * pageBox.height + 8;
      const visible = below > 0 && below < bounds.height;
      Object.assign(popup.style, {
        visibility: visible ? "visible" : "hidden",
        width: `${width}px`,
        left: `${clamp(pageBox.left - bounds.left + first.x * pageBox.width, 8, Math.max(8, bounds.width - width - 8))}px`,
        top: `${below}px`,
        maxHeight: `${Math.max(0, bounds.height - below - 8)}px`,
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
  }, [selection]);

  const name = mapped ? mapped.path.split("/").at(-1) ?? mapped.path : null;
  const location = mapped ? t`PDF p.${selection.page} → ${name}:${mapped.line}` : t`PDF p.${selection.page} → …`;
  return (
    <div
      ref={popupRef}
      className="editor-comment-popover annotation-composer pdf-annotation-composer"
      style={{ bottom: "auto", right: "auto" }}
      role="dialog"
      aria-label={t`Annotate the PDF`}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <AnnotationForm
        quote={selection.text}
        location={location}
        body={body}
        intent={intent}
        error={error}
        ready={Boolean(mapped)}
        footnote={mapped ? t`Mapped to the source with SyncTeX` : error ? undefined : t`Finding it in the source…`}
        canRevise={props.canRevise}
        onBodyChange={setBody}
        onIntentChange={setIntent}
        onCancel={props.onCancel}
        onSave={(revise) => {
          if (!mapped) return;
          if (!props.onSave(mapped, body, intent, revise)) {
            setError(t`The source changed since the PDF was built. Build again, then annotate.`);
          }
        }}
      />
    </div>
  );
}
