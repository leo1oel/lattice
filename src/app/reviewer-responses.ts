import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { toMessage } from "../app-utils";
import { resolveCommentAnchor, type EditorComment } from "../editor/comments/editor-comment-data";
import {
  EMPTY_RESPONSES,
  addComments,
  parseResponses,
  updateComment,
  type LinkPlace,
  type NewReviewerComments,
  type ReviewerCommentChange,
  type ReviewerResponses,
} from "../project/reviewer-responses";
import { i18n } from "../i18n";
import { notifyInfo } from "../telemetry/app-notify";
import { annotationRounds, revisable } from "./annotation-rounds";
import type { EditorComments } from "./use-editor-comments";

type Ref<T> = { readonly current: T };

/** What the responses read and do in the app, attached by App once it has them. */
export type ReviewerResponsesDeps = {
  store: Pick<EditorComments, "stateRef" | "openComment">;
  projectRootRef: Ref<string | null>;
};

export type ReviewerResponsesSnapshot = {
  /** Whether the project's responses have been read yet. */
  loaded: boolean;
  /**
   * Whether the file is there but could not be read or is not one this
   * version reads; nothing is changed or saved over it until a later read
   * succeeds.
   */
  unreadable: boolean;
  responses: ReviewerResponses;
};

const EMPTY: ReviewerResponsesSnapshot = { loaded: false, unreadable: false, responses: EMPTY_RESPONSES };
/** Typing in a reply saves once it pauses, not on every key. */
const SAVE_DELAY_MS = 400;

/**
 * The project's answers to its reviewers (`project/reviewer-responses.ts`),
 * kept in `.research/responses.json`. Each change is on screen at once and
 * on disk shortly after; a project change writes what is pending to the
 * project it belongs to before forgetting it.
 *
 * A plain object rather than a hook (one per window, `reviewerResponses`
 * below), like the paper review: only the panel subscribes, once it is on
 * screen.
 */
export class ReviewerResponsesStore {
  private deps: ReviewerResponsesDeps | null = null;
  private snapshot: ReviewerResponsesSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  /** Bumped by `reset`, so a read for an earlier project drops its answer. */
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The project the pending save is for, fixed when the change was made. */
  private pendingRoot: string | null = null;
  /** The last save in line: each waits for the one before, so the newest lands last. */
  private saving: Promise<void> = Promise.resolve();

  attach(deps: ReviewerResponsesDeps) {
    this.deps = deps;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = () => this.snapshot;

  private publish(change: Partial<ReviewerResponsesSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of [...this.listeners]) listener();
  }

  /** Read the project's responses, once per project, or again while the file is unreadable. */
  load = async () => {
    if (this.snapshot.loaded && !this.snapshot.unreadable) return;
    const generation = this.generation;
    const before = this.snapshot;
    const responses = await invoke<unknown>("read_reviewer_responses").then(
      (stored) => (stored == null ? EMPTY_RESPONSES : parseResponses(stored)),
      () => null,
    );
    if (generation !== this.generation || this.snapshot !== before) return;
    this.publish(responses ? { loaded: true, unreadable: false, responses } : { loaded: true, unreadable: true, responses: EMPTY_RESPONSES });
  };

  /** Write what is pending now, to the project it was made in; settles once every save in line has. */
  flush = (): Promise<void> => {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const projectRoot = this.pendingRoot;
    this.pendingRoot = null;
    if (!projectRoot) return this.saving;
    const responses = this.snapshot.responses;
    this.saving = this.saving
      .then(() => invoke("save_reviewer_responses", { projectRoot, responses }))
      .then(() => {}, (reason: unknown) => {
        notifyInfo(i18n._(msg`Responses`), i18n._(msg`The responses could not be saved: ${toMessage(reason)}`), {
          dedupeKey: "reviewer-responses-save",
        });
      });
    return this.saving;
  };

  /**
   * Stop and forget everything: the project is closing or changing. The
   * switch flushes before the backend lets go of the outgoing project; this
   * flush only catches a change made after it.
   */
  reset = () => {
    void this.flush();
    this.generation += 1;
    this.snapshot = EMPTY;
    for (const listener of [...this.listeners]) listener();
  };

