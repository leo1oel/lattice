/**
 * Lattice Share project chat: the message list on the chat document, and the
 * hook that wires it onto React state.
 *
 * Messages are plain objects on a Y.Array rather than JSON packed into a
 * Y.Text: an array's inserts merge structurally, so two people typing at once
 * each keep their own message instead of one whole-document rewrite clobbering
 * the other's. There is no server to ask for history or to acknowledge a send:
 * the array *is* the history, kept current by the same provider that syncs the
 * editor text, so a guest who joins mid-conversation sees everything the CRDT
 * already holds without a separate fetch, and sending is just a local
 * transaction that cannot fail the way a network request can.
 */
import { useCallback, useEffect, useState } from "react";
import type * as Y from "yjs";
import { COLLAB_LOCAL_ORIGIN } from "./collab-session";

/**
 * Catalog path of the project-wide chat document. Every file is its own Y.Doc,
 * so chat cannot ride "the session's doc" — peers reading different files would
 * each see a different conversation. It lives on one dedicated catalog file
 * whose "content" Y.Text stays empty; messages ride the chat Y.Array beside it.
 */
export const COLLAB_CHAT_PATH = ".research/collab-chat.json";
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

const chatArray = (doc: Y.Doc) => doc.getArray<CollabChatMessage>("chat");

/** A message ready to send; the id is random so two peers typing at once never collide. */
export function createCollabChatMessage(authorId: string, authorName: string, body: string): CollabChatMessage {
  return { id: crypto.randomUUID(), authorId, authorName: authorName.trim() || "Anonymous", body, at: Date.now() };
}

/**
 * Append a message and trim back to the cap in the same transaction. Two
 * peers can each be over the cap at the same moment — every client only ever
 * deletes from its own front, so the array settles at `<= cap` on both sides
 * without a server arbitrating who trims first.
 */
export function sendCollabChatMessage(doc: Y.Doc, message: CollabChatMessage): void {
  const chat = chatArray(doc);
  doc.transact(() => {
    chat.push([message]);
    const overflow = chat.length - MAX_COLLAB_CHAT_MESSAGES;
    if (overflow > 0) chat.delete(0, overflow);
  }, COLLAB_LOCAL_ORIGIN);
}

/**
 * Every entry was written by some peer's client, so an entry mid-write or from
 * a future build is dropped rather than crash the panel. Sorted by `at` rather
 * than array order: a guest who reconnects after being offline merges in a
 * backlog whose CRDT insertion position does not follow wall-clock order.
 */
export function readCollabChatMessages(doc: Y.Doc): CollabChatMessage[] {
  return chatArray(doc).toArray().flatMap((entry) => {
    const { id, authorId, authorName, body, at } = (entry ?? {}) as Partial<CollabChatMessage>;
    if (typeof id !== "string" || typeof authorId !== "string" || typeof authorName !== "string" || typeof body !== "string") return [];
    return [{ id, authorId, authorName, body, at: typeof at === "number" ? at : 0 }];
  }).sort((left, right) => left.at - right.at);
}

/** Fires on every chat change; callers re-read with `readCollabChatMessages`. */
export function observeCollabChatMessages(doc: Y.Doc, onChange: () => void): () => void {
  const chat = chatArray(doc);
  chat.observe(onChange);
  return () => chat.unobserve(onChange);
}

export type CollabChat = {
  messages: CollabChatMessage[];
  /** Messages from someone else that arrived since the last `markRead`. */
  unread: number;
  send: (body: string) => void;
  /** Call when the chat panel becomes visible, so the badge clears. */
  markRead: () => void;
};

export function useCollabChat(options: {
  doc: Y.Doc | null;
  /** Stable per-device id used to tell "mine" from everyone else's. */
  selfId: string;
  displayName: string;
}): CollabChat {
  const { doc, selfId, displayName } = options;
  const [messages, setMessages] = useState<CollabChatMessage[]>([]);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    if (!doc) {
      // From a microtask rather than the effect body: setting state on the way
      // into an effect cascades renders, and there is nothing to show anyway.
      queueMicrotask(() => {
        setMessages([]);
        setUnread(0);
      });
      return;
    }
    // Ids counted so far. A doc swap re-creates this closure (fresh Set),
    // which is what makes leaving and rejoining a room start the badge over
    // instead of replaying the whole backlog as "new".
    const seen = new Set<string>();
    // The very first read is whatever backlog the CRDT already holds —
    // including for a guest arriving late — and a backlog is not "unread",
    // it is just the conversation so far.
    let first = true;
    const sync = () => {
      const next = readCollabChatMessages(doc);
      setMessages(next);
      // A fresh subscription starts the badge over: leaving and rejoining a
      // room should not replay the whole backlog as unread.
      if (first) setUnread(0);
      for (const message of next) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        if (!first && message.authorId !== selfId) {
          setUnread((count) => count + 1);
        }
      }
      first = false;
    };
    sync();
    return observeCollabChatMessages(doc, sync);
  }, [doc, selfId]);

  const send = useCallback((body: string) => {
    if (!doc) return;
    const trimmed = body.trim();
    if (!trimmed) return;
    sendCollabChatMessage(doc, createCollabChatMessage(selfId, displayName, trimmed));
  }, [doc, selfId, displayName]);

  const markRead = useCallback(() => setUnread(0), []);

  return { messages, unread, send, markRead };
}
