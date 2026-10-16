import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import type { OpenProjectFile } from "../app-types";
import { isRecord, toMessage } from "../app-utils";
import { ProofreadFailure } from "../agent/agent-proofread";
import {
  manuscriptStats,
  readManuscript,
  reviewWithAgent,
  type ManuscriptStats,
  type PaperReview,
  type ReviewFinding,
  type ReviewKind,
} from "../agent/agent-review";
import {
  createEditorComment,
  resolveCommentAnchor,
  type AnnotationIntent,
  type EditorComment,
} from "../editor/comments/editor-comment-data";
import { i18n } from "../i18n";
import { notifyInfo } from "../telemetry/app-notify";
import { annotationRounds, revisable } from "./annotation-rounds";
import type { SupportClaim } from "./claim-support";
import type { EditorComments } from "./use-editor-comments";

type Ref<T> = { readonly current: T };

/** What a finding asks the agent to do once it is an annotation and revised. */
const INTENTS: Partial<Record<ReviewKind, AnnotationIntent>> = { citation: "cite", clarity: "clarify", key: "fix" };

/** What the review reads and does in the app, attached by App once it has them. */
export type PaperReviewDeps = {
  store: Pick<EditorComments, "stateRef" | "create" | "openComment">;
  projectRootRef: Ref<string | null>;
  /** The root document, every project path (to resolve `\input`), and the venue the project targets. */
  manuscript: () => { root: string | null; paths: string[]; venue: string | null };
  openProjectFile: OpenProjectFile;
  author: { id: string; name: string };
  /** Find papers that would support the passage a finding quotes (`app/claim-support.ts`). */
  findSupport: (claim: SupportClaim) => void;
};

/** A review the agent is reading the paper for. */
export type PaperReviewRun = {
  startedAt: number;
  /** "reading" until every file is read, then "reviewing" until the report is pinned to the source. */
  stage: "reading" | "reviewing";
  files: number;
  stats: ManuscriptStats | null;
};

/** What React reads from the review, a new object on every change. */
export type PaperReviewSnapshot = {
  /** Whether the project's last review has been looked for yet. */
  loaded: boolean;
  /** The last finished review, as the writer left it. */
  report: PaperReview | null;
  run: PaperReviewRun | null;
  /** Why the last review produced nothing. */
  error: string | null;
  /** The findings being made annotations, which take no other decision meanwhile. */
  annotating: ReadonlySet<string>;
};

const EMPTY: PaperReviewSnapshot = { loaded: false, report: null, run: null, error: null, annotating: new Set() };

/** A sortable, file-safe id for a review started at `ms`: its UTC time to the second. */
export function reviewId(ms: number): string {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- a file name, not interface copy
  return new Date(ms).toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

/** A stored review, when it is one this version can show. */
function asReview(value: unknown): PaperReview | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.id !== "string" || !Array.isArray(value.findings)) return null;
  return value as PaperReview;
}

function failureMessage(reason: unknown): string {
  if (reason instanceof ProofreadFailure) {
    if (reason.kind === "unavailable") {
      return i18n._(msg`This version of the agent runtime cannot review the paper yet. Update Lattice to use reviews.`);
    }
    if (reason.kind === "unreadable") return i18n._(msg`The agent's report could not be read. Try the review again.`);
    return reason.detail
      ? i18n._(msg`The agent could not review the paper: ${reason.detail}`)
      : i18n._(msg`The agent could not review the paper.`);
  }
  return toMessage(reason);
}

/**
 * A reviewer's pass over the whole paper: the agent reads every file the
 * root document reaches and reports, and the writer turns the points they
 * agree with into annotations, which a revision round then works through.
 *
 * The report is kept in `.research/reviews/<id>.json`, the writer's
 * decisions with it, so the panel reopens on it; a new review is a new file.
 * A review keeps running when its panel closes, and stops when the project
 * changes.
 *
 * A plain object rather than a hook (one per window, `paperReview` below),
 * like the revision rounds: only the panel subscribes, once it is on screen.
 */
export class PaperReviews {
  private deps: PaperReviewDeps | null = null;
  private snapshot: PaperReviewSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  /** Bumped by `reset`, so work for an earlier project drops its results. */
  private generation = 0;
  /** The last save in line: each waits for the one before, so the newest decisions land last. */
  private saving: Promise<void> = Promise.resolve();

