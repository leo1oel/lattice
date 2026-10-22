/**
 * Review in the document open live: the comment threads and suggestions
 * Overleaf anchored in it, and whether our own edits go out as suggestions.
 *
 * Overleaf states where the anchors sit when a document is joined and never
 * restates them, so they ride along on every operation (`anchorsAfter`). An
 * operation sent as a suggestion also adds suggestions, which this side can
 * only work out provisionally (./overleaf-suggestions). While any are
 * provisional, the document's ranges are read back as soon as nothing of ours
 * is still being typed or waiting for an answer. Only then do the server's
 * ranges describe the text on screen: the read resumes from our version, and
 * is used only when it replays nothing and our version has not moved
 * meanwhile. Otherwise it tries again a little later.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { OtDocument, OtOp } from "./ot";
import type { OverleafEvent } from "./overleaf-realtime-listen";
import { anchorsAfter, type JoinedDoc, type JoinedProject, type OpenDoc } from "./overleaf-realtime-model";
import { isProvisional, type Suggester } from "./overleaf-suggestions";

/** How long the document has to stay quiet before its suggestions are read back. */
export const SUGGESTION_REFRESH_MS = 1_500;

/**
 * `quiet` answers with the open document and its project when nothing of ours
 * is unsent or unanswered in it, else null.
 */
export function useOpenDocReview(quiet: (id: string) => { doc: OtDocument; projectRoot: string } | null) {
  const [openDoc, setOpenDoc] = useState<OpenDoc | null>(null);
  /**
   * Overleaf's track-changes setting for this account, and who we are. While
   * it is on, our edits go out as suggestions: Overleaf leaves tracking to
   * the client that sends an update, so ignoring it makes a writer's typing
   * plain edits in a project that asked for suggestions.
   */
  const suggesting = useRef<{ on: boolean; by: Suggester }>({ on: false, by: { userId: null, hue: 0 } });
  const latestQuiet = useRef(quiet);
  useEffect(() => {
    latestQuiet.current = quiet;
  });

  const patchOpenDoc = useCallback((id: string, patch: (current: OpenDoc) => Partial<OpenDoc> | null) => {
    setOpenDoc((current) => {
      if (!current || current.id !== id) return current;
      const next = patch(current);
      return next ? { ...current, ...next } : current;
    });
  }, []);

  /** Move the open document's anchors along with `ops`, suggested by `by` if they were; see `anchorsAfter`. */
  const shiftAnchors = useCallback((id: string, ops: OtOp[], by: Suggester | null = null) => {
    if (ops.length) patchOpenDoc(id, (current) => anchorsAfter(current, ops, by));
  }, [patchOpenDoc]);

  /** Take the review events off the live channel; false for any other event. */
  const onReviewEvent = useCallback((payload: OverleafEvent) => {
    switch (payload.type) {
      case "trackChangesToggled":
        suggesting.current = { ...suggesting.current, on: payload.on };
        return true;
      case "changesAccepted":
        // Accepted suggestions become ordinary text without an operation, so
        // the only way to learn the new ranges is to ask again.
        patchOpenDoc(payload.docId, (current) => ({
          changes: current.changes.filter((change) => !payload.changeIds.includes(change.id)),
        }));
        return true;
      case "commentAnchored":
        // Someone commented on the file we have open; show the marker without
        // making them re-open it.
        patchOpenDoc(payload.docId, (current) => (
          current.comments.some((item) => item.threadId === payload.range.threadId)
            ? null
            : { comments: [...current.comments, payload.range] }
        ));
        return true;
      default:
        return false;
    }
  }, [patchOpenDoc]);

  useEffect(() => {
    if (!openDoc?.changes.some(isProvisional)) return;
    const id = openDoc.id;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const attempt = async () => {
      const found = latestQuiet.current(id);
      if (found) {
        const { doc, projectRoot } = found;
        const version = doc.version;
        const read = await invoke<JoinedDoc>("overleaf_rt_doc_ranges", { projectRoot, docId: id, version }).catch(() => null);
        if (stopped) return;
        if (read?.resumed && !read.caughtUp?.length && latestQuiet.current(id)?.doc === doc && doc.version === version) {
          patchOpenDoc(id, () => ({ comments: read.comments ?? [], changes: read.changes ?? [] }));
          return;
        }
      }
      if (!stopped) timer = setTimeout(attempt, SUGGESTION_REFRESH_MS);
    };
    timer = setTimeout(attempt, SUGGESTION_REFRESH_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [openDoc, patchOpenDoc]);

  return {
    openDoc, setOpenDoc, patchOpenDoc, shiftAnchors, onReviewEvent,
    /** Read the setting, and who we are, from a connect answer. */
    noteProject: useCallback((joined: JoinedProject) => {
      suggesting.current = { on: joined.trackChanges === true, by: { userId: joined.userId ?? null, hue: joined.ownHue ?? 0 } };
    }, []),
    /** Who our edits are suggested by, or null while they go out as ordinary edits. */
    suggester: useCallback(() => (suggesting.current.on ? suggesting.current.by : null), []),
  };
}
