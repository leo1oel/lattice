import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import type { OpenProjectFile, SyncTexTarget } from "../app-types";
import { toMessage } from "../app-utils";
import {
  ANNOTATION_PASSAGE_MAX_LENGTH,
  annotationContext,
  reviseAnnotationWithAgent,
  type AnnotationCitation,
  type AnnotationToolHost,
} from "../agent/agent-annotations";
import { ProofreadFailure } from "../agent/agent-proofread";
import {
  createEditorComment,
  resolveCommentAnchor,
  type AnnotationIntent,
  type AnnotationRevision,
  type AnnotationRound,
  type EditorComment,
} from "../editor/comments/editor-comment-data";
import { sourceRangeForPdfText } from "../editor/comments/pdf-source-anchor";
import { i18n } from "../i18n";
import type { PdfTextSelection } from "../pdf/pdf-annotations";
import { notifyInfo } from "../telemetry/app-notify";
import { showError } from "./notify";
import { createAnnotationReviewBridge } from "../canvas/annotation-review-bridge";
import type { EditorComments } from "./use-editor-comments";

/** Text tasks the agent service runs at once is four; one stays free for a proofread. */
const CONCURRENT_REVISIONS = 3;

type Ref<T> = { readonly current: T };

/** A file's text as a round found it, and as it left it once settled. */
export type RoundFile = { path: string; before: string | null; after: string | null };

/** Where an annotation was accepted, as the editor applied it. */
export type AcceptedRevision = Pick<EditorComment, "from" | "to" | "quote" | "prefix" | "suffix">;

/** A PDF selection placed in the source: the file and span SyncTeX and its text led to. */
export type MappedPdfSelection = { path: string; line: number; from: number; to: number; source: string };

/** The open round: the last one that has not settled. */
export const openRound = (rounds: readonly AnnotationRound[]) => {
  const last = rounds.at(-1);
  return last && !last.settledAt ? last : null;
};

/** A local annotation the agent can be asked about now. */
export function revisable(annotation: EditorComment, running: ReadonlySet<string>): boolean {
  if (!annotation.number || annotation.resolved || running.has(annotation.id)) return false;
  const state = annotation.revision?.state;
  if (state === "proposed") return false;
  // A question waits for its answer.
  return state !== "asked" || Boolean(annotation.revision?.answer?.trim());
}

/** Proposals still waiting for the writer, in the order the review walks them. */
export function pendingProposals(annotations: readonly EditorComment[]): EditorComment[] {
  return annotations
    .filter((annotation) => !annotation.resolved && annotation.revision?.state === "proposed")
    .sort((left, right) => left.path.localeCompare(right.path) || left.from - right.from || (left.number ?? 0) - (right.number ?? 0));
}

/** The open round's progress: how many annotations it asked about, how many are answered, how many still run. */
export function roundProgress(rounds: readonly AnnotationRound[], annotations: readonly EditorComment[], running: ReadonlySet<string>) {
  const round = openRound(rounds);
  if (!round) return null;
  const ids = Object.keys(round.outcomes);
  const answered = annotations.filter((annotation) => ids.includes(annotation.id) && !running.has(annotation.id)
    && annotation.revision?.round === round.number).length;
  return { round: round.number, total: ids.length, answered, running: ids.filter((id) => running.has(id)).length };
}

const lineAt = (source: string, offset: number) => source.slice(0, offset).split("\n").length;

/** What the rounds read and do in the app, attached by App once it has them. */
export type AnnotationRoundsDeps = {
  store: Pick<EditorComments, "stateRef" | "commit" | "create" | "setActiveId" | "openComment">;
  projectRootRef: Ref<string | null>;
  activeFileRef: Ref<string>;
  /** The active file's live text. */
  sourceRef: Ref<string>;
  openProjectFile: OpenProjectFile;
  author: { id: string; name: string };
  /** A project linked to Overleaf keeps its notes as Overleaf threads, which have no place on the PDF. */
  overleafLinked: boolean;
  openPanel: () => void;
  openHistoryEntry: (id: string) => void;
  /** Save pending edits before files are restored; false when that failed. */
  save: () => Promise<boolean>;
  /** Bring the project, the open file and history up to date after a restore. */
  reloadAfterRestore: () => Promise<void>;
};

