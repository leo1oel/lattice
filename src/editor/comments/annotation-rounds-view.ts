import { useMemo, useSyncExternalStore } from "react";
import type { AnnotationRound, EditorComment } from "./editor-comment-data";
import { pendingProposals, revisable, roundProgress, type AnnotationRounds } from "../../app/annotation-rounds";

/** What the panel shows and asks of the revision rounds (`app/annotation-rounds.ts`). */
export type AnnotationRoundsView = {
  /** Annotations the agent is answering now. */
  running: ReadonlySet<string>;
  /** The open round, while one is: how many it asked about and how many are answered. */
  progress: { round: number; total: number; answered: number; running: number } | null;
  /** Proposals waiting for the writer. */
  proposals: readonly EditorComment[];
  /** How many annotations a round would ask about now. */
  revisable: number;
  /** Whether there are rounds to compare. */
  hasRounds: boolean;
  onRevise: () => void;
  onReview: (id: string) => void;
  onRetry: (id: string) => void;
  onAnswer: (id: string, answer: string) => void;
  onOpenRounds: () => void;
  /** A compiled PDF is on screen to export a review copy of. */
  reviewPdfReady: boolean;
  onExportReviewPdf: () => void;
};

const NO_RUNNING: ReadonlySet<string> = new Set();
const NO_ROUNDS: readonly AnnotationRound[] = [];
const noSubscription = () => () => {};
const noRunning = () => NO_RUNNING;
const notReady = () => false;

/** The rounds as the panel shows them, read from the rounds while the panel is on screen. */
export function useRoundsView(
  annotationRounds: AnnotationRounds | undefined,
  roundsList: readonly AnnotationRound[] = NO_ROUNDS,
  comments: readonly EditorComment[],
): AnnotationRoundsView | undefined {
  const running = useSyncExternalStore(
    annotationRounds?.subscribe ?? noSubscription,
    annotationRounds ? () => annotationRounds.getSnapshot().running : noRunning,
  );
  const reviewPdfReady = useSyncExternalStore(
    annotationRounds?.subscribe ?? noSubscription,
    annotationRounds ? () => annotationRounds.getSnapshot().reviewPdfReady : notReady,
  );
  return useMemo(() => annotationRounds && {
    running,
    progress: roundProgress(roundsList, comments, running),
    proposals: pendingProposals(comments),
    revisable: comments.filter((annotation) => revisable(annotation, running)).length,
    hasRounds: roundsList.some((round) => round.settledAt),
    onRevise: () => annotationRounds.revise(),
    onReview: annotationRounds.openReview,
    onRetry: (id: string) => annotationRounds.retry(id),
    onAnswer: annotationRounds.answer,
    onOpenRounds: annotationRounds.openRounds,
    reviewPdfReady,
    onExportReviewPdf: annotationRounds.openReviewPdf,
  }, [annotationRounds, comments, roundsList, running, reviewPdfReady]);
}
