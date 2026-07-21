import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import * as Y from "yjs";
import { yCollab } from "y-codemirror.next";
import YProvider from "y-partyserver/provider";
import { builtInCollabHost, isLocalCollabHost } from "./collab-config";
import { peerColorForKey } from "./collab-colors";
import {
  COLLAB_LOCAL_ORIGIN,
  collabBlobsMap,
  collabSyncedFileCount,
  collabTextsMap,
  ensureCollabText,
} from "./collab-project-sync";

export { peerColorForName, peerColorForKey } from "./collab-colors";

/** Must match the Durable Object binding name kebab-cased (LatticeDoc → lattice-doc). */
export const COLLAB_PARTY = "lattice-doc";

export type CollabStatus = "disconnected" | "connecting" | "synced" | "error";

export type CollabSession = {
  host: string;
  room: string;
  doc: Y.Doc;
  provider: YProvider;
  activePath: string;
  ytext: Y.Text;
  undoManager: Y.UndoManager;
  setActivePath: (path: string, seedIfEmpty?: string) => Y.Text;
  fileCount: () => number;
  destroy: () => void;
};

export type CollabInvite = {
  host: string;
  room: string;
};

const HOST_STORAGE_KEY = "lattice.collab.host";
const NAME_STORAGE_KEY = "lattice.collab.name";
const ROOM_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function normalizeCollabHost(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed
    .replace(/^https?:\/\//i, "")
    .replace(/^wss?:\/\//i, "")
    .replace(/\/+$/, "");
}

export function defaultCollabRoom(projectId: string, filePath: string): string {
  const project = (projectId || "project").trim() || "project";
  const file = (filePath || "main.tex").trim().replace(/^\/+/, "") || "main.tex";
  return `${project}/${file}`.replace(/\s+/g, "-");
}

export function createShareRoomCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) code += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
  return `LT-${code}`;
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

export function formatCollabInvite(host: string, room: string): string {
  const normalizedHost = normalizeCollabHost(host) || resolveCollabHost();
  const normalizedRoom = room.trim();
  return `lattice:${normalizedHost}/${normalizedRoom}`;
}

export function formatCollabInviteMessage(host: string, room: string): string {
  const invite = formatCollabInvite(host, room);
  const local = isLocalCollabHost(normalizeCollabHost(host) || resolveCollabHost());
  if (local) {
    return [
      "Join my Lattice project share",
      invite,
      "",
      "Note: this invite uses a local/LAN host, so it only works on the same network.",
      "In Lattice: Live collaboration → Join → paste → Join share (opens a new shared workspace).",
    ].join("\n");
  }
  return [
    "Join my Lattice project share",
    invite,
    "",
    "In Lattice: Live collaboration → Join → paste this invite → Join share.",
    "Joining opens a new Documents/Lattice Shares workspace (your other projects stay untouched).",
    "Sources, figures, papers, comments, and named cursors sync; PDF stays local — rebuild after join.",
  ].join("\n");
}

export function parseCollabInvite(raw: string): CollabInvite | null {
  const text = raw.trim();
  if (!text) return null;

  const lattice = text.match(/lattice:([^\s/]+)\/([^\s]+)/i);
  if (lattice) {
    return {
      host: normalizeCollabHost(lattice[1] ?? ""),
      room: (lattice[2] ?? "").trim(),
    };
  }

  const plain = text.match(/\b(LT-[A-Z0-9]{6,12})\b/i) ?? text.match(/^([A-Za-z0-9._/-]{3,96})$/);
  if (plain?.[1]) {
    return {
      host: resolveCollabHost(),
      room: plain[1].trim(),
    };
  }
  return null;
}

export function saveCollabHost(host: string): void {
  try {
    localStorage.setItem(HOST_STORAGE_KEY, host);
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

/** Seed an empty shared text once after the first sync. */
export function maybeSeedCollabText(ytext: Y.Text, seedText: string): boolean {
  if (ytext.length > 0 || !seedText) return false;
  ytext.insert(0, seedText);
  return true;
}

/** Another person in the room, as the presence UI needs them. */
export type CollabPeer = {
  clientId: number;
  name: string;
  color: string;
  /** The file they are looking at, when they have announced one. */
  path: string | null;
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
    const record = (state ?? {}) as { user?: unknown; path?: unknown };
    const user = (record.user ?? {}) as { name?: unknown; color?: unknown };
    const name = typeof user.name === "string" && user.name.trim() ? user.name.trim() : "Anonymous";
    peers.push({
      clientId,
      name,
      color: typeof user.color === "string" && user.color ? user.color : "#8b8b93",
      path: typeof record.path === "string" && record.path.trim() ? record.path.trim() : null,
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

export function createCollabSession(options: {
  host: string;
  room: string;
  displayName: string;
  activePath: string;
  onStatus: (status: CollabStatus, detail?: string) => void;
  onSynced: (session: CollabSession) => void | Promise<void>;
  onActiveText: (path: string, text: string) => void;
  onPeers?: (peers: CollabPeer[]) => void;
}): CollabSession {
  const host = normalizeCollabHost(options.host);
  const room = options.room.trim();
  if (!host) throw new Error("Collab host is required.");
  if (!room) throw new Error("Collab room is required.");

  const doc = new Y.Doc();
  // Touch shared types so they exist before sync.
  collabTextsMap(doc);
  collabBlobsMap(doc);
  doc.getMap("meta");

  const provider = new YProvider(host, room, doc, {
    connect: true,
    party: COLLAB_PARTY,
  });

  let activePath = options.activePath || "main.tex";
  // Bound to the doc so UndoManager can subscribe (detached Y.Text has doc=null
  // and crashes on `this.doc.on`). Kept out of the shared `texts` map so we do
  // not publish an empty main.tex before the host seeds from disk.
  let ytext = doc.getText("__lattice_pending__");
  let undoManager = new Y.UndoManager(ytext);
  const name = options.displayName.trim() || "Anonymous";
  // Mix in clientID so two "Anonymous" peers never share the same caret color.
  const colors = peerColorForKey(`${name}\0${doc.clientID}`);

  provider.awareness.setLocalStateField("user", {
    name,
    color: colors.color,
    colorLight: colors.colorLight,
  });
  // Which file we are in, so peers can show where everyone is and jump there.
  provider.awareness.setLocalStateField("path", activePath);

  options.onStatus("connecting");

  const pushActiveText = () => {
    options.onActiveText(activePath, ytext.toString());
  };

  let activeObserver: ((event: Y.YTextEvent, transaction: Y.Transaction) => void) | null = null;
  const bindActiveText = (path: string) => {
    if (activeObserver) {
      ytext.unobserve(activeObserver);
      activeObserver = null;
    }
    activePath = path;
    ytext = ensureCollabText(doc, path);
    undoManager.destroy();
    undoManager = new Y.UndoManager(ytext);
    activeObserver = (_event, transaction) => {
      if (transaction.origin === COLLAB_LOCAL_ORIGIN) return;
      pushActiveText();
    };
    ytext.observe(activeObserver);
    return ytext;
  };

  const setActivePath = (path: string, seedIfEmpty?: string) => {
    const next = bindActiveText(path);
    try {
      provider.awareness.setLocalStateField("path", path);
    } catch {
      // Awareness may be torn down mid-switch; presence is not worth failing on.
    }
    if (next.length === 0 && seedIfEmpty) {
      next.doc?.transact(() => {
        next.insert(0, seedIfEmpty);
      }, COLLAB_LOCAL_ORIGIN);
    }
    // Never push an empty placeholder into React — that cleared main.tex on share.
    if (next.length > 0) {
      pushActiveText();
    }
    return next;
  };

  const session: CollabSession = {
    host,
    room,
    doc,
    provider,
    get activePath() {
      return activePath;
    },
    get ytext() {
      return ytext;
    },
    get undoManager() {
      return undoManager;
    },
    setActivePath,
    fileCount: () => collabSyncedFileCount(doc),
    destroy: () => {},
  };

  const onSync = (synced: boolean) => {
    if (!synced) {
      options.onStatus("connecting");
      return;
    }
    options.onStatus("synced");
    void Promise.resolve(options.onSynced(session)).catch((reason) => {
      const detail = reason instanceof Error ? reason.message : String(reason);
      options.onStatus("error", detail);
    });
  };

  const onStatus = (event: { status: string }) => {
    if (event.status === "disconnected") options.onStatus("disconnected");
    if (event.status === "connecting") options.onStatus("connecting");
  };

  const onConnectionError = (event: { error?: Error } | Error) => {
    const detail = event instanceof Error
      ? event.message
      : event.error?.message ?? "Could not connect to collab host.";
    options.onStatus("error", detail);
  };

  const pushPeers = () => {
    // Exclude ourselves — the UI shows the other people in the room.
    options.onPeers?.(readCollabPeers(provider.awareness.getStates(), doc.clientID));
  };

  provider.awareness.on("change", pushPeers);
  provider.on("sync", onSync);
  provider.on("status", onStatus);
  provider.on("connection-error", onConnectionError);
  pushPeers();

  let destroyed = false;
  session.destroy = () => {
    if (destroyed) return;
    destroyed = true;
    if (activeObserver) ytext.unobserve(activeObserver);
    undoManager.clear();
    provider.awareness.off("change", pushPeers);
    provider.off("sync", onSync);
    provider.off("status", onStatus);
    provider.off("connection-error", onConnectionError);
    // Announce departure while still connected so peers drop our caret/name
    // immediately instead of waiting out the ~30s awareness timeout (the "ghost
    // cursors / duplicate names" that linger after leaving or rejoining).
    try {
      provider.awareness.setLocalState(null);
    } catch {
      // Awareness may already be torn down; nothing to clear.
    }
    provider.disconnect();
    provider.destroy();
    doc.destroy();
    options.onStatus("disconnected");
    options.onPeers?.([]);
  };

  return session;
}

export function collabEditorExtensions(session: CollabSession): Extension[] {
  return [
    yCollab(session.ytext, session.provider.awareness, { undoManager: session.undoManager }),
    // Keep native selection visible while y-collab draws remote carets.
    EditorView.theme({
      ".cm-selectionBackground": {
        backgroundColor: "color-mix(in srgb, #3d7af2 38%, transparent) !important",
      },
      "&.cm-focused .cm-selectionBackground": {
        backgroundColor: "color-mix(in srgb, #3d7af2 45%, transparent) !important",
      },
    }),
  ];
}

/**
 * Which file a peer's caret is in and on which line, or null if it cannot be
 * placed.
 *
 * Awareness carries the cursor as a relative position that survived a JSON round
 * trip, so rebuild it explicitly rather than trusting the wire shape.
 */
export function peerCursorLocation(
  session: CollabSession,
  clientId: number,
): { path: string; line: number } | null {
  try {
    const state = session.provider.awareness.getStates().get(clientId) as
      | { cursor?: { head?: unknown } | null }
      | undefined;
    const head = state?.cursor?.head;
    if (!head) return null;
    const relative = Y.createRelativePositionFromJSON(head);
    const absolute = Y.createAbsolutePositionFromRelativePosition(relative, session.doc);
    if (!absolute) return null;
    // Resolve against the whole document tree rather than the file we happen to
    // have bound, so following someone into another file works.
    for (const [path, text] of collabTextsMap(session.doc).entries()) {
      if (text !== absolute.type) continue;
      const before = text.toString().slice(0, absolute.index);
      return { path, line: before.split("\n").length };
    }
    return null;
  } catch {
    return null;
  }
}

export function collabPeerCount(session: CollabSession | null): number {
  if (!session) return 0;
  return Math.max(0, session.provider.awareness.getStates().size - 1);
}

export { COLLAB_LOCAL_ORIGIN };
