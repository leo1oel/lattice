/**
 * Overleaf's comment threads, kept in step with the browser.
 *
 * The conversation lives behind a REST endpoint; the spans the conversations
 * are attached to arrive with the document on the realtime channel. Anything
 * that changes a thread — a reply, a resolve, a delete, from anyone — comes
 * down that same channel, and this re-reads the threads when it does.
 *
 * Re-reading rather than replaying each event is deliberate. Overleaf spreads
 * thread state across six socket events, and a panel that rebuilds state from
 * partial events is a panel that eventually disagrees with the browser.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { OverleafThread } from "./app-types";

/** How long to wait before re-reading, so a burst costs one request. */
const REFRESH_DEBOUNCE_MS = 400;

export type OverleafComments = {
  threads: OverleafThread[];
  loading: boolean;
  error: string | null;
  /** Unresolved threads anchored in the open document. */
  openCount: number;
  refresh: () => Promise<void>;
  reply: (threadId: string, content: string) => Promise<void>;
  /**
   * Start a thread on a span of the open document. Overleaf keeps the two
   * halves apart — the conversation behind REST, the anchor on the editing
   * channel — so this does both and answers with the thread's id.
   */
  create: (position: number, quote: string, content: string) => Promise<string>;
  setResolved: (threadId: string, resolved: boolean) => Promise<void>;
  remove: (threadId: string) => Promise<void>;
};

/**
 * A Mongo-ObjectId-shaped id, which is what Overleaf's thread ids are.
 *
 * Mirrors `RangesTracker.generateId`: eight hex digits of timestamp, six of
 * machine, four of process, six of increment. The server does not mint these —
 * the client names the thread and both halves of the call use that name.
 */
function newThreadId(): string {
  const hex = (value: number, width: number) =>
    Math.floor(value).toString(16).padStart(width, "0").slice(-width);
  return (
    hex(Date.now() / 1000, 8)
    + hex(Math.random() * 0x1000000, 6)
    + hex(Math.random() * 0x10000, 4)
    + hex(Math.random() * 0x1000000, 6)
  );
}

export function useOverleafComments(options: {
  enabled: boolean;
  /** Overleaf's id for the open document; resolve and delete are keyed on it. */
  docId: string | null;
  /** Thread ids anchored in the open document. */
  anchored: string[];
  /** Anchors the thread to its span on the editing channel. */
  anchor: (threadId: string, position: number, quote: string) => Promise<void>;
}): OverleafComments {
  const [threads, setThreads] = useState<OverleafThread[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const docId = useRef(options.docId);
  docId.current = options.docId;
  const anchor = useRef(options.anchor);
  anchor.current = options.anchor;

  const enabled = options.enabled;

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      setThreads(await invoke<OverleafThread[]>("overleaf_threads"));
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
    setLoading(false);
  }, [enabled]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!enabled) {
      setThreads([]);
      setError(null);
      return;
    }
    void refreshRef.current();
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unlisten: (() => void) | null = null;
    void listen<{ type: string }>("overleaf-realtime", (event) => {
      if (event.payload.type !== "threadsChanged") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refreshRef.current();
      }, REFRESH_DEBOUNCE_MS);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, [enabled]);

  /** Run an action, then re-read: the server is the authority on the result. */
  const act = useCallback(async (run: () => Promise<void>) => {
    setError(null);
    try {
      await run();
      await refreshRef.current();
    } catch (reason) {
      setError(String(reason));
      throw reason;
    }
  }, []);

  const reply = useCallback((threadId: string, content: string) => act(async () => {
    await invoke("overleaf_reply_to_thread", { threadId, content });
  }), [act]);

  const create = useCallback(async (position: number, quote: string, content: string) => {
    const threadId = newThreadId();
    setError(null);
    try {
      // The message first, the anchor second — the order Overleaf's own editor
      // uses, so a thread never exists on the page with nothing in it.
      await invoke("overleaf_reply_to_thread", { threadId, content });
      await anchor.current(threadId, position, quote);
      await refreshRef.current();
      return threadId;
    } catch (reason) {
      setError(String(reason));
      throw reason;
    }
  }, []);

  const setResolved = useCallback((threadId: string, resolved: boolean) => act(async () => {
    if (!docId.current) {
      throw new Error(
        "Open the file this comment is on first — Overleaf needs to know which document it belongs to.",
      );
    }
    await invoke("overleaf_resolve_thread", { docId: docId.current, threadId, resolved });
  }), [act]);

  const remove = useCallback((threadId: string) => act(async () => {
    if (!docId.current) {
      throw new Error(
        "Open the file this comment is on first — Overleaf needs to know which document it belongs to.",
      );
    }
    await invoke("overleaf_delete_thread", { docId: docId.current, threadId });
  }), [act]);

  const anchored = new Set(options.anchored);
  const openCount = threads.filter(
    (thread) => !thread.resolved && anchored.has(thread.id),
  ).length;

  return { threads, loading, error, openCount, refresh, reply, create, setResolved, remove };
}