  attach(deps: PaperReviewDeps) {
    this.deps = deps;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = () => this.snapshot;

  private publish(change: Partial<PaperReviewSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * Read the project's last review, once per project. Resolves whether the
   * project open when it was called has been looked in: false once that
   * project closed, whose answer is then no one's.
   */
  load = async () => {
    if (this.snapshot.loaded) return true;
    const generation = this.generation;
    const stored = await invoke<unknown>("read_paper_review").catch(() => null);
    if (generation !== this.generation) return false;
    if (!this.snapshot.loaded) this.publish({ loaded: true, report: this.snapshot.report ?? asReview(stored) });
    return true;
  };

  /** Read the paper and ask the agent for a review; the last one stays until the new one is in. */
  start = async () => {
    const deps = this.deps;
    const projectRoot = deps?.projectRootRef.current;
    if (!deps || !projectRoot || this.snapshot.run) return;
    const { root, paths, venue } = deps.manuscript();
    if (!root) {
      this.publish({ error: i18n._(msg`Set a root document to review the paper.`) });
      return;
    }
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const startedAt = Date.now();
    const live = () => generation === this.generation && this.controller === controller;
    this.publish({ error: null, run: { startedAt, stage: "reading", files: 0, stats: null } });
    try {
      const sources = await readManuscript(root, paths, annotationRounds.readSource);
      if (!live()) return;
      if (!sources.length) throw new Error(i18n._(msg`Lattice could not read ${root}.`));
      this.publish({ run: { startedAt, stage: "reviewing", files: sources.length, stats: manuscriptStats(sources) } });
      const result = await reviewWithAgent({
        projectRoot,
        sources,
        venue,
        // eslint-disable-next-line lingui/no-unlocalized-strings -- model input: the language the report is written in
        language: i18n.locale.startsWith("zh") ? "Simplified Chinese" : "English",
        signal: controller.signal,
      });
      if (!live()) return;
      const report: PaperReview = {
        version: 1,
        id: reviewId(startedAt),
        createdAt: new Date(startedAt).toISOString(),
        seconds: Math.round((Date.now() - startedAt) / 1000),
        venue,
        readiness: result.readiness,
        verdict: result.verdict,
        strengths: result.strengths,
        findings: result.findings,
        dropped: result.dropped,
        ...result.truncated ? { truncated: true } : {},
        ...result.model ? { model: result.model } : {},
      };
      this.controller = null;
      this.publish({ run: null, report, loaded: true });
      this.save(report);
    } catch (reason) {
      if (!live()) return;
      this.controller = null;
      this.publish({ run: null, error: controller.signal.aborted ? null : failureMessage(reason) });
    }
  };

  /**
   * Review the paper unless a review is running or one was already made.
   * Only for the project it was asked in: a lookup that outlived it must not
   * read as "no review yet" for the project opened since and review that.
   */
  startIfNone = async () => {
    const generation = this.generation;
    const projectRoot = this.deps?.projectRootRef.current;
    if (!(await this.load())) return;
    if (generation !== this.generation || this.deps?.projectRootRef.current !== projectRoot) return;
    if (!this.snapshot.report && !this.snapshot.run) await this.start();
  };

  /** Stop the review in flight; the last finished one stays. */
  cancel = () => {
    this.controller?.abort();
    this.controller = null;
    this.publish({ run: null });
  };

  /** Stop and forget everything: the project is closing or changing. */
  reset = () => {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.snapshot = EMPTY;
    for (const listener of [...this.listeners]) listener();
  };

  private save(report: PaperReview) {
    const projectRoot = this.deps?.projectRootRef.current;
    if (!projectRoot) return;
    this.saving = this.saving
      .then(() => invoke("save_paper_review", { projectRoot, review: report }))
      .then(() => {}, (reason: unknown) => {
        notifyInfo(i18n._(msg`Review`), i18n._(msg`The review could not be saved: ${toMessage(reason)}`), { dedupeKey: "paper-review-save" });
      });
  }

  /** Change one finding of the report on screen, and keep it. */
  private updateFinding(id: string, change: (finding: ReviewFinding) => ReviewFinding) {
    const report = this.snapshot.report;
    if (!report) return;
    const next = { ...report, findings: report.findings.map((finding) => (finding.id === id ? change(finding) : finding)) };
    this.publish({ report: next });
    this.save(next);
  }

  private find(id: string) {
    return this.snapshot.report?.findings.find((finding) => finding.id === id) ?? null;
  }

  /** Where `finding` is in its file now, or null once its text is gone. */
  private async place(finding: ReviewFinding) {
    const source = await annotationRounds.readSource(finding.path);
    if (source == null) return null;
    const range = resolveCommentAnchor(source, finding);
    return range ? { source, ...range } : null;
  }

  /** Show the passage a finding quotes, where it is now. */
  reveal = async (id: string) => {
    const finding = this.find(id);
    const deps = this.deps;
    if (!finding || !deps) return;
    const placed = await this.place(finding);
    const line = placed ? placed.source.slice(0, placed.from).split("\n").length : finding.line;
    await deps.openProjectFile(finding.path, { line });
  };

  /**
   * Make a finding an annotation on the passage it quotes, its title and
   * reason as the note, so a revision round can work through it.
   */
  annotate = async (id: string) => {
    const finding = this.find(id);
    const deps = this.deps;
    const reportId = this.snapshot.report?.id;
    if (!finding || !deps || finding.state || this.snapshot.annotating.has(id)) return;
    const generation = this.generation;
    this.publish({ annotating: new Set([...this.snapshot.annotating, id]) });
    try {
      await this.annotateFinding(finding, deps, reportId);
    } finally {
      if (generation === this.generation) {
        this.publish({ annotating: new Set([...this.snapshot.annotating].filter((item) => item !== id)) });
      }
    }
  };

  private async annotateFinding(finding: ReviewFinding, deps: PaperReviewDeps, reportId: string | undefined) {
    const { id } = finding;
    const root = deps.projectRootRef.current;
    const live = () => deps.projectRootRef.current === root && this.snapshot.report?.id === reportId && !this.find(id)?.state;
    const placed = await this.place(finding);
    if (!live()) return;
    if (!placed) {
      notifyInfo(i18n._(msg`Review`), i18n._(msg`The quoted passage has changed since the review, so this point has nowhere to go.`), {
        dedupeKey: `paper-review-unplaced:${id}`,
      });
      return;
    }
    const comment = createEditorComment({
      path: finding.path,
      source: placed.source,
      from: placed.from,
      to: placed.to,
      body: finding.reason ? `${finding.title}\n${finding.reason}` : finding.title,
      // eslint-disable-next-line lingui/no-unlocalized-strings -- stored sentinel; editorCommentAuthorDisplayName translates it
      authorId: deps.author.id, authorName: deps.author.name.trim() || "Anonymous",
      intent: INTENTS[finding.kind],
    });
    if (!comment) return;
    const created = deps.store.create(comment);
    if (!created) return;
    if (created instanceof Promise && (!await created || !live())) return;
    const annotation = created instanceof Promise ? undefined : created.number;
    this.updateFinding(id, (current) => ({
      ...current,
      state: "added",
      ...annotation ? { annotation } : {},
    }));
  }

  /** Set a finding aside, with the toast's Undo to bring it back. */
  dismiss = (id: string) => {
    const report = this.snapshot.report;
    if (!this.find(id) || !report || this.snapshot.annotating.has(id)) return;
    this.updateFinding(id, (finding) => ({ ...finding, state: "dismissed" }));
    notifyInfo(i18n._(msg`Review`), i18n._(msg`Point dismissed`), {
      dedupeKey: `paper-review-dismissed:${id}`,
      primaryAction: {
        label: i18n._(msg`Undo`),
        onClick: () => {
          if (this.snapshot.report?.id !== report.id) return;
          this.updateFinding(id, (finding) => {
            const { state: _state, ...rest } = finding;
            return rest;
          });
        },
      },
    });
  };

  /** Find papers that would support the passage a finding quotes, searching with its keywords when it named some. */
  findSupport = (id: string) => {
    const finding = this.find(id);
    if (!finding) return;
    const { path, line, from, to, quote, prefix, suffix, search } = finding;
    this.deps?.findSupport({ path, line, from, to, quote, prefix, suffix, ...search ? { terms: search } : {} });
  };

  /** Open the annotation a finding became. */
  openAnnotation = (id: string) => {
    const finding = this.find(id);
    const annotation = finding?.annotation
      ? this.deps?.store.stateRef.current.annotations.find((item) => item.number === finding.annotation)
      : null;
    if (annotation) this.deps?.store.openComment(annotation);
  };

  /** The annotations this review's points became that a round can ask about now. */
  revisableIds = (
    annotations: readonly EditorComment[] = this.deps?.store.stateRef.current.annotations ?? [],
    running: ReadonlySet<string> = annotationRounds.getSnapshot().running,
  ): string[] => {
    const numbers = new Set(this.snapshot.report?.findings.flatMap((finding) => finding.annotation ? [finding.annotation] : []));
    if (!numbers.size) return [];
    return annotations
      .filter((annotation) => annotation.number && numbers.has(annotation.number) && revisable(annotation, running))
      .map((annotation) => annotation.id);
  };

  /** Hand the points made annotations to a revision round. */
  revise = () => {
    const ids = this.revisableIds();
    if (ids.length) annotationRounds.revise(ids);
  };
}

/** The window's paper review, for its one project at a time. */
export const paperReview = new PaperReviews();
