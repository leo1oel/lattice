/**
 * Which files of a linked Overleaf project open with margin review beside
 * their source, known before the file is read: the threads' anchors come
 * with the project, for every file, while suggestions only come with the
 * document the live channel has joined, so each file keeps whether it had
 * some when it was last open. A skeleton drawn for the file's source on its
 * way (document-skeleton.tsx) is laid out for review from its first frame,
 * as the editor that replaces it is (margin-review-layout.ts).
 *
 * The layer's own chunk loads as soon as a file has review to show, so it
 * draws with the editor's first frame instead of after it (`lazyChunk`).
 */
import { chunk } from "../lib/lazy-chunk";
import { marginReviewMode } from "./margin-review-mode";

export const loadMarginReviewLayer = chunk(() => import("./overleaf-margin-review"));

const state = {
  /** The linked project the sets belong to. */
  scope: "",
  comments: new Set<string>() as ReadonlySet<string>,
  suggestions: new Set<string>(),
};
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

/** The files `scope` has open threads anchored in; another scope forgets the last one's suggestions. */
export function publishMarginReviewComments(scope: string, paths: Iterable<string>): void {
  const next = new Set(paths);
  const sameScope = scope === state.scope;
  if (sameScope && next.size === state.comments.size && [...next].every((path) => state.comments.has(path))) return;
  if (!sameScope) state.suggestions = new Set();
  Object.assign(state, { scope, comments: next });
  if (next.size && marginReviewMode() !== "off") void loadMarginReviewLayer().catch(() => undefined);
  notify();
}

/** Whether the live document at `path` has suggestions, as it was last seen. */
export function rememberSuggestions(path: string, has: boolean): void {
  if (state.suggestions.has(path) === has) return;
  if (has) state.suggestions.add(path);
  else state.suggestions.delete(path);
  notify();
}

/** `path` had suggestions when the live channel last carried it. */
export const hadSuggestions = (path: string) => state.suggestions.has(path);

/** Whether `path` opens with margin review beside its source (the window's switch aside). */
export const marginReviewFile = (path: string) => state.comments.has(path) || state.suggestions.has(path);

export function subscribeMarginReviewFiles(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
