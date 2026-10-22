/**
 * Export review PDF: a copy of the compiled PDF that carries the annotations
 * the writer ticks as standard PDF comments, for a collaborator who reads in
 * Preview, Acrobat or Zotero rather than in Lattice. Opening the sheet finds
 * each annotation on the PDF the preview shows (review-pdf.ts); unticked
 * notes stay private, and the plain PDF and the project are not touched.
 * Page 1 also gets a note saying when the PDF was built and exported, so a
 * reply can be matched to the version it was about.
 */
import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { CircleAlert, Highlighter, MessageSquareShare, StickyNote } from "lucide-react";
import type { AnnotationRounds } from "../app/annotation-rounds";
import { InfinityLoader } from "../components/ui/activity-icons";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { InlineMessage } from "../components/ui/inline-message";
import { LoadingAnnouncement } from "../components/ui/loading-status";
import { PanelHeader } from "../components/ui/panel-header";
import { SheetDialog } from "../components/ui/sheet-dialog";
import { AnnotationPin } from "../editor/comments/annotation-pin";
import {
  annotationStatus, editorCommentAuthorDisplayName, type EditorComment,
} from "../editor/comments/editor-comment-data";
import { useIntentLabels } from "../editor/comments/use-intent-labels";
import { toMessage } from "../app-utils";
import { i18n } from "../i18n";
import { logAction } from "../telemetry/app-notify";
import { PDFDateString } from "./pdfjs-runtime";
import type { ActiveViewerRef } from "./use-pdf-view";
import {
  lineAndColumn, pdfDigest, placeAnnotation, reviewFileName, separateNotes,
  type PageText, type PlacementReader, type ReviewPlacement, type SyncBox, type TextRun,
} from "./review-pdf";
import "../papers/add-papers-sheet.css";
import "./review-pdf-sheet.css";

/** One note as `save_review_pdf` takes it (`ReviewNote` in review_pdf.rs). */
type ReviewNote = {
  id: string;
  page: number;
  contents: string;
  author: string;
  created: string;
  modified: string;
} & ({ kind: "highlight"; quads: number[][] } | { kind: "note"; x: number; y: number });

const PDF_SOURCE = "PDF";
/** The cover note's id, in its `/NM`. */
const COVER_ID = "review-cover";

const shortQuote = (quote: string) => {
  const flat = quote.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
};

