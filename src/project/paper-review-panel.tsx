/**
 * The reviewer's pass over the whole paper (`app/paper-review.ts`), as a tool
 * panel. Not a chat answer: a dated report that reopens, verdict first on a
 * readiness track rather than a score, then the findings grouped by kind with
 * counts, one open at a time with its quote, reason and place in the source.
 * Each finding is something the writer can act on: "Add as annotation" makes
 * it an annotation on the passage it quotes, which "Revise from annotations"
 * then hands to a revision round.
 */
import { useEffect, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { useLingui } from "@lingui/react/macro";
import {
  Check, ChevronDown, ChevronRight, CircleDot, LoaderCircle, MessageSquarePlus, RotateCw, ScanSearch, Search, X,
} from "lucide-react";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { IconButton } from "../components/ui/icon-button";
import { InlineMessage } from "../components/ui/inline-message";
import { PanelHeader } from "../components/ui/panel-header";
import { ResizableDrawer } from "../components/ui/resizable-drawer";
import {
  REVIEW_KINDS, REVIEW_READINESS, venueName, type PaperReview, type ReviewFinding, type ReviewKind,
} from "../agent/agent-review";
import { comboText, parseKeyName } from "../app/key-combos";
import { annotationRounds } from "../app/annotation-rounds";
import { paperReview, type PaperReviewRun } from "../app/paper-review";
import type { EditorComment } from "../editor/comments/editor-comment-data";
import { clockTime, dayName } from "../history/history-time";
import { formatCount } from "../i18n";
import { spaceMixedScript } from "../trellis/trellis-titles";
import "./paper-review.css";

/* eslint-disable lingui/no-unlocalized-strings -- key names, drawn as glyphs */
const REVISE_KEYS = comboText(parseKeyName("Mod-Shift-Enter"));
/* eslint-enable lingui/no-unlocalized-strings */

/** `m:ss` since `startedAt`, ticking once a second. */
function Elapsed({ startedAt }: { startedAt: number }) {
  const { t } = useLingui();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return <p className="review-running-time">{t`${clock} elapsed`}</p>;
}

function Running({ run, venue }: { run: PaperReviewRun; venue: string | null }) {
  const { t } = useLingui();
  const stats = run.stats;
  const read = stats
    ? [
      stats.sections === 1 ? t`1 section` : t`${stats.sections} sections`,
      stats.figures === 1 ? t`1 figure` : t`${stats.figures} figures`,
      stats.tables === 1 ? t`1 table` : t`${stats.tables} tables`,
    ].join(t`, `)
    : null;
  const name = venueName(venue);
  const checking = !stats
    ? t`Checking claims and citations`
    : stats.references === 1
      ? t`Checking claims against 1 reference`
      : t`Checking claims against ${stats.references} references`;
  return (
    <div className="review-running" role="status">
      <h2>{name ? spaceMixedScript(t`Reading the paper as a ${name} reviewer`) : t`Reading the paper as a reviewer`}</h2>
      <ol className="review-steps">
        <li data-state={read ? "done" : "running"}>
          {read ? <Check size={14} aria-hidden="true" /> : <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />}
          <span>{read ? t`Read ${read}` : t`Reading the paper`}</span>
        </li>
        <li data-state={read ? "running" : "pending"}>
          {read ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : <CircleDot size={14} aria-hidden="true" />}
          <span>{checking}</span>
        </li>
        <li data-state="pending">
          <CircleDot size={14} aria-hidden="true" />
          <span>{t`Writing the report`}</span>
        </li>
      </ol>
      <Elapsed startedAt={run.startedAt} />
      <ul className="review-skeleton" aria-hidden="true">
        <li /><li /><li />
      </ul>
      <p className="review-running-note">{t`The paper stays editable; findings point at the text as it was when the review started`}</p>
      <div>
        <Button size="compact" variant="ghost" onClick={paperReview.cancel}>{t`Stop`}</Button>
      </div>
    </div>
  );
}

function Finding({ finding, expanded, busy, onToggle }: {
  finding: ReviewFinding;
  expanded: boolean;
  /** Whether it is being made an annotation, so it takes no other decision meanwhile. */
  busy: boolean;
  onToggle: () => void;
}) {
  const { t } = useLingui();
  const added = finding.state === "added";
  return (
    <li className="review-finding" data-open={expanded || undefined} data-severity={finding.severity} data-added={added || undefined}>
      <button type="button" className="review-finding-row" aria-expanded={expanded} onClick={onToggle}>
        <span className="review-finding-mark" aria-hidden="true">{added ? <Check size={10} strokeWidth={3} /> : null}</span>
        <span className="review-finding-title">{finding.title}</span>
        {finding.section ? <span className="review-finding-anchor" title={finding.section}>{finding.section}</span> : null}
        {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
      </button>
      {expanded && (
        <div className="review-finding-body">
          <button type="button" className="review-quote" onClick={() => void paperReview.reveal(finding.id)} title={t`Show in the source`}>
            <q>{finding.quote}</q>
            <span>{finding.path}:{finding.line}</span>
          </button>
          {finding.reason ? <p>{finding.reason}</p> : null}
          <div className="review-actions">
            {added ? (
              finding.annotation ? (
                <Button size="compact" variant="ghost" className="review-added" onClick={() => paperReview.openAnnotation(finding.id)}>
                  <Check size={14} aria-hidden="true" />{t`Added as annotation ${finding.annotation}`}
                </Button>
              ) : (
                <span className="review-added"><Check size={14} aria-hidden="true" />{t`Added as a comment`}</span>
              )
            ) : (
              <Button size="compact" disabled={busy} onClick={() => void paperReview.annotate(finding.id)}>
                <MessageSquarePlus size={14} aria-hidden="true" />{t`Add as annotation`}
              </Button>
            )}
            {finding.search ? (
              <Button size="compact" variant="ghost" onClick={() => paperReview.findSupport(finding.id)}>
                <Search size={14} aria-hidden="true" />{t`Find support`}
              </Button>
            ) : null}
            {!added ? (
              <Button size="compact" variant="ghost" className="review-dismiss" disabled={busy} onClick={() => paperReview.dismiss(finding.id)}>
                <X size={14} aria-hidden="true" />{t({ message: "Dismiss", context: "review point" })}
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </li>
  );
}

function Report({ report, revisable, annotating }: { report: PaperReview; revisable: number; annotating: ReadonlySet<string> }) {
  const { t, i18n } = useLingui();
  const shown = report.findings.filter((finding) => finding.state !== "dismissed");
  // The first point is open as the report arrives: the one a reviewer would raise first.
  const [open, setOpen] = useState<string | null>(() => shown[0]?.id ?? null);
  const titles: Record<ReviewKind, string> = {
    key: t`Key issues`, citation: t`Missing citations`, clarity: t`Clarity`, question: t`Questions`,
  };
  const stops = [t`Not ready`, t`Needs work`, t`Almost`, t`Ready`];
  const stop = REVIEW_READINESS.indexOf(report.readiness);
  const created = Date.parse(report.createdAt);
  const name = venueName(report.venue);
  const minutes = Math.max(1, Math.round(report.seconds / 60));
  const meta = [
    `${dayName(created, i18n.locale)} ${clockTime(created, i18n.locale)}`,
    name ? spaceMixedScript(t`as a ${name} reviewer`) : t`as a peer reviewer`,
    t`read in ${minutes} min`,
  ].join(" · ");
  const added = report.findings.filter((finding) => finding.state === "added").length;
  // A gap in what was read is not a footnote: the verdict is about less than the whole paper.
  const unread = report.unread ?? [];
  const unreadFiles = new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(unread);
  const unreadNote = unread.length === 1 ? spaceMixedScript(t`Not the whole paper: Lattice couldn’t read ${unreadFiles}, so this review didn’t cover it.`)
    : unread.length > 1 ? spaceMixedScript(t`Not the whole paper: Lattice couldn’t read ${unreadFiles}, so this review didn’t cover them.`)
      : null;
  const notes = [
    report.truncated ? t`The paper is longer than one review reads, so its end was left out` : null,
    report.dropped === 1 ? t`1 point was left out: its quote is not in the paper`
      : report.dropped > 1 ? t`${report.dropped} points were left out: their quotes are not in the paper` : null,
  ].filter(Boolean);
  return (
    <>
      <div className="review-body">
        <header className="review-head">
          <p className="review-meta">{meta}</p>
          <div className="review-track" role="img" aria-label={t`Readiness: ${stops[stop]}`}>
            {stops.map((label, index) => (
              <span key={label} data-on={index === stop || undefined} data-past={index < stop || undefined}>{label}</span>
            ))}
          </div>
          <p className="review-verdict">{report.verdict}</p>
          {unreadNote ? <InlineMessage level="warning">{unreadNote}</InlineMessage> : null}
          {notes.map((note) => <p key={note} className="review-note">{note}</p>)}
        </header>
        {report.strengths.length ? (
          <details className="review-strengths">
            <summary>
              <ChevronRight size={14} aria-hidden="true" />{t`Strengths`}<span>{formatCount(report.strengths.length)}</span>
            </summary>
            <ul>{report.strengths.map((item) => <li key={item}>{item}</li>)}</ul>
          </details>
        ) : null}
        {shown.length ? REVIEW_KINDS.map((kind) => {
          const findings = shown.filter((finding) => finding.kind === kind);
          if (!findings.length) return null;
          return (
            <section key={kind} className="review-group">
              <h3>{titles[kind]}<span>{formatCount(findings.length)}</span></h3>
              <ul>
                {findings.map((finding) => (
                  <Finding
                    key={finding.id}
                    finding={finding}
                    expanded={open === finding.id}
                    busy={annotating.has(finding.id)}
                    onToggle={() => setOpen(open === finding.id ? null : finding.id)}
                  />
                ))}
              </ul>
            </section>
          );
        }) : (
          <p className="review-none">{report.findings.length ? t`Every point has been dismissed` : t`No points to raise`}</p>
        )}
      </div>
      <footer className="review-foot">
        <span>
          {added === 0 ? t`Add the points you agree with; nothing changes until you do`
            : added === 1 ? t`1 point added as an annotation` : t`${added} points added as annotations`}
        </span>
        <Button variant="primary" size="compact" disabled={!revisable} onClick={paperReview.revise}>
          <span className="review-foot-label">{t`Revise from annotations`}</span><kbd>{REVISE_KEYS}</kbd>
        </Button>
      </footer>
    </>
  );
}

export function PaperReviewPanel({ venue, annotations, onClose }: {
  /** The venue the project targets, which the review is written for. */
  venue: string | null;
  /** The project's annotations, so the footer follows what a round can revise. */
  annotations: readonly EditorComment[];
  onClose: () => void;
}) {
  const { t } = useLingui();
  const { loaded, report, run, error, annotating } = useSyncExternalStore(paperReview.subscribe, paperReview.getSnapshot);
  // A round starting or settling changes what can be revised.
  const { running } = useSyncExternalStore(annotationRounds.subscribe, annotationRounds.getSnapshot);
  useEffect(() => {
    if (!loaded) void paperReview.load();
  }, [loaded]);
  const revisable = report ? paperReview.revisableIds(annotations, running).length : 0;
  const reviseOnKey = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && event.shiftKey && revisable) {
      event.preventDefault();
      paperReview.revise();
    }
  };
  const name = venueName(venue);
  return (
    <ResizableDrawer className="paper-review-drawer" onClose={onClose}>
      <PanelHeader
        className="drawer-header"
        icon={<ScanSearch size={16} />}
        title={t`Review`}
        onClose={onClose}
        actions={report && !run ? (
          <IconButton label={t`Review again`} size="compact" onClick={() => void paperReview.start()}>
            <RotateCw size={14} />
          </IconButton>
        ) : null}
      />
      <div className="review-panel" onKeyDown={reviseOnKey}>
        {error ? <InlineMessage level="error" className="review-error">{error}</InlineMessage> : null}
        {run ? (
          <Running run={run} venue={venue} />
        ) : report ? (
          <Report key={report.id} report={report} revisable={revisable} annotating={annotating} />
        ) : loaded ? (
          <EmptyState
            fill
            icon={<ScanSearch size={20} />}
            title={t`Read the paper as a reviewer would`}
            description={name
              ? spaceMixedScript(t`A verdict, then what a ${name} reviewer would raise, each point pinned to the passage it is about`)
              : t`A verdict, then what a reviewer would raise, each point pinned to the passage it is about`}
            actions={<Button variant="primary" onClick={() => void paperReview.start()}>{error ? t`Try again` : t`Review the paper`}</Button>}
          />
        ) : null}
      </div>
    </ResizableDrawer>
  );
}
