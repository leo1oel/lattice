import { useEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { toMessage } from "../app-utils";
import type { AnnotationRounds, MappedPdfSelection } from "../app/annotation-rounds";
import { useExitPicture } from "../components/ui/exit-picture";
import { popupMotionClassName } from "../components/ui/popup-motion";
import { LoadingAnnouncement } from "../components/ui/loading-status";
import type { AnnotationIntent } from "../editor/comments/editor-comment-data";
import type { PdfTextSelection } from "../pdf/pdf-annotations";
import { useDismissOnOutsidePointer } from "../hooks/use-dismiss-on-outside-pointer";
import { usePdfAnchoredPopup } from "../pdf/use-pdf-anchored-popup";
import { AnnotationForm } from "./annotation-composer";

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
  const { rounds } = props;

  useEffect(() => {
    let cancelled = false;
    rounds.mapPdfSelection(selection).then(
      (place) => {
        if (!cancelled) setMapped(place);
      },
      (reason: unknown) => {
        if (!cancelled) setError(toMessage(reason));
      },
    );
    return () => { cancelled = true; };
  }, [rounds, selection]);

  // Under the selection on its page, kept there as the PDF scrolls or zooms.
  usePdfAnchoredPopup(popupRef, selection, COMPOSER_PLACE);
  // A click outside closes it (and still selects, or presses, where it lands).
  useDismissOnOutsidePointer(popupRef, () => props.onDismiss({ body, intent }));

  const name = mapped ? mapped.path.split("/").at(-1) ?? mapped.path : null;
  const location = mapped ? t`PDF p.${selection.page} → ${name}:${mapped.line}` : t`PDF p.${selection.page} → …`;
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
        error={error}
        ready={Boolean(mapped)}
        canRevise
        onBodyChange={setBody}
        onIntentChange={setIntent}
        onCancel={() => props.onDismiss({ body, intent })}
        onSave={(revise) => {
          if (!mapped) return;
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
