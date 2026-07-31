/**
 * The project's Overleaf chat, kept current without polling.
 *
 * History comes from Overleaf's REST endpoint the first time the panel is
 * needed; everything after that arrives on the same realtime channel the
 * editor uses, so a message someone types in the browser shows up here as
 * they send it. The unread count is what makes that visible when the panel is
 * closed — a chat you have to open to discover is a chat nobody reads.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { OverleafMessage, OverleafStatus } from "./app-types";

const HISTORY_LIMIT = 100;

type ChatEvent = {
  type: string;
  id?: string;
  content?: string;
  authorName?: string;
  authorEmail?: string | null;
  timestamp?: number;
};

export type OverleafChat = {
  messages: OverleafMessage[];
  loading: boolean;
  error: string | null;
  /** Messages that arrived while the panel was closed. */
  unread: number;
  /** Load history; safe to call repeatedly. */
  refresh: () => Promise<void>;
  send: (content: string) => Promise<void>;
  /** Call when the panel opens, so the badge clears. */
  markRead: () => void;
};

export function useOverleafChat(options: {
  enabled: boolean;
  projectRoot: string | null;
}): OverleafChat {
  const [messages, setMessages] = useState<OverleafMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const myEmail = useRef<string | null>(null);
  // Ids already shown. Overleaf replays recent messages after a reconnect, and
  // a replay is neither a new message nor something to badge as unread.
  const seen = useRef<Set<string>>(new Set());

  const enabled = options.enabled;
  const projectRoot = options.projectRoot;

  useEffect(() => {
    if (!enabled) {
      setMessages([]);
      setUnread(0);
      setError(null);
      seen.current = new Set();
      return;
    }
    // Which messages are ours decides which side of the panel they sit on, and
    // realtime arrivals carry only an address to compare against.
    void invoke<OverleafStatus>("overleaf_status")
      .then((status) => {
        myEmail.current = status.email;
      })
      .catch(() => {});
  }, [enabled, projectRoot]);

  const refresh = useCallback(async () => {
    if (!enabled || !projectRoot) return;
    setLoading(true);
    setError(null);
    try {
      const history = await invoke<OverleafMessage[]>("overleaf_chat_messages", {
        projectRoot,
        limit: HISTORY_LIMIT,
      });
      // Merge rather than replace: a message can land on the channel while
      // this request is in flight, and overwriting the list would drop it.
      setMessages((current) => {
        const byId = new Map(history.map((item) => [item.id, item]));
        for (const item of current) if (!byId.has(item.id)) byId.set(item.id, item);
        return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp);
      });
      for (const item of history) seen.current.add(item.id);
    } catch (reason) {
      setError(String(reason));
    }
    setLoading(false);
  }, [enabled, projectRoot]);

  const send = useCallback(async (content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    if (!projectRoot) throw new Error("Open the linked Overleaf project first.");
    setError(null);
    try {
      await invoke("overleaf_send_chat_message", { projectRoot, content: trimmed });
      // Overleaf echoes the message back over the channel, so there is nothing
      // to append here — doing both would show it twice.
    } catch (reason) {
      setError(String(reason));
      throw reason;
    }
  }, [projectRoot]);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<ChatEvent>("overleaf-realtime", (event) => {
      const payload = event.payload;
      if (payload.type !== "chatMessage" || !payload.id) return;
      if (seen.current.has(payload.id)) return;
      seen.current.add(payload.id);
      const email = payload.authorEmail ?? null;
      const mine = Boolean(
        myEmail.current && email && myEmail.current.toLowerCase() === email.toLowerCase(),
      );
      const message: OverleafMessage = {
        id: payload.id,
        content: payload.content ?? "",
        authorName: payload.authorName ?? "Someone",
        authorEmail: email,
        timestamp: payload.timestamp ?? 0,
        mine,
      };
      setMessages((current) => [...current, message]);
      if (!mine) setUnread((count) => count + 1);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled, projectRoot]);

  const markRead = useCallback(() => setUnread(0), []);

  return { messages, loading, error, unread, refresh, send, markRead };
}
