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

/**
 * Where one thread is anchored, and in which document.
 *
 * The editing channel only reveals this for documents that have been joined,
 * but Overleaf will also answer for the whole project at once — which is the
 * only way to learn the document a comment on some other file belongs to.
 * Resolve, reopen and delete are all keyed by that document, so without this
 * they were being sent the id of whichever file happened to be open.
 */
export type OverleafCommentAnchor = {
  threadId: string;
  docId: string;
  position: number;
  quote: string;
};

export type OverleafComments = {
  threads: OverleafThread[];
  /** Every thread's anchor, keyed by thread id, across the whole project. */
  anchors: Map<string, OverleafCommentAnchor>;
  loading: boolean;
  error: string | null;
  /** Unresolved threads anchored in the open document. */
  openCount: number;
  refresh: () => Promise<void>;
  reply: (threadId: string, content: string) => Promise<void>;
  /** Change what one of your own messages says. */
  editMessage: (threadId: string, messageId: string, content: string) => Promise<void>;
  /**
   * Remove one of your own messages. Overleaf deletes the thread with its last
   * message, so callers must say so before calling this on a lone message.
   */
  deleteMessage: (threadId: string, messageId: string) => Promise<void>;
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
  projectRoot: string | null;
  /** Overleaf's id for the open document; resolve and delete are keyed on it. */
  docId: string | null;
  /** Thread ids anchored in the open document. */
  anchored: string[];
  /** Anchors the thread to its span on the editing channel. */
  anchor: (threadId: string, position: number, quote: string) => Promise<void>;
}): OverleafComments {
  const [threads, setThreads] = useState<OverleafThread[]>([]);
  const [anchors, setAnchors] = useState<Map<string, OverleafCommentAnchor>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const docId = useRef(options.docId);
  docId.current = options.docId;
  const anchor = useRef(options.anchor);
  anchor.current = options.anchor;
  const anchorsRef = useRef(anchors);
  anchorsRef.current = anchors;

  const enabled = options.enabled;
  const projectRoot = options.projectRoot;

  const refresh = useCallback(async () => {
    if (!enabled || !projectRoot) return;
    setLoading(true);
    try {
      // The conversations and the spans they hang on come from two different
      // endpoints, and a thread is only usable with both: the messages say
      // what was said, the anchor says which file it was said about.
      const [found, anchored] = await Promise.all([
        invoke<OverleafThread[]>("overleaf_threads", { projectRoot }),
        invoke<OverleafCommentAnchor[]>("overleaf_comment_anchors", { projectRoot }),
      ]);
      setThreads(found);
      setAnchors(new Map(anchored.map((item) => [item.threadId, item])));
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
    setLoading(false);
  }, [enabled, projectRoot]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!enabled) {
      setThreads([]);
      setAnchors(new Map());
      setError(null);
      return;
    }
    void refreshRef.current();
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unlisten: (() => void) | null = null;
    void listen<{ type: string }>("overleaf-realtime", (event) => {
      // A conversation changing and a span being commented are separate
      // events on separate channels, and either can move a thread's anchor.
      if (event.payload.type !== "threadsChanged" && event.payload.type !== "commentAnchored") {
        return;
      }
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
  }, [enabled, projectRoot]);

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
    await invoke("overleaf_reply_to_thread", { projectRoot, threadId, content });
  }), [act, projectRoot]);

  const create = useCallback(async (position: number, quote: string, content: string) => {
    const threadId = newThreadId();
    setError(null);
    try {
      // The message first, the anchor second — the order Overleaf's own editor
      // uses, so a thread never exists on the page with nothing in it.
      await invoke("overleaf_reply_to_thread", { projectRoot, threadId, content });
      await anchor.current(threadId, position, quote);
      await refreshRef.current();
      return threadId;
    } catch (reason) {
      setError(String(reason));
      throw reason;
    }
  }, [projectRoot]);

  /**
   * The document a thread lives in, which is what Overleaf keys resolve,
   * reopen and delete on. It comes from the thread's own anchor — using the
   * open document instead was silently addressing the wrong file whenever
   * someone acted on a comment from anywhere but the file they were reading.
   * A thread with no anchor left is orphaned: its span was edited away, and
   * there is no document to name.
   */
  const documentOf = (threadId: string) => {
    const found = anchorsRef.current.get(threadId)?.docId ?? null;
    if (found) return found;
    throw new Error(
      "This comment is no longer attached to any text, so Overleaf has nowhere to apply this.",
    );
  };

  const setResolved = useCallback((threadId: string, resolved: boolean) => act(async () => {
    await invoke("overleaf_resolve_thread", {
      projectRoot,
      docId: documentOf(threadId),
      threadId,
      resolved,
    });
  }), [act, projectRoot]);

  const remove = useCallback((threadId: string) => act(async () => {
    await invoke("overleaf_delete_thread", {
      projectRoot,
      docId: documentOf(threadId),
      threadId,
    });
  }), [act, projectRoot]);

  const editMessage = useCallback(
    (threadId: string, messageId: string, content: string) => act(async () => {
      await invoke("overleaf_edit_message", { projectRoot, threadId, messageId, content });
    }),
    [act, projectRoot],
  );

  const deleteMessage = useCallback(
    (threadId: string, messageId: string) => act(async () => {
      await invoke("overleaf_delete_message", { projectRoot, threadId, messageId });
    }),
    [act, projectRoot],
  );

  const anchored = new Set(options.anchored);
  const openCount = threads.filter(
    (thread) => !thread.resolved && anchored.has(thread.id),
  ).length;

  return {
    threads,
    anchors,
    loading,
    error,
    openCount,
    refresh,
    reply,
    editMessage,
    deleteMessage,
    create,
    setResolved,
    remove,
  };
}
