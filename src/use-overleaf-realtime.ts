/**
 * Live editing against Overleaf for the file currently open.
 *
 * This owns the connection, the map from project paths to Overleaf document
 * ids, and the per-document state machine. Local edits leave as operations a
 * moment after they are typed; a collaborator's arrive as operations and are
 * applied to the buffer with the caret carried across them.
 *
 * It is deliberately failure-tolerant: anything unexpected — a rejected
 * update, a document that drifted, a dropped connection — stops the live
 * channel and leaves the existing sync to keep the project correct. A live
 * channel is an improvement on syncing, never a replacement for it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { OtDesyncError, OtDocument } from "./ot-document";
import type { OtOp } from "./ot-ops";

type DocEntry = { id: string; path: string };
/** One entity in the project, with the id Overleaf's own endpoints take. */
export type EntityEntry = { id: string; path: string; kind: "doc" | "file" | "folder" };
/** What this account may do to the project, as Overleaf reports it. */
export type OverleafPermission = "owner" | "readAndWrite" | "review" | "readOnly" | "unknown";
type JoinedProject = {
  publicId: string | null;
  rootFolderId: string;
  docs: DocEntry[];
  entities: EntityEntry[];
  permission: OverleafPermission;
  trackChanges: boolean;
  userId: string | null;
};
/** Where a comment thread is anchored in the open document. */
export type CommentRange = { threadId: string; position: number; quote: string };
/** A suggestion in the open document: text somebody proposed adding or removing. */
export type TrackedChange = {
  id: string;
  position: number;
  text: string;
  /** True when the suggestion is to remove `text`, which is still in the document. */
  deletion: boolean;
  userId: string | null;
  timestamp: string | null;
  /** The author's colour in Overleaf's own palette. */
  hue: number;
};
/** One update replayed by a join that resumed from a version we already had. */
type CaughtUpUpdate = {
  /** The version it applied at; the document moves to one past it. */
  version: number;
  ops: OtOp[];
  /** Whose it was. Our own work comes back here and counts as an ack. */
  source: string | null;
};

type JoinedDoc = {
  text: string;
  version: number;
  comments: CommentRange[];
  changes: TrackedChange[];
  caughtUp: CaughtUpUpdate[];
  /**
   * Whether the server honoured the version we asked to resume from. False
   * means it could not reach back that far, and `text` is all there is.
   */
  resumed: boolean;
};

type RealtimeEvent =
  | { type: "connected"; publicId: string }
  | {
    type: "projectJoined";
    rootFolderId: string;
    docs: DocEntry[];
    entities: EntityEntry[];
    permission: OverleafPermission;
  }
  | { type: "treeChanged"; docs: DocEntry[]; entities: EntityEntry[] }
  | { type: "docUpdate"; docId: string; version: number; ops: OtOp[]; source: string | null }
  | { type: "docAck"; docId: string; version: number }
  | { type: "commentAnchored"; docId: string; range: CommentRange }
  | { type: "changesAccepted"; docId: string; changeIds: string[] }
  | { type: "trackChangesToggled"; on: boolean }
  | { type: "otError"; docId: string; message: string }
  | { type: "disconnected"; reason: string };

export type RealtimeStatus = "off" | "connecting" | "live" | "error";

/** Shared empty array, so "no comments" is a stable reference across renders. */
const EMPTY_COMMENTS: CommentRange[] = [];
const EMPTY_CHANGES: TrackedChange[] = [];

function entityMap(entries: EntityEntry[] | undefined) {
  return new Map((entries ?? []).map((entity) => [
    entity.path,
    { id: entity.id, kind: entity.kind },
  ]));
}

export type OverleafRealtime = {
  status: RealtimeStatus;
  detail: string | null;
  /** True when the open file is being edited through the live channel. */
  liveFile: boolean;
  /** Overleaf's id for the open document, when it has one. */
  docId: string | null;
  /** What this account may do to the project. */
  permission: OverleafPermission;
  /**
   * Our own Overleaf account id. Needed because several of Overleaf's
   * settings are stored per account, so changing one for ourselves means
   * naming ourselves in the request.
   */
  userId: string | null;
  /** False for a reviewer or a viewer: their edits stay on this machine. */
  canWrite: boolean;
  /** Comment anchors in the open document, as Overleaf holds them. */
  comments: CommentRange[];
  /**
   * Everything in the project by path, with the id its endpoints take.
   * Deleting a file on Overleaf needs the id, and nothing else hands them out.
   */
  entities: Map<string, { id: string; kind: string }>;
  /** Suggestions in the open document, oldest position first. */
  changes: TrackedChange[];
  /** The document's version, which accepting and rejecting are built on. */
  version: number | null;
  /** True when this account's edits are recorded as suggestions. */
  trackChanges: boolean;
  /** Re-read the open document, after accepting or rejecting a suggestion. */
  reload: () => void;
  /** Feed the editor's current text in; ops go out when it differs. */
  pushLocal: (text: string) => void;
  /**
   * Anchor a new comment thread to a span of the open document. Resolves once
   * Overleaf has it; rejects when the document is not live or an edit is still
   * in flight, which the caller should report rather than swallow.
   */
  anchorComment: (threadId: string, position: number, quote: string) => Promise<void>;
};

