/**
 * Wires a Lattice Share session's chat onto React state.
 *
 * There is no server to ask for history or to acknowledge a send: the Y.Array
 * on the session's doc *is* the history, kept current by the same provider
 * that syncs the editor text, so a guest who joins mid-conversation sees
 * everything the CRDT already holds without a separate fetch. Sending is just
 * a local transaction — there is nothing to await and nothing that can fail
 * the way a network request can.
 */
import { useCallback, useEffect, useState } from "react";
import type { Doc } from "yjs";
import {
  createCollabChatMessage,
  observeCollabChatMessages,
  readCollabChatMessages,
  sendCollabChatMessage,
  type CollabChatMessage,
} from "./collab-session";

export type CollabChat = {
  messages: CollabChatMessage[];
  /** Messages from someone else that arrived since the last `markRead`. */
  unread: number;
  send: (body: string) => void;
  /** Call when the chat panel becomes visible, so the badge clears. */
  markRead: () => void;
};

export function useCollabChat(options: {
  doc: Doc | null;
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
