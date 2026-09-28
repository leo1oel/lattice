/**
 * What an editor needs from a Lattice Share session, and the helpers that read
 * other people out of it: who is here (awareness), and where their carets are.
 */
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import type { GrantPermission } from "../../protocol/collab-v2";

/** Origin tag for local Yjs transactions, so observers can tell them apart from remote ones. */
export const COLLAB_LOCAL_ORIGIN = "lattice-local";

/**
 * Replace a shared text's content with `next` as a minimal-span edit (common
 * prefix/suffix preserved) rather than a delete-all + insert-all. Peers'
 * concurrent edits outside the changed span survive the merge, their carets
 * keep their relative anchors, and the wire update stays small. Two clients
 * appending at the same spot (e.g. both adding a JSON array entry) still
 * converge: a single insert op is atomic in Yjs merges, so both chunks land
 * contiguous and the document stays parseable. The transaction is tagged
 * local by default so disk observers do not rewrite a file the caller just wrote.
 */
export function mergeTextIntoYText(ytext: Y.Text, next: string, origin: unknown = COLLAB_LOCAL_ORIGIN): void {
  const current = ytext.toString();
  if (current === next) return;
  let start = 0;
  const limit = Math.min(current.length, next.length);
  while (start < limit && current[start] === next[start]) start += 1;
  let currentEnd = current.length;
  let nextEnd = next.length;
  while (currentEnd > start && nextEnd > start && current[currentEnd - 1] === next[nextEnd - 1]) {
    currentEnd -= 1;
    nextEnd -= 1;
  }
  ytext.doc?.transact(() => {
    if (currentEnd > start) ytext.delete(start, currentEnd - start);
    if (nextEnd > start) ytext.insert(start, next.slice(start, nextEnd));
  }, origin);
}

export type CollabStatus = "disconnected" | "connecting" | "synced" | "error";

export type EditorCollabBinding = {
  doc: Y.Doc;
  provider: { awareness: Awareness };
  ytext: Y.Text;
  undoManager: Y.UndoManager;
};

type StructuredDocument = { doc: Y.Doc; awareness: Awareness | null; canWrite: boolean };

export type EditorCollabSession = EditorCollabBinding & {
  host: string;
  room: string;
  activePath: string;
  setActivePath: (path: string, seedIfEmpty?: string) => Y.Text;
  fileCount: () => number;
  /** Flush pending workspace materialization before ending or switching sessions. */
  flush?: () => Promise<void>;
  /** Wait until every open file client has persisted and sent its pending Yjs updates. */
  settled?: () => Promise<void>;
  destroy: () => void;
  /** Identity for board cursor presence. */
  boardPresenceUser?: { id: string; name: string; color: string };
  /** A sideloaded board keeps its own Y.Doc when it is shown in the other pane. */
  boardDocumentForPath?: (path: string) => StructuredDocument | null;
  /** A sideloaded spreadsheet keeps its structured Y.Doc in its file client. */
  spreadsheetDocumentForPath?: (path: string) => StructuredDocument | null;
  /** Pin and bind the text document displayed in the secondary editor pane. */
  openSecondaryPath?: (path: string) => Promise<EditorCollabBinding | null>;
  /** Release the secondary pane's pin without disturbing the primary binding. */
  releaseSecondaryPath?: (path?: string) => void;
  /** Rebind consumers when the secondary transport replaces its Awareness. */
  subscribeSecondaryBindingChanges?: (listener: () => void) => () => void;
  /** Whether this actor may mutate the active collaborative document. */
  canWrite?: boolean;
  /** Observe live permission loss such as grant revocation. */
  subscribeCanWrite?: (listener: (canWrite: boolean) => void) => () => void;
  /** Bumped when provider.awareness is swapped (file switch / reconnect); watch it to re-bind awareness consumers. */
  awarenessVersion?: number;
};

/** Another person in the room, as the presence UI needs them. */
export type CollabPeer = {
  clientId: number;
  name: string;
  color: string;
  /** The file they are looking at, when they have announced one. */
  path: string | null;
  /** Stable session identity used to merge awareness with project presence. */
  instanceId?: string;
  /** Host-visible authorization grant. Peers sharing one invite share this grant. */
  grantId?: string;
  /**
   * What the coordinator authenticated this peer as. `"host"` marks the person
   * who started the share — the only one who can end it for everyone.
   * Undefined until their presence entry arrives.
   */
  permission?: GrantPermission;
};

/**
 * Awareness states are written by other clients, so treat every field as
 * untrusted: a peer running an older build announces no path, and a malformed
 * state must not take the presence list down.
 */
export function readCollabPeers(states: Map<number, unknown>, selfClientId: number): CollabPeer[] {
  const peers: CollabPeer[] = [];
  for (const [clientId, state] of states) {
    if (clientId === selfClientId) continue;
    const record = (state ?? {}) as { user?: unknown; path?: unknown; instanceId?: unknown };
    const user = (record.user ?? {}) as { name?: unknown; color?: unknown };
    const instanceId = typeof record.instanceId === "string" ? record.instanceId : undefined;
    const announced = typeof user.name === "string" ? user.name.trim() : "";
    // A connection is not a person. Awareness publishes `{}` for its own
    // client the instant it is constructed, and a document opened only to
    // mirror it to disk never announces an identity over that; listing those
    // invented an "Anonymous" collaborator per background document.
    if (!instanceId && !announced) continue;
    peers.push({
      clientId,
      name: announced || "Anonymous",
      color: typeof user.color === "string" && user.color ? user.color : "#8b8b93",
      path: typeof record.path === "string" && record.path.trim() ? record.path.trim() : null,
      ...(instanceId ? { instanceId } : {}),
    });
  }
  // Stable order so avatars do not shuffle on every awareness tick.
  return peers.sort((left, right) => left.clientId - right.clientId);
}

