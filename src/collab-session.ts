import * as Y from "yjs";
import { builtInCollabHost, isLocalCollabHost } from "./collab-config";

export { peerColorForName, peerColorForKey } from "./collab-colors";

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
 * local so disk observers do not rewrite a file the caller just wrote.
 */
export function mergeTextIntoYText(ytext: Y.Text, next: string): void {
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
  }, COLLAB_LOCAL_ORIGIN);
}

export type CollabStatus = "disconnected" | "connecting" | "synced" | "error";

export type EditorCollabSession = {
  host: string;
  room: string;
  doc: Y.Doc;
  provider: { awareness: import("y-protocols/awareness").Awareness };
  activePath: string;
  ytext: Y.Text;
  undoManager: Y.UndoManager;
  setActivePath: (path: string, seedIfEmpty?: string) => Y.Text;
  fileCount: () => number;
  /** Flush pending workspace materialization before ending or switching sessions. */
  flush?: () => Promise<void>;
  destroy: () => void;
  /** Identity for board cursor presence. */
  boardPresenceUser?: { id: string; name: string; color: string };
  /** Whether this actor may mutate the active collaborative document. */
  canWrite?: boolean;
  /** Observe live permission loss such as grant revocation. */
  subscribeCanWrite?: (listener: (canWrite: boolean) => void) => () => void;
  /** Bumped when provider.awareness is swapped (file switch / reconnect); watch it to re-bind awareness consumers. */
  awarenessVersion?: number;
};

// v2: the old key persisted the built-in host, which pinned users to whatever
// it was that day and blocked later built-in changes (e.g. the sync-host move)
// from reaching them. Bumping the key retires those stale values; we now only
// store a genuine custom override.
const HOST_STORAGE_KEY = "lattice.collab.host.v2";
const NAME_STORAGE_KEY = "lattice.collab.name";