/** What React reads from the rounds, a new object on every change. */
export type AnnotationRoundsSnapshot = {
  /** Annotations the agent is answering now. */
  running: ReadonlySet<string>;
  /** The proposal to review in the editor. */
  review: { id: string; nonce: string } | null;
  /** The Revision rounds sheet is open. */
  roundsOpen: boolean;
};

/**
 * Revision rounds: asking the agent to revise the passages the writer
 * annotated, and the writer's decision on each proposal.
 *
 * A round asks about every open annotation at once (`revise`), each in its
 * own text task, a few at a time; asking again while a round still has
 * proposals waiting adds to that round. Each answer is saved with its
 * annotation as it arrives. Proposals are accepted or rejected in the editor
 * (`accepted`, `rejected`), and nothing reaches a file until accepted.
 *
 * Every round is a version: it keeps the text of each file it touches from
 * before its first answer, and once no proposal is waiting it settles,
 * keeping their text after it too and recording the round in the project
 * history (`save_annotation_round`).
 *
 * A plain object rather than a hook (one per window, `annotationRounds`
 * below): the work runs in the background, and only the surfaces that show it
 * (the panel, the review card, the PDF's marks, the sheet) subscribe, once
 * they are on screen, so a project that is not being annotated pays nothing
 * for it on any render.
 */
export class AnnotationRounds {
  private deps: AnnotationRoundsDeps | null = null;
  private snapshot: AnnotationRoundsSnapshot = { running: new Set(), review: null, roundsOpen: false };
  private readonly listeners = new Set<() => void>();
  private readonly tasks = new Map<string, AbortController>();
  private queue: Array<() => Promise<void>> = [];
  private activeTasks = 0;
  /** Per round, the files it touches with their text from before its first answer. */
  private readonly baselines = new Map<number, Map<string, string | null>>();
  /** The round being settled, so answers landing together settle it once. */
  private settling: number | null = null;
  /** Bumped by `reset`, so work for an earlier project drops its results. */
  private generation = 0;
  /** The editor's keys (⌘↵, Escape) reach the open review card through this. */
  readonly reviewBridge = createAnnotationReviewBridge();

  attach(deps: AnnotationRoundsDeps) {
    this.deps = deps;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = () => this.snapshot;

  private publish(change: Partial<AnnotationRoundsSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of [...this.listeners]) listener();
  }

  private updateRunning() {
    this.publish({ running: new Set(this.tasks.keys()) });
  }

  /** A file's current text: the open buffer when it is the active file, else the disk. */
  readSource = async (path: string): Promise<string | null> => {
    const deps = this.deps;
    if (!deps) return null;
    if (path === deps.activeFileRef.current) return deps.sourceRef.current;
    const projectRoot = deps.projectRootRef.current;
    if (!projectRoot) return null;
    return invoke<string>("read_project_file", { path, projectRoot }).catch(() => null);
  };

  /** Change `id`'s revision and its outcome in round `round` together. */
  private record(id: string, revision: AnnotationRevision, change: Partial<EditorComment> = {}) {
    this.deps?.store.commit((current) => ({
      annotations: current.annotations.map((annotation) => annotation.id === id
        ? { ...annotation, ...change, revision, updatedAt: new Date().toISOString() }
        : annotation),
      rounds: current.rounds.map((round) => round.number === revision.round
        ? { ...round, outcomes: { ...round.outcomes, [id]: revision.state } }
        : round),
    }));
  }

  private find(id: string) {
    return this.deps?.store.stateRef.current.annotations.find((annotation) => annotation.id === id);
  }

