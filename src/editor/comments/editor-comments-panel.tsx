import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { Check, CornerDownLeft, FileSearch, History, Pencil, Reply, RotateCcw, Search } from "lucide-react";
import { comboText, parseKeyName } from "../../app/key-combos";
import { InfinityLoader } from "../../components/ui/activity-icons";
import { Button } from "../../components/ui/button";
import { DestructiveButton } from "../../components/ui/destructive-button";
import { EmptyIllustration } from "../../components/ui/empty-illustration";
import { EmptyState } from "../../components/ui/empty-state";
import { IconButton } from "../../components/ui/icon-button";
import { ResizableDrawer } from "../../components/ui/resizable-drawer";
import { ScrollArea } from "../../components/ui/scroll-area";
import { SearchField } from "../../components/ui/search-field";
import { Textarea } from "../../components/ui/textarea";
import { AnnotationPin } from "./annotation-pin";
import {
  annotationStatus,
  editorCommentAuthorDisplayName,
  resolveCommentAnchor,
  type AnnotationRound,
  type AnnotationStatus,
  type EditorComment,
} from "./editor-comment-data";
import { formatCommentTimestamp } from "./editor-comments";
import { useIntentLabels } from "./use-intent-labels";
import { formatCount } from "../../i18n";
import { latexHighlights } from "../latex/latex-highlights";
import { HIGHLIGHTERS, highlighterOf, readsDarkOn, useHighlightPrefs } from "../latex/highlighters";
import { pendingProposals, revisable, roundProgress, type AnnotationRounds } from "../../app/annotation-rounds";
import "./annotations.css";

/* eslint-disable lingui/no-unlocalized-strings -- key names, drawn as glyphs */
const REVISE_KEYS = comboText(parseKeyName("Mod-Shift-Enter"));
const STORAGE_PATH = ".research/annotations.json";
/* eslint-enable lingui/no-unlocalized-strings */

type Filter = "open" | "resolved" | "all";

/** A highlight in the open file, listed by what its highlighter means. */
type PlacedHighlight = { from: number; line: number; text: string; color: string | null; kind: string };
/** The kind of a highlight in none of the six highlighters' colours. */
const OTHER = "other";

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
};

const NO_RUNNING: ReadonlySet<string> = new Set();
const NO_ROUNDS: readonly AnnotationRound[] = [];
const noSubscription = () => () => {};
const noRunning = () => NO_RUNNING;

/** The rounds as the panel shows them, read from the rounds while the panel is on screen. */
function useRoundsView(
  annotationRounds: AnnotationRounds | undefined,
  roundsList: readonly AnnotationRound[] = NO_ROUNDS,
  comments: readonly EditorComment[],
): AnnotationRoundsView | undefined {
  const running = useSyncExternalStore(
    annotationRounds?.subscribe ?? noSubscription,
    annotationRounds ? () => annotationRounds.getSnapshot().running : noRunning,
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
  }, [annotationRounds, comments, roundsList, running]);
}

/** A heading of the source, as the panel groups annotations under it. */
type Section = { offset: number; label: string };

/**
 * The top-level headings of `source`: chapters when it has them, else
 * sections, numbered as LaTeX numbers them (a starred one has no number);
 * Markdown's top headings for Markdown.
 */