export function normalizeCollabHost(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed
    .replace(/^https?:\/\//i, "")
    .replace(/^wss?:\/\//i, "")
    .replace(/\/+$/, "");
}

export function resolveCollabHost(preferred?: string): string {
  const explicit = normalizeCollabHost(preferred ?? "");
  if (explicit) return explicit;
  const builtIn = builtInCollabHost();
  let stored = "";
  try {
    stored = normalizeCollabHost(localStorage.getItem(HOST_STORAGE_KEY) ?? "");
  } catch {
    // Ignore.
  }
  if (stored && !(builtIn && isLocalCollabHost(stored) && !isLocalCollabHost(builtIn))) {
    return stored;
  }
  if (builtIn) return builtIn;
  return stored || "localhost:8787";
}

export function loadCollabHost(): string {
  return resolveCollabHost();
}

export function saveCollabHost(host: string): void {
  try {
    const normalized = normalizeCollabHost(host);
    // Only persist a genuine custom override. Storing the built-in host would
    // pin the user to today's value, so a later change to the built-in (e.g. a
    // new sync host) could never reach them — exactly the bug v2 retires.
    if (!normalized || normalized === builtInCollabHost()) {
      localStorage.removeItem(HOST_STORAGE_KEY);
    } else {
      localStorage.setItem(HOST_STORAGE_KEY, normalized);
    }
  } catch {
    // Ignore.
  }
}

export function loadCollabDisplayName(): string {
  try {
    return localStorage.getItem(NAME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveCollabDisplayName(name: string): void {
  try {
    localStorage.setItem(NAME_STORAGE_KEY, name);
  } catch {
    // Ignore.
  }
}

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
};

/**
 * Awareness states are written by other clients, so treat every field as
 * untrusted: a peer running an older build announces no path, and a malformed
 * state must not take the presence list down.
 */
export function readCollabPeers(
  states: Map<number, unknown>,
  selfClientId: number,
): CollabPeer[] {
  const peers: CollabPeer[] = [];
  for (const [clientId, state] of states) {
    if (clientId === selfClientId) continue;
    const record = (state ?? {}) as { user?: unknown; path?: unknown; instanceId?: unknown };
    const user = (record.user ?? {}) as { name?: unknown; color?: unknown };
    const name = typeof user.name === "string" && user.name.trim() ? user.name.trim() : "Anonymous";
    peers.push({
      clientId,
      name,
      color: typeof user.color === "string" && user.color ? user.color : "#8b8b93",
      path: typeof record.path === "string" && record.path.trim() ? record.path.trim() : null,
      ...(typeof record.instanceId === "string" ? { instanceId: record.instanceId } : {}),
    });
  }
  // Stable order so avatars do not shuffle on every awareness tick.
  peers.sort((left, right) => left.clientId - right.clientId);
  return peers;
}

/** Up to two letters standing in for a name in a presence avatar. */
export function peerInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toLocaleUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toLocaleUpperCase();
}

/**
 * Each shared file is its own Y.Doc with its own awareness room, so a peer's
 * caret only resolves when they are in the file we currently have bound —
 * cross-file peers live in the coordinator's presence table instead and fall
 * back to their announced path.
 */
export function peerCursorLocationV2(
  session: EditorCollabSession,
  clientId: number,
): { path: string; line: number } | null {
  const caret = peerCaretOffsetsV2(session).find((peer) => peer.clientId === clientId);
  if (!caret) return null;
  const before = session.ytext.toString().slice(0, caret.index);
  return { path: session.activePath, line: before.split("\n").length };
}

function peerCursorLocationByInstanceV2(
  session: EditorCollabSession,
  instanceId: string,
): { path: string; line: number } | null {
  const awareness = session.provider.awareness;
  for (const [clientId, state] of awareness.getStates()) {
    if ((state as { instanceId?: unknown } | null)?.instanceId !== instanceId) continue;
    return peerCursorLocationV2(session, clientId);
  }
  return null;
}

/** Wait for a cross-file coordinator peer to appear in the newly opened file's awareness room. */
export function waitForPeerCursorLocationV2(
  session: EditorCollabSession,
  instanceId: string,
  timeoutMs = 1_200,
): Promise<{ path: string; line: number } | null> {
  const immediate = peerCursorLocationByInstanceV2(session, instanceId);
  if (immediate) return Promise.resolve(immediate);
  const awareness = session.provider.awareness;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (location: { path: string; line: number } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      awareness.off("change", onChange);
      resolve(location);
    };
    const onChange = () => {
      const location = peerCursorLocationByInstanceV2(session, instanceId);
      if (location) finish(location);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    awareness.on("change", onChange);
    // Close the gap between the synchronous check and listener registration.
    onChange();
  });
}

type PendingCursorPublicationV2 = {
  pendingIndex?: number;
  session: EditorCollabSession;
  awareness: EditorCollabSession["provider"]["awareness"];
  doc: Y.Doc;
  ytext: Y.Text;
  cancelFrame?: () => void;
};

const pendingCursorPublicationsV2 = new WeakMap<object, PendingCursorPublicationV2>();

function scheduleCollabFrameV2(callback: () => void): () => void {
  if (typeof requestAnimationFrame === "function") {
    const frame = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(frame);
  }
  const timer = setTimeout(callback, 16);
  return () => clearTimeout(timer);
}

function commitCollabCursorV2(state: PendingCursorPublicationV2): void {
  state.cancelFrame = undefined;
  const index = state.pendingIndex;
  state.pendingIndex = undefined;
  if (index === undefined) return;
  if (
    state.session.provider.awareness !== state.awareness
    || state.session.doc !== state.doc
    || state.session.ytext !== state.ytext
  ) return;
  if (state.awareness.getLocalState() == null) return;
  const boundedIndex = Math.min(Math.max(index, 0), state.ytext.length);
  if (localCollabCursorIndexV2(state.awareness, state.doc, state.ytext) === boundedIndex) return;
  const position = Y.createRelativePositionFromTypeIndex(state.ytext, boundedIndex);
  state.awareness.setLocalStateField("cursor", { anchor: position, head: position });
}

function localCollabCursorIndexV2(
  awareness: EditorCollabSession["provider"]["awareness"],
  doc: Y.Doc,
  ytext: Y.Text,
): number | undefined {
  const head = (awareness.getLocalState() as { cursor?: { head?: unknown } } | null)?.cursor?.head;
  if (!head) return undefined;
  try {
    const absolute = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(head),
      doc,
    );
    return absolute?.type === ytext ? absolute.index : undefined;
  } catch {
    return undefined;
  }
}

/** Publish a visual editor caret in the same awareness shape as y-codemirror. */
export function publishCollabCursorV2(session: EditorCollabSession, index: number): void {
  const awareness = session.provider.awareness;
  if (awareness.getLocalState() == null) return;
  const boundedIndex = Math.min(Math.max(index, 0), session.ytext.length);
  let state = pendingCursorPublicationsV2.get(awareness);
  if (!state || state.doc !== session.doc || state.ytext !== session.ytext) {
    state?.cancelFrame?.();
    state = { session, awareness, doc: session.doc, ytext: session.ytext };
    pendingCursorPublicationsV2.set(awareness, state);
  }
  state.session = session;
  const publishedIndex = localCollabCursorIndexV2(awareness, session.doc, session.ytext);
  if (publishedIndex === undefined && state.cancelFrame === undefined) {
    state.pendingIndex = boundedIndex;
    commitCollabCursorV2(state);
    return;
  }
  if (boundedIndex === publishedIndex && state.pendingIndex === undefined) return;
  state.pendingIndex = boundedIndex;
  state.cancelFrame ??= scheduleCollabFrameV2(() => commitCollabCursorV2(state!));
}

/**
 * Caret offset of every remote peer in the session's currently bound file
 * (v2). Awareness carries the cursor as a relative position that survived a
 * JSON round trip, so rebuild it explicitly rather than trusting the wire
 * shape; carets that fail to resolve against the live doc are skipped.
 */
export function peerCaretOffsetsV2(
  session: EditorCollabSession,
): Array<{ clientId: number; name: string; color: string; index: number }> {
  const awareness = session.provider.awareness;
  const carets: Array<{ clientId: number; name: string; color: string; index: number }> = [];
  for (const [clientId, state] of awareness.getStates()) {
    if (clientId === awareness.clientID) continue;
    const entry = state as { cursor?: { head?: unknown } | null; user?: { name?: unknown; color?: unknown } } | null;
    const head = entry?.cursor?.head;
    if (!head) continue;
    try {
      const absolute = Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(head),
        session.doc,
      );
      if (!absolute || absolute.type !== session.ytext) continue;
      carets.push({
        clientId,
        name: typeof entry?.user?.name === "string" ? entry.user.name : "Anonymous",
        color: typeof entry?.user?.color === "string" ? entry.user.color : "#888888",
        index: absolute.index,
      });
    } catch { /* A caret from another doc revision fails to resolve — skip it. */ }
  }
  return carets;
}

