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
import { isCollapsed, transformSpan } from "./ot-ranges";

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
type ProjectPermission = {
  projectRoot: string | null;
  permission: OverleafPermission;
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

/** The exact document/version pair reserved for an out-of-band OT mutation. */
export type ReservedOperation = {
  docId: string;
  version: number;
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
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** Authentication and project-identity failures need user action, not a retry loop. */
function shouldRetryConnection(reason: string): boolean {
  return !/session expired|not connected to overleaf|cookie|sign.?in|authentication|unauthorized|forbidden|permission|project changed|not linked|newer overleaf connection|invalid project/i
    .test(reason.toLowerCase());
}

function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * (2 ** Math.max(0, attempt)), RECONNECT_MAX_MS);
}

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
  /**
   * Every path still owned by the live channel, including a file that is no
   * longer open but is waiting for an acknowledgement. Ordinary syncing must
   * skip all of them: an acknowledgement can arrive after the writer switches
   * tabs, and uploading the same bytes meanwhile would be an out-of-band
   * overwrite.
   */
  livePaths: string[];
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
  /**
   * Whether this account may change the document directly — false for a
   * reviewer, who can still type, but only ever as suggestions. This is the
   * answer to "may they accept someone else's suggestion", not "may they
   * type at all".
   */
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
  /**
   * The version the open document was joined at. Only good for display — it
   * does not move as the document does, so anything sent to the server must
   * use `reserveOperation` instead.
   */
  version: number | null;
  /**
   * Take the wire for an operation this hook does not build itself — the
   * inverse operations that reject a suggestion, say — and answer with the
   * version to send it at.
   *
   * Null when the document is not live, or when one of our own operations is
   * still unacknowledged: the server numbers versions, so a second operation
   * built on a version it has not confirmed would be applied against the
   * wrong history.
   */
  reserveOperation: () => ReservedOperation | null;
  /**
   * A separately-sent reserved operation failed without proving whether the
   * server committed it. Keep the document OT-owned and reconcile by replay.
   */
  noteReservedOperationUnknown: (reservation: ReservedOperation, reason: unknown) => void;
  /**
   * The current server version when the open document has no local operation
   * in flight. Unlike `reserveOperation`, this does not take the wire.
   */
  settledVersion: () => number | null;
  /** True when this account's edits are recorded as suggestions. */
  trackChanges: boolean;
  /**
   * Record that we just turned suggesting on or off ourselves.
   *
   * The setting is changed over REST and normally comes back on the channel,
   * which is what moves this state — but the REST call succeeds whether or
   * not the channel is up, and when it is not, nothing ever reflected the
   * change. The button then read as stuck: it kept saying the old mode, and
   * since which call a keystroke leaves by is decided from the same state,
   * the mode really was stuck too.
   */
  noteTrackChanges: (on: boolean) => void;
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
  const [projectPermission, setProjectPermission] = useState<ProjectPermission>({
    projectRoot: null,
    permission: "unknown",
  });
  const [entities, setEntities] = useState<Map<string, { id: string; kind: string }>>(new Map());
  const [userId, setUserId] = useState<string | null>(null);
  const [livePaths, setLivePaths] = useState<string[]>([]);

  const publicId = useRef<string | null>(null);
  /**
   * Every document this connection is holding, which is not the same as the
   * one on screen. A document that still owes the server an operation stays
   * here after the writer has moved on, because the answer is addressed to it
   * and arrives on the channel regardless of what is being looked at — throw
   * it away at the moment of switching and the last edit made in it goes too.
   */
  const documents = useRef<Map<string, OtDocument>>(new Map());
  /** Current reverse lookup, so draining documents keep their project paths. */
  const pathsByDocId = useRef<Map<string, string>>(new Map());
  /** Documents kept alive only until they settle, then left. */
  const draining = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  /**
   * A send whose outcome could not be proven. These documents remain owned by
   * OT — and therefore excluded from ordinary sync — until a late ack or
   * catch-up proves what happened.
   */
  const uncertain = useRef<Set<string>>(new Set());
  const reconciling = useRef<Set<string>>(new Set());
  /** The one being edited: local typing goes here, and it drives the editor. */
  const docId = useRef<string | null>(null);
  const sendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Typed but still inside the send debounce, so not yet in the document. */
  const unsentText = useRef<string | null>(null);
  /** Pending re-read of a document's anchors after we suggested something. */
  const rangesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Set by `reload`: take the server's copy instead of resuming from ours. */
  const forceFullJoin = useRef(false);
  const flushRef = useRef<(
    id: string | null,
    send: { version: number; ops: OtOp[] } | null,
  ) => Promise<void>>(async () => undefined);
  const reconcileUnknownRef = useRef<(id: string) => void>(() => undefined);
  const requestReconnectRef = useRef<(reason: string, immediate?: boolean) => void>(
    () => undefined,
  );
  /** The root that owns every document currently held by this hook. */
  const connectionRoot = useRef<string | null>(null);

  /** How long a document that will not settle is allowed to hold the channel. */
  const DRAIN_TIMEOUT_MS = 15_000;

  // Read through refs inside the event listener so it can stay mounted for the
  // whole session instead of being torn down on every keystroke.
  const callbacks = useRef(options);
  callbacks.current = options;
  // A permission is only meaningful for the project whose connect result
  // supplied it. During a root switch, the previous render's role must not be
  // reused for the new project.
  const permission = projectPermission.projectRoot === options.projectRoot
    ? projectPermission.permission
    : "unknown";
  /**
   * Whether this account may put anything into the document at all.
   *
   * A reviewer can: not as edits, but as suggestions, which is the whole point
   * of the role. Treating them as read-only locked them out of the one thing
   * they are there to do. Only a viewer is genuinely unable to contribute.
   */
  const canContribute = useRef(true);
  canContribute.current = permission !== "readOnly" && permission !== "unknown";
  /**
   * Whether what is typed goes out as a suggestion rather than an edit.
   *
   * Two independent reasons: the account asked for it, or the account has no
   * choice — the server rejects a plain update from a reviewer, and
   * disconnects them for trying.
   */
  const asSuggestion = useRef(false);
  asSuggestion.current = trackChanges || permission === "review";

  /** Publish the complete set of paths that ordinary syncing must not own. */
  const publishLivePaths = useCallback(() => {
    const next = [...new Set(
      [...documents.current.keys()]
        .map((id) => pathsByDocId.current.get(id))
        .filter((path): path is string => Boolean(path)),
    )].sort();
    setLivePaths((current) => (
      current.length === next.length && current.every((path, index) => path === next[index])
        ? current
        : next
    ));
  }, []);

  /** Replace both directions of the live document tree without dropping held ids. */
  const noteDocumentTree = useCallback((entries: DocEntry[]) => {
    setDocs(new Map(entries.map((doc) => [doc.path, doc.id])));
    const previous = pathsByDocId.current;
    const next = new Map(entries.map((doc) => [doc.id, doc.path]));
    // A tree event can remove a document while its final operation is still
    // awaiting an answer. Keep that id's last path so REST cannot take it over.
    // If the same id was renamed, `next` already contains the new path and wins.
    for (const id of documents.current.keys()) {
      if (!next.has(id)) {
        const lastPath = previous.get(id);
        if (lastPath) next.set(id, lastPath);
      }
    }
    pathsByDocId.current = next;
    publishLivePaths();
  }, [publishLivePaths]);

  /** Let go of a document for good: leave the room and forget it. */
  const release = useCallback((id: string) => {
    const timer = draining.current.get(id);
    if (timer) clearTimeout(timer);
    draining.current.delete(id);
    uncertain.current.delete(id);
    reconciling.current.delete(id);
    documents.current.delete(id);
    publishLivePaths();
    const projectRoot = connectionRoot.current;
    if (projectRoot) {
      void invoke("overleaf_rt_leave_doc", { projectRoot, docId: id }).catch(() => {});
    }
  }, [publishLivePaths]);

  /**
   * Keep an ambiguous send away from ordinary syncing and ask Overleaf to
   * replay what happened. A timeout is not a rejection: the server may have
   * committed the operation before its answer was lost.
   */
  const markOutcomeUnknown = useCallback((id: string, reason: unknown) => {
    const first = !uncertain.current.has(id);
    uncertain.current.add(id);
    publishLivePaths();
    const path = pathsByDocId.current.get(id) ?? "this file";
    const message = `Lattice could not confirm whether Overleaf accepted the latest edit to ${path} (${String(reason)}). Syncing is paused for this file while Lattice checks.`;
    if (docId.current === id) setDetail(message);
    if (first) callbacks.current.onNotice(message);
    reconcileUnknownRef.current(id);
  }, [publishLivePaths]);

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

    const unsent = typed !== null && canContribute.current ? doc.local(typed).send : null;
    if (unsent) {
      // The last thing typed leaves the same way everything before it did —
      // as a suggestion when that is the mode, and not as a plain edit that
      // slips past it on the way out of the file.
      void flushRef.current(previous, unsent);
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
      setTimeout(() => {
        const held = documents.current.get(previous);
        if (!held || held.settled) {
          release(previous);
          return;
        }
        markOutcomeUnknown(previous, "the acknowledgement did not arrive in time");
      }, DRAIN_TIMEOUT_MS),
    );
  }, [markOutcomeUnknown, release]);

  /** Every document goes, on the way to shutting the connection down. */
  const stopEverything = useCallback(() => {
    stopDocument();
    for (const id of [...documents.current.keys()]) release(id);
  }, [release, stopDocument]);

  /**
   * A broken connection is different from an intentional shutdown: settled
   * documents can go, but any unacknowledged one has an unknown remote outcome
   * and must keep blocking ordinary sync.
   */
  const stopAfterDisconnect = useCallback((reason: string) => {
    stopDocument();
    for (const [id, doc] of [...documents.current.entries()]) {
      if (doc.settled) release(id);
      else markOutcomeUnknown(id, reason);
    }
  }, [markOutcomeUnknown, release, stopDocument]);

  const fail = useCallback((message: string, projectRoot = connectionRoot.current) => {
    if (!projectRoot || connectionRoot.current !== projectRoot) return;
    stopAfterDisconnect(message);
    setStatus("error");
    setDetail(message);
    void invoke("overleaf_rt_disconnect", {
      projectRoot,
    }).catch(() => {});
  }, [stopAfterDisconnect]);

  /**
   * Give up on one document without giving up the connection.
   *
   * One file failing to send says nothing about the others, and nothing at all
   * about chat, presence, or the file tree, which ride the same socket. This
   * file falls back to syncing — which will reconcile it — and everything else
   * carries on.
   */
  const dropDocument = useCallback((id: string, message: string) => {
    if (docId.current === id) {
      docId.current = null;
      setLiveFile(false);
      setOpenDoc(null);
      setDetail(message);
    }
    release(id);
  }, [release]);

  /**
   * Carry the open document's anchored spans across an operation.
   *
   * Overleaf states where comments and suggestions sit when the document is
   * joined and never mentions them again — they are expected to ride along on
   * the operations that move the text. Without this they drift, and a drifted
   * suggestion is worse than a misplaced highlight: accepting or rejecting one
   * applies to a range, so it would rewrite text nobody proposed touching.
   * Applies to our own typing as much as to anyone else's.
   */
  const shiftAnchors = useCallback((id: string, ops: OtOp[]) => {
    if (!ops.length) return;
    setOpenDoc((current) => {
      if (!current || current.id !== id) return current;
      const comments = current.comments.map((comment) => {
        const moved = transformSpan(
          { from: comment.position, length: comment.quote.length },
          ops,
        );
        return moved.from === comment.position
          ? comment
          : { ...comment, position: moved.from };
      });
      const changes = current.changes
        .map((change) => {
          const moved = transformSpan({ from: change.position, length: change.text.length }, ops);
          // A suggestion whose text was deleted outright has nothing left to
          // accept or reject; dropping it is better than offering a button
          // that would act on whatever moved into its place.
          if (isCollapsed(moved)) return null;
          return moved.from === change.position ? change : { ...change, position: moved.from };
        })
        .filter((change): change is TrackedChange => change !== null);
      return { ...current, comments, changes };
    });
  }, []);

  /**
   * Re-read what is anchored in a document, shortly after we suggested
   * something in it.
   *
   * Overleaf never echoes our own operation back, so a suggestion we just made
   * is invisible here: the text looks like ordinary text, nothing underlines
   * it, and the changes list stays empty — which made suggesting look exactly
   * like editing. This asks for the ranges without re-joining, so the buffer
   * is not replaced under whoever is still typing. Debounced, because a burst
   * of typing is one suggestion being written, not many.
   */
  const refreshRanges = useCallback((id: string) => {
    if (rangesTimer.current) clearTimeout(rangesTimer.current);
    const projectRoot = connectionRoot.current;
    if (!projectRoot) return;
    rangesTimer.current = setTimeout(() => {
      rangesTimer.current = null;
      void invoke<{ comments: CommentRange[]; changes: TrackedChange[] }>(
        "overleaf_doc_ranges",
        { projectRoot, docId: id },
      )
        .then((ranges) => {
          if (connectionRoot.current !== projectRoot) return;
          setOpenDoc((current) => (
            current && current.id === id
              ? { ...current, comments: ranges.comments, changes: ranges.changes }
              : current
          ));
        })
        .catch(() => {
          // The suggestion is on Overleaf either way; only its highlight here
          // is missing, and the next read will pick it up.
        });
    }, 700);
  }, []);

  /**
   * Ask the server to replay from the last version we trust after a send's
   * acknowledgement went missing.
   *
   * If our update is in the replay, `catchUp` treats it as the missing ack. If
   * it is not, the outcome remains unknown: a late server apply is still
   * possible, so the document stays held rather than being handed to REST.
   */
  const reconcileUnknown = useCallback(async (id: string) => {
    if (reconciling.current.has(id)) return;
    const doc = documents.current.get(id);
    if (!doc || !uncertain.current.has(id)) return;
    const projectRoot = connectionRoot.current;
    if (!projectRoot) return;
    reconciling.current.add(id);
    try {
      const joined = await invoke<JoinedDoc>("overleaf_rt_join_doc", {
        projectRoot,
        docId: id,
        fromVersion: doc.version,
      });
      if (connectionRoot.current !== projectRoot) return;
      if (documents.current.get(id) !== doc || !joined.resumed) return;
      const caughtUp = joined.caughtUp ?? [];
      if (!publicId.current && caughtUp.length) {
        // With an operation already in flight, replaying a source we cannot
        // identify may apply our own text a second time. Keep the outcome
        // unknown until the connection supplies our public id.
        if (docId.current === id) {
          setDetail(
            "Overleaf replayed updates before Lattice could identify this connection. Syncing remains paused for this file.",
          );
        }
        return;
      }
      const sawOurUpdate = caughtUp.some(
        (update) => Boolean(update.source) && update.source === publicId.current,
      );
      const caret = docId.current === id ? callbacks.current.readCaret() : 0;
      const result = doc.catchUp(caughtUp.map((update) => ({
        version: update.version,
        ops: update.ops,
        mine: Boolean(update.source) && update.source === publicId.current,
      })));
      shiftAnchors(id, result.applied);
      if (docId.current === id) {
        setOpenDoc((current) => (
          current && current.id === id
            ? {
              ...current,
              comments: joined.comments ?? current.comments,
              changes: joined.changes ?? current.changes,
              version: joined.version,
            }
            : current
        ));
        callbacks.current.onRemoteText(
          result.text,
          OtDocument.caretAfter(caret, result.applied),
        );
      }
      if (sawOurUpdate || doc.settled) {
        uncertain.current.delete(id);
        publishLivePaths();
        if (docId.current === id) setDetail(null);
      }
      if (result.send) void flushRef.current(id, result.send);
      if (doc.settled && (draining.current.has(id) || docId.current !== id)) release(id);
    } catch {
      // Still unknown. Keeping the path in livePaths is the safety mechanism;
      // a later ack or reconnect can resolve it without a blind retransmit.
    } finally {
      if (connectionRoot.current === projectRoot) reconciling.current.delete(id);
    }
  }, [publishLivePaths, release, shiftAnchors]);
  useEffect(() => {
    reconcileUnknownRef.current = (id) => {
      void reconcileUnknown(id);
    };
  }, [reconcileUnknown]);

  /** Send whatever a document says is ready, if anything. */
  const flush = useCallback(async (
    id: string | null,
    send: { version: number; ops: OtOp[] } | null,
  ) => {
    if (!send || !id) return;
    const projectRoot = connectionRoot.current;
    if (!projectRoot) {
      markOutcomeUnknown(id, "the Overleaf project connection is no longer active");
      return;
    }
    try {
      // Suggesting is not a display mode: the difference is which call the
      // keystrokes leave by, and it is decided here at the moment of sending.
      // Sending plain updates while the setting says suggestions made the
      // toolbar's own label untrue — it read "Suggesting" while every
      // keystroke went straight into everyone else's document.
      const suggesting = asSuggestion.current;
      const command = suggesting ? "overleaf_rt_send_tracked_ops" : "overleaf_rt_send_ops";
      await invoke(command, {
        projectRoot,
        docId: id,
        version: send.version,
        ops: send.ops,
      });
      if (connectionRoot.current !== projectRoot) return;
      // Only suggestions need this: an ordinary edit is just text, and its
      // effect is already on screen.
      if (suggesting) refreshRanges(id);
    } catch (reason) {
      if (connectionRoot.current !== projectRoot) return;
      // A rejected Promise only says the acknowledgement did not reach this
      // call. The server may already have committed the operation, so handing
      // the file to REST (or blindly sending the op again) could duplicate or
      // overwrite it. Keep ownership and reconcile by replaying history.
      markOutcomeUnknown(id, reason);
    }
  }, [markOutcomeUnknown, refreshRanges]);
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

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
        for (const id of uncertain.current) reconcileUnknownRef.current(id);
        return;
      }
      if (payload.type === "projectJoined") {
        noteDocumentTree(payload.docs);
        setEntities(entityMap(payload.entities));
        // Do not persist a permission from an unscoped event. The event does
        // not name its project, so one emitted late by project A could arrive
        // after the UI has already switched to project B. The scoped connect
        // result below is the authority for permission.
        return;
      }
      if (payload.type === "treeChanged") {
        // Somebody created, renamed, moved or deleted something. A file that
        // appeared this way is joinable straight away, which is the point:
        // waiting for the next zip poll to notice it is what made new files
        // read as "not a document Overleaf tracks".
        noteDocumentTree(payload.docs);
        setEntities(entityMap(payload.entities));
        return;
      }
      if (payload.type === "disconnected") {
        const reason = payload.reason || "The realtime connection closed.";
        stopAfterDisconnect(reason);
        requestReconnectRef.current(reason);
        return;
      }
      if (payload.type === "otError") {
        // Overleaf addresses a rejection to the document it happened in, and
        // one document failing says nothing about the others — or about chat
        // and presence, which ride the same connection.
        if (payload.docId && !documents.current.has(payload.docId)) return;
        if (payload.docId) {
          dropDocument(payload.docId, `Overleaf rejected a live update (${payload.message}).`);
        } else {
          // No document named: nothing narrower to act on than the connection.
          fail(payload.message);
        }
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
          const wasUncertain = uncertain.current.delete(payload.docId);
          publishLivePaths();
          void flush(payload.docId, doc.acknowledge(payload.version).send);
          if (wasUncertain && docId.current === payload.docId) setDetail(null);
          if (
            doc.settled
            && (draining.current.has(payload.docId) || docId.current !== payload.docId)
          ) {
            release(payload.docId);
          }
        } catch (reason) {
          dropDocument(
            payload.docId,
            reason instanceof Error ? reason.message : String(reason),
          );
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
        shiftAnchors(payload.docId, applied);
        // A document being drained still has to apply this, or its own
        // outstanding operation is transformed against the wrong history and
        // the server rejects it. Nobody is looking at it, so nothing is drawn.
        if (onScreen) {
          callbacks.current.onRemoteText(text, OtDocument.caretAfter(caret, applied));
        }
      } catch (reason) {
        // One document drifting is that document's problem; the rest of the
        // project, and the chat and presence beside it, are unaffected.
        dropDocument(
          payload.docId,
          reason instanceof OtDesyncError ? reason.message : String(reason),
        );
        callbacks.current.onNotice(
          "This document drifted from Overleaf's copy, so live editing stopped. Syncing will reconcile it.",
        );
      }
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [
    dropDocument,
    fail,
    flush,
    noteDocumentTree,
    publishLivePaths,
    release,
    shiftAnchors,
    stopAfterDisconnect,
    stopEverything,
  ]);

  // ---- connection ---------------------------------------------------------

  useEffect(() => {
    if (!options.enabled || !options.projectRoot) {
      requestReconnectRef.current = () => undefined;
      setStatus("off");
      setDetail(null);
      noteDocumentTree([]);
      setEntities(new Map());
      setProjectPermission({ projectRoot: null, permission: "unknown" });
      stopEverything();
      connectionRoot.current = null;
      // `null` is an intentional global disconnect. An empty string used to
      // become a scoped path that matched nothing and left the old socket live.
      void invoke("overleaf_rt_disconnect", { projectRoot: null }).catch(() => {});
      return;
    }
    const connectingRoot = options.projectRoot;
    let cancelled = false;
    let connecting = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryAttempt = 0;
    let needsReconnect = false;
    let lastReason = "";

    setProjectPermission({ projectRoot: connectingRoot, permission: "unknown" });
    const scheduleReconnect = (reason: string, immediate = false) => {
      if (cancelled) return;
      needsReconnect = true;
      lastReason = reason;
      if (retryTimer || connecting) return;
      const delay = immediate ? 0 : reconnectDelay(retryAttempt);
      if (!immediate) retryAttempt += 1;
      setStatus("connecting");
      setDetail(
        delay === 0
          ? `Overleaf live editing disconnected (${reason}). Reconnecting now…`
          : `Overleaf live editing disconnected (${reason}). Reconnecting in ${Math.ceil(delay / 1_000)}s…`,
      );
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (cancelled || connecting) return;
      connecting = true;
      setStatus("connecting");
      if (!needsReconnect) setDetail(null);
      try {
        const joined = await invoke<JoinedProject>("overleaf_rt_connect", {
          projectRoot: connectingRoot,
        });
        if (cancelled) return;
        // The join answer carries the document ids, so live editing can start
        // without waiting on — or racing — the event of the same name.
        // Overleaf may not have named us yet; the `connected` event fills that
        // in, and an empty id here would make our own echo look like someone
        // else's edit and apply it twice.
        if (joined.publicId) publicId.current = joined.publicId;
        connectionRoot.current = connectingRoot;
        noteDocumentTree(joined.docs);
        setEntities(entityMap(joined.entities));
        setProjectPermission({
          projectRoot: connectingRoot,
          permission: joined.permission,
        });
        setTrackChanges(joined.trackChanges);
        setUserId(joined.userId ?? null);
        setStatus("live");
        setDetail(null);
        const recovered = needsReconnect;
        needsReconnect = false;
        retryAttempt = 0;
        lastReason = "";
        // The handshake's connected event can arrive before Rust installs the
        // new client. Reconcile uncertain sends once the command itself has
        // returned, when joining their history is guaranteed to be possible.
        for (const id of uncertain.current) reconcileUnknownRef.current(id);
        if (recovered) {
          callbacks.current.onNotice("Overleaf live editing reconnected.");
        }
      } catch (reason) {
        if (cancelled) return;
        const message = String(reason);
        if (shouldRetryConnection(message)) {
          // Mark the call complete before scheduling: the scheduler refuses
          // to overlap connection attempts.
          connecting = false;
          scheduleReconnect(message);
          return;
        }
        needsReconnect = false;
        setStatus("error");
        setDetail(message);
      } finally {
        connecting = false;
      }
    };

    requestReconnectRef.current = scheduleReconnect;
    const retryNow = () => {
      if (!needsReconnect || cancelled || connecting) return;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      scheduleReconnect(lastReason || "the network became available", true);
    };
    window.addEventListener("online", retryNow);
    window.addEventListener("focus", retryNow);
    void connect();

    return () => {
      cancelled = true;
      requestReconnectRef.current = () => undefined;
      if (retryTimer) clearTimeout(retryTimer);
      window.removeEventListener("online", retryNow);
      window.removeEventListener("focus", retryNow);
      // This cleanup is an intentional project/unlink transition, not an
      // unexplained network failure. No synchronizer remains for the old
      // project, so release its rooms instead of carrying their paths into the
      // next project.
      stopEverything();
      if (connectionRoot.current === connectingRoot) connectionRoot.current = null;
      void invoke("overleaf_rt_disconnect", { projectRoot: connectingRoot }).catch(() => {});
    };
  }, [noteDocumentTree, options.enabled, options.projectRoot, stopEverything]);

  // The ZIP synchronizer also enforces this permission from its durable
  // SyncState. Keep it in step with the live channel, but never persist
  // "unknown": absence of evidence must not turn into write permission.
  useEffect(() => {
    if (
      !options.projectRoot
      || projectPermission.projectRoot !== options.projectRoot
      || projectPermission.permission === "unknown"
    ) {
      return;
    }
    const scopedPermission = projectPermission.permission;
    void invoke("overleaf_set_permission", {
      permission: scopedPermission,
      projectRoot: options.projectRoot,
    }).catch((reason) => {
      callbacks.current.onNotice(
        `Could not record Overleaf's ${scopedPermission} permission locally (${String(reason)}).`,
      );
    });
  }, [options.projectRoot, projectPermission]);

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
    const fullJoin = forceFullJoin.current;
    forceFullJoin.current = false;
    const held = fullJoin ? undefined : documents.current.get(id);
    const joiningRoot = connectionRoot.current;
    if (!joiningRoot) {
      setDetail("The Overleaf project connection is no longer active.");
      return;
    }
    void invoke<JoinedDoc>("overleaf_rt_join_doc", {
      projectRoot: joiningRoot,
      docId: id,
      fromVersion: held?.version ?? null,
    })
      .then((joined) => {
        if (cancelled) {
          // Joined after the writer moved on. Leave, or the room stays
          // subscribed for the rest of the session.
          if (!documents.current.has(id)) {
            void invoke("overleaf_rt_leave_doc", {
              projectRoot: joiningRoot,
              docId: id,
            }).catch(() => {});
          }
          return;
        }
        let text = joined.text;
        let caret = callbacks.current.readCaret();
        if (held && !held.settled && !joined.resumed) {
          markOutcomeUnknown(
            id,
            "Overleaf could not replay from the last version Lattice trusts",
          );
          setDetail(
            `Overleaf could not replay enough history to confirm the last edit to ${options.activeFile}. Syncing remains paused for this file.`,
          );
          publishLivePaths();
          return;
        }
        if (held && joined.resumed) {
          const caughtUp = joined.caughtUp ?? [];
          if (held.waiting && !publicId.current && caughtUp.length) {
            markOutcomeUnknown(
              id,
              "the connection id needed to classify replayed updates is not available",
            );
            setDetail(
              `Lattice cannot yet identify which replayed edits to ${options.activeFile} are its own. Syncing remains paused for this file.`,
            );
            publishLivePaths();
            return;
          }
          const result = held.catchUp(caughtUp.map((update) => ({
            version: update.version,
            ops: update.ops,
            mine: !!update.source && update.source === publicId.current,
          })));
          text = result.text;
          caret = OtDocument.caretAfter(caret, result.applied);
          if (
            held.settled
            || caughtUp.some(
              (update) => Boolean(update.source) && update.source === publicId.current,
            )
          ) {
            uncertain.current.delete(id);
          }
          void flush(id, result.send);
        } else {
          // Either the first time here, or the server would not reach back far
          // enough. Its copy is the only thing both sides agree on.
          const doc = held ?? new OtDocument(joined.text, joined.version);
          doc.reset(joined.text, joined.version);
          documents.current.set(id, doc);
          uncertain.current.delete(id);
          caret = callbacks.current.readCaret();
        }
        publishLivePaths();
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
  }, [
    options.activeFile,
    options.documents,
    activeDocId,
    status,
    reloadNonce,
    stopDocument,
    flush,
    markOutcomeUnknown,
    publishLivePaths,
  ]);

  // ---- local edits --------------------------------------------------------

  const pushLocal = useCallback((text: string) => {
    const id = docId.current;
    if (!id || !documents.current.has(id) || !canContribute.current) return;
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
      const { send } = current.local(text);
      if (send) shiftAnchors(id, send.ops);
      void flush(id, send);
    }, 250);
  }, [flush, shiftAnchors]);

  const anchorComment = useCallback(async (threadId: string, position: number, quote: string) => {
    const id = docId.current;
    const doc = id ? documents.current.get(id) : null;
    if (!doc || !id) {
      throw new Error("This file is not being edited live with Overleaf yet.");
    }
    const projectRoot = connectionRoot.current;
    if (!projectRoot) {
      throw new Error("Open the linked Overleaf project first.");
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
        projectRoot,
        docId: id,
        version: reserved.version,
        position,
        quote,
        threadId,
      });
    } catch (reason) {
      fail(String(reason), projectRoot);
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
    livePaths,
    docId: openDoc?.id ?? null,
    permission,
    // Unknown fails closed. Until Overleaf names a role, neither the live
    // channel nor the durable ZIP synchronizer may assume write access.
    canWrite: permission !== "readOnly"
      && permission !== "review"
      && permission !== "unknown",
    entities,
    userId,
    comments: openDoc?.comments ?? EMPTY_COMMENTS,
    changes: openDoc?.changes ?? EMPTY_CHANGES,
    version: openDoc?.version ?? null,
    trackChanges,
    noteTrackChanges: setTrackChanges,
    reserveOperation: () => {
      const id = docId.current;
      const doc = id ? documents.current.get(id) : null;
      const anchor = doc?.anchor();
      return id && anchor ? { docId: id, version: anchor.version } : null;
    },
    noteReservedOperationUnknown: (reservation: ReservedOperation, reason: unknown) => {
      if (documents.current.get(reservation.docId)?.waiting) {
        markOutcomeUnknown(reservation.docId, reason);
      }
    },
    settledVersion: () => {
      const id = docId.current;
      const doc = id ? documents.current.get(id) : null;
      // Text inside the short debounce has not entered OtDocument yet, but it
      // is still local work. Treating the document as settled here would let a
      // REST mutation reload the server copy over those keystrokes.
      if (sendTimer.current || unsentText.current !== null) return null;
      return doc?.settled ? doc.version : null;
    },
    reload: () => {
      const id = docId.current;
      const doc = id ? documents.current.get(id) : null;
      if (
        sendTimer.current
        || unsentText.current !== null
        || (doc && !doc.settled)
      ) {
        setDetail(
          "A local edit has not settled on Overleaf yet, so this document cannot be reloaded safely.",
        );
        if (id && uncertain.current.has(id)) reconcileUnknownRef.current(id);
        return;
      }
      // Start over from the server's copy rather than resuming from ours.
      // Reload is asked for after something changed the document in a way no
      // operation describes — a suggestion accepted, or rejected by an
      // operation we sent but never applied here — so our copy is exactly
      // what cannot be trusted.
      forceFullJoin.current = true;
      setReloadNonce((nonce) => nonce + 1);
    },
    pushLocal,
    anchorComment,
  };
}