  /** Keep `round`'s files from before its first answer, adding `paths` it had not touched. */
  private async keepBaseline(round: number, paths: readonly string[]) {
    const projectRoot = this.deps?.projectRootRef.current;
    let baseline = this.baselines.get(round);
    if (!baseline) {
      // A round left open by an earlier session kept its baseline on disk.
      const kept = await invoke<RoundFile[]>("read_annotation_round", { number: round }).catch(() => []);
      baseline = this.baselines.get(round) ?? new Map(kept.map((file) => [file.path, file.before]));
      this.baselines.set(round, baseline);
    }
    const added = paths.filter((path) => !baseline.has(path));
    if (!added.length || !projectRoot) return;
    for (const path of added) baseline.set(path, await this.readSource(path));
    if (this.deps?.projectRootRef.current !== projectRoot) return;
    const files = [...baseline].map(([path, before]) => ({ path, before, after: null }));
    await invoke("save_annotation_round", { projectRoot, number: round, files, settled: false })
      .catch((reason: unknown) => showError(toMessage(reason)));
  }

  /** The open round, or a new one; `ids` join it. */
  private joinRound(ids: readonly string[]): number {
    let number = 0;
    this.deps?.store.commit((current) => {
      const open = openRound(current.rounds);
      number = open?.number ?? (current.rounds.at(-1)?.number ?? 0) + 1;
      const round: AnnotationRound = open ?? { number, startedAt: new Date().toISOString(), outcomes: {} };
      const outcomes = { ...round.outcomes };
      // Present in the round from the start; the answer replaces it.
      for (const id of ids) if (!(id in outcomes)) outcomes[id] = "failed";
      const next = { ...round, outcomes };
      return { ...current, rounds: open ? current.rounds.map((item) => item === open ? next : item) : [...current.rounds, next] };
    });
    return number;
  }

  /** Keep `round`'s files as it left them and record it in the project history. */
  private async keepSettled(round: AnnotationRound) {
    const deps = this.deps;
    const projectRoot = deps?.projectRootRef.current;
    if (!deps || !projectRoot) return;
    const generation = this.generation;
    const baseline = this.baselines.get(round.number) ?? new Map<string, string | null>(
      (await invoke<RoundFile[]>("read_annotation_round", { number: round.number }).catch(() => []))
        .map((file) => [file.path, file.before]),
    );
    const files: RoundFile[] = [];
    for (const [path, before] of baseline) files.push({ path, before, after: await this.readSource(path) });
    if (this.generation !== generation || openRound(deps.store.stateRef.current.rounds)?.number !== round.number) return;
    const historyId = await invoke<string | null>("save_annotation_round", {
      projectRoot, number: round.number, files, settled: true,
    }).catch((reason: unknown) => {
      showError(toMessage(reason));
      return undefined;
    });
    if (historyId === undefined || this.generation !== generation) return;
    this.baselines.delete(round.number);
    deps.store.commit((current) => ({
      ...current,
      rounds: current.rounds.map((item) => item.number === round.number
        ? { ...item, settledAt: new Date().toISOString(), ...historyId ? { historyId } : {} }
        : item),
    }));
    if (Object.values(round.outcomes).some((outcome) => outcome === "accepted")) {
      const number = round.number;
      notifyInfo(i18n._(msg`Annotations`), i18n._(msg`Round ${number} is saved as a version`), {
        dedupeKey: `annotation-round-settled:${number}`,
        primaryAction: { label: i18n._(msg`Compare`), onClick: this.openRounds },
      });
    }
  }

  /**
   * Settle the open round once nothing in it is running or waiting for the
   * writer: keep its files' text as it left them, and record it as one
   * project-history entry.
   */
  private async settle() {
    const deps = this.deps;
    const state = deps?.store.stateRef.current;
    const round = state && openRound(state.rounds);
    if (!deps || !state || !round || !deps.projectRootRef.current) return;
    const ids = Object.keys(round.outcomes);
    if (this.settling === round.number || ids.some((id) => this.tasks.has(id))) return;
    if (state.annotations.some((annotation) => ids.includes(annotation.id) && annotation.revision?.round === round.number
      && annotation.revision.state === "proposed" && !annotation.resolved)) return;
    // A round the agent answered nothing in is no version; its notes say why on their cards.
    if (Object.values(round.outcomes).every((outcome) => outcome === "failed")) {
      this.baselines.delete(round.number);
      deps.store.commit((current) => ({ ...current, rounds: current.rounds.filter((item) => item.number !== round.number) }));
      return;
    }
    this.settling = round.number;
    await this.keepSettled(round).finally(() => {
      this.settling = null;
    });
  }

