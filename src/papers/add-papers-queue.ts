/**
 * The Add papers sheet's batch, kept outside React: it imports one paper
 * after another and outlives the sheet, so the writer can close it and keep
 * writing while the rest arrive. Only the sheet reads it (through
 * `useSyncExternalStore`), so App holds none of its state.
 */
import { hostErrorMessage } from "../app-utils";

/** One paper in the batch, as it moves through the import. */
export type PaperAddItem = {
  id: string;
  /** What the import is given: an identifier, a resolved record's BibTeX, or a pasted entry. */
  input: string;
  /** What the pending row names it by. */
  label: string;
  /** The Zotero attachment whose PDF becomes its text (zotero-browser.tsx). */
  pdf?: string;
  /** The Zotero item whose annotations go to the paper's note, and the data folder the browser read (null: the one Lattice finds). */
  annotations?: { item: string; dataDir: string | null };
  /** The citation key of the paper Papers already holds: only its annotations come in. */
  existing?: string;
  state: "waiting" | "adding" | "added" | "failed" | "cancelled";
  citationKey?: string;
  /** Why it failed, what was added without its full text, or where its annotations went. */
  note?: string;
};

/** What one import answered, as much of it as a row says; `note` says where its annotations went. */
export type PaperAddOutcome = { citationKey?: string; cancelled?: boolean; fetchError?: string; note?: string } | undefined;

/** What a batch is given for each paper. */
export type PaperAddRequest = Pick<PaperAddItem, "id" | "input" | "label" | "pdf" | "annotations" | "existing">;

let queue: readonly PaperAddItem[] = [];
let running = false;
let cancelled = false;
const listeners = new Set<() => void>();

function publish(next: readonly PaperAddItem[]) {
  queue = next;
  for (const listener of listeners) listener();
}

export function subscribeAddQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const getAddQueue = (): readonly PaperAddItem[] => queue;

export const addQueueRunning = (): boolean => running;

/** Stops the batch after the paper being imported; the rest are not added. */
export function cancelAddQueue() {
  if (running) cancelled = true;
}

/** Forgets a finished batch; one still running keeps its rows for the next opening. */
export function clearAddQueue() {
  if (!running) publish([]);
}

/**
 * Imports `items` one at a time through `importOne`, which reports through
 * the pipeline's own progress and Cancel. `current` says whether the project
 * the batch began in is still open; once it is not, the batch stops.
 */
export async function runAddQueue(
  items: ReadonlyArray<PaperAddRequest>,
  importOne: (item: Omit<PaperAddRequest, "id">) => Promise<PaperAddOutcome>,
  current: () => boolean,
) {
  if (running || !items.length) return;
  running = true;
  cancelled = false;
  const update = (id: string, change: Partial<PaperAddItem>) =>
    publish(queue.map((item) => (item.id === id ? { ...item, ...change } : item)));
  publish(items.map((item) => ({ ...item, state: "waiting" })));
  try {
    for (const item of items) {
      // The project it was adding to closed: its rows belong to no open sheet,
      // and left as "waiting" they would read as a batch still running (with
      // a Stop that does nothing) in the next project's sheet. Drop them.
      if (!current()) return;
      if (cancelled) {
        update(item.id, { state: "cancelled" });
        continue;
      }
      update(item.id, { state: "adding" });
      try {
        const result = await importOne(item);
        if (!result || (result.cancelled && !result.citationKey)) update(item.id, { state: "cancelled" });
        else {
          // The converter's stderr ends with its one meaningful "Error: …" line.
          const failure = result.fetchError?.trim().split("\n").filter((line) => line.trim()).pop()?.replace(/^Error:\s*/, "");
          const note = [failure, result.note].filter(Boolean).join(" · ") || undefined;
          update(item.id, { state: "added", citationKey: result.citationKey, note });
        }
      } catch (reason) {
        update(item.id, { state: "failed", note: hostErrorMessage(reason) });
      }
    }
  } finally {
    running = false;
    publish(current() ? [...queue] : []);
  }
}
