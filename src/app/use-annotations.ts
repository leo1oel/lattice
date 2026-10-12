import { useLingui } from "@lingui/react/macro";
import { useCallback, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { OpenProjectFile, SyncTexTarget } from "../app-types";
import type { CanvasAnnotations, MappedPdfSelection } from "../canvas/pdf-annotation-composer";
import { annotationStatus, type EditorComment } from "../editor/comments/editor-comment-data";
import type { AnnotationRoundsView } from "../editor/comments/editor-comments-panel";
import { sourceRangeForPdfText } from "../editor/comments/pdf-source-anchor";
import type { CitationInfo } from "../editor/latex/latex-text";
import type { PdfAnnotationMark, PdfTextSelection } from "../pdf/pdf-viewer";
import { useLatestRef } from "../hooks/use-latest-ref";
import { revisable, useAnnotationRounds } from "./use-annotation-rounds";
import type { EditorComments } from "./use-editor-comments";

type Ref<T> = { readonly current: T };

/**
 * Local annotations as the workspace shows them: the revision rounds behind
 * them (`use-annotation-rounds.ts`), what the editor and the compiled PDF
 * draw and ask (`canvas`), what the Annotations panel shows (`panel`), and
 * the Revision rounds sheet. App renders each where it belongs.
 */
export function useAnnotations({ comments, projectRootRef, activeFileRef, sourceRef, openFile, citations, openTool, overleafLinked }: {
  comments: EditorComments;
  projectRootRef: Ref<string | null>;
  activeFileRef: Ref<string>;
  /** The active file's live text. */
  sourceRef: Ref<string>;
  openFile: OpenProjectFile;
  citations: readonly CitationInfo[];
  /** Open a tool panel; the Annotations panel is `comments`. */
  openTool: (kind: "comments") => void;
  /** A project linked to Overleaf keeps its notes as Overleaf threads, which have no place on the PDF. */
  overleafLinked: boolean;
}) {
  const { t, i18n } = useLingui();
  const openPanel = useCallback(() => openTool("comments"), [openTool]);
  const citationsRef = useLatestRef(citations);
  const readSource = useCallback(async (path: string): Promise<string | null> => {
    if (path === activeFileRef.current) return sourceRef.current;
    const projectRoot = projectRootRef.current;
    if (!projectRoot) return null;
    return invoke<string>("read_project_file", { path, projectRoot }).catch(() => null);
  }, [activeFileRef, projectRootRef, sourceRef]);
  const [roundsOpen, setRoundsOpen] = useState(false);
  const openRounds = useCallback(() => setRoundsOpen(true), []);
  const rounds = useAnnotationRounds({
    store: comments,
    projectRootRef,
    readSource,
    openProjectFile: openFile,
    // eslint-disable-next-line lingui/no-unlocalized-strings -- model input, not interface copy
    language: i18n.locale.startsWith("zh") ? "Simplified Chinese" : "English",
    citations: () => citationsRef.current,
    onCompare: openRounds,
  });

  const { comments: local, openComment, setActiveId } = comments;
  const { revise, accepted, rejected, retry, answer, openReview, closeReview, neighbour } = rounds;

  /**
   * Show an annotation: its passage in the editor (its proposal, when one
   * waits), and its card in the panel unless `inPlace`: a pin on the PDF
   * leaves the panel where it is, which may be the PDF's own.
   */
  const open = useCallback((comment: EditorComment, inPlace = false) => {
    if (!inPlace) openPanel();
    setActiveId(comment.id);
    if (comment.revision?.state === "proposed" && !comment.resolved) openReview(comment.id);
    else openComment(comment);
  }, [openComment, openPanel, openReview, setActiveId]);

  /** Decide one proposal, then move to the next one waiting, or close the review. */
  const decide = useCallback((id: string, decision: () => void) => {
    const next = neighbour(id, 1);
    decision();
    if (next) openReview(next.id);
    else closeReview();
  }, [closeReview, neighbour, openReview]);

  /** Where text selected on the PDF was written: SyncTeX's line, then the words around it. */
  const mapPdfSelection = useCallback(async (selection: PdfTextSelection): Promise<MappedPdfSelection> => {
    const target = await invoke<SyncTexTarget>("synctex_edit", { page: selection.page, x: selection.point.x, y: selection.point.y });
    const source = await readSource(target.path);
    if (source === null) throw new Error(t`Lattice could not read ${target.path}.`);
    const range = sourceRangeForPdfText(source, target.line, selection.text);
    if (!range) throw new Error(t`SyncTeX placed this text outside ${target.path}. Build the PDF again, then annotate.`);
    return { path: target.path, line: source.slice(0, range.from).split("\n").length, from: range.from, to: range.to, source };
  }, [readSource, t]);

  const pdfMarks = useMemo((): PdfAnnotationMark[] => local.flatMap((annotation) => annotation.pdf && !annotation.resolved
    ? [{ id: annotation.id, number: annotation.number ?? 0, page: annotation.pdf.page, rects: annotation.pdf.rects, status: annotationStatus(annotation) }]
    : []), [local]);

  const reviseAll = useCallback(() => {
    revise();
    openPanel();
  }, [openPanel, revise]);

  const canvas = useMemo((): CanvasAnnotations => ({
    local,
    proposals: rounds.proposals,
    running: rounds.running,
    review: rounds.review,
    canRevise: true,
    canAnnotatePdf: !overleafLinked,
    pdfMarks,
    onRevise: reviseAll,
    onOpen: (comment) => open(comment),
    onOpenById: (id) => {
      const annotation = comments.stateRef.current.annotations.find((item) => item.id === id);
      if (annotation) open(annotation, true);
    },
    onAccepted: (id, applied) => decide(id, () => accepted(id, applied)),
    onRejected: (id) => decide(id, () => rejected(id)),
    onRetry: retry,
    onNavigate: (from, step) => {
      const next = neighbour(from, step);
      if (next) openReview(next.id);
    },
    onCloseReview: closeReview,
    mapPdfSelection,
  }), [accepted, closeReview, comments.stateRef, decide, local, mapPdfSelection, neighbour, open, openReview, overleafLinked, pdfMarks,
    rejected, retry, reviseAll, rounds.proposals, rounds.review, rounds.running]);

  const panel = useMemo((): AnnotationRoundsView => ({
    running: rounds.running,
    progress: rounds.progress,
    proposals: rounds.proposals,
    revisable: local.filter((annotation) => revisable(annotation, rounds.running)).length,
    hasRounds: comments.rounds.some((round) => round.settledAt),
    onRevise: reviseAll,
    onReview: openReview,
    onRetry: (id) => retry(id),
    onAnswer: answer,
    onOpenRounds: openRounds,
  }), [answer, comments.rounds, local, openReview, openRounds, retry, reviseAll, rounds.progress, rounds.proposals, rounds.running]);

  return { rounds, canvas, panel, readSource, roundsOpen, setRoundsOpen };
}

export type Annotations = ReturnType<typeof useAnnotations>;
