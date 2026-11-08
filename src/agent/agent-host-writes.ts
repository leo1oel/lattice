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

type Sink = (message: HostFileWritesMessage) => void;

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
    const writes = [...paths]
      .filter(([, writtenAt]) => writtenAt >= cutoff)
      .map(([path, writtenAt]) => ({ path, writtenAt: new Date(writtenAt).toISOString() }));
    for (let start = 0; start < writes.length; start += MAX_WRITES_PER_MESSAGE) {
      sink({
        type: LATTICE_HOST_FILE_WRITES,
        version: 1,
        workspaceRoot,
        writes: writes.slice(start, start + MAX_WRITES_PER_MESSAGE),
      });
    }
  }
  pending.clear();
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

/** The ready panel frame's postMessage, or null while there is none. */
export function setHostFileWritesSink(next: Sink | null) {
  sink = next;
  if (sink && pending.size) schedule();
  if (!sink && timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}