export default function ReviewPdfSheet({ recordRef, fileName, annotations, rounds, onClose }: {
  /** The preview's viewer, whose document the notes are placed on and whose bytes are annotated. */
  recordRef: ActiveViewerRef;
  fileName: string;
  annotations: readonly EditorComment[];
  rounds: AnnotationRounds;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const intentLabels = useIntentLabels();
  // Local annotations only (an Overleaf thread has no pin and stays in
  // Overleaf), as they were when the sheet opened: an answer landing from a
  // revision round meanwhile neither re-places them nor resets the ticks.
  const [notes] = useState(
    () => annotations.filter((annotation) => annotation.number).sort((a, b) => a.number! - b.number!),
  );
  const [failure, setFailure] = useState<string | null>(null);
  const [placements, setPlacements] = useState<ReadonlyMap<string, ReviewPlacement> | null>(null);
  const [views, setViews] = useState<ReadonlyMap<number, number[]>>(new Map());
  const [built, setBuilt] = useState<Date | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [withReplies, setWithReplies] = useState(true);
  const [busy, setBusy] = useState(false);

  // Placed once, on the document the sheet opened over: a rebuild replaces
  // the preview, whose release closes the sheet. Its bytes' digest goes with
  // the notes, so the backend annotates only the PDF they were placed on.
  const [digest, setDigest] = useState<string | null>(null);
  useEffect(() => {
    const document = recordRef.current?.slick.document;
    if (!document) return;
    let live = true;
    const pages = new Map<number, Promise<PageText>>();
    const pageViews = new Map<number, number[]>();
    const reader: PlacementReader = {
      pageCount: document.numPages,
      page: (number) => {
        let text = pages.get(number);
        if (!text) {
          text = document.getPage(number).then(async (page) => {
            const content = await page.getTextContent();
            pageViews.set(number, page.view);
            return { view: page.view, runs: content.items.filter((item): item is TextRun & typeof item => "str" in item) };
          });
          pages.set(number, text);
        }
        return text;
      },
      sync: async (annotation) => {
        const source = await rounds.readSource(annotation.path);
        if (source === null) return null;
        const { line, column } = lineAndColumn(source, annotation.from);
        return invoke<SyncBox | null>("synctex_view", { path: annotation.path, line, column });
      },
    };
    (async () => {
      const placed = new Map<string, ReviewPlacement>();
      // One at a time: each source note runs SyncTeX, a process of its own.
      for (const annotation of notes) {
        placed.set(annotation.id, await placeAnnotation(annotation, reader).catch(() => ({ kind: "unplaced" as const })));
        if (!live) return;
      }
      await reader.page(1);
      const sum = await pdfDigest(await document.getData());
      const info = await document.getMetadata().catch(() => null);
      if (!live) return;
      const created = (info?.info as { CreationDate?: unknown } | undefined)?.CreationDate;
      setBuilt(typeof created === "string" ? PDFDateString.toDateObject(created) : null);
      setDigest(sum);
      setViews(pageViews);
      setPlacements(placed);
      // What a collaborator should see: every open note that is on the PDF.
      setSelected(new Set(notes.filter((annotation) => !annotation.resolved && placed.get(annotation.id)?.kind !== "unplaced")
        .map((annotation) => annotation.id)));
    })().catch((reason: unknown) => {
      if (live) setFailure(toMessage(reason));
    });
    return () => { live = false; };
  }, [notes, recordRef, rounds]);

  const placeable = placements ? notes.filter((annotation) => placements.get(annotation.id)?.kind !== "unplaced") : [];
  const chosen = placeable.filter((annotation) => selected.has(annotation.id));
  const allChosen = placeable.length > 0 && chosen.length === placeable.length;
  const toggle = (id: string, on: boolean) => setSelected((current) => {
    const next = new Set(current);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });
  const anonymous = t`Anonymous`;
  const formatDate = (date: Date) => new Intl.DateTimeFormat(i18n.locale, { dateStyle: "medium", timeStyle: "short" }).format(date);

  /** The comment a reader shows: its pin and intent, the note, what it is about, and its replies. */
  const contentsOf = (annotation: EditorComment, placement: ReviewPlacement) => {
    const heading = annotation.intent ? `#${annotation.number} · ${intentLabels[annotation.intent]}` : `#${annotation.number}`;
    const parts = [heading, annotation.body.trim()];
    // A highlight shows its words; a margin note says which they are.
    if (placement.kind === "note") parts.push(t`On “${shortQuote(annotation.quote)}”`);
    if (withReplies && annotation.replies.length) {
      parts.push(annotation.replies
        .map((reply) => `${editorCommentAuthorDisplayName(reply.authorName, anonymous)}: ${reply.body.trim()}`)
        .join("\n"));
    }
    return parts.filter(Boolean).join("\n\n");
  };

  const exportReview = () => {
    const projectRoot = rounds.projectRoot();
    if (!placements || !digest || !chosen.length || busy || !projectRoot) return;
    const exported = new Date();
    const view = views.get(1) ?? [0, 0, 612, 792];
    const count = chosen.length === 1 ? t`1 note` : t`${chosen.length} notes`;
    const coverLines = [
      t`Review copy exported from Lattice on ${formatDate(exported)}, with ${count}.`,
      built ? t`The PDF was built on ${formatDate(built)}.` : "",
      t`Each note is a comment on the passage it is about; reply in your PDF reader and send the file back.`,
    ];
    // The cover stands in page 1's top right corner; notes in that margin make way for it.
    const cover: ReviewPlacement = { kind: "note", page: 1, x: (view[2] ?? 612) - 26, y: (view[3] ?? 792) - 8 };
    const [coverPlace, ...spaced] = separateNotes([cover, ...chosen.map((annotation) => placements.get(annotation.id)!)], views) as
      Array<Exclude<ReviewPlacement, { kind: "unplaced" }>>;
    const stamp = exported.toISOString();
    const reviewNotes: ReviewNote[] = [
      {
        id: COVER_ID, contents: coverLines.filter(Boolean).join("\n"),
        author: editorCommentAuthorDisplayName(rounds.author().name, anonymous), created: stamp, modified: stamp, ...coverPlace!,
      },
      ...chosen.map((annotation, index) => ({
        id: annotation.id,
        contents: contentsOf(annotation, spaced[index]!),
        author: editorCommentAuthorDisplayName(annotation.authorName, anonymous),
        created: annotation.createdAt,
        modified: annotation.updatedAt,
        ...spaced[index]!,
      })),
    ];
    // A promise chain, not try/finally: that statement makes the React Compiler bail out.
    void saveDialog({
      title: t`Export review PDF`,
      defaultPath: reviewFileName(fileName),
      filters: [{ name: t`PDF document`, extensions: ["pdf"] }],
    }).then((destination) => {
      if (!destination) return;
      setBusy(true);
      const trace = logAction(PDF_SOURCE, t`Export review PDF`, fileName);
      return invoke<string>("save_review_pdf", { projectRoot, destination, review: { digest, notes: reviewNotes } })
        .then((path) => {
          trace.ok(t({ message: `Saved to ${path}` }));
          onClose();
        }, (reason: unknown) => {
          trace.fail(reason);
          setBusy(false);
        });
    }, (reason: unknown) => logAction(PDF_SOURCE, t`Export review PDF`, fileName).fail(reason));
  };

  const placementLabel = (placement: ReviewPlacement | undefined) => {
    if (!placement) return "";
    if (placement.kind === "unplaced") return t`Not on this PDF`;
    return placement.kind === "highlight" ? t`Highlight · p. ${placement.page}` : t`Margin note · p. ${placement.page}`;
  };
  // Why a row cannot be ticked, and how to fix it: the only hint a row keeps.
  const placementHint = (placement: ReviewPlacement | undefined) => (placement?.kind === "unplaced"
    ? t`SyncTeX does not place this passage on the PDF. Build the project again, then export.`
    : undefined);
  const hasReplies = chosen.some((annotation) => annotation.replies.length > 0);
  const action = chosen.length === 1 ? t`Export 1 note…` : chosen.length ? t`Export ${chosen.length} notes…` : t`Export notes…`;

  return (
    <SheetDialog className="add-papers-sheet review-pdf-sheet" label={t`Export review PDF`} onClose={onClose}>
      <PanelHeader className="drawer-header" icon={<MessageSquareShare size={16} />} title={t`Export review PDF`} onClose={onClose} />
      <div className="add-papers-body review-pdf-body">
        {!notes.length ? (
          <p className="review-pdf-empty">{t`No annotations yet`}</p>
        ) : failure ? (
          <InlineMessage level="error">{failure}</InlineMessage>
        ) : !placements ? (
          <div className="review-pdf-loading">
            <InfinityLoader size={14} />
            <LoadingAnnouncement message={t`Finding each note on the PDF…`} />
          </div>
        ) : (
          <div className="review-pdf-list">
            <label className="review-pdf-all">
              <Checkbox
                checked={allChosen}
                indeterminate={chosen.length > 0 && !allChosen}
                disabled={!placeable.length || busy}
                onChange={() => setSelected(new Set(allChosen ? [] : placeable.map((annotation) => annotation.id)))}
              />
              <span>{t`${chosen.length} of ${placeable.length} selected`}</span>
            </label>
            <ol className="add-papers-rows review-pdf-rows">
              {notes.map((annotation) => {
                const placement = placements.get(annotation.id);
                const unplaced = placement?.kind === "unplaced";
                const status = annotationStatus(annotation);
                return (
                  <li key={annotation.id} data-resolved={annotation.resolved || undefined} data-unplaced={unplaced || undefined}>
                    <label className="review-pdf-row">
                      <Checkbox
                        checked={selected.has(annotation.id) && !unplaced}
                        disabled={unplaced || busy}
                        onChange={(event) => toggle(annotation.id, event.target.checked)}
                      />
                      <AnnotationPin number={annotation.number!} status={status} />
                      <span className="add-papers-main">
                        <strong title={annotation.quote}>{shortQuote(annotation.quote)}</strong>
                        <span title={annotation.body}>
                          {annotation.resolved ? `${t`Resolved`} · ` : ""}
                          {annotation.body.trim() || t`No note`}
                        </span>
                      </span>
                      {placement && <PlacementChip kind={placement.kind} label={placementLabel(placement)} hint={placementHint(placement)} />}
                    </label>
                  </li>
                );
              })}
            </ol>
            {hasReplies && (
              <label className="review-pdf-option">
                <Checkbox checked={withReplies} disabled={busy} onChange={(event) => setWithReplies(event.target.checked)} />
                <span>{t`Include replies`}</span>
              </label>
            )}
          </div>
        )}
      </div>
      <div className="table-generator-actions add-papers-footer">
        <Button variant="ghost" onClick={onClose}>{t`Cancel`}</Button>
        <Button variant="primary" disabled={!chosen.length || busy} onClick={exportReview}>
          {busy && <InfinityLoader size={14} />}
          {action}
        </Button>
      </div>
    </SheetDialog>
  );
}

const PLACEMENT_ICONS = { highlight: Highlighter, note: StickyNote, unplaced: CircleAlert } as const;

/**
 * Where a note lands, said by the chip alone: a highlight on its words, a
 * note in the margin where they are not on the page, or nowhere yet.
 */
function PlacementChip({ kind, label, hint }: { kind: ReviewPlacement["kind"]; label: string; hint?: string }) {
  const Icon = PLACEMENT_ICONS[kind];
  return (
    <span className="review-pdf-place" data-kind={kind} title={hint}>
      <Icon size={11} aria-hidden="true" />
      {label}
    </span>
  );
}
