import { useEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { hostErrorMessage } from "../app-utils";
import { showError } from "../app/notify";
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
  // Overleaf is taking a comment on a file not open; Save waits for it.
  const [saving, setSaving] = useState(false);
  // An answer arriving after the note closed (a new note replaced it) must
  // not act for it (`onDone` would close whatever note is open by then); one
  // that did not land says so in a toast instead.
  const closedRef = useRef(false);
  useEffect(() => {
    closedRef.current = false;
    return () => { closedRef.current = true; };
  }, []);

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
  // Not while Overleaf is taking the comment: the request cannot be called
  // back, so "Note discarded" would be untrue and its Undo would post twice.
  const dismiss = () => {
    if (!saving) props.onDismiss({ body, intent });
  };
  useDismissOnOutsidePointer(popupRef, dismiss);

  const name = mapped ? baseName(mapped.path) : null;
  const location = mapped ? t`PDF p.${selection.page} → ${name}:${mapped.line}` : t`PDF p.${selection.page} → …`;
  // In a project linked to Overleaf the note becomes an Overleaf comment on
  // the span SyncTeX found, which collaborators see: in the open file, or in
  // any other, which Overleaf is asked to take in the background ("other-file").
  const destination = destinationAtSave ?? (mapped ? rounds.pdfNoteDestination(mapped.path) : null);
  const toOverleaf = destination !== null && destination !== "annotation";
  const notLive = destination === "offline"
    ? t`This comment would go to Overleaf, but ${name} is not being edited live with Overleaf right now. Reconnect live editing (or turn on Live sync), then select it again.`
    : null;
  /**
   * Comment on a file the editor does not have open, staying here until
   * Overleaf has it. When Overleaf's copy reads differently around the
   * passage, the file opens beside the PDF at it and the note stays, so Save
   * places it in the file as the editor then holds it. Built here rather than
   * in `rounds`, which loads with the app, so the PDF alone pays for it.
   */
  const commentInDocument = (place: MappedPdfSelection) => {
    const session = rounds.pdfNoteSession();
    const docId = session?.deps.store.docIdOf(place.path);
    const projectRoot = session?.deps.projectRootRef.current;
    if (!session || !docId || !projectRoot) {
      setError(t`This file is not live with Overleaf right now. Reconnect before commenting.`);
      return;
    }
    const { deps, generation } = session;
    const quote = place.source.slice(place.from, place.to);
    if (!quote.trim()) {
      setError(t`There is no text to comment on in this selection.`);
      return;
    }
    setSaving(true);
    setError(null);
    deps.store.createInDocument({ projectRoot, docId, path: place.path }, place.source, place.from, quote, body.trim()).then((placement) => {
      // Not once the project changed meanwhile: there is no file of it left to open.
      if (placement === "notFound" && rounds.pdfNoteSession()?.generation !== generation) {
        throw new Error(t`The project closed before the comment was saved.`);
      }
      return placement;
    }).then(
      (placement) => {
        if (placement === "placed") {
          if (!closedRef.current) props.onDone();
          return;
        }
        void deps.openProjectFile(place.path, { line: place.line, revealSource: false });
        if (closedRef.current) {
          showError(t`Your note on ${name} did not reach Overleaf: its copy reads differently there, so the file is open beside the PDF now. Comment on the passage there.`);
          return;
        }
        setSaving(false);
        setError(t`Overleaf's copy of ${name} reads differently here, so it is open beside the PDF now. Check the passage there, then save again.`);
      },
      (reason: unknown) => {
        const message = hostErrorMessage(reason);
        if (closedRef.current) {
          showError(t`Your note on ${name} did not reach Overleaf: ${message}`);
          return;
        }
        setSaving(false);
        setError(message);
      },
    );
  };
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
        ready={Boolean(mapped) && !notLive && !saving}
        canRevise={!toOverleaf}
        overleaf={toOverleaf}
        onBodyChange={setBody}
        onIntentChange={setIntent}
        onCancel={dismiss}
        onSave={(revise) => {
          if (!mapped) return;
          const destinationNow = rounds.pdfNoteDestination(mapped.path);
          if (destinationNow === "offline") {
            setDestinationAtSave(destinationNow);
            return;
          }
          if (destinationNow === "other-file") {
            commentInDocument(mapped);
            return;
          }
          const outcome = rounds.createFromPdf(selection, mapped, body, intent, revise);
          if (outcome === "saved") props.onDone();
          else if (outcome === "stale") setError(t`The source changed since the PDF was built. Build again, then annotate.`);
        }}
      />
      {/* While SyncTeX maps the words, the location reads "→ …" and Save
          waits; the search itself is said only to assistive technology. */}
      {!mapped && !error && <LoadingAnnouncement message={t`Finding it in the source…`} />}
      {saving && <LoadingAnnouncement message={t`Commenting on ${name} on Overleaf…`} />}
    </div>
  );
}
