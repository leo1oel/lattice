/** A comment's popups over its passage on the PDF: the preview on hover, and the card a click opens. */
import { useEffect, useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import { ArrowUpRight } from "lucide-react";
import type { AnnotationRounds } from "../app/annotation-rounds";
import { Button } from "../components/ui/button";
import { CommentCard, CommentPreview } from "../editor/comments/comment-card";
import type { EditorComment } from "../editor/comments/editor-comment-data";
import { useDismissOnOutsidePointer } from "../hooks/use-dismiss-on-outside-pointer";
import { usePdfAnchoredPopup, type PdfPassage } from "./use-pdf-anchored-popup";

const CARD_PLACE = { side: "above", width: 320 } as const;
const PREVIEW_PLACE = { side: "above" } as const;

/** The preview over a passage the pointer rests on: lines only, never in the pointer's way. */
export function PdfCommentPreview({ annotation, passage }: { annotation: EditorComment; passage: PdfPassage }) {
  const ref = useRef<HTMLDivElement>(null);
  usePdfAnchoredPopup(ref, passage, PREVIEW_PLACE);
  return (
    <div ref={ref} role="tooltip" className="pdf-comment-popup pdf-comment-preview">
      <CommentPreview comments={[annotation]} />
    </div>
  );
}

/** An annotation's card on the PDF, above its passage, until Esc or a click elsewhere. */
export function PdfCommentCard({ annotation, passage, rounds, keyboard, onResolving, onClose }: {
  annotation: EditorComment;
  passage: PdfPassage;
  rounds: AnnotationRounds;
  keyboard: boolean;
  onResolving: (id: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  usePdfAnchoredPopup(ref, passage, CARD_PLACE);
  // Its own pin opened it: pressing the pin again is not a click elsewhere.
  useDismissOnOutsidePointer(ref, onClose, (target) => Boolean(target.closest(`[data-annotation-id="${CSS.escape(annotation.id)}"]`)));
  useEffect(() => {
    if (keyboard) ref.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [keyboard]);
  return (
    <div ref={ref} className="pdf-comment-popup">
      <PdfCommentThread annotation={annotation} rounds={rounds} onResolving={onResolving} onClose={onClose} onShowSource={onClose} />
    </div>
  );
}

/**
 * A comment's card as the PDF shows it, over its passage or in the comment
 * column: the thread with Resolve and Reply, and the way to its source.
 */
export function PdfCommentThread({ annotation, rounds, onResolving, onClose, onShowSource, still }: {
  annotation: EditorComment;
  rounds: AnnotationRounds;
  onResolving: (id: string) => void;
  onClose: () => void;
  onShowSource?: () => void;
  still?: boolean;
}) {
  const { t } = useLingui();
  const proposed = annotation.revision?.state === "proposed";
  return (
    <CommentCard
      comments={[annotation]}
      author={rounds.author()}
      onResolve={rounds.resolve}
      onReply={rounds.reply}
      onResolving={onResolving}
      onClose={onClose}
      still={still}
      footer={(
        <Button
          size="compact"
          variant="ghost"
          onClick={() => {
            onShowSource?.();
            rounds.open(annotation, true);
          }}
        >
          <ArrowUpRight size={13} aria-hidden="true" />
          {proposed ? t`Review the proposal` : t`Show in the source`}
        </Button>
      )}
    />
  );
}
