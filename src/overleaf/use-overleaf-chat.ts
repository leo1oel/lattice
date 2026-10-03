/**
 * The project's Overleaf chat, kept current without polling.
 *
 * History comes from Overleaf's REST endpoint the first time the panel is
 * needed; everything after that arrives on the same realtime channel the
 * editor uses, so a message someone types in the browser shows up here as
 * they send it. The unread count is what makes that visible when the panel is
 * closed — a chat you have to open to discover is a chat nobody reads.
 */
import { useCallback, useEffect, useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import type { OverleafMessage, OverleafStatus } from "../app-types";
import { onOverleafEvent } from "./overleaf-realtime-listen";
import { useOverleafProjectSnapshot } from "./use-overleaf-project-snapshot";

const HISTORY_LIMIT = 100;

type ChatSnapshot = {
  messages: OverleafMessage[];
  /** Messages that arrived while the panel was closed. */
  unread: number;
  loading: boolean;
  error: string | null;
};

const NO_CHAT: ChatSnapshot = { messages: [], unread: 0, loading: false, error: null };

export function useOverleafChat(options: { enabled: boolean; projectRoot: string | null }) {
  const { t } = useLingui();
  const { enabled, projectRoot } = options;
  const [{ messages, unread, loading, error }, session] = useOverleafProjectSnapshot(
    enabled ? projectRoot : null,
    NO_CHAT,
  );
  const myEmail = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !projectRoot) return;
    // Which messages are ours decides which side of the panel they sit on, and
    // realtime arrivals carry only an address to compare against.
    void invoke<OverleafStatus>("overleaf_status")
      .then((status) => {
        myEmail.current = status.email;
      })
      .catch(() => {});
    return onOverleafEvent(() => projectRoot, (event) => {
      if (event.type !== "chatMessage") return;
      const { id, content, authorName, authorEmail, timestamp } = event;
      const mine = Boolean(myEmail.current && authorEmail && myEmail.current.toLowerCase() === authorEmail.toLowerCase());
      const message = { id, content, authorName, authorEmail, timestamp, mine };
      session()?.publish((current) => {
        // Overleaf replays recent messages after a reconnect, and a replay is
        // neither a new message nor something to badge as unread.
        if (current.messages.some((item) => item.id === id)) return current;
        return {
          ...current,
          messages: [...current.messages, message],
          unread: mine ? current.unread : current.unread + 1,
        };
      });
    });
  }, [enabled, projectRoot, session]);

  /** Load history; safe to call repeatedly. */
  const refresh = useCallback(async () => {
    const current = session();
    if (!current) return;
    const publishRead = current.read();
    const publish = (update: (snapshot: ChatSnapshot) => Partial<ChatSnapshot>) =>
      publishRead((snapshot) => ({ ...snapshot, ...update(snapshot) }));
    publish(() => ({ loading: true, error: null }));
    try {
      const history = await invoke<OverleafMessage[]>("overleaf_chat_messages", {
        projectRoot: current.projectRoot, limit: HISTORY_LIMIT,
      });
      // Merge rather than replace: a message can land on the channel while
      // this request is in flight, and overwriting the list would drop it.
      publish((snapshot) => {
        const byId = new Map(history.map((item) => [item.id, item]));
        for (const item of snapshot.messages) if (!byId.has(item.id)) byId.set(item.id, item);
        return { messages: [...byId.values()].sort((a, b) => a.timestamp - b.timestamp), loading: false };
      });
    } catch (reason) {
      publish(() => ({ loading: false, error: String(reason) }));
    }
  }, [session]);

  const send = useCallback(async (content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;
    if (!projectRoot) throw new Error(t`Open the linked Overleaf project first.`);
    const current = session();
    current?.publish((snapshot) => ({ ...snapshot, error: null }));
    try {
      // Overleaf echoes the message back over the channel, so there is nothing
      // to append here — doing both would show it twice.
      await invoke("overleaf_send_chat_message", { projectRoot, content: trimmed });
    } catch (reason) {
      current?.publish((snapshot) => ({ ...snapshot, error: String(reason) }));
      throw reason;
    }
  }, [projectRoot, session, t]);

  /** Call when the panel opens, so the badge clears. */
  const markRead = useCallback(() => {
    session()?.publish((snapshot) => (snapshot.unread === 0 ? snapshot : { ...snapshot, unread: 0 }));
  }, [session]);

  return { messages, loading, error, unread, refresh, send, markRead };
}
