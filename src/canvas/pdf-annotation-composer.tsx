import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { toMessage } from "../app-utils";
import type { AnnotationRounds, MappedPdfSelection } from "../app/annotation-rounds";
import { useExitPicture } from "../components/ui/exit-picture";
import { popupMotionClassName } from "../components/ui/popup-motion";
import type { AnnotationIntent } from "../editor/comments/editor-comment-data";
import type { PdfTextSelection } from "../pdf/pdf-annotations";
import { clamp } from "../settings/app-settings";
import { AnnotationForm } from "./annotation-composer";

/**
 * The note for text selected on the PDF: it maps the selection to the source
 * with SyncTeX first, says where (`PDF p.1 → main.tex:35`), and stays pinned
 * under the selection on its page while the PDF scrolls.
 */
export function PdfAnnotationComposer(props: {
  selection: PdfTextSelection;
  rounds: AnnotationRounds;
  onDone: () => void;
}) {
  const { t } = useLingui();
  const { selection } = props;
  const popupRef = useRef<HTMLDivElement>(null);
  // It grows from the selection above it as every popup does, and leaves on the popup exit.
  useExitPicture([popupRef]);
  const [mapped, setMapped] = useState<MappedPdfSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [intent, setIntent] = useState<AnnotationIntent | undefined>();
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
  useLayoutEffect(() => {
    const popup = popupRef.current;
    const column = popup?.parentElement;
    if (!popup || !column) return;
    const place = () => {
      const page = column.querySelector<HTMLElement>(`[data-page-number="${selection.page}"]`);
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
        footnote={mapped ? t`Mapped to the source with SyncTeX` : error ? undefined : t`Finding it in the source…`}
        canRevise
        onBodyChange={setBody}
        onIntentChange={setIntent}
        onCancel={props.onDone}
        onSave={(revise) => {
          if (!mapped) return;
          if (rounds.createFromPdf(selection, mapped, body, intent, revise)) props.onDone();
          else setError(t`The source changed since the PDF was built. Build again, then annotate.`);
        }}
      />
    </div>
  );
}
