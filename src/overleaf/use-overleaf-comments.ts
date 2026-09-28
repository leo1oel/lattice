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
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import type { OverleafThread } from "../app-types";
import { onOverleafEvent } from "./overleaf-realtime-listen";
import type { OverleafCommentTarget } from "./use-overleaf-realtime";

/** How long to wait before re-reading, so a burst costs one request. */
const REFRESH_DEBOUNCE_MS = 400;

/**
 * Where one thread is anchored, and in which document.
 *
 * The editing channel only reveals this for documents that have been joined,
 * but Overleaf will also answer for the whole project at once — which is the
 * only way to learn the document a comment on some other file belongs to.
 * Resolve, reopen and delete are all keyed by that document.
 */
export type OverleafCommentAnchor = {
  threadId: string;
  docId: string;
  position: number;
  quote: string;
};

export type OverleafComments = ReturnType<typeof useOverleafComments>;

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
  return hex(Date.now() / 1000, 8) + hex(Math.random() * 0x1000000, 6)
    + hex(Math.random() * 0x10000, 4) + hex(Math.random() * 0x1000000, 6);
}

export function useOverleafComments(options: {
  enabled: boolean;
  projectRoot: string | null;
  /** Anchors the thread to its span on the editing channel. */
  anchor: (target: OverleafCommentTarget, threadId: string, position: number, quote: string) => Promise<void>;
}) {
  const { t } = useLingui();
  const [threads, setThreads] = useState<OverleafThread[]>([]);
  /** Every thread's anchor, keyed by thread id, across the whole project. */
  const [anchors, setAnchors] = useState<Map<string, OverleafCommentAnchor>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { enabled, projectRoot } = options;

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

  // Kept current before any effect or handler reads them.
  const latest = useRef({ anchor: options.anchor, anchors, refresh });
  useLayoutEffect(() => {
    latest.current = { anchor: options.anchor, anchors, refresh };
  });

  useEffect(() => {
    if (!enabled) {
      setThreads([]);
      setAnchors(new Map());
      setError(null);
      return;
    }
    void latest.current.refresh();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = onOverleafEvent((event) => {
      // A conversation changing and a span being commented are separate
      // events on separate channels, and either can move a thread's anchor.
      if (event.type !== "threadsChanged" && event.type !== "commentAnchored") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void latest.current.refresh();
      }, REFRESH_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      stop();
    };
  }, [enabled, projectRoot]);

  /** Surface a failed action's reason and pass the failure on to the caller. */
  const guard = <T,>(run: () => Promise<T>) => {
    setError(null);
    return run().catch((reason: unknown) => {
      setError(String(reason));
      throw reason;
    });
  };
  /** Run an action, then re-read: the server is the authority on the result. */
  const act = (run: () => Promise<unknown>) => guard(async () => {
    await run();
    await latest.current.refresh();
  });
  const call = (command: string, args: Record<string, unknown>) => act(() => invoke(command, { projectRoot, ...args }));

  /**
   * The document a thread lives in, which is what Overleaf keys resolve,
   * reopen and delete on. It comes from the thread's own anchor — using the
   * open document instead silently addressed the wrong file whenever someone
   * acted on a comment from anywhere but the file they were reading. A thread
   * with no anchor left is orphaned: its span was edited away.
   */
  const documentOf = (threadId: string) => {
    const found = latest.current.anchors.get(threadId)?.docId;
    if (found) return found;
    throw new Error(t`This comment is no longer attached to any text, so Overleaf has nowhere to apply this.`);
  };

  return {
    threads,
    anchors,
    loading,
    error,
    reply: (threadId: string, content: string) => call("overleaf_reply_to_thread", { threadId, content }),
    /** Change what one of your own messages says. */
    editMessage: (threadId: string, messageId: string, content: string) =>
      call("overleaf_edit_message", { threadId, messageId, content }),
    /**
     * Remove one of your own messages. Overleaf deletes the thread with its last
     * message, so callers must say so before calling this on a lone message.
     */
    deleteMessage: (threadId: string, messageId: string) => call("overleaf_delete_message", { threadId, messageId }),
    setResolved: (threadId: string, resolved: boolean) => act(async () => invoke("overleaf_resolve_thread", {
      projectRoot, docId: documentOf(threadId), threadId, resolved,
    })),
    remove: (threadId: string) => act(async () => invoke("overleaf_delete_thread", {
      projectRoot, docId: documentOf(threadId), threadId,
    })),
    /**
     * Start a thread on a span of the open document. Overleaf keeps the two
     * halves apart — the conversation behind REST, the anchor on the editing
     * channel — so this does both and answers with the thread's id. The
     * message goes first, the order Overleaf's own editor uses, so a thread
     * never exists on the page with nothing in it.
     */
    create: (target: OverleafCommentTarget, position: number, quote: string, content: string) => guard(async () => {
      if (target.projectRoot !== projectRoot) {
        throw new Error(t`The linked Overleaf project changed. Try commenting again.`);
      }
      const threadId = newThreadId();
      await invoke("overleaf_reply_to_thread", { projectRoot: target.projectRoot, threadId, content });
      await latest.current.anchor(target, threadId, position, quote);
      await latest.current.refresh();
      return threadId;
    }),
  };
}