  private failure(error: unknown): string {
    if (error instanceof ProofreadFailure && error.kind === "unavailable") {
      return i18n._(msg`This version of the agent runtime cannot revise annotations yet. Update Lattice to use revisions.`);
    }
    if (error instanceof ProofreadFailure && error.kind === "unreadable") {
      return i18n._(msg`The agent's reply held neither a revision nor a question.`);
    }
    const detail = error instanceof ProofreadFailure ? error.detail : toMessage(error);
    return detail ? i18n._(msg`The agent could not revise this passage: ${detail}`) : i18n._(msg`The agent could not revise this passage.`);
  }

  /** Ask the agent about one annotation in `round`. */
  private async ask(id: string, round: number, extra: { guidance?: string; rejected?: string }) {
    const annotation = this.find(id);
    const projectRoot = this.deps?.projectRootRef.current;
    const controller = this.tasks.get(id);
    if (!annotation || !projectRoot || !controller) return;
    const fail = (error: string) => this.record(id, { round, state: "failed", error });
    const source = await this.readSource(annotation.path);
    if (controller.signal.aborted) return;
    const range = source === null ? null : resolveCommentAnchor(source, annotation);
    if (source === null || !range) {
      fail(i18n._(msg`The annotated text changed or moved. Select it again and annotate it to ask about it.`));
      return;
    }
    const passage = source.slice(range.from, range.to);
    if (passage.length > ANNOTATION_PASSAGE_MAX_LENGTH) {
      const limit = ANNOTATION_PASSAGE_MAX_LENGTH.toLocaleString();
      fail(i18n._(msg`Annotate at most ${limit} characters for the agent to revise.`));
      return;
    }
    const previous = annotation.revision;
    const citations = annotation.intent === "cite"
      ? await invoke<AnnotationCitation[]>("list_citations").catch(() => [])
      : undefined;
    const stale = () => controller.signal.aborted || this.deps?.projectRootRef.current !== projectRoot;
    await reviseAnnotationWithAgent({
      projectRoot,
      signal: controller.signal,
      path: annotation.path,
      line: lineAt(source, range.from),
      note: annotation.body,
      intent: annotation.intent,
      passage,
      ...annotationContext(source, range.from, range.to),
      question: previous?.question,
      answer: previous?.answer,
      // A proposal turned down earlier is what not to propose again.
      rejected: extra.rejected ?? (previous?.state === "rejected" ? previous.text : undefined),
      guidance: extra.guidance,
      // eslint-disable-next-line lingui/no-unlocalized-strings -- model input, not interface copy
      language: i18n.locale.startsWith("zh") ? "Simplified Chinese" : "English",
      citations,
    }).then(
      (answer) => {
        if (stale()) return;
        this.record(id, answer.kind === "revision"
          ? { round, state: "proposed", original: passage, text: answer.text, reason: answer.reason }
          : { round, state: "asked", question: answer.question });
      },
      (error: unknown) => {
        if (!stale()) fail(this.failure(error));
      },
    );
  }

  /** Run queued tasks while fewer than the limit are running. */
  private pump() {
    while (this.activeTasks < CONCURRENT_REVISIONS && this.queue.length) {
      const task = this.queue.shift()!;
      this.activeTasks += 1;
      void task().finally(() => {
        this.activeTasks -= 1;
        this.pump();
      });
    }
  }

  /** Ask about `ids` in the open round (a new one when none is open). */
  private start(ids: readonly string[], extra: (id: string) => { guidance?: string; rejected?: string } = () => ({})) {
    const deps = this.deps;
    if (!deps || !ids.length || !deps.projectRootRef.current) return;
    const round = this.joinRound(ids);
    const paths = [...new Set(deps.store.stateRef.current.annotations.filter((item) => ids.includes(item.id)).map((item) => item.path))];
    const generation = this.generation;
    const baseline = this.keepBaseline(round, paths);
    for (const id of ids) {
      this.tasks.get(id)?.abort();
      const controller = new AbortController();
      this.tasks.set(id, controller);
      this.queue.push(async () => {
        // The first answer may not land before the baseline holds the text it changes.
        await baseline;
        if (!controller.signal.aborted) await this.ask(id, round, extra(id));
        if (this.tasks.get(id) === controller) this.tasks.delete(id);
        if (this.generation !== generation) return;
        this.updateRunning();
        void this.settle();
      });
    }
    this.updateRunning();
    this.pump();
  }

