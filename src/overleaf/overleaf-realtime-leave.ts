/**
 * Hand every live document back before the window leaves its project (#1208).
 *
 * `open_project` points the window at the next project and drops this one's
 * connection, so anything the old project still owes Overleaf has to go
 * first: the typing still in the send debounce, the acknowledgement for it,
 * and the leave that writes each document's OT checkpoint as the merge base.
 * Left for the teardown after the switch, every one of those is refused, the
 * base stays at the last ZIP sync, and a co-author's edit next to ours comes
 * back as conflict markers instead of a clean merge.
 */
import type { RefObject } from "react";
import type { OtDocument } from "./ot";

/** How long a switch waits for Overleaf to acknowledge what was just typed. */
export const LEAVE_WAIT_MS = 5_000;
const POLL_MS = 25;

export async function leaveEveryDocument({ root, documents, leaving, stopDocument, release }: {
  root: RefObject<string | null>;
  documents: RefObject<Map<string, OtDocument>>;
  leaving: RefObject<Map<string, Promise<boolean>>>;
  /** Sends the unsent typing, and releases the open document once it has settled. */
  stopDocument: () => void;
  release: (id: string) => void;
}): Promise<void> {
  const projectRoot = root.current;
  if (!projectRoot) return;
  stopDocument();
  const current = () => root.current === projectRoot;
  // A document draining an operation is released by its acknowledgement. One
  // whose answer never comes keeps its room until the teardown, as before.
  const owed = () => [...documents.current.values()].some((doc) => !doc.settled);
  for (const deadline = Date.now() + LEAVE_WAIT_MS; current() && owed() && Date.now() < deadline;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  if (!current()) return;
  for (const [id, doc] of documents.current) if (doc.settled) release(id);
  await Promise.all(leaving.current.values());
}