// ---------------------------------------------------------------------------
// Project chat
//
// Overleaf gives collaborators who stayed in the browser a chat panel; a
// Lattice Share session only had editor comments anchored to text, so a plain
// "give me five minutes" had nowhere to go. Messages are plain objects on a
// Y.Array rather than JSON packed into a Y.Text (the way editor comments are):
// an array's inserts merge structurally, so two people typing at once each
// keep their own message instead of one whole-document rewrite clobbering the
// other's. That also means a guest who joins mid-conversation just receives
// the array as part of the normal doc sync — there is no separate history
// fetch, and nothing to do for the "arrived late" case beyond reading it.
// ---------------------------------------------------------------------------

const COLLAB_CHAT_KEY = "chat";
/** Keeps a long-running share's doc from growing without bound. */
export const MAX_COLLAB_CHAT_MESSAGES = 500;

export type CollabChatMessage = {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  /** Milliseconds since the epoch, the sender's clock. */
  at: number;
};

function collabChatArray(doc: Y.Doc): Y.Array<CollabChatMessage> {
  return doc.getArray<CollabChatMessage>(COLLAB_CHAT_KEY);
}

/** A message ready to send; the id is random so two peers typing at once never collide. */
export function createCollabChatMessage(authorId: string, authorName: string, body: string): CollabChatMessage {
  return {
    id: crypto.randomUUID(),
    authorId,
    authorName: authorName.trim() || "Anonymous",
    body,
    at: Date.now(),
  };
}

/**
 * Append a message and trim back to the cap in the same transaction. Two
 * peers can each be over the cap at the same moment — every client only ever
 * deletes from its own front, so the array settles at `<= cap` on both sides
 * without a server arbitrating who trims first.
 */
export function sendCollabChatMessage(
  doc: Y.Doc,
  message: CollabChatMessage,
  origin = COLLAB_LOCAL_ORIGIN,
): void {
  const chat = collabChatArray(doc);
  doc.transact(() => {
    chat.push([message]);
    const overflow = chat.length - MAX_COLLAB_CHAT_MESSAGES;
    if (overflow > 0) chat.delete(0, overflow);
  }, origin);
}

/**
 * Every entry was written by some peer's client, so — like `readCollabPeers`
 * treats awareness state — treat each one as untrusted: an entry mid-write or
 * from a future build must be dropped rather than crash the panel. Sorted by
 * `at` rather than array order: a guest who reconnects after being offline
 * merges in a backlog whose CRDT insertion position does not follow wall-
 * clock order.
 */
export function readCollabChatMessages(doc: Y.Doc): CollabChatMessage[] {
  const out: CollabChatMessage[] = [];
  for (const entry of collabChatArray(doc).toArray()) {
    const record = (entry ?? {}) as Partial<CollabChatMessage>;
    if (
      typeof record.id !== "string"
      || typeof record.authorId !== "string"
      || typeof record.authorName !== "string"
      || typeof record.body !== "string"
    ) continue;
    out.push({
      id: record.id,
      authorId: record.authorId,
      authorName: record.authorName,
      body: record.body,
      at: typeof record.at === "number" ? record.at : 0,
    });
  }
  out.sort((left, right) => left.at - right.at);
  return out;
}

/** Fires on every chat change; callers re-read with `readCollabChatMessages`. */
export function observeCollabChatMessages(doc: Y.Doc, onChange: () => void): () => void {
  const chat = collabChatArray(doc);
  chat.observe(onChange);
  return () => chat.unobserve(onChange);
}