export function useOverleafRealtime(options: {
  /** Connect whenever the project is linked: chat and presence ride here too. */
  enabled: boolean;
  /**
   * Whether to edit the open file through the channel. Off in manual sync mode
   * and during a Lattice share — two live channels writing one buffer would
   * fight over every keystroke — while the connection itself stays up so the
   * rest of the bridge keeps working.
   */
  documents: boolean;
  projectRoot: string | null;
  activeFile: string | null;
  /** Replace the buffer with text from a collaborator, keeping the caret. */
  onRemoteText: (text: string, caret: number) => void;
  /** Where the caret is right now, so it can be carried across remote edits. */
  readCaret: () => number;
  onNotice: (message: string) => void;
}): OverleafRealtime {
  const [status, setStatus] = useState<RealtimeStatus>("off");
  const [detail, setDetail] = useState<string | null>(null);
  const [liveFile, setLiveFile] = useState(false);
  const [openDoc, setOpenDoc] = useState<{
    id: string;
    comments: CommentRange[];
    changes: TrackedChange[];
    version: number;
  } | null>(null);
  const [trackChanges, setTrackChanges] = useState(false);
  // Bumped to re-join the open document, which is how the suggestion list is
  // re-read: accepting one is an endpoint, not an operation, so nothing on the
  // channel would otherwise tell us the ranges moved.
  const [reloadNonce, setReloadNonce] = useState(0);
  // State, not a ref: the tree can arrive from the connect call or from an
  // event, and either way the effect that joins the open document has to run
  // again once it does.
  const [docs, setDocs] = useState<Map<string, string>>(new Map());
  const [permission, setPermission] = useState<OverleafPermission>("unknown");
  const [entities, setEntities] = useState<Map<string, { id: string; kind: string }>>(new Map());
  const [userId, setUserId] = useState<string | null>(null);

  const publicId = useRef<string | null>(null);
  /**
   * Every document this connection is holding, which is not the same as the
   * one on screen. A document that still owes the server an operation stays
   * here after the writer has moved on, because the answer is addressed to it
   * and arrives on the channel regardless of what is being looked at — throw
   * it away at the moment of switching and the last edit made in it goes too.
   */
  const documents = useRef<Map<string, OtDocument>>(new Map());
  /** Documents kept alive only until they settle, then left. */
  const draining = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  /** The one being edited: local typing goes here, and it drives the editor. */
  const docId = useRef<string | null>(null);
  const sendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Typed but still inside the send debounce, so not yet in the document. */
  const unsentText = useRef<string | null>(null);

  /** How long a document that will not settle is allowed to hold the channel. */
  const DRAIN_TIMEOUT_MS = 15_000;

  // Read through refs inside the event listener so it can stay mounted for the
  // whole session instead of being torn down on every keystroke.
  const callbacks = useRef(options);
  callbacks.current = options;
  const canWrite = useRef(true);
  canWrite.current = permission !== "readOnly" && permission !== "review";

  /** Let go of a document for good: leave the room and forget it. */
  const release = useCallback((id: string) => {
    const timer = draining.current.get(id);
    if (timer) clearTimeout(timer);
    draining.current.delete(id);
    documents.current.delete(id);
    void invoke("overleaf_rt_leave_doc", { docId: id }).catch(() => {});
  }, []);

  /**
   * Stop editing the open document, without necessarily letting go of it.
   *
   * Anything the send debounce was still holding goes in first — typing a
   * sentence and immediately clicking another file is the ordinary way to use
   * the app, and cancelling that timer on the way out is how the sentence used
   * to vanish. If the document still owes the server an operation after that,
   * it is kept and stays in its room until the answer arrives: leaving first
   * would put both the acknowledgement and any rejection somewhere we are no
   * longer listening.
   */
  const stopDocument = useCallback(() => {
    if (sendTimer.current) {
      clearTimeout(sendTimer.current);
      sendTimer.current = null;
    }
    const previous = docId.current;
    const typed = unsentText.current;
    unsentText.current = null;
    docId.current = null;
    setLiveFile(false);
    setOpenDoc(null);
    if (!previous) return;
    const doc = documents.current.get(previous);
    if (!doc) return;

    const unsent = typed !== null && canWrite.current ? doc.local(typed).send : null;
    if (unsent) {
      void invoke("overleaf_rt_send_ops", {
        docId: previous,
        version: unsent.version,
        ops: unsent.ops,
      }).catch(() => {});
    }
    if (doc.settled) {
      release(previous);
      return;
    }
    // Held until the server answers, and no longer: a document that will never
    // settle — the connection died mid-operation — must not keep its room for
    // the rest of the session.
    draining.current.set(
      previous,
      setTimeout(() => release(previous), DRAIN_TIMEOUT_MS),
    );
  }, [release]);

  /** Every document goes, on the way to shutting the connection down. */
  const stopEverything = useCallback(() => {
    stopDocument();
    for (const id of [...documents.current.keys()]) release(id);
  }, [release, stopDocument]);

  const fail = useCallback((message: string) => {
    stopEverything();
    setStatus("error");
    setDetail(message);
    void invoke("overleaf_rt_disconnect").catch(() => {});
  }, [stopEverything]);

  /** Send whatever a document says is ready, if anything. */
  const flush = useCallback(async (
    id: string | null,
    send: { version: number; ops: OtOp[] } | null,
  ) => {
    if (!send || !id) return;
    try {
      await invoke("overleaf_rt_send_ops", { docId: id, version: send.version, ops: send.ops });
    } catch (reason) {
      fail(String(reason));
    }
  }, [fail]);

  // ---- events -------------------------------------------------------------
  // Registered before anything connects, so nothing the backend emits during
  // the join can be missed.

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<RealtimeEvent>("overleaf-realtime", (event) => {
      const payload = event.payload;
      if (payload.type === "connected") {
        publicId.current = payload.publicId;
        return;
      }
      if (payload.type === "projectJoined") {
        setDocs(new Map(payload.docs.map((doc) => [doc.path, doc.id])));
        setEntities(entityMap(payload.entities));
        setPermission(payload.permission);
        return;
      }
      if (payload.type === "treeChanged") {
        // Somebody created, renamed, moved or deleted something. A file that
        // appeared this way is joinable straight away, which is the point:
        // waiting for the next zip poll to notice it is what made new files
        // read as "not a document Overleaf tracks".
        setDocs(new Map(payload.docs.map((doc) => [doc.path, doc.id])));
        setEntities(entityMap(payload.entities));
        return;
      }
      if (payload.type === "disconnected") {
        stopEverything();
        setStatus("off");
        setDetail(payload.reason || null);
        return;
      }
      if (payload.type === "otError") {
        // Overleaf addresses a rejection to the document it happened in, and
        // one document failing says nothing about the others — or about chat
        // and presence, which ride the same connection.
        if (payload.docId && !documents.current.has(payload.docId)) return;
        fail(payload.message);
        callbacks.current.onNotice(
          `Overleaf rejected a live update (${payload.message}). Falling back to syncing.`,
        );
        return;
      }
      if (payload.type === "docAck") {
        // Overleaf never sends an operation back to whoever sent it: the
        // originating client gets the version alone, and that is the
        // acknowledgement. Without acting on it the operation would stay in
        // flight forever and every later edit would queue behind it unsent.
        const doc = documents.current.get(payload.docId);
        if (!doc) return;
        try {
          // Answers arrive for a document being drained too, and that is the
          // point of keeping it: this is what finishes its last operation.
          void flush(payload.docId, doc.acknowledge(payload.version).send);
          if (doc.settled && draining.current.has(payload.docId)) release(payload.docId);
        } catch (reason) {
          fail(reason instanceof Error ? reason.message : String(reason));
          callbacks.current.onNotice(
            "This document drifted from Overleaf's copy, so live editing stopped. Syncing will reconcile it.",
          );
        }
        return;
      }
      if (payload.type === "trackChangesToggled") {
        setTrackChanges(payload.on);
        return;
      }
      if (payload.type === "changesAccepted") {
        // Accepted suggestions become ordinary text without an operation, so
        // the only way to learn the new ranges is to ask again.
        setOpenDoc((current) => (
          current && current.id === payload.docId
            ? {
              ...current,
              changes: current.changes.filter(
                (change) => !payload.changeIds.includes(change.id),
              ),
            }
            : current
        ));
        return;
      }
      if (payload.type === "commentAnchored") {
        // Someone commented on the file we have open; show the marker without
        // making them re-open it.
        setOpenDoc((current) => {
          if (!current || current.id !== payload.docId) return current;
          if (current.comments.some((item) => item.threadId === payload.range.threadId)) {
            return current;
          }
          return { ...current, comments: [...current.comments, payload.range] };
        });
        return;
      }
      if (payload.type !== "docUpdate") return;

      const doc = documents.current.get(payload.docId);
      if (!doc) return;
      // Our own work coming back is already in this copy; only the separate
      // acknowledgement moves the state machine on.
      if (payload.source && publicId.current && payload.source === publicId.current) return;
      try {
        const onScreen = payload.docId === docId.current;
        const caret = onScreen ? callbacks.current.readCaret() : 0;
        const { text, applied } = doc.remote(payload.ops, payload.version);
        // A document being drained still has to apply this, or its own
        // outstanding operation is transformed against the wrong history and
        // the server rejects it. Nobody is looking at it, so nothing is drawn.
        if (onScreen) {
          callbacks.current.onRemoteText(text, OtDocument.caretAfter(caret, applied));
        }
      } catch (reason) {
        if (reason instanceof OtDesyncError) {
          fail(reason.message);
          callbacks.current.onNotice(
            "This document drifted from Overleaf's copy, so live editing stopped. Syncing will reconcile it.",
          );
        } else {
          fail(String(reason));
        }
      }
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [fail, flush, stopDocument]);

  // ---- connection ---------------------------------------------------------

  useEffect(() => {
    if (!options.enabled || !options.projectRoot) {
      setStatus("off");
      setDetail(null);
      setDocs(new Map());
      setEntities(new Map());
      setPermission("unknown");
      stopDocument();
      void invoke("overleaf_rt_disconnect").catch(() => {});
      return;
    }
    let cancelled = false;
    setStatus("connecting");
    setDetail(null);
    void invoke<JoinedProject>("overleaf_rt_connect")
      .then((joined) => {
        if (cancelled) return;
        // The join answer carries the document ids, so live editing can start
        // without waiting on — or racing — the event of the same name.
        // Overleaf may not have named us yet; the `connected` event fills that
        // in, and an empty id here would make our own echo look like someone
        // else's edit and apply it twice.
        if (joined.publicId) publicId.current = joined.publicId;
        setDocs(new Map(joined.docs.map((doc) => [doc.path, doc.id])));
        setEntities(entityMap(joined.entities));
        setPermission(joined.permission);
        setTrackChanges(joined.trackChanges);
        setUserId(joined.userId ?? null);
        setStatus("live");
        setDetail(null);
      })
      .catch((reason) => {
        if (cancelled) return;
        // Falling back to sync is fine; say so rather than looking broken.
        setStatus("error");
        setDetail(String(reason));
      });
    return () => {
      cancelled = true;
      stopDocument();
      void invoke("overleaf_rt_disconnect").catch(() => {});
    };
  }, [options.enabled, options.projectRoot, stopDocument]);

  // ---- the open file ------------------------------------------------------

  // Resolved here rather than inside the effect so the effect can depend on
  // the document id itself. `docs` is replaced wholesale every time anyone in
  // the project creates, renames, moves or deletes anything, and depending on
  // the map meant an unrelated file appearing would leave and re-join the
  // document being typed in — replacing the buffer with the server's copy and
  // taking every keystroke not yet acknowledged with it.
  const activeDocId = options.activeFile ? docs.get(options.activeFile) ?? null : null;

  useEffect(() => {
    stopDocument();
    if (!options.documents || status !== "live" || !options.activeFile) return;
    const id = activeDocId;
    // Only text documents Overleaf tracks can be edited live; anything else
    // (figures, files added since we joined) keeps going through syncing.
    if (!id) {
      setDetail(`${options.activeFile} is not a document Overleaf tracks, so it syncs instead.`);
      return;
    }
    let cancelled = false;
    // Coming back to a document that was still draining: it is being edited
    // again, so the timer that would have given up its room has to go, or it
    // would fire in the middle of typing.
    const drainTimer = draining.current.get(id);
    if (drainTimer) {
      clearTimeout(drainTimer);
      draining.current.delete(id);
    }
    // A document we still hold is one we were editing a moment ago. Asking to
    // resume from its version makes the server replay what it did meanwhile
    // instead of only stating where it ended up, which is the difference
    // between keeping work that never reached it and overwriting it.
    const held = documents.current.get(id);
    void invoke<JoinedDoc>("overleaf_rt_join_doc", {
      docId: id,
      fromVersion: held?.version ?? null,
    })
      .then((joined) => {
        if (cancelled) {
          // Joined after the writer moved on. Leave, or the room stays
          // subscribed for the rest of the session.
          if (!documents.current.has(id)) {
            void invoke("overleaf_rt_leave_doc", { docId: id }).catch(() => {});
          }
          return;
        }
        let text = joined.text;
        let caret = callbacks.current.readCaret();
        if (held && joined.resumed) {
          const result = held.catchUp(joined.caughtUp.map((update) => ({
            version: update.version,
            ops: update.ops,
            mine: !!update.source && update.source === publicId.current,
          })));
          text = result.text;
          caret = OtDocument.caretAfter(caret, result.applied);
          void flush(id, result.send);
        } else {
          // Either the first time here, or the server would not reach back far
          // enough. Its copy is the only thing both sides agree on.
          const doc = held ?? new OtDocument(joined.text, joined.version);
          doc.reset(joined.text, joined.version);
          documents.current.set(id, doc);
          caret = callbacks.current.readCaret();
        }
        docId.current = id;
        setLiveFile(true);
        setOpenDoc({
          id,
          comments: joined.comments ?? [],
          changes: joined.changes ?? [],
          version: joined.version,
        });
        setDetail(null);
        callbacks.current.onRemoteText(text, caret);
      })
      .catch((reason) => {
        if (!cancelled) setDetail(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [options.activeFile, options.documents, activeDocId, status, reloadNonce, stopDocument, flush]);

  // ---- local edits --------------------------------------------------------

  const pushLocal = useCallback((text: string) => {
    const id = docId.current;
    if (!id || !documents.current.has(id) || !canWrite.current) return;
    // Coalesce keystrokes briefly: one operation per short pause keeps the
    // channel quiet without anyone noticing a delay. Held where leaving the
    // document can find it, because until the timer fires this text exists
    // nowhere else on this side of the wire.
    unsentText.current = text;
    if (sendTimer.current) clearTimeout(sendTimer.current);
    sendTimer.current = setTimeout(() => {
      sendTimer.current = null;
      unsentText.current = null;
      // Read again rather than closing over it: the writer may have moved to
      // another file in the meantime, and this text belongs to the old one.
      const current = docId.current === id ? documents.current.get(id) : null;
      if (!current) return;
      void flush(id, current.local(text).send);
    }, 250);
  }, [flush]);

  const anchorComment = useCallback(async (threadId: string, position: number, quote: string) => {
    const id = docId.current;
    const doc = id ? documents.current.get(id) : null;
    if (!doc || !id) {
      throw new Error("This file is not being edited live with Overleaf yet.");
    }
    // An anchor is an operation like any other, so it needs the wire to
    // itself; typing while one is outstanding would be built on a version the
    // server has not confirmed.
    const reserved = doc.anchor();
    if (!reserved) {
      throw new Error("An edit is still on its way to Overleaf. Try again in a moment.");
    }
    try {
      await invoke("overleaf_rt_send_comment", {
        docId: id,
        version: reserved.version,
        position,
        quote,
        threadId,
      });
    } catch (reason) {
      fail(String(reason));
      throw reason;
    }
    // Show it straight away rather than waiting for the round trip.
    setOpenDoc((current) => (
      current && current.id === id
        ? { ...current, comments: [...current.comments, { threadId, position, quote }] }
        : current
    ));
  }, [fail]);

  return {
    status,
    detail,
    liveFile,
    docId: openDoc?.id ?? null,
    permission,
    // Unknown reads as writable: refusing to send work the user can in fact
    // push is the worse mistake, and Overleaf enforces this server-side too.
    canWrite: permission !== "readOnly" && permission !== "review",
    entities,
    userId,
    comments: openDoc?.comments ?? EMPTY_COMMENTS,
    changes: openDoc?.changes ?? EMPTY_CHANGES,
    version: openDoc?.version ?? null,
    trackChanges,
    reload: () => setReloadNonce((nonce) => nonce + 1),
    pushLocal,
    anchorComment,
  };
}
