/**
 * The Add papers sheet's batch, kept outside React: it imports a few papers
 * at once and outlives the sheet, so the writer can close it and keep
 * writing while the rest arrive. Only the sheet reads it (through
 * `useSyncExternalStore`), so App holds none of its state.
 *
 * Each import commits on its own as soon as it resolves (the backend merges
 * one commit at a time into the bibliography as it is then), so a paper that
 * fails or is slow never holds back the ones that resolved.
 */
import { hostErrorMessage } from "../app-utils";

/** How many papers import at once: enough to hide each lookup's latency, few enough not to flood the services. */
export const ADDS_AT_ONCE = 4;

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
  /** The title the import found, for a row added before its lookup answered. */
  title?: string;
  /** Added, but the bibliography already held it. */
  alreadyImported?: boolean;
  /** Why it failed, what was added without its full text, or where its annotations went. */
  note?: string;
};

/** What one import answered, as much of it as a row says; `note` says where its annotations went. */
export type PaperAddOutcome = {
  citationKey?: string; title?: string; cancelled?: boolean; alreadyImported?: boolean; fetchError?: string; note?: string;
} | undefined;

/** What a batch is given for each paper. */
export type PaperAddRequest = Pick<PaperAddItem, "id" | "input" | "label" | "pdf" | "annotations" | "existing">;

type ImportOne = (item: Omit<PaperAddRequest, "id">) => Promise<PaperAddOutcome>;

let queue: readonly PaperAddItem[] = [];
/** The ids still to start, in order, and how many imports are under way. */
let pending: string[] = [];
let active = 0;
let cancelled = false;
/** The running batch's importer and project check, kept so a failed row can be retried. */
let batch: { importOne: ImportOne; current: () => boolean; limit: number } | null = null;
/** Resolves the promise `runAddQueue` returned once the pool drains. */
let drained: (() => void) | null = null;
const listeners = new Set<() => void>();

function publish(next: readonly PaperAddItem[]) {
  queue = next;
  for (const listener of listeners) listener();
}

const update = (id: string, change: Partial<PaperAddItem>) =>
  publish(queue.map((item) => (item.id === id ? { ...item, ...change } : item)));

export function subscribeAddQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const getAddQueue = (): readonly PaperAddItem[] => queue;

export const addQueueRunning = (): boolean => active > 0 || pending.length > 0;

/** Stops the batch: papers not yet started are not added; the ones under way stop through their own Cancel. */
export function cancelAddQueue() {
  if (!addQueueRunning()) return;
  cancelled = true;
  for (const id of pending) update(id, { state: "cancelled" });
  pending = [];
  settle();
}

/** Forgets a finished batch; one still running keeps its rows for the next opening. */
export function clearAddQueue() {
  if (addQueueRunning()) return;
  batch = null;
  publish([]);
}

/** Once nothing is waiting or under way, the batch ends; a closed project's rows are dropped. */
function settle() {
  if (addQueueRunning()) return;
  if (batch && !batch.current()) {
    batch = null;
    publish([]);
  } else publish([...queue]);
  const done = drained;
  drained = null;
  done?.();
}

/** Starts waiting papers while there is room. */
function pump() {
  const current = batch;
  if (!current) return;
  // The project it was adding to closed: its rows belong to no open sheet,
  // and left as "waiting" they would read as a batch still running (with
  // a Stop that does nothing) in the next project's sheet. Drop them.
  if (!current.current()) {
    pending = [];
    settle();
    return;
  }
  while (active < current.limit && pending.length && !cancelled) {
    const id = pending.shift()!;
    const item = queue.find((row) => row.id === id);
    if (!item) continue;
    active += 1;
    update(id, { state: "adding", note: undefined });
    void importItem(current, item).finally(() => {
      active -= 1;
      if (batch === current) pump();
      settle();
    });
  }
  settle();
}

async function importItem({ importOne }: NonNullable<typeof batch>, item: PaperAddItem) {
  const { id, input, label, pdf, annotations, existing } = item;
  try {
    const result = await importOne({ input, label, pdf, annotations, existing });
    if (!result || (result.cancelled && !result.citationKey)) update(id, { state: "cancelled" });
    else {
      // The converter's stderr ends with its one meaningful "Error: …" line.
      const failure = result.fetchError?.trim().split("\n").filter((line) => line.trim()).pop()?.replace(/^Error:\s*/, "");
      const note = [failure, result.note].filter(Boolean).join(" · ") || undefined;
      update(id, {
        state: "added", citationKey: result.citationKey, title: result.title || undefined,
        alreadyImported: result.alreadyImported, note,
      });
    }
  } catch (reason) {
    update(id, { state: "failed", note: hostErrorMessage(reason) });
  }
}

/**
 * Imports `items` through `importOne`, `limit` at a time, each committing as
 * it resolves. `current` says whether the project the batch began in is still
 * open; once it is not, the batch stops. Resolves when every paper settled.
 */
export function runAddQueue(
  items: ReadonlyArray<PaperAddRequest>,
  importOne: ImportOne,
  current: () => boolean,
  limit = ADDS_AT_ONCE,
): Promise<void> {
  if (addQueueRunning() || !items.length) return Promise.resolve();
  cancelled = false;
  batch = { importOne, current, limit };
  publish(items.map((item) => ({ ...item, state: "waiting" })));
  pending = items.map((item) => item.id);
  const done = new Promise<void>((resolve) => { drained = resolve; });
  pump();
  return done;
}

/** Tries a failed paper of the batch again, with the importer the batch ran with. */
export function retryAddItem(id: string) {
  const item = queue.find((row) => row.id === id);
  if (!batch || item?.state !== "failed" || pending.includes(id)) return;
  cancelled = false;
  update(id, { state: "waiting", note: undefined });
  pending.push(id);
  pump();
}
