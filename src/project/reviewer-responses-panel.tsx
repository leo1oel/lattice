/**
 * Answering the venue's reviewers (`reviewer-responses.ts`), as a tool panel.
 *
 * Pasted reviews become comments under numbers that stay (R1.1, R2.3), once
 * the writer has confirmed how the paste was cut. Each comment then reads
 * like an issue: a status mark, its number and the reviewer's words; opened,
 * the words stay as written above who owns it, the reply, whether the reply
 * was checked, whether the paper still has to change, and the annotations on
 * the passages that changed for it. A linked passage that has since been
 * rewritten says so instead of pointing at whatever replaced it. The letter
 * goes out as Markdown or LaTeX, opening with what is still open.
 */
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useLingui } from "@lingui/react/macro";
import {
  AlertTriangle, Check, ChevronDown, ChevronRight, Download, Link2, MessageSquareQuote, Plus, Trash2, Unlink, Wand2,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { CheckboxField } from "../components/ui/checkbox-field";
import { Checkbox } from "../components/ui/checkbox";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { EmptyState } from "../components/ui/empty-state";
import { IconButton } from "../components/ui/icon-button";
import { Input } from "../components/ui/input";
import { PanelHeader } from "../components/ui/panel-header";
import { ResizableDrawer } from "../components/ui/resizable-drawer";
import { SegmentedControl } from "../components/ui/segmented-control";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { resizeTextareaToContent } from "../components/ui/auto-resize-textarea";
import { AnnotationPin } from "../editor/comments/annotation-pin";
import { annotationStatus, type EditorComment } from "../editor/comments/editor-comment-data";
import { annotationRounds } from "../app/annotation-rounds";
import { placeAnnotations, reviewerResponses } from "../app/reviewer-responses";
import { formatCount } from "../i18n";
import { utf8ToBase64 } from "../pdf/pdf-bytes";
import { logAction } from "../telemetry/app-notify";
import {
  assembleParts,
  commentLabel,
  initiallySkipped,
  nextCommentNumber,
  nextReviewer,
  normalizePasted,
  pastedReviewerNumbers,
  responseLetter,
  responseStatus,
  reviewerNumbers,
  sortedComments,
  splitPastedReviews,
  type LetterFormat,
  type LinkPlace,
  type ResponseChange,
  type ResponseStatus,
  type ReviewerComment,
  type ReviewerResponses,
} from "./reviewer-responses";
import "./reviewer-responses.css";

type Places = ReadonlyMap<string, LinkPlace>;

function useStatusLabels(): Record<ResponseStatus, string> {
  const { t } = useLingui();
  return {
    unanswered: t`Not answered`,
    drafted: t`Reply to check`,
    changing: t`Change to make`,
    done: t`Done`,
  };
}

/** "Reviewer 2", or "Reviewer 2 · xK7p" with the name the venue gave them. */
function useReviewerTitle() {
  const { t } = useLingui();
  return (responses: Pick<ReviewerResponses, "reviewers">, reviewer: number, name = responses.reviewers[String(reviewer)]) => (
    name ? t`Reviewer ${reviewer} · ${name}` : t`Reviewer ${reviewer}`
  );
}

/** Ask where the letter goes and write it there; a cancelled panel writes nothing. */
async function exportLetter(responses: ReviewerResponses, format: LetterFormat, places: Places, title: string, done: (path: string) => string) {
  const name = format === "latex" ? "response-letter.tex" : "response-letter.md";
  const trace = logAction(title, title, name, "reviewer-responses-export");
  try {
    const destination = await saveDialog({ title, defaultPath: name });
    if (!destination) return;
    const text = responseLetter(responses, format, (annotationId) => places.get(annotationId) ?? { state: "missing" });
    const written = await invoke<string>("save_source_copy", new TextEncoder().encode(text), {
      headers: { "x-copy-destination": utf8ToBase64(destination) },
    });
    trace.ok(done(written));
  } catch (reason) {
    trace.fail(reason);
  } finally {
    trace.finish("cancelled");
  }
}

/* ── Adding comments ──────────────────────────────────────────────────── */

function Intake({ responses, onDone, onCancel }: {
  responses: ReviewerResponses;
  onDone: () => void;
  onCancel: (() => void) | null;
}) {
  const { t } = useLingui();
  const reviewerTitle = useReviewerTitle();
  const [raw, setRaw] = useState("");
  const text = useMemo(() => normalizePasted(raw), [raw]);
  const pasted = useMemo(() => splitPastedReviews(text), [text]);
  const newReviewer = nextReviewer(responses);
  const [unheaded, setUnheaded] = useState(String(newReviewer));
  const [joined, setJoined] = useState<ReadonlySet<number>>(new Set());
  const [skipped, setSkipped] = useState<ReadonlySet<number>>(new Set());
  const proposedSkips = useMemo(() => initiallySkipped(pasted), [pasted]);
  // A new paste proposes afresh: the decisions were about the old text's parts.
  const [decidedFor, setDecidedFor] = useState(text);
  if (decidedFor !== text) {
    setDecidedFor(text);
    setJoined(new Set());
    setSkipped(proposedSkips);
  }
  const numbers = pastedReviewerNumbers(responses, pasted, Number(unheaded));
  const hasUnheaded = pasted.some((reviewer) => reviewer.number == null && reviewer.name == null);
  // Each reviewer's comments continue from where that reviewer's numbers are,
  // and two pasted parts for one reviewer continue from each other.
  const next = new Map<number, number>();
  const groups = pasted.map((reviewer, index) => {
    const number = numbers[index];
    const comments = assembleParts(text, reviewer.parts, joined, skipped);
    const first = next.get(number) ?? nextCommentNumber(responses, number);
    next.set(number, first + comments.length);
    // Each part as the preview lists it: whether it continues the one above,
    // whether its comment is added, and the number it would take.
    const rows: Array<{ part: (typeof reviewer.parts)[number]; partIndex: number; continues: boolean; open: boolean; shown: string | null }> = [];
    let label = first;
    let open = false;
    for (const [partIndex, part] of reviewer.parts.entries()) {
      const continues = partIndex > 0 && joined.has(part.start);
      if (!continues) open = !skipped.has(part.start);
      const shown = open && !continues ? commentLabel({ reviewer: number, number: label }) : null;
      if (shown) label += 1;
      rows.push({ part, partIndex, continues, open, shown });
    }
    return { reviewer, number, rows };
  });
  const total = groups.reduce((sum, group) => sum + assembleParts(text, group.reviewer.parts, joined, skipped).length, 0);
  const toggle = (set: ReadonlySet<number>, key: number) => {
    const copy = new Set(set);
    if (!copy.delete(key)) copy.add(key);
    return copy;
  };
  const add = () => {
    reviewerResponses.add(groups.map(({ reviewer, number }) => ({
      reviewer: number,
      ...reviewer.name ? { name: reviewer.name } : {},
      comments: assembleParts(text, reviewer.parts, joined, skipped),
    })));
    onDone();
  };
  const fieldId = useId();
  return (
    <div className="responses-intake">
      <div className="responses-intake-head">
        <label className="responses-intake-title" htmlFor={fieldId}>{t`Paste the reviews`}</label>
        <p>{t`Each comment keeps the reviewer's words and a number that stays. A heading such as “Reviewer 2” starts the next reviewer.`}</p>
      </div>
      <Textarea
        id={fieldId}
        className="responses-intake-text"
        value={raw}
        placeholder={t`Reviewer 1\n1. The ablation leaves out…\n2. …`}
        onChange={(event) => setRaw(event.target.value)}
        autoFocus
      />
      {hasUnheaded && (
        <div className="responses-intake-reviewer">
          <span>{t`Comments without a heading are from`}</span>
          <Select value={unheaded} onValueChange={setUnheaded}>
            <SelectTrigger size="compact" aria-label={t`Reviewer of comments without a heading`}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={String(newReviewer)}>{t`New reviewer (R${newReviewer})`}</SelectItem>
              {reviewerNumbers(responses).map((reviewer) => (
                <SelectItem key={reviewer} value={String(reviewer)}>{reviewerTitle(responses, reviewer)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {groups.map(({ reviewer, number, rows }, index) => (
        <section key={`${index}-${reviewer.parts[0].start}`} className="responses-intake-group">
          <h3>{reviewerTitle(responses, number, reviewer.name ?? undefined)}</h3>
          <ol>
            {rows.map(({ part, partIndex, continues, open, shown }) => {
              return (
                <li key={part.start} data-skipped={!open || undefined} data-continues={continues || undefined}>
                  {continues ? <span className="responses-intake-gap" /> : (
                    <Checkbox
                      checked={open}
                      aria-label={t`Add this comment`}
                      onChange={() => setSkipped((current) => toggle(current, part.start))}
                    />
                  )}
                  <span className="responses-intake-label">{shown}</span>
                  <p>{text.slice(part.start, part.end)}</p>
                  {partIndex > 0 && (open || continues) ? (
                    <IconButton
                      size="compact"
                      label={continues ? t`Make its own comment` : t`Join with the comment above`}
                      aria-pressed={continues}
                      onClick={() => setJoined((current) => toggle(current, part.start))}
                    >
                      <Link2 size={13} />
                    </IconButton>
                  ) : <span />}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
      <footer className="responses-foot">
        <span>{raw.trim() && !total ? t`Nothing to add: every part is left out` : null}</span>
        {onCancel ? <Button size="compact" variant="ghost" onClick={onCancel}>{t`Cancel`}</Button> : null}
        <Button size="compact" variant="primary" disabled={!total} onClick={add}>
          {total === 1 ? t`Add 1 comment` : t`Add ${formatCount(total)} comments`}
        </Button>
      </footer>
    </div>
  );
}

/* ── One comment ──────────────────────────────────────────────────────── */

/** A linked annotation under its pin number now, or marked deleted once no annotation has its id. */
function LinkedPassage({ place, annotation, onOpen, onUnlink }: {
  place: LinkPlace | undefined;
  annotation: EditorComment | undefined;
  onOpen: () => void;
  onUnlink: () => void;
}) {
  const { t } = useLingui();
  const number = annotation?.number;
  const where = !annotation ? t`Annotation deleted`
    : !place ? null
      : place.state === "placed" ? `${place.path}:${place.line}`
        : place.state === "moved" ? t`Passage rewritten since it was linked`
          : t`Annotation deleted`;
  const lost = !annotation || place?.state === "moved" || place?.state === "missing";
  return (
    <li className="responses-link" data-lost={lost || undefined}>
      <button type="button" className="responses-link-open" disabled={!annotation} onClick={onOpen} title={number ? t`Show annotation ${number}` : undefined}>
        {annotation && number ? <AnnotationPin number={number} status={annotationStatus(annotation)} /> : null}
        {annotation ? <span className="responses-link-quote">{annotation.quote.replace(/\s+/g, " ").trim()}</span> : null}
        {where ? (
          <span className="responses-link-where">
            {lost ? <AlertTriangle size={12} aria-hidden="true" /> : null}{where}
          </span>
        ) : null}
      </button>
      <IconButton size="compact" label={number ? t`Unlink annotation ${number}` : t`Unlink the deleted annotation`} onClick={onUnlink}><Unlink size={13} /></IconButton>
    </li>
  );
}

function CommentDetail({ comment, annotations, places, owners }: {
  comment: ReviewerComment;
  annotations: readonly EditorComment[];
  places: Places;
  owners: readonly string[];
}) {
  const { t } = useLingui();
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const ownersId = useId();
  useEffect(() => {
    if (replyRef.current) resizeTextareaToContent(replyRef.current);
  }, [comment.reply]);
  const linkable = annotations.filter((annotation) => annotation.number && !comment.annotationIds.includes(annotation.id));
  const changes: Array<{ value: ResponseChange; label: string }> = [
    { value: "todo", label: t({ message: "To change", context: "paper change for a reviewer comment" }) },
    { value: "done", label: t({ message: "Changed", context: "paper change for a reviewer comment" }) },
    { value: "none", label: t({ message: "No change", context: "paper change for a reviewer comment" }) },
  ];
  const update = reviewerResponses.update;
  return (
    <div className="responses-detail">
      <blockquote className="responses-original" aria-label={t`The reviewer's comment`}>{comment.comment}</blockquote>
      <label className="responses-field">
        <span>{t`Owner`}</span>
        <Input
          controlSize="compact"
          value={comment.owner}
          list={ownersId}
          placeholder={t`Who answers it`}
          onChange={(event) => update(comment.id, { owner: event.target.value })}
        />
        <datalist id={ownersId}>{owners.map((owner) => <option key={owner} value={owner} />)}</datalist>
      </label>
      <label className="responses-field">
        <span>{t`Reply`}</span>
        <Textarea
          ref={replyRef}
          className="responses-reply"
          value={comment.reply}
          placeholder={t`What you tell the reviewer`}
          onChange={(event) => update(comment.id, { reply: event.target.value })}
        />
      </label>
      <CheckboxField
        className="responses-checked"
        checked={comment.replyChecked}
        disabled={!comment.reply.trim()}
        onChange={(event) => update(comment.id, { replyChecked: event.target.checked })}
        label={t`Reply checked against the paper`}
      />
      <div className="responses-field">
        <span>{t({ message: "Paper", context: "whether the paper changes for a reviewer comment" })}</span>
        <SegmentedControl
          ariaLabel={t`Whether the paper changes for this comment`}
          value={comment.change}
          items={changes}
          onChange={(change) => update(comment.id, { change })}
        />
      </div>
      <div className="responses-field">
        <span>{t`Changed passages`}</span>
        {comment.annotationIds.length ? (
          <ul className="responses-links">
            {comment.annotationIds.map((annotationId) => (
              <LinkedPassage
                key={annotationId}
                place={places.get(annotationId)}
                annotation={annotations.find((annotation) => annotation.id === annotationId)}
                onOpen={() => reviewerResponses.openAnnotation(annotationId)}
                onUnlink={() => reviewerResponses.unlink(comment.id, annotationId)}
              />
            ))}
          </ul>
        ) : null}
        <div className="responses-detail-actions">
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button size="compact" variant="secondary"><Link2 size={13} aria-hidden="true" />{t`Link annotation`}</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="responses-menu">
              {linkable.length ? linkable.map((annotation) => (
                <DropdownMenuItem key={annotation.id} onSelect={() => reviewerResponses.link(comment.id, annotation.id)}>
                  <AnnotationPin number={annotation.number!} status={annotationStatus(annotation)} />
                  <span className="responses-menu-quote">{annotation.quote.replace(/\s+/g, " ").trim()}</span>
                </DropdownMenuItem>
              )) : (
                <DropdownMenuLabel className="responses-menu-empty">
                  {annotations.length
                    ? t`Every annotation is linked already`
                    : t`Annotate the passage you changed, then link it here`}
                </DropdownMenuLabel>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="compact" variant="ghost" className="responses-remove" onClick={() => reviewerResponses.remove(comment.id)}>
            <Trash2 size={13} aria-hidden="true" />{t({ message: "Remove", context: "reviewer comment" })}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CommentRow({ comment, expanded, onToggle, lost, ...detail }: {
  comment: ReviewerComment;
  expanded: boolean;
  onToggle: () => void;
  /** Whether a linked passage was rewritten or its annotation deleted. */
  lost: boolean;
  annotations: readonly EditorComment[];
  places: Places;
  owners: readonly string[];
}) {
  const { t } = useLingui();
  const labels = useStatusLabels();
  const status = responseStatus(comment);
  return (
    <li className="responses-comment" data-open={expanded || undefined} data-status={status}>
      <button type="button" className="responses-comment-row" aria-expanded={expanded} onClick={onToggle}>
        <span className="responses-mark" role="img" aria-label={labels[status]} title={labels[status]}>
          {status === "done" ? <Check size={10} strokeWidth={3} /> : null}
        </span>
        <span className="responses-label">{commentLabel(comment)}</span>
        {/* Opened, the comment is quoted in full below; the row says where it stands instead. */}
        <span className="responses-comment-text">{expanded ? labels[status] : comment.comment}</span>
        <span className="responses-comment-meta">
          {lost ? <AlertTriangle size={12} className="responses-lost" aria-label={t`A linked passage needs checking`} /> : null}
          {comment.owner.trim() ? <span className="responses-owner" title={comment.owner}>{comment.owner}</span> : null}
        </span>
        {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
      </button>
      {expanded && <CommentDetail comment={comment} {...detail} />}
    </li>
  );
}

/* ── The panel ────────────────────────────────────────────────────────── */

export function ReviewerResponsesPanel({ annotations, onClose }: {
  /** The project's annotations: what a comment can link to, and where each passage is now. */
  annotations: readonly EditorComment[];
  onClose: () => void;
}) {
  const { t } = useLingui();
  const reviewerTitle = useReviewerTitle();
  const { loaded, responses } = useSyncExternalStore(reviewerResponses.subscribe, reviewerResponses.getSnapshot);
  const { running } = useSyncExternalStore(annotationRounds.subscribe, annotationRounds.getSnapshot);
  useEffect(() => {
    if (!loaded) void reviewerResponses.load();
  }, [loaded]);
  // Closing the panel writes a reply still waiting on its pause.
  useEffect(() => () => { void reviewerResponses.flush(); }, []);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [open, setOpen] = useState<string | null>(null);
  const comments = useMemo(() => sortedComments(responses.comments), [responses.comments]);

  // Where each linked passage is now, read again as annotations or links change.
  const linked = useMemo(() => [...new Set(comments.flatMap((comment) => comment.annotationIds))].sort(), [comments]);
  const linkedKey = JSON.stringify(linked);
  const [places, setPlaces] = useState<Places>(new Map());
  useEffect(() => {
    let current = true;
    void placeAnnotations(JSON.parse(linkedKey) as string[], annotations).then((next) => {
      if (current) setPlaces(next);
    });
    return () => { current = false; };
  }, [linkedKey, annotations]);

  const counts = { unanswered: 0, drafted: 0, changing: 0, done: 0 } satisfies Record<ResponseStatus, number>;
  for (const comment of comments) counts[responseStatus(comment)] += 1;
  const answered = counts.changing + counts.done;
  const pending = [
    counts.unanswered === 1 ? t`1 without a reply` : counts.unanswered ? t`${formatCount(counts.unanswered)} without a reply` : null,
    counts.drafted === 1 ? t`1 reply to check` : counts.drafted ? t`${formatCount(counts.drafted)} replies to check` : null,
  ];
  const toChange = comments.filter((comment) => comment.change === "todo").length;
  pending.push(toChange === 1 ? t`1 change to make` : toChange ? t`${formatCount(toChange)} changes to make` : null);
  const listed = pending.filter((item) => item !== null);
  const summaryDetail = listed.length ? listed.join(" · ") : t`Every comment is answered`;
  const owners = [...new Set(comments.map((comment) => comment.owner.trim()).filter(Boolean))].sort();
  const isLost = (comment: ReviewerComment) => comment.annotationIds.some((annotationId) => {
    const state = places.get(annotationId)?.state;
    return state === "moved" || state === "missing";
  });
  // A comment open in the list stays listed while it is worked on, even once it is done.
  const shown = filter === "all" ? comments : comments.filter((comment) => responseStatus(comment) !== "done" || comment.id === open);
  const revisable = reviewerResponses.revisableIds(annotations, running).length;
  const exportTitle = t`Export the response letter`;
  const doExport = (format: LetterFormat) => void exportLetter(responses, format, places, exportTitle, (path) => t`Saved the response letter to ${path}`);

  const intake = adding || (loaded && !comments.length);
  return (
    <ResizableDrawer className="reviewer-responses-drawer" onClose={onClose}>
      <PanelHeader
        className="drawer-header"
        icon={<MessageSquareQuote size={16} />}
        title={t`Responses`}
        onClose={onClose}
        actions={comments.length && !adding ? (
          <>
            <IconButton label={t`Add reviewer comments`} size="compact" onClick={() => setAdding(true)}><Plus size={14} /></IconButton>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <IconButton label={exportTitle} size="compact"><Download size={14} /></IconButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="responses-menu">
                <DropdownMenuItem onSelect={() => doExport("markdown")}>{t`Markdown (.md)`}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => doExport("latex")}>{t`LaTeX (.tex)`}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : null}
      />
      <div className="responses-panel">
        {!loaded ? null : intake ? (
          comments.length || adding ? (
            <Intake responses={responses} onDone={() => setAdding(false)} onCancel={comments.length ? () => setAdding(false) : null} />
          ) : (
            <EmptyState
              fill
              icon={<MessageSquareQuote size={20} />}
              title={t`Answer every reviewer comment`}
              description={t`Paste the reviews to number each comment, then track its reply, its owner and the passages that changed for it`}
              actions={<Button variant="primary" onClick={() => setAdding(true)}>{t`Paste reviews`}</Button>}
            />
          )
        ) : (
          <>
            <header className="responses-summary">
              <p className="responses-summary-count">
                {t`${formatCount(answered)} of ${formatCount(comments.length)} answered`}
              </p>
              <span className="responses-meter" aria-hidden="true">
                <span style={{ width: `${(counts.done / comments.length) * 100}%` }} data-tone="done" />
                <span style={{ width: `${(counts.changing / comments.length) * 100}%` }} data-tone="changing" />
                <span style={{ width: `${(counts.drafted / comments.length) * 100}%` }} data-tone="drafted" />
              </span>
              <p className="responses-summary-detail">{summaryDetail}</p>
              <SegmentedControl
                ariaLabel={t`Which comments to show`}
                value={filter}
                onChange={setFilter}
                items={[
                  { value: "open", label: t({ message: "Open", context: "reviewer comments still to answer" }) },
                  { value: "all", label: t({ message: "All", context: "reviewer comments" }) },
                ]}
              />
            </header>
            {shown.length ? reviewerNumbers(responses).map((reviewer) => {
              const own = comments.filter((comment) => comment.reviewer === reviewer);
              const listed = shown.filter((comment) => comment.reviewer === reviewer);
              if (!listed.length) return null;
              const done = own.filter((comment) => responseStatus(comment) === "done").length;
              return (
                <section key={reviewer} className="responses-group">
                  <h3>
                    <span className="responses-group-title">{reviewerTitle(responses, reviewer)}</span>
                    <span>{formatCount(done)}/{formatCount(own.length)}</span>
                  </h3>
                  <ul>
                    {listed.map((comment) => (
                      <CommentRow
                        key={comment.id}
                        comment={comment}
                        expanded={open === comment.id}
                        onToggle={() => setOpen(open === comment.id ? null : comment.id)}
                        lost={isLost(comment)}
                        annotations={annotations}
                        places={places}
                        owners={owners}
                      />
                    ))}
                  </ul>
                </section>
              );
            }) : (
              <p className="responses-none">{t`Every comment is done`}</p>
            )}
            {revisable ? (
              <footer className="responses-foot">
                <span>{revisable === 1 ? t`1 linked annotation still to change` : t`${formatCount(revisable)} linked annotations still to change`}</span>
                <Button size="compact" variant="primary" onClick={() => reviewerResponses.revise(annotations)}>
                  <Wand2 size={13} aria-hidden="true" />{t`Revise from annotations`}
                </Button>
              </footer>
            ) : null}
          </>
        )}
      </div>
    </ResizableDrawer>
  );
}