/** Up to two letters standing in for a name in a presence avatar. */
export function peerInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toLocaleUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toLocaleUpperCase();
}

/** Run `callback` on the next animation frame (or shortly, without one); returns a canceller. */
export function scheduleFrame(callback: () => void): () => void {
  if (typeof requestAnimationFrame === "function") {
    const frame = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(frame);
  }
  const timer = setTimeout(callback, 16);
  return () => clearTimeout(timer);
}

/**
 * Where an awareness cursor head points in `ytext`. Awareness carries it as a
 * relative position that survived a JSON round trip, so it is rebuilt
 * explicitly rather than trusted; one from another doc revision fails to resolve.
 */
function cursorIndex(head: unknown, doc: Y.Doc, ytext: Y.Text): number | undefined {
  if (!head) return undefined;
  try {
    const absolute = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(head), doc);
    return absolute?.type === ytext ? absolute.index : undefined;
  } catch {
    return undefined;
  }
}

type CursorState = { cursor?: { head?: unknown } | null; user?: { name?: unknown; color?: unknown }; instanceId?: unknown } | null;

/** Caret offset of every remote peer in the session's currently bound file. */
export function peerCaretOffsetsV2(session: EditorCollabSession): Array<{ clientId: number; name: string; color: string; index: number }> {
  const awareness = session.provider.awareness;
  return [...awareness.getStates()].flatMap(([clientId, state]) => {
    const entry = state as CursorState;
    const index = clientId === awareness.clientID ? undefined : cursorIndex(entry?.cursor?.head, session.doc, session.ytext);
    if (index === undefined) return [];
    return [{
      clientId,
      name: typeof entry?.user?.name === "string" ? entry.user.name : "Anonymous",
      color: typeof entry?.user?.color === "string" ? entry.user.color : "#888888",
      index,
    }];
  });
}

/**
 * Each shared file is its own Y.Doc with its own awareness room, so a peer's
 * caret only resolves when they are in the file we currently have bound —
 * cross-file peers live in the coordinator's presence table instead and fall
 * back to their announced path.
 */
export function peerCursorLocationV2(session: EditorCollabSession, clientId: number): { path: string; line: number } | null {
  const caret = peerCaretOffsetsV2(session).find((peer) => peer.clientId === clientId);
  if (!caret) return null;
  return { path: session.activePath, line: session.ytext.toString().slice(0, caret.index).split("\n").length };
}

/** Wait for a cross-file coordinator peer to appear in the newly opened file's awareness room. */
export function waitForPeerCursorLocationV2(
  session: EditorCollabSession,
  instanceId: string,
  timeoutMs = 1_200,
): Promise<{ path: string; line: number } | null> {
  const awareness = session.provider.awareness;
  const locate = () => {
    for (const [clientId, state] of awareness.getStates()) {
      if ((state as CursorState)?.instanceId === instanceId) return peerCursorLocationV2(session, clientId);
    }
    return null;
  };
  const immediate = locate();
  if (immediate) return Promise.resolve(immediate);
  return new Promise((resolve) => {
    const finish = (location: { path: string; line: number } | null) => {
      clearTimeout(timer);
      awareness.off("change", onChange);
      resolve(location);
    };
    const onChange = () => {
      const location = locate();
      if (location) finish(location);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    awareness.on("change", onChange);
    // Close the gap between the synchronous check and listener registration.
    onChange();
  });
}

type PendingCursorPublication = {
  pendingIndex?: number;
  session: EditorCollabSession;
  awareness: Awareness;
  doc: Y.Doc;
  ytext: Y.Text;
  cancelFrame?: () => void;
};

const pendingCursorPublications = new WeakMap<object, PendingCursorPublication>();

function commitCollabCursor(state: PendingCursorPublication): void {
  state.cancelFrame = undefined;
  const index = state.pendingIndex;
  state.pendingIndex = undefined;
  const { session, awareness, doc, ytext } = state;
  // The session switched files since this was scheduled: the caret belongs to a document it no longer shows.
  if (index === undefined || session.provider.awareness !== awareness || session.doc !== doc || session.ytext !== ytext) return;
  if (awareness.getLocalState() == null) return;
  const bounded = Math.min(Math.max(index, 0), ytext.length);
  if (cursorIndex((awareness.getLocalState() as CursorState)?.cursor?.head, doc, ytext) === bounded) return;
  const position = Y.createRelativePositionFromTypeIndex(ytext, bounded);
  awareness.setLocalStateField("cursor", { anchor: position, head: position });
}

/**
 * Publish a visual editor caret in the same awareness shape as y-codemirror.
 * The first publication goes out at once; rapid moves after it coalesce to
 * the latest position per frame.
 */
export function publishCollabCursorV2(session: EditorCollabSession, index: number): void {
  const awareness = session.provider.awareness;
  if (awareness.getLocalState() == null) return;
  const bounded = Math.min(Math.max(index, 0), session.ytext.length);
  let state = pendingCursorPublications.get(awareness);
  if (!state || state.doc !== session.doc || state.ytext !== session.ytext) {
    state?.cancelFrame?.();
    state = { session, awareness, doc: session.doc, ytext: session.ytext };
    pendingCursorPublications.set(awareness, state);
  }
  state.session = session;
  const published = cursorIndex((awareness.getLocalState() as CursorState)?.cursor?.head, session.doc, session.ytext);
  if (published === undefined && state.cancelFrame === undefined) {
    state.pendingIndex = bounded;
    commitCollabCursor(state);
    return;
  }
  if (bounded === published && state.pendingIndex === undefined) return;
  state.pendingIndex = bounded;
  const scheduled = state;
  state.cancelFrame ??= scheduleFrame(() => commitCollabCursor(scheduled));
}