  /** Ask the agent to revise every open annotation (or `ids`), and show the panel. */
  revise = (ids?: readonly string[]) => {
    const deps = this.deps;
    if (!deps) return;
    const running = new Set(this.tasks.keys());
    const candidates = deps.store.stateRef.current.annotations
      .filter((annotation) => revisable(annotation, running) && (!ids || ids.includes(annotation.id)));
    this.start(candidates.map((annotation) => annotation.id));
    deps.openPanel();
  };

  /** Turn down the proposal for `id` and ask again, with what the writer wants instead. */
  retry = (id: string, guidance = "") => {
    const annotation = this.find(id);
    if (!annotation || annotation.resolved) return;
    const rejected = annotation.revision?.state === "proposed" ? annotation.revision.text : undefined;
    this.start([id], () => ({ guidance: guidance.trim() || undefined, rejected }));
  };

  /** The writer's answer to the agent's question, then a revision that reads it. */
  answer = (id: string, text: string) => {
    const revision = this.find(id)?.revision;
    if (revision?.state !== "asked" || !text.trim()) return;
    this.record(id, { ...revision, answer: text.trim() });
    this.start([id]);
  };

  /** Accept `id`'s proposal as the editor applied it, then review the next one waiting. */
  accepted = (id: string, applied: AcceptedRevision) => {
    const revision = this.find(id)?.revision;
    if (revision?.state !== "proposed") return;
    this.decide(id, () => this.record(id, { ...revision, state: "accepted" }, { ...applied, resolved: true }));
  };

  /** Keep `id`'s passage, then review the next proposal waiting. */
  rejected = (id: string) => {
    const revision = this.find(id)?.revision;
    if (revision?.state !== "proposed") return;
    this.decide(id, () => this.record(id, { ...revision, state: "rejected" }));
  };

  private decide(id: string, decision: () => void) {
    const next = this.neighbour(id, 1);
    decision();
    if (next) this.openReview(next.id);
    else this.closeReview();
    void this.settle();
  }

  /** Open `id`'s proposal in the editor, its card under the passage. */
  openReview = (id: string) => {
    const annotation = this.find(id);
    if (!annotation || !this.deps) return;
    void this.deps.openProjectFile(annotation.path, { restoreView: false }).then(() => {
      this.publish({ review: { id, nonce: crypto.randomUUID() } });
    });
  };

  closeReview = () => {
    if (this.snapshot.review) this.publish({ review: null });
  };

  /** The next (or previous) waiting proposal after `id`, wrapping; null when there is none. */
  neighbour = (id: string | null, step: 1 | -1) => {
    const proposals = pendingProposals(this.deps?.store.stateRef.current.annotations ?? []);
    if (!proposals.length) return null;
    const index = proposals.findIndex((annotation) => annotation.id === id);
    if (index < 0) return proposals[step === 1 ? 0 : proposals.length - 1]!;
    const next = proposals[(index + step + proposals.length) % proposals.length]!;
    return next.id === id ? null : next;
  };

  /** Review the proposal before or after `id`. */
  navigate = (id: string, step: 1 | -1) => {
    const next = this.neighbour(id, step);
    if (next) this.openReview(next.id);
  };

  /**
   * Show an annotation: its passage in the editor (its proposal, when one
   * waits), and its card in the panel unless `inPlace`: a pin on the PDF
   * leaves the panel where it is, which may be the PDF's own.
   */
  open = (comment: EditorComment, inPlace = false) => {
    const deps = this.deps;
    if (!deps) return;
    if (!inPlace) deps.openPanel();
    deps.store.setActiveId(comment.id);
    if (comment.revision?.state === "proposed" && !comment.resolved) this.openReview(comment.id);
    else deps.store.openComment(comment);
  };

