import { msg } from "@lingui/core/macro";
import type { CitationInfo, ReferenceInfo } from "../editor/latex/latex-text";
import { i18n } from "../i18n";
import { dismissAppToastByDedupeKey } from "../telemetry/app-log-store";
import { notifyError, notifyWarning } from "../telemetry/app-notify";

/** A file the citation or label index left out, as `list_citations` and `list_references` name it. */
type SkippedIndexSource =
  | { path: string; reason: "notUtf8" }
  | { path: string; reason: "unreadable"; message: string };

/** `list_citations`: the keys of every readable `.bib`, and the `.bib` files it could not read. */
export type CitationIndex = { citations: CitationInfo[]; skipped: SkippedIndexSource[] };
/** `list_references`: the labels of every readable `.tex`, and the `.tex` files it could not read. */
export type ReferenceIndex = { references: ReferenceInfo[]; skipped: SkippedIndexSource[] };

type IndexPart = "citations" | "references";
type IndexRead =
  | { status: "loading" }
  | { status: "ready"; skipped: SkippedIndexSource[] }
  | { status: "failed"; error: string };

/**
 * Whether the project's citation and label indexes have been read. Until both
 * are, the editor checks no key or label: an index that is still loading, or
 * whose read failed, would flag every `\cite` and cross-file `\ref` as
 * unknown. A failed read says so with a retry, instead of leaving the checks
 * off without a word for the rest of the session.
 */
export type ProjectIndexLoad = Record<IndexPart, IndexRead>;

export type ProjectIndexAction =
  | { type: "reset" }
  | { type: "loaded"; part: IndexPart; skipped: SkippedIndexSource[] }
  | { type: "failed"; part: IndexPart; error: string };

const READY: IndexRead = { status: "ready", skipped: [] };
const LOADING: IndexRead = { status: "loading" };

/** No project open: nothing to wait for. */
export const PROJECT_INDEX_IDLE: ProjectIndexLoad = { citations: READY, references: READY };

export function projectIndexReducer(state: ProjectIndexLoad, action: ProjectIndexAction): ProjectIndexLoad {
  switch (action.type) {
    case "reset":
      return { citations: LOADING, references: LOADING };
    case "loaded":
      return { ...state, [action.part]: { status: "ready", skipped: action.skipped } };
    case "failed":
      // A failed re-read (after a save, say) keeps the index already shown, as
      // a failed paper list keeps the library already shown.
      return state[action.part].status === "ready"
        ? state
        : { ...state, [action.part]: { status: "failed", error: action.error } };
  }
}

export function isProjectIndexPending(state: ProjectIndexLoad): boolean {
  return state.citations.status !== "ready" || state.references.status !== "ready";
}

/** What the writer is told about the index: a failed read, or files it left out. */
export type ProjectIndexNotice =
  | { kind: "failed"; error: string }
  | { kind: "skipped"; files: SkippedIndexSource[] };

export function projectIndexNotice(state: ProjectIndexLoad): ProjectIndexNotice | null {
  const reads = [state.citations, state.references];
  const failed = reads.find((read) => read.status === "failed");
  if (failed) return { kind: "failed", error: failed.error };
  const files = reads.flatMap((read) => (read.status === "ready" ? read.skipped : []));
  // Said once both reads land, so a slow label scan does not show the list twice.
  if (!files.length || reads.some((read) => read.status === "loading")) return null;
  return { kind: "skipped", files };
}

const TOAST_KEY = "project-index";

/** Show `notice` as the one project-index toast, or take that toast down. */
export function announceProjectIndex(notice: ProjectIndexNotice | null, retry: () => void) {
  if (!notice) {
    dismissAppToastByDedupeKey(TOAST_KEY);
    return;
  }
  const source = i18n._(msg`Labels and citations`);
  const retryAction = { label: i18n._(msg`Check again`), onClick: retry };
  if (notice.kind === "failed") {
    const { error } = notice;
    notifyError(source, i18n._(msg`Label and citation checks are off`), {
      detail: i18n._(msg`Lattice could not read the project’s labels and citations: ${error}`),
      primaryAction: retryAction,
      timeoutMs: 0,
      dedupeKey: TOAST_KEY,
    });
    return;
  }
  const notUtf8 = notice.files.filter((file) => file.reason === "notUtf8").map((file) => file.path);
  const unreadable = notice.files.flatMap((file) => (file.reason === "unreadable" ? [`${file.path} (${file.message})`] : []));
  const encoded = notUtf8.join(", ");
  const failed = unreadable.join(", ");
  const detail = [
    encoded ? i18n._(msg`Not UTF-8 text; convert to UTF-8 to include: ${encoded}`) : "",
    failed ? i18n._(msg`Could not be read: ${failed}`) : "",
  ].filter(Boolean).join("\n");
  // A long list is clipped in the toast; Copy carries all of it.
  notifyWarning(source, i18n._(msg`Some files are left out of label and citation checks`), {
    detail,
    copyText: detail,
    primaryAction: retryAction,
    timeoutMs: 0,
    dedupeKey: TOAST_KEY,
  });
}
