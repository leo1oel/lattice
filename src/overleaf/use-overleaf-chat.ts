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
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import type { OverleafMessage, OverleafStatus } from "../app-types";
import { onOverleafEvent } from "./overleaf-realtime-listen";

const HISTORY_LIMIT = 100;

type ChatEvent = {
  type: string;
  id?: string;
  content?: string;
  authorName?: string;
  authorEmail?: string | null;
  timestamp?: number;
};

export type OverleafChat = ReturnType<typeof useOverleafChat>;

export function useOverleafChat(options: { enabled: boolean; projectRoot: string | null }) {
  const { t } = useLingui();
  const [messages, setMessages] = useState<OverleafMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Messages that arrived while the panel was closed. */
  const [unread, setUnread] = useState(0);
  const myEmail = useRef<string | null>(null);
  // Ids already shown. Overleaf replays recent messages after a reconnect, and
  // a replay is neither a new message nor something to badge as unread.
  const seen = useRef<Set<string>>(new Set());
  const { enabled, projectRoot } = options;

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
    return onOverleafEvent<ChatEvent>((payload) => {
      if (payload.type !== "chatMessage" || !payload.id || seen.current.has(payload.id)) return;
      seen.current.add(payload.id);
      const email = payload.authorEmail ?? null;
      const mine = Boolean(myEmail.current && email && myEmail.current.toLowerCase() === email.toLowerCase());
      setMessages((current) => [...current, {
        id: payload.id!,
        content: payload.content ?? "",
        authorName: payload.authorName ?? t`Someone`,
        authorEmail: email,
        timestamp: payload.timestamp ?? 0,
        mine,
      }]);
      if (!mine) setUnread((count) => count + 1);
    });
  }, [enabled, projectRoot, t]);

  /** Load history; safe to call repeatedly. */
  const refresh = useCallback(async () => {
    if (!enabled || !projectRoot) return;
    setLoading(true);
    setError(null);
    try {
      const history = await invoke<OverleafMessage[]>("overleaf_chat_messages", { projectRoot, limit: HISTORY_LIMIT });
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
    if (!projectRoot) throw new Error(t`Open the linked Overleaf project first.`);
    setError(null);
    try {
      // Overleaf echoes the message back over the channel, so there is nothing
      // to append here — doing both would show it twice.
      await invoke("overleaf_send_chat_message", { projectRoot, content: trimmed });
    } catch (reason) {
      setError(String(reason));
      throw reason;
    }
  }, [projectRoot, t]);

  /** Call when the panel opens, so the badge clears. */
  const markRead = useCallback(() => setUnread(0), []);

  return { messages, loading, error, unread, refresh, send, markRead };
}
