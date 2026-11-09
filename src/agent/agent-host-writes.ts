// Project files Lattice writes itself, reported to the agent panel so its
// Undo can tell them from the agent's edits. Synara's turn diff is the whole
// workspace between the turn's start and end snapshots, so a co-author's
// Overleaf edit (synced or streamed) or the writer's own save that lands while
// a turn runs is inside that diff, and undoing the turn would delete it and
// upload the deletion. Synara records each reported path on the turn that was
// running and refuses to undo that file instead. `lattice:host-file-writes`
// (version 1) is that wire contract; the fork's latticeHostWrites.ts parses it.
import { isWorkspaceRelativePath } from "./agent-protocol";

export const LATTICE_HOST_FILE_WRITES = "lattice:host-file-writes";

export type HostFileWritesMessage = {
  type: typeof LATTICE_HOST_FILE_WRITES;
  version: 1;
  workspaceRoot: string;
  writes: Array<{ path: string; writtenAt: string }>;
};

/**
 * Hands a report to the ready panel frame; false when that frame cannot take
 * it (another project's panel), so the writes stay pending for the next one.
 */
type Sink = (message: HostFileWritesMessage) => boolean;

/** Coalesces a burst (a sync's pulls, realtime keystrokes) into one message. */
const FLUSH_DELAY_MS = 250;
/** The panel's server bounds each report; split a large sync across several. */
const MAX_WRITES_PER_MESSAGE = 200;
/**
 * Writes kept while no panel frame is ready (it is reloading or not yet up):
 * a turn may still be running in the sidecar, and its Undo needs to know.
 * Older ones have outlived any turn that could still be capturing them.
 */
const UNSENT_RETENTION_MS = 120_000;

let sink: Sink | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
// Per project root, the latest write time of each path.
const pending = new Map<string, Map<string, number>>();

function flush() {
  timer = null;
  if (!sink) return;
  const cutoff = Date.now() - UNSENT_RETENTION_MS;
  for (const [workspaceRoot, paths] of pending) {
    for (const [path, writtenAt] of paths) if (writtenAt < cutoff) paths.delete(path);
    const writes = [...paths].map(([path, writtenAt]) => ({ path, writtenAt: new Date(writtenAt).toISOString() }));
    let delivered = true;
    for (let start = 0; delivered && start < writes.length; start += MAX_WRITES_PER_MESSAGE) {
      delivered = sink({
        type: LATTICE_HOST_FILE_WRITES,
        version: 1,
        workspaceRoot,
        writes: writes.slice(start, start + MAX_WRITES_PER_MESSAGE),
      });
    }
    // A refused report is kept whole: resending a part the panel already took
    // only refreshes the same paths on its turn.
    if (delivered || !paths.size) pending.delete(workspaceRoot);
  }
}

function schedule() {
  if (sink && timer === null) timer = setTimeout(flush, FLUSH_DELAY_MS);
}

/**
 * Note project-relative files Lattice has just written for the user or a
 * co-author. Never call it for a write made on the agent's behalf (a host
 * tool answering the agent): that edit is the agent's, and reporting it
 * would block undoing it.
 */
export function noteHostFileWrites(workspaceRoot: string | null | undefined, paths: Iterable<string>) {
  if (!workspaceRoot) return;
  const now = Date.now();
  let noted = false;
  for (const path of paths) {
    if (!isWorkspaceRelativePath(path)) continue;
    let root = pending.get(workspaceRoot);
    if (!root) pending.set(workspaceRoot, root = new Map());
    root.set(path, now);
    noted = true;
  }
  if (noted) schedule();
}

/**
 * The ready panel frame's postMessage, or null while there is none: the host
 * clears it the moment the frame starts reloading, so a write noted then waits
 * here for the reloaded panel instead of going to a document that is unloading.
 */
export function setHostFileWritesSink(next: Sink | null) {
  sink = next;
  if (sink && pending.size) schedule();
  if (!sink && timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}
