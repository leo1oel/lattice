import { useEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { hostErrorMessage } from "../app-utils";
import type { AnnotationRounds, MappedPdfSelection } from "../app/annotation-rounds";
import type { CommentDestination } from "../app/use-editor-comments";
import { useExitPicture } from "../components/ui/exit-picture";
import { popupMotionClassName } from "../components/ui/popup-motion";
import { LoadingAnnouncement } from "../components/ui/loading-status";
import type { AnnotationIntent } from "../editor/comments/editor-comment-data";
import type { PdfTextSelection } from "../pdf/pdf-annotations";
import { useDismissOnOutsidePointer } from "../hooks/use-dismiss-on-outside-pointer";
import { usePdfAnchoredPopup } from "../pdf/use-pdf-anchored-popup";
import { AnnotationForm } from "./annotation-composer";
import { baseName } from "../lib/base-name";

const COMPOSER_PLACE = { side: "below", width: 360 } as const;

/**
 * The note for text selected on the PDF: it maps the selection to the source
 * with SyncTeX first, says where (`PDF p.1 → main.tex:35`), and stays pinned
 * under the selection on its page while the PDF scrolls.
 */
export function PdfAnnotationComposer(props: {
  selection: PdfTextSelection;
  rounds: AnnotationRounds;
  /** What a note offered back after it was dismissed opens with. */
  initial?: { body: string; intent?: AnnotationIntent };
  onDone: () => void;
  /** Esc or a click outside closed the note, with what was written in it. */
  onDismiss: (written: { body: string; intent?: AnnotationIntent }) => void;
}) {
  const { t } = useLingui();
  const { selection } = props;
  const popupRef = useRef<HTMLDivElement>(null);
  // It grows from the selection above it as every popup does, and leaves on the popup exit.
  useExitPicture([popupRef]);
  const [mapped, setMapped] = useState<MappedPdfSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState(props.initial?.body ?? "");
  const [intent, setIntent] = useState<AnnotationIntent | undefined>(props.initial?.intent);
  // Where Save found the note had to go, when the live channel moved on after
  // it opened. Kept in state: the React Compiler memoizes the render-time read
  // below on `rounds` and `mapped`, so a bare re-render would not re-read it.
  const [destinationAtSave, setDestinationAtSave] = useState<CommentDestination | null>(null);
  const { rounds } = props;

  useEffect(() => {
    let cancelled = false;
    rounds.mapPdfSelection(selection).then(
      (place) => {
        if (!cancelled) setMapped(place);
      },
      (reason: unknown) => {
        if (!cancelled) setError(hostErrorMessage(reason));
      },
    );
    return () => { cancelled = true; };
  }, [rounds, selection]);

  // Under the selection on its page, kept there as the PDF scrolls or zooms.
  usePdfAnchoredPopup(popupRef, selection, COMPOSER_PLACE);
  // A click outside closes it (and still selects, or presses, where it lands).
  useDismissOnOutsidePointer(popupRef, () => props.onDismiss({ body, intent }));

  const name = mapped ? baseName(mapped.path) : null;
  const location = mapped ? t`PDF p.${selection.page} → ${name}:${mapped.line}` : t`PDF p.${selection.page} → …`;
  // In a project linked to Overleaf the note becomes an Overleaf comment on
  // the span SyncTeX found, which collaborators see; Overleaf takes one only
  // on the file the live channel holds, so a passage elsewhere says why not.
  const destination = destinationAtSave ?? (mapped ? rounds.pdfNoteDestination(mapped.path) : null);
  const toOverleaf = destination !== null && destination !== "annotation";
  const notLive = destination === "other-file"
    ? t`Overleaf takes a comment only on the file open in the editor, and this passage is in ${name}. Double-click it to open ${name}, then select it again.`
    : destination === "offline"
      ? t`This comment would go to Overleaf, but ${name} is not being edited live with Overleaf right now. Reconnect live editing (or turn on Live sync), then select it again.`
      : null;
  return (
    <div
      ref={popupRef}
      className={`editor-comment-popover annotation-composer pdf-annotation-composer ${popupMotionClassName}`}
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
        error={error ?? notLive}
        ready={Boolean(mapped) && !notLive}
        canRevise={!toOverleaf}
        overleaf={toOverleaf}
        onBodyChange={setBody}
        onIntentChange={setIntent}
        onCancel={() => props.onDismiss({ body, intent })}
        onSave={(revise) => {
          if (!mapped) return;
          const destinationNow = rounds.pdfNoteDestination(mapped.path);
          if (destinationNow === "other-file" || destinationNow === "offline") {
            setDestinationAtSave(destinationNow);
            return;
          }
          if (rounds.createFromPdf(selection, mapped, body, intent, revise)) props.onDone();
          else setError(t`The source changed since the PDF was built. Build again, then annotate.`);
        }}
      />
      {/* While SyncTeX maps the words, the location reads "→ …" and Save
          waits; the search itself is said only to assistive technology. */}
      {!mapped && !error && <LoadingAnnouncement message={t`Finding it in the source…`} />}
    </div>
  );
}
