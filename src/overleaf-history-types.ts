/**
 * The shape of Overleaf's own project-history REST layer, as the Tauri
 * commands hand it to the frontend. Overleaf is the sole authority on every
 * field here — the origins its own editor and integrations can leave behind,
 * the two shapes a diff can come back in, and the "no operation" convention
 * that lets one file-list endpoint answer both "what changed" and "what does
 * the tree look like." Nothing in this file is inferred or guessed; it is a
 * direct transcription of the verified backend contract.
 */

/** One entry in the paginated `overleaf_history_updates` feed, newest first. */
export type OverleafUpdate = {
  fromVersion: number;
  toVersion: number;
  /** Milliseconds since the epoch — not an ISO string. */
  startTs: number;
  endTs: number;
  /** Display names; accounts Overleaf could not resolve are already dropped. */
  authors: string[];
  /** Files this entry touched. Can be empty even though the entry is real. */
  paths: string[];
  labels: OverleafLabel[];
  /** "upload", "dropbox", "git-bridge", "file-restore", "project-restore", … or null for a normal editor edit. */
  origin: string | null;
};

export type OverleafLabel = {
  id: string;
  comment: string;
  version: number;
  createdAt: string | null;
  author: string | null;
};

export type OverleafUpdatesPage = {
  updates: OverleafUpdate[];
  /** Pass straight back as `before` to fetch the next page; pagination is over
   *  when this is null. It is epoch milliseconds — Overleaf pages this feed by
   *  time, not by version. */
  nextBefore: number | null;
};

/** One run of a per-file diff: unchanged, inserted, or deleted verbatim text. */
export type OverleafDiffChunk = {
  u?: string;
  i?: string;
  d?: string;
  meta?: unknown;
};

/** What `overleaf_history_diff` answers with for a path that is an image or a PDF. */
export type OverleafBinaryDiff = { binary: true };

export type OverleafFileOperation = "added" | "edited" | "removed" | "renamed";

/**
 * One row of `overleaf_history_files`. An entry with no `operation` existed,
 * unchanged, for the entire range asked about — that is what lets the same
 * call double as "what changed between two versions" (keep entries that HAVE
 * an operation) and "the full tree at a version" (pass from === to and keep
 * everything, changed or not).
 */
export type OverleafFileEntry = {
  pathname: string;
  operation?: OverleafFileOperation;
  newPathname?: string;
  /** Set when `operation` is "removed"; the version to pass back to bring the file back. */
  deletedAtV?: number;
  editable?: boolean;
};
