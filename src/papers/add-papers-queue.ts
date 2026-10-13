/**
 * The Add papers sheet's batch, kept outside React: it imports one paper
 * after another and outlives the sheet, so the writer can close it and keep
 * writing while the rest arrive. Only the sheet reads it (through
 * `useSyncExternalStore`), so App holds none of its state.
 */
import { toMessage } from "../app-utils";

/** One paper in the batch, as it moves through the import. */
export type PaperAddItem = {
  id: string;
  /** What the import is given: an identifier, a resolved record's BibTeX, or a pasted entry. */
  input: string;
  /** What the pending row names it by. */
  label: string;
  state: "waiting" | "adding" | "added" | "failed" | "cancelled";
  citationKey?: string;
  /** Why it failed, or what was added without its full text. */
  note?: string;
};

/** What one import answered, as much of it as a row says. */
export type PaperAddOutcome = { citationKey?: string; cancelled?: boolean; fetchError?: string } | undefined;

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
  items: ReadonlyArray<Pick<PaperAddItem, "id" | "input" | "label">>,
  importOne: (item: Pick<PaperAddItem, "input" | "label">) => Promise<PaperAddOutcome>,
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
          const note = result.fetchError?.trim().split("\n").filter((line) => line.trim()).pop()?.replace(/^Error:\s*/, "");
          update(item.id, { state: "added", citationKey: result.citationKey, note });
        }
      } catch (reason) {
        update(item.id, { state: "failed", note: toMessage(reason) });
      }
    }
  } finally {
    running = false;
    publish([...queue]);
  }
}