  private change(next: ReviewerResponses) {
    const projectRoot = this.deps?.projectRootRef.current;
    if (!projectRoot || !this.snapshot.loaded || this.snapshot.unreadable) return;
    // A change for another project than the one pending writes that one first.
    if (this.pendingRoot && this.pendingRoot !== projectRoot) this.flush();
    this.publish({ responses: next });
    this.pendingRoot = projectRoot;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(this.flush, SAVE_DELAY_MS);
  }

  add = (groups: readonly NewReviewerComments[]) => {
    this.change(addComments(this.snapshot.responses, groups));
  };

  update = (id: string, change: ReviewerCommentChange) => {
    this.change(updateComment(this.snapshot.responses, id, change));
  };

  link = (id: string, annotationId: string) => {
    const comment = this.snapshot.responses.comments.find((item) => item.id === id);
    if (!comment || comment.annotationIds.includes(annotationId)) return;
    this.update(id, { annotationIds: [...comment.annotationIds, annotationId] });
  };

  unlink = (id: string, annotationId: string) => {
    const comment = this.snapshot.responses.comments.find((item) => item.id === id);
    if (comment) this.update(id, { annotationIds: comment.annotationIds.filter((item) => item !== annotationId) });
  };

  /** Remove a comment, with the toast's Undo to bring it back; its number is not given again either way. */
  remove = (id: string) => {
    const before = this.snapshot.responses;
    const index = before.comments.findIndex((item) => item.id === id);
    if (index < 0) return;
    const removed = before.comments[index];
    this.change({ ...before, comments: before.comments.filter((item) => item.id !== id) });
    const generation = this.generation;
    notifyInfo(i18n._(msg`Responses`), i18n._(msg`Comment removed`), {
      dedupeKey: `reviewer-responses-removed:${id}`,
      primaryAction: {
        label: i18n._(msg`Undo`),
        onClick: () => {
          const current = this.snapshot.responses;
          if (generation !== this.generation || current.comments.some((item) => item.id === id)) return;
          const comments = [...current.comments];
          comments.splice(Math.min(index, comments.length), 0, removed);
          this.change({ ...current, comments });
        },
      },
    });
  };

  /** Open a linked annotation in the Annotations panel. */
  openAnnotation = (annotationId: string) => {
    const annotation = this.deps?.store.stateRef.current.annotations.find((item) => item.id === annotationId);
    if (annotation) this.deps?.store.openComment(annotation);
  };

  /** The linked annotations a revision round can ask about now, among `annotations`. */
  revisableIds = (
    annotations: readonly EditorComment[],
    running: ReadonlySet<string> = annotationRounds.getSnapshot().running,
  ): string[] => {
    const linked = new Set(this.snapshot.responses.comments.flatMap((comment) => comment.change === "todo" ? comment.annotationIds : []));
    if (!linked.size) return [];
    return annotations
      .filter((annotation) => linked.has(annotation.id) && revisable(annotation, running))
      .map((annotation) => annotation.id);
  };

  /** Hand the linked annotations of comments still to change to a revision round. */
  revise = (annotations: readonly EditorComment[]) => {
    const ids = this.revisableIds(annotations);
    if (ids.length) annotationRounds.revise(ids);
  };
}

/**
 * Where each linked annotation's passage is now, by annotation id: read from
 * the open buffer or the file, so a passage rewritten since it was linked
 * reads as moved rather than pointing at whatever took its place. An id no
 * annotation has any more is missing, even when a newer annotation took the
 * deleted one's pin number.
 */
export async function placeAnnotations(
  ids: readonly string[],
  annotations: readonly EditorComment[],
  readSource: (path: string) => Promise<string | null> = annotationRounds.readSource,
): Promise<Map<string, LinkPlace>> {
  const places = new Map<string, LinkPlace>();
  const sources = new Map<string, Promise<string | null>>();
  await Promise.all([...new Set(ids)].map(async (id) => {
    const annotation = annotations.find((item) => item.id === id);
    if (!annotation) {
      places.set(id, { state: "missing" });
      return;
    }
    if (!sources.has(annotation.path)) sources.set(annotation.path, readSource(annotation.path));
    const source = await sources.get(annotation.path);
    const range = source == null ? null : resolveCommentAnchor(source, annotation);
    places.set(id, range && source != null
      ? { state: "placed", path: annotation.path, line: source.slice(0, range.from).split("\n").length, quote: annotation.quote }
      : { state: "moved", path: annotation.path, quote: annotation.quote });
  }));
  return places;
}

/** The window's reviewer responses, for its one project at a time. */
export const reviewerResponses = new ReviewerResponsesStore();
