import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { OpenProjectFile } from "../app-types";
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
  resolveCommentAnchor,
  type AnnotationRevision,
  type AnnotationRound,
  type EditorComment,
} from "../editor/comments/editor-comment-data";
import { notifyInfo } from "../telemetry/app-notify";
import { showError } from "./notify";
import type { AnnotationsState, EditorComments } from "./use-editor-comments";

/** Text tasks the agent service runs at once is four; one stays free for a proofread. */
const CONCURRENT_REVISIONS = 3;

/** A file's text as a round found it, and as it left it once settled. */
export type RoundFile = { path: string; before: string | null; after: string | null };

/** Where an annotation was accepted, as the editor applied it. */
export type AcceptedRevision = Pick<EditorComment, "from" | "to" | "quote" | "prefix" | "suffix">;

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

const lineAt = (source: string, offset: number) => source.slice(0, offset).split("\n").length;

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
 */
export function useAnnotationRounds({ store, projectRootRef, readSource, openProjectFile, language, citations, onCompare }: {
  store: Pick<EditorComments, "stateRef" | "commit" | "comments" | "rounds">;
  projectRootRef: { readonly current: string | null };
  /** A file's current text: the open buffer when it is the active file, else the disk. */
  readSource: (path: string) => Promise<string | null>;
  openProjectFile: OpenProjectFile;
  /** The interface language, in English words, for the agent's reasons and questions. */
  language: string;
  /** Bibliography entries the agent may cite for an "Add a citation" annotation. */
  citations: () => readonly AnnotationCitation[];
  /** Open the Revision rounds sheet, from a settled round's toast. */
  onCompare: () => void;
}) {
  const { t } = useLingui();
  const { stateRef, commit } = store;
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const runningRef = useRef(new Map<string, AbortController>());
  const queueRef = useRef<Array<() => Promise<void>>>([]);
  const activeTasksRef = useRef(0);
  /** Per round, the files it touches with their text from before its first answer. */
  const baselinesRef = useRef(new Map<number, Map<string, string | null>>());
  const [review, setReview] = useState<{ id: string; nonce: string } | null>(null);
  const generationRef = useRef(0);
  /** The round being settled, so answers landing together settle it once. */
  const settlingRef = useRef<number | null>(null);

  const updateRunning = useCallback(() => setRunning(new Set(runningRef.current.keys())), []);

  /** Change `id`'s revision and its outcome in round `round` together. */
  const record = useCallback((id: string, revision: AnnotationRevision, change: Partial<EditorComment> = {}) => {
    commit((current) => ({
      annotations: current.annotations.map((annotation) => annotation.id === id
        ? { ...annotation, ...change, revision, updatedAt: new Date().toISOString() }
        : annotation),
      rounds: current.rounds.map((round) => round.number === revision.round
        ? { ...round, outcomes: { ...round.outcomes, [id]: revision.state } }
        : round),
    }));
  }, [commit]);

  /** Keep `round`'s files from before its first answer, adding `paths` it had not touched. */
  const keepBaseline = useCallback(async (round: number, paths: readonly string[]) => {
    const projectRoot = projectRootRef.current;
    let baseline = baselinesRef.current.get(round);
    if (!baseline) {
      // A round left open by an earlier session kept its baseline on disk.
      const kept = await invoke<RoundFile[]>("read_annotation_round", { number: round }).catch(() => []);
      baseline = baselinesRef.current.get(round) ?? new Map(kept.map((file) => [file.path, file.before]));
      baselinesRef.current.set(round, baseline);
    }
    const added = paths.filter((path) => !baseline.has(path));
    if (!added.length || !projectRoot) return;
    for (const path of added) baseline.set(path, await readSource(path));
    if (projectRootRef.current !== projectRoot) return;
    const files = [...baseline].map(([path, before]) => ({ path, before, after: null }));
    await invoke("save_annotation_round", { projectRoot, number: round, files, settled: false })
      .catch((reason: unknown) => showError(toMessage(reason)));
  }, [projectRootRef, readSource]);

  /** The open round, or a new one; `ids` join it. */
  const joinRound = useCallback((ids: readonly string[]): number => {
    let number = 0;
    commit((current) => {
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
  }, [commit]);

  /** Keep `round`'s files as it left them and record it in the project history. */
  const keepSettled = useCallback(async (round: AnnotationRound) => {
    const projectRoot = projectRootRef.current;
    if (!projectRoot) return;
    const generation = generationRef.current;
    const baseline = baselinesRef.current.get(round.number) ?? new Map<string, string | null>(
      (await invoke<RoundFile[]>("read_annotation_round", { number: round.number }).catch(() => []))
        .map((file) => [file.path, file.before]),
    );
    const files: RoundFile[] = [];
    for (const [path, before] of baseline) files.push({ path, before, after: await readSource(path) });
    if (generationRef.current !== generation || openRound(stateRef.current.rounds)?.number !== round.number) return;
    const historyId = await invoke<string | null>("save_annotation_round", {
      projectRoot, number: round.number, files, settled: true,
    }).catch((reason: unknown) => {
      showError(toMessage(reason));
      return undefined;
    });
    if (historyId === undefined || generationRef.current !== generation) return;
    baselinesRef.current.delete(round.number);
    commit((current) => ({
      ...current,
      rounds: current.rounds.map((item) => item.number === round.number
        ? { ...item, settledAt: new Date().toISOString(), ...historyId ? { historyId } : {} }
        : item),
    }));
    const outcomes = Object.values(round.outcomes);
    const accepted = outcomes.filter((outcome) => outcome === "accepted").length;
    if (accepted) {
      const number = round.number;
      notifyInfo(t`Annotations`, t`Round ${number} is saved as a version`, {
        dedupeKey: `annotation-round-settled:${number}`,
        primaryAction: { label: t`Compare`, onClick: onCompare },
      });
    }
  }, [commit, onCompare, projectRootRef, readSource, stateRef, t]);

  /**
   * Settle the open round once nothing in it is running or waiting for the
   * writer: keep its files' text as it left them, and record it as one
   * project-history entry.
   */
  const settle = useCallback(async () => {
    const state = stateRef.current;
    const round = openRound(state.rounds);
    const projectRoot = projectRootRef.current;
    if (!round || !projectRoot) return;
    const ids = Object.keys(round.outcomes);
    if (settlingRef.current === round.number || ids.some((id) => runningRef.current.has(id))) return;
    if (state.annotations.some((annotation) => ids.includes(annotation.id) && annotation.revision?.round === round.number
      && annotation.revision.state === "proposed" && !annotation.resolved)) return;
    // A round the agent answered nothing in is no version; its notes say why on their cards.
    if (Object.values(round.outcomes).every((outcome) => outcome === "failed")) {
      baselinesRef.current.delete(round.number);
      commit((current) => ({ ...current, rounds: current.rounds.filter((item) => item.number !== round.number) }));
      return;
    }
    settlingRef.current = round.number;
    await keepSettled(round).finally(() => {
      settlingRef.current = null;
    });
  }, [commit, keepSettled, projectRootRef, stateRef]);

  const failure = useCallback((error: unknown) => {
    if (error instanceof ProofreadFailure && error.kind === "unavailable") {
      return t`This version of the agent runtime cannot revise annotations yet. Update Lattice to use revisions.`;
    }
    if (error instanceof ProofreadFailure && error.kind === "unreadable") return t`The agent's reply held neither a revision nor a question.`;
    const detail = error instanceof ProofreadFailure ? error.detail : toMessage(error);
    return detail ? t`The agent could not revise this passage: ${detail}` : t`The agent could not revise this passage.`;
  }, [t]);

  /** Ask the agent about one annotation in `round`. */
  const ask = useCallback(async (id: string, round: number, extra: { guidance?: string; rejected?: string }) => {
    const annotation = stateRef.current.annotations.find((item) => item.id === id);
    const projectRoot = projectRootRef.current;
    const controller = runningRef.current.get(id);
    if (!annotation || !projectRoot || !controller) return;
    const fail = (error: string) => record(id, { round, state: "failed", error });
    const source = await readSource(annotation.path);
    if (controller.signal.aborted) return;
    const range = source === null ? null : resolveCommentAnchor(source, annotation);
    if (source === null || !range) {
      fail(t`The annotated text changed or moved. Select it again and annotate it to ask about it.`);
      return;
    }
    const passage = source.slice(range.from, range.to);
    if (passage.length > ANNOTATION_PASSAGE_MAX_LENGTH) {
      const limit = ANNOTATION_PASSAGE_MAX_LENGTH.toLocaleString();
      fail(t`Annotate at most ${limit} characters for the agent to revise.`);
      return;
    }
    const previous = annotation.revision;
    const request = {
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
      language,
      citations: annotation.intent === "cite" ? citations() : undefined,
    };
    const stale = () => controller.signal.aborted || projectRootRef.current !== projectRoot;
    await reviseAnnotationWithAgent(request).then(
      (answer) => {
        if (stale()) return;
        record(id, answer.kind === "revision"
          ? { round, state: "proposed", original: passage, text: answer.text, reason: answer.reason }
          : { round, state: "asked", question: answer.question });
      },
      (error: unknown) => {
        if (!stale()) fail(failure(error));
      },
    );
  }, [citations, failure, language, projectRootRef, readSource, record, stateRef, t]);

  /** Run queued tasks while fewer than the limit are running. */
  const pump = useCallback(() => {
    const run = () => {
      while (activeTasksRef.current < CONCURRENT_REVISIONS && queueRef.current.length) {
        const task = queueRef.current.shift()!;
        activeTasksRef.current += 1;
        void task().finally(() => {
          activeTasksRef.current -= 1;
          run();
        });
      }
    };
    run();
  }, []);

  /** Ask about `ids` in the open round (a new one when none is open). */
  const start = useCallback((ids: readonly string[], extra: (id: string) => { guidance?: string; rejected?: string } = () => ({})) => {
    if (!ids.length || !projectRootRef.current) return;
    const round = joinRound(ids);
    const paths = [...new Set(stateRef.current.annotations.filter((item) => ids.includes(item.id)).map((item) => item.path))];
    const generation = generationRef.current;
    const baseline = keepBaseline(round, paths);
    for (const id of ids) {
      runningRef.current.get(id)?.abort();
      const controller = new AbortController();
      runningRef.current.set(id, controller);
      queueRef.current.push(async () => {
        // The first answer may not land before the baseline holds the text it changes.
        await baseline;
        if (!controller.signal.aborted) await ask(id, round, extra(id));
        if (runningRef.current.get(id) === controller) runningRef.current.delete(id);
        if (generationRef.current !== generation) return;
        updateRunning();
        void settle();
      });
    }
    updateRunning();
    pump();
  }, [ask, joinRound, keepBaseline, projectRootRef, pump, settle, stateRef, updateRunning]);

  /** Ask the agent to revise every open annotation (or `ids`). */
  const revise = useCallback((ids?: readonly string[]) => {
    const running = new Set(runningRef.current.keys());
    const candidates = stateRef.current.annotations.filter((annotation) => revisable(annotation, running)
      && (!ids || ids.includes(annotation.id)));
    start(candidates.map((annotation) => annotation.id));
  }, [start, stateRef]);

  /** Turn down the proposal for `id` and ask again, with what the writer wants instead. */
  const retry = useCallback((id: string, guidance = "") => {
    const annotation = stateRef.current.annotations.find((item) => item.id === id);
    if (!annotation || annotation.resolved) return;
    const rejected = annotation.revision?.state === "proposed" ? annotation.revision.text : undefined;
    start([id], () => ({ guidance: guidance.trim() || undefined, rejected }));
  }, [start, stateRef]);

  /** The writer's answer to the agent's question, then a revision that reads it. */
  const answer = useCallback((id: string, text: string) => {
    const annotation = stateRef.current.annotations.find((item) => item.id === id);
    const revision = annotation?.revision;
    if (!annotation || revision?.state !== "asked" || !text.trim()) return;
    record(id, { ...revision, answer: text.trim() });
    start([id]);
  }, [record, start, stateRef]);

  const accepted = useCallback((id: string, applied: AcceptedRevision) => {
    const annotation = stateRef.current.annotations.find((item) => item.id === id);
    const revision = annotation?.revision;
    if (!annotation || revision?.state !== "proposed") return;
    record(id, { ...revision, state: "accepted" }, { ...applied, resolved: true });
    void settle();
  }, [record, settle, stateRef]);

  const rejected = useCallback((id: string) => {
    const annotation = stateRef.current.annotations.find((item) => item.id === id);
    const revision = annotation?.revision;
    if (!annotation || revision?.state !== "proposed") return;
    record(id, { ...revision, state: "rejected" });
    void settle();
  }, [record, settle, stateRef]);

  /** Open `id`'s proposal in the editor, its card under the passage. */
  const openReview = useCallback((id: string) => {
    const annotation = stateRef.current.annotations.find((item) => item.id === id);
    if (!annotation) return;
    void openProjectFile(annotation.path, { restoreView: false }).then(() => {
      setReview({ id, nonce: crypto.randomUUID() });
    });
  }, [openProjectFile, stateRef]);

  /** The next (or previous) waiting proposal after `id`, wrapping; null when there is none. */
  const neighbour = useCallback((id: string | null, step: 1 | -1) => {
    const proposals = pendingProposals(stateRef.current.annotations);
    if (!proposals.length) return null;
    const index = proposals.findIndex((annotation) => annotation.id === id);
    if (index < 0) return proposals[step === 1 ? 0 : proposals.length - 1]!;
    const next = proposals[(index + step + proposals.length) % proposals.length]!;
    return next.id === id ? null : next;
  }, [stateRef]);

  const closeReview = useCallback(() => setReview(null), []);

  /** Stop every question in flight: the project is closing or changing. */
  const reset = useCallback(() => {
    generationRef.current += 1;
    for (const controller of runningRef.current.values()) controller.abort();
    runningRef.current.clear();
    queueRef.current = [];
    baselinesRef.current.clear();
    setRunning(new Set());
    setReview(null);
  }, []);
  useEffect(() => reset, [reset]);

  /** The conversation's `propose_annotation_edit` and `ask_about_annotation`, recorded in the open round. */
  const toolHost = useMemo((): AnnotationToolHost => ({
    find: (number) => stateRef.current.annotations.find((annotation) => annotation.number === number) ?? null,
    propose: (annotation, text, reason) => {
      const round = joinRound([annotation.id]);
      void keepBaseline(round, [annotation.path]);
      record(annotation.id, { round, state: "proposed", original: annotation.quote, text, reason });
    },
    ask: (annotation, question) => {
      const round = joinRound([annotation.id]);
      record(annotation.id, { round, state: "asked", question });
      void settle();
    },
  }), [joinRound, keepBaseline, record, settle, stateRef]);

  const proposals = useMemo(() => pendingProposals(store.comments), [store.comments]);
  const round = openRound(store.rounds);
  const progress = useMemo(() => {
    if (!round) return null;
    const ids = Object.keys(round.outcomes);
    const answered = store.comments.filter((annotation) => ids.includes(annotation.id) && !running.has(annotation.id)
      && annotation.revision?.round === round.number).length;
    return { round: round.number, total: ids.length, answered, running: ids.filter((id) => running.has(id)).length };
  }, [round, running, store.comments]);

  return {
    running, progress, proposals, review, revise, retry, answer, accepted, rejected,
    openReview, closeReview, neighbour, reset, toolHost,
  };
}

export type AnnotationRounds = ReturnType<typeof useAnnotationRounds>;
export type { AnnotationsState };