  openById = (id: string) => {
    const annotation = this.find(id);
    if (annotation) this.open(annotation, true);
  };

  openRounds = () => this.publish({ roundsOpen: true });
  closeRounds = () => this.publish({ roundsOpen: false });

  openInHistory = (historyId: string) => {
    this.closeRounds();
    this.deps?.openHistoryEntry(historyId);
  };

  /** Write `files` (path → text) as one restore, after saving pending edits; then reload. */
  restore = async (label: string, files: Array<{ path: string; text: string }>) => {
    const deps = this.deps;
    const projectRoot = deps?.projectRootRef.current;
    if (!deps || !projectRoot) return;
    if (!await deps.save()) throw new Error(i18n._(msg`Save pending edits before restoring a round.`));
    await invoke("restore_annotation_round", {
      projectRoot, label, files: files.map(({ path, text }) => ({ path, before: null, after: text })),
    });
    await deps.reloadAfterRestore();
  };

  /** Annotations can be made on the compiled PDF (not in a project linked to Overleaf). */
  canAnnotatePdf = () => Boolean(this.deps && !this.deps.overleafLinked);

  /** Where text selected on the PDF was written: SyncTeX's line, then the words around it. */
  mapPdfSelection = async (selection: PdfTextSelection): Promise<MappedPdfSelection> => {
    const target = await invoke<SyncTexTarget>("synctex_edit", { page: selection.page, x: selection.point.x, y: selection.point.y });
    const source = await this.readSource(target.path);
    if (source === null) throw new Error(i18n._(msg`Lattice could not read ${target.path}.`));
    const range = sourceRangeForPdfText(source, target.line, selection.text);
    if (!range) throw new Error(i18n._(msg`SyncTeX placed this text outside ${target.path}. Build the PDF again, then annotate.`));
    return { path: target.path, line: source.slice(0, range.from).split("\n").length, from: range.from, to: range.to, source };
  };

  /** Save a note made on the PDF; false when its source no longer holds the span. Revises at once with `revise`. */
  createFromPdf = (selection: PdfTextSelection, mapped: MappedPdfSelection, body: string, intent: AnnotationIntent | undefined, revise: boolean) => {
    const deps = this.deps;
    if (!deps) return false;
    const comment = createEditorComment({
      path: mapped.path, source: mapped.source, from: mapped.from, to: mapped.to, body,
      // eslint-disable-next-line lingui/no-unlocalized-strings -- stored sentinel; editorCommentAuthorDisplayName translates it
      authorId: deps.author.id, authorName: deps.author.name.trim() || "Anonymous",
      intent, pdf: { page: selection.page, rects: selection.rects, text: selection.text },
    });
    if (!comment) return false;
    if (deps.store.create(comment) && revise) this.revise();
    return true;
  };

  /** Stop every question in flight: the project is closing or changing. */
  reset = () => {
    this.generation += 1;
    for (const controller of this.tasks.values()) controller.abort();
    this.tasks.clear();
    this.queue = [];
    this.baselines.clear();
    this.publish({ running: new Set(), review: null, roundsOpen: false });
  };

  /** The conversation's `propose_annotation_edit` and `ask_about_annotation`, recorded in the open round. */
  readonly toolHost: AnnotationToolHost = {
    find: (number) => this.deps?.store.stateRef.current.annotations.find((annotation) => annotation.number === number) ?? null,
    propose: (annotation, text, reason) => {
      const round = this.joinRound([annotation.id]);
      void this.keepBaseline(round, [annotation.path]);
      this.record(annotation.id, { round, state: "proposed", original: annotation.quote, text, reason });
    },
    ask: (annotation, question) => {
      const round = this.joinRound([annotation.id]);
      this.record(annotation.id, { round, state: "asked", question });
      void this.settle();
    },
  };
}

/**
 * The window's revision rounds, one for its one project at a time, like the
 * notification stack: App attaches what they need on every commit and resets
 * them when the project changes.
 */
export const annotationRounds = new AnnotationRounds();