function sectionsOf(source: string, path: string): Section[] {
  if (/\.(md|markdown)$/i.test(path)) {
    const headings = [...source.matchAll(/^(#{1,2})\s+(.+)$/gm)];
    const top = Math.min(...headings.map((match) => match[1]!.length));
    return headings.filter((match) => match[1]!.length === top).map((match) => ({ offset: match.index, label: match[2]!.trim() }));
  }
  const commands = [...source.matchAll(/\\(chapter|section)(\*?)\{([^{}]*)\}/g)];
  const level = commands.some((match) => match[1] === "chapter") ? "chapter" : "section";
  let number = 0;
  return commands.filter((match) => match[1] === level).map((match) => {
    const title = match[3]!.replace(/\s+/g, " ").trim();
    if (match[2]) return { offset: match.index, label: title };
    number += 1;
    return { offset: match.index, label: `§${number} ${title}` };
  });
}

/**
 * The Annotations panel: the writer's notes on this project, grouped by the
 * section they sit in, each with its pin, the passage it quotes in the
 * reading serif, the note, and where and when it was made. From here a
 * revision round asks the agent about every open one; its proposals are
 * reviewed in the editor, and its questions answered on their cards.
 * Annotations live in `.research/annotations.json`, with the project.
 */
export function EditorCommentsPanel(props: {
  embedded?: boolean;
  comments: EditorComment[];
  activePath: string | null;
  /** The file the writer annotates in, or null with none open. */
  writingFile?: string | null;
  /** Back to `writingFile`'s editor, caret where it was; with no file, a file picker. */
  onReturnToEditor?: () => void;
  currentAuthorId: string;
  focusCommentId?: string | null;
  /** The note last opened, from here, the gutter or the PDF: its card stands out and comes into view. */
  activeCommentId?: string | null;
  /** A file's live text, when the panel can read it, for line numbers and sections. */
  sourceFor?: (path: string) => string | undefined;
  /** Open a file at a line: where a highlight listed here sits. */
  onOpenHighlight?: (path: string, line: number) => void;
  /** The revision rounds behind Revise, and the project's rounds; without them the panel only lists notes. */
  annotationRounds?: AnnotationRounds;
  roundsList?: readonly AnnotationRound[];
  onClose: () => void;
  onOpen: (comment: EditorComment) => void;
  onDelete: (id: string) => void;
  onToggleResolved: (comment: EditorComment) => void;
  onUpdateBody: (comment: EditorComment, body: string) => void;
  onReply: (comment: EditorComment, body: string) => void;
}) {
  const { i18n, t } = useLingui();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [filter, setFilter] = useState<Filter>(props.focusCommentId ? "all" : "open");
  /** The highlighter whose highlights the list shows instead of the notes (its hex, or `OTHER`). */
  const [highlightKind, setHighlightKind] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [replyingId, setReplyingId] = useState<string | null>(props.focusCommentId ?? null);
  const [replyDraft, setReplyDraft] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const focusRef = useRef<HTMLElement | null>(null);
  const activeRef = useRef<HTMLElement | null>(null);
  const anonymousAuthor = t`Anonymous`;
  const { activePath, sourceFor } = props;
  const rounds = useRoundsView(props.annotationRounds, props.roundsList, props.comments);
  const intentLabels = useIntentLabels();
  const highlightPrefs = useHighlightPrefs();

  // When opened from the editor's hover "Reply…", jump to that note and open
  // its reply box straight away.
  useEffect(() => {
    if (!props.focusCommentId) return;
    setReplyingId(props.focusCommentId);
    setFilter("all");
    setHighlightKind(null);
    focusRef.current?.scrollIntoView({ block: "center" });
  }, [props.focusCommentId]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [props.activeCommentId]);

  const openCount = props.comments.filter((comment) => !comment.resolved).length;
  const resolvedCount = props.comments.length - openCount;
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matches = (comment: EditorComment) => !needle || [
      comment.body,
      comment.quote,
      comment.path,
      editorCommentAuthorDisplayName(comment.authorName, anonymousAuthor),
    ].some((text) => text.toLocaleLowerCase().includes(needle));
    // A proposal accepted in the round still under review stays with the open
    // notes until the round settles, green, so the round reads whole.
    const round = rounds?.progress?.round;
    const open = (comment: EditorComment) => !comment.resolved
      || (round !== undefined && comment.revision?.state === "accepted" && comment.revision.round === round);
    const shown = (comment: EditorComment) => filter === "all" || (filter === "open" ? open(comment) : comment.resolved);
    return props.comments.filter((comment) => shown(comment) && matches(comment));
  }, [anonymousAuthor, filter, props.comments, query, rounds?.progress?.round]);

  /** The visible notes in reading order, under the file and section each sits in. */
  const groups = useMemo(() => {
    const byFile = new Map<string, EditorComment[]>();
    for (const comment of visible) byFile.set(comment.path, [...byFile.get(comment.path) ?? [], comment]);
    // The open file first, then the others by name.
    const files = [...byFile.keys()].sort((a, b) => Number(b === activePath) - Number(a === activePath) || a.localeCompare(b));
    const many = files.length > 1;
    return files.flatMap((path) => {
      const source = sourceFor?.(path);
      const sections = source ? sectionsOf(source, path) : [];
      const name = path.split("/").at(-1) ?? path;
      const placed = byFile.get(path)!.map((comment) => {
        const range = source ? resolveCommentAnchor(source, comment) : null;
        const from = range?.from ?? comment.from;
        const section = sections.filter((item) => item.offset <= from).at(-1) ?? null;
        const line = source && range ? source.slice(0, range.from).split("\n").length : null;
        return { comment, from, section, line };
      }).sort((a, b) => a.from - b.from || (a.comment.number ?? 0) - (b.comment.number ?? 0));
      const out: Array<{ key: string; label: string | null; items: typeof placed }> = [];
      for (const item of placed) {
        const label = item.section?.label ?? (sections.length ? t`Before the first section` : null);
        const heading = many ? [name, label].filter(Boolean).join(" · ") : label;
        const last = out.at(-1);
        if (last && last.label === heading) last.items.push(item);
        else out.push({ key: `${path}:${item.section?.offset ?? -1}`, label: heading, items: [item] });
      }
      return out;
    });
  }, [activePath, sourceFor, t, visible]);

  // The open file's highlights, by highlighter: a meaning reads back as a
  // list ("every sentence that needs a citation"), in reading order.
  const activeSource = activePath?.endsWith(".tex") ? sourceFor?.(activePath) : undefined;
  const highlights = useMemo<PlacedHighlight[]>(() => {
    if (!activeSource) return [];
    let line = 1;
    let counted = 0;
    return latexHighlights(activeSource).map((highlight) => {
      line += activeSource.slice(counted, highlight.from).split("\n").length - 1;
      counted = highlight.from;
      return {
        from: highlight.from,
        line,
        text: activeSource.slice(highlight.contentFrom, highlight.contentTo).replace(/\s+/g, " ").trim(),
        color: highlight.color,
        kind: highlighterOf(highlight.color)?.hex ?? OTHER,
      };
    });
  }, [activeSource]);
  const highlightKinds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const highlight of highlights) counts.set(highlight.kind, (counts.get(highlight.kind) ?? 0) + 1);
    return [...HIGHLIGHTERS.map((item) => item.hex), OTHER].filter((kind) => counts.has(kind)).map((kind) => ({ kind, count: counts.get(kind)! }));
  }, [highlights]);
  const kindLabel = (kind: string) => {
    const item = highlighterOf(kind);
    return item ? highlightPrefs.meaningOf(item) : t`Other colours`;
  };
  const highlightGroups = useMemo(() => {
    if (!activePath || !activeSource || !highlightKind) return [];
    const sections = sectionsOf(activeSource, activePath);
    const out: Array<{ key: string; label: string | null; items: PlacedHighlight[] }> = [];
    for (const highlight of highlights) {
      if (highlight.kind !== highlightKind) continue;
      const section = sections.filter((item) => item.offset <= highlight.from).at(-1) ?? null;
      const label = section?.label ?? (sections.length ? t`Before the first section` : null);
      const last = out.at(-1);
      if (last && last.label === label) last.items.push(highlight);
      else out.push({ key: String(section?.offset ?? -1), label, items: [highlight] });
    }
    return out;
  }, [activePath, activeSource, highlightKind, highlights, t]);

  const hasComments = props.comments.length > 0;
  const writingName = props.writingFile ? props.writingFile.split("/").at(-1) || props.writingFile : null;
  const closeReply = () => {
    setReplyingId(null);
    setReplyDraft("");
  };
  const statusLabels: Record<AnnotationStatus, string> = {
    open: t({ message: "Open", context: "annotation filter" }),
    proposed: t`Proposed`,
    asked: t`Needs your answer`,
    accepted: t`Accepted`,
    rejected: t`Rejected`,
    failed: t`Could not revise`,
    resolved: t`Resolved`,
  };
  const progress = rounds?.progress ?? null;
  const reviewing = (rounds?.proposals.length ?? 0) > 0;

  // The actions follow the filter in the markup, so revealing the panel (which
  // focuses its first control) lands on the filter rather than on an icon
  // whose tooltip would open; the grid still draws them beside the title.
  const header = (
    <div className="annotations-head">
      <div className="annotations-title-row">
        {!props.embedded && <h2 className="annotations-title">{t`Annotations`}</h2>}
        <span className="annotations-count">
          {openCount === 1 ? t`1 open` : t`${openCount} open`}
        </span>
      </div>
      {hasComments && (
        <div className="ui-segmented ui-segmented--compact annotations-filter" role="group" aria-label={t`Show annotations`}>
          {([
            ["open", t({ message: "Open", context: "annotation filter" }), openCount],
            ["resolved", t`Resolved`, resolvedCount],
            ["all", t`All`, 0],
          ] as const).map(([value, label, count]) => (
            <button
              type="button"
              key={value}
              className="ui-segmented-tab"
              aria-pressed={filter === value && !highlightKind}
              onClick={() => {
                setFilter(value);
                setHighlightKind(null);
              }}
            >
              <span className="annotations-filter-label">{label}</span>
              {count > 0 && <span className="annotations-filter-count">{count}</span>}
            </button>
          ))}
        </div>
      )}
      <span className="annotations-head-actions">
        {hasComments && (
          <IconButton
            size="compact"
            className="annotations-search-toggle"
            label={t`Filter annotations`}
            aria-pressed={searching}
            onClick={() => {
              setSearching((current) => !current);
              setQuery("");
            }}
          >
            <Search size={13} />
          </IconButton>
        )}
        {rounds?.hasRounds && (
          <IconButton size="compact" label={t`Revision rounds`} onClick={rounds.onOpenRounds}>
            <History size={13} />
          </IconButton>
        )}
      </span>
      {highlightKinds.length > 0 && (
        <div className="annotations-highlights" role="group" aria-label={t`Highlights`}>
          {highlightKinds.map(({ kind, count }) => (
            <button
              type="button"
              key={kind}
              className="annotations-highlight-kind"
              aria-pressed={highlightKind === kind}
              onClick={() => setHighlightKind((current) => current === kind ? null : kind)}
            >
              <span className="annotations-highlight-swatch" data-kind={kind === OTHER ? OTHER : undefined} style={kind === OTHER ? undefined : { background: kind }} aria-hidden />
              <span className="annotations-filter-label">{kindLabel(kind)}</span>
              <span className="annotations-filter-count">{formatCount(count, i18n.locale)}</span>
            </button>
          ))}
        </div>
      )}
      {searching && hasComments && (
        <SearchField
          controlSize="compact"
          containerClassName="annotations-search"
          autoFocus
          aria-label={t`Filter annotations`}
          placeholder={t`Filter annotations…`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onClear={() => setQuery("")}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setSearching(false);
              setQuery("");
            }
          }}
        />
      )}
    </div>
  );

  const banner = progress && (progress.running > 0 || reviewing) && (
    <div className="annotations-round" role="status">
      <span className="annotations-round-text">
        {progress.running > 0
          ? t`Agent is revising · ${progress.answered} of ${progress.total} answered`
          : rounds!.proposals.length === 1
            ? t`Round ${progress.round} · 1 proposal to review`
            : t`Round ${progress.round} · ${rounds!.proposals.length} proposals to review`}
      </span>
      <span className="annotations-round-bar" aria-hidden>
        <i style={{ width: `${progress.total ? Math.round((progress.answered / progress.total) * 100) : 0}%` }} />
      </span>
    </div>
  );

  const card = (comment: EditorComment, line: number | null) => {
    const status = rounds?.running.has(comment.id) ? null : annotationStatus(comment);
    const isAuthor = comment.authorId === props.currentAuthorId;
    const focused = comment.id === props.focusCommentId;
    const author = editorCommentAuthorDisplayName(comment.authorName, anonymousAuthor);
    const name = comment.path.split("/").at(-1) ?? comment.path;
    const location = comment.pdf ? t`PDF p.${comment.pdf.page}` : line ? `${name}:${line}` : name;
    const revision = comment.revision;
    const asking = status === "asked" && revision?.question;
    const pin = comment.number ?? 0;
    return (
      <article
        className="annotation-card"
        data-status={status ?? "running"}
        data-focused={focused || comment.id === props.activeCommentId || undefined}
        key={comment.id}
        ref={focused ? focusRef : comment.id === props.activeCommentId ? activeRef : undefined}
      >
        <button
          type="button"
          className="annotation-card-body"
          // The card's parts run together as inline text; its name reads them as sentences.
          aria-label={[
            pin ? t`Annotation ${pin}` : author,
            comment.body || (comment.intent && intentLabels[comment.intent]),
            `“${comment.quote.trim()}”`,
            status === null ? t`Revising…` : status === "open" ? null : statusLabels[status],
            location,
          ].filter(Boolean).join(". ")}
          onClick={() => status === "proposed" && rounds ? rounds.onReview(comment.id) : props.onOpen(comment)}
        >
          {pin
            ? <AnnotationPin number={pin} status={status ?? "open"} />
            : <span className="annotation-card-author-dot" aria-hidden />}
          <span className="annotation-card-quote">{comment.quote.trim() || t`(empty span)`}</span>
          {comment.body
            ? <span className="annotation-card-note">{comment.body}</span>
            : comment.intent && <span className="annotation-card-note">{intentLabels[comment.intent]}</span>}
          <span className="annotation-card-meta">
            {status === null ? (
              <span className="annotation-status" data-annotation-status="running"><InfinityLoader size={11} />{t`Revising…`}</span>
            ) : status !== "open" && (
              <span className="annotation-status" data-annotation-status={status}>{statusLabels[status]}</span>
            )}
            <span className="annotation-card-where">
              {[pin ? null : author, location, formatCommentTimestamp(comment.createdAt, undefined, i18n.locale, "short")]
                .filter(Boolean).join(" · ")}
            </span>
          </span>
        </button>
        {asking && (
          <div className="annotation-ask">
            <span className="annotation-ask-label">{t`The agent asks`}</span>
            <p>{revision.question}</p>
            <Textarea
              rows={2}
              value={answers[comment.id] ?? ""}
              placeholder={t`Your answer…`}
              aria-label={t`Answer the agent`}
              onChange={(event) => setAnswers((current) => ({ ...current, [comment.id]: event.target.value }))}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && answers[comment.id]?.trim()) {
                  event.preventDefault();
                  rounds?.onAnswer(comment.id, answers[comment.id]!);
                }
              }}
            />
            <Button
              size="compact"
              variant="tinted"
              disabled={!answers[comment.id]?.trim()}
              onClick={() => rounds?.onAnswer(comment.id, answers[comment.id] ?? "")}
            >
              {t`Answer and revise`}
            </Button>
          </div>
        )}
        {status === "failed" && revision?.error && (
          <div className="annotation-failed">
            <p>{revision.error}</p>
            {rounds && <Button size="compact" variant="ghost" onClick={() => rounds.onRetry(comment.id)}>{t`Try again`}</Button>}
          </div>
        )}

        {comment.replies.length > 0 && (
          <div className="editor-comment-replies annotation-replies">
            {comment.replies.map((reply) => (
              <div className="editor-comment-reply" key={reply.id}>
                <div className="editor-comment-reply-meta">
                  <span>{editorCommentAuthorDisplayName(reply.authorName, anonymousAuthor)}</span>
                  <span>{formatCommentTimestamp(reply.createdAt, undefined, i18n.locale)}</span>
                </div>
                <p>{reply.body}</p>
              </div>
            ))}
          </div>
        )}

        {editingId === comment.id ? (
          <div className="annotation-card-edit">
            <Textarea
              value={draft}
              rows={3}
              // Edit lands in the text, at its end, like Reply does.
              autoFocus
              onFocus={(event) => event.currentTarget.setSelectionRange(draft.length, draft.length)}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t`Update annotation…`}
              onKeyDown={(event) => {
                if (event.key === "Escape") setEditingId(null);
              }}
            />
            <div className="annotation-card-edit-actions">
              <Button
                size="compact"
                variant="tinted"
                onClick={() => {
                  props.onUpdateBody(comment, draft);
                  setEditingId(null);
                }}
              >
                {t`Save`}
              </Button>
              <Button size="compact" variant="ghost" onClick={() => setEditingId(null)}>{t`Cancel`}</Button>
            </div>
          </div>
        ) : replyingId === comment.id ? (
          <div className="annotation-card-edit">
            <Textarea
              value={replyDraft}
              rows={2}
              autoFocus
              onChange={(event) => setReplyDraft(event.target.value)}
              placeholder={t({ message: `Reply to ${author}` })}
              onKeyDown={(event) => {
                if (event.key === "Escape") closeReply();
              }}
            />
            <div className="annotation-card-edit-actions">
              <Button
                size="compact"
                variant="tinted"
                disabled={!replyDraft.trim()}
                onClick={() => {
                  props.onReply(comment, replyDraft);
                  closeReply();
                }}
              >
                {t`Reply`}
              </Button>
              <Button size="compact" variant="ghost" onClick={closeReply}>{t`Cancel`}</Button>
            </div>
          </div>
        ) : (
          <div className="annotation-card-actions">
            <IconButton
              size="compact"
              label={comment.resolved ? t`Reopen` : t`Resolve`}
              onClick={() => props.onToggleResolved(comment)}
            >
              {comment.resolved ? <RotateCcw size={13} /> : <Check size={13} />}
            </IconButton>
            <IconButton
              size="compact"
              label={t`Reply`}
              onClick={() => {
                setReplyingId(comment.id);
                setReplyDraft("");
              }}
            >
              <Reply size={13} />
            </IconButton>
            {isAuthor && (
              <>
                <IconButton
                  size="compact"
                  label={t`Edit`}
                  onClick={() => {
                    setEditingId(comment.id);
                    setDraft(comment.body);
                  }}
                >
                  <Pencil size={13} />
                </IconButton>
                <DestructiveButton className="annotation-card-delete" iconSize={13} onClick={() => props.onDelete(comment.id)} />
              </>
            )}
          </div>
        )}
      </article>
    );
  };

  const fileName = activePath?.split("/").at(-1) ?? activePath ?? "";
  const highlightList = highlightKind && (
    <div className="annotations-list">
      {!highlightGroups.length && (
        <EmptyState align="start" density="compact" description={t`No highlights of this kind in ${fileName}`} />
      )}
      {highlightGroups.map((group) => (
        <Fragment key={group.key}>
          {group.label && <h3 className="annotations-section">{group.label}</h3>}
          {group.items.map((highlight) => {
            // A colour by name, or soul's `\hl`, is the document's to say.
            const paper = highlight.color?.startsWith("#") ? highlight.color : null;
            return (
              <button
                type="button"
                key={highlight.from}
                className="annotation-highlight"
                onClick={() => activePath && props.onOpenHighlight?.(activePath, highlight.line)}
              >
                <span className="annotation-highlight-text">
                  <mark
                    className={paper ? undefined : "annotation-highlight-unknown"}
                    style={paper ? { background: paper, color: readsDarkOn(paper) ? undefined : "white" } : undefined}
                  >
                    {highlight.text || t`(empty span)`}
                  </mark>
                </span>
                <span className="annotation-card-meta">
                  <span className="annotation-card-where">{`${fileName}:${highlight.line}`}</span>
                </span>
              </button>
            );
          })}
        </Fragment>
      ))}
    </div>
  );

  // Before the first annotation the empty state is all the panel shows, so
  // it fills the panel and centres; a filter that matches nothing keeps the
  // list's compact line at the top.
  const emptyState = !visible.length && (
    <EmptyState
      fill={!hasComments}
      align={hasComments ? "start" : "center"}
      density={hasComments ? "compact" : "default"}
      icon={<EmptyIllustration kind={hasComments && query.trim() ? "search" : "comments"} size={hasComments ? "compact" : "default"} />}
      description={!hasComments
        ? props.onReturnToEditor && !props.writingFile
          ? t`No annotations yet. Open a file, select text and click Annotate`
          : t`No annotations yet. Select text in the editor or the PDF and click Annotate`
        : query.trim() ? t`No matches` : filter === "resolved" ? t`No resolved annotations` : t`No open annotations`}
      actions={!hasComments && props.onReturnToEditor && (
        <Button size="compact" className="editor-comments-return" onClick={props.onReturnToEditor}>
          {writingName ? <CornerDownLeft size={13} /> : <FileSearch size={13} />}
          <span>{writingName ? t`Return to ${writingName}` : t`Open a file`}</span>
        </Button>
      )}
    />
  );
  const list = highlightList || (!hasComments && !banner ? emptyState : (
    <div className="annotations-list">
      {banner}
      {emptyState}
      {groups.map((group) => (
        <Fragment key={group.key}>
          {group.label && <h3 className="annotations-section">{group.label}</h3>}
          {group.items.map(({ comment, line }) => card(comment, line))}
        </Fragment>
      ))}
    </div>
  ));

  const footer: ReactNode = rounds && hasComments && (
    <div className="annotations-foot">
      {reviewing ? (
        <Button variant="tinted" className="annotations-go" onClick={() => rounds.onReview(rounds.proposals[0]!.id)}>
          <span className="annotations-go-label">
            {rounds.proposals.length === 1 ? t`Review 1 proposal` : t`Review ${rounds.proposals.length} proposals`}
          </span>
        </Button>
      ) : (
        <Button
          variant="tinted"
          className="annotations-go"
          disabled={!rounds.revisable}
          onClick={rounds.onRevise}
        >
          <span className="annotations-go-label">
            {rounds.revisable === 0 ? t`Revise from annotations`
              : rounds.revisable === 1 ? t`Revise from 1 annotation` : t`Revise from ${rounds.revisable} annotations`}
          </span>
          <kbd>{REVISE_KEYS}</kbd>
        </Button>
      )}
      <small className="annotations-foot-note">
        {reviewing
          ? t`Accept or reject each one in the editor; the round is saved as a version`
          : t`Saved with the project in ${STORAGE_PATH}; no server involved`}
      </small>
    </div>
  );

  const content = (
    <div
      className="annotations-panel"
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && event.shiftKey && rounds?.revisable) {
          event.preventDefault();
          rounds.onRevise();
        }
      }}
    >
      {header}
      <ScrollArea className="annotations-scroll" viewportClassName="annotations-scroll-viewport">
        {list}
      </ScrollArea>
      {footer}
    </div>
  );
  return props.embedded ? content : (
    <ResizableDrawer className="editor-comments-drawer editor-comments-content" onClose={props.onClose}>
      {content}
    </ResizableDrawer>
  );
}

