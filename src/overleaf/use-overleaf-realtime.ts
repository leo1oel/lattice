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
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { toMessage } from "../app-utils";
import { i18n } from "../i18n";
import { OtDocument, transformCaret, type OtOp } from "./ot";
import { onOverleafEvent } from "./overleaf-realtime-listen";
import {
  anchorsAfter, isOwnUpdate, overleafDocHash, promoteShared, shouldRetryConnection,
  type CommentRange, type DocEntry, type DocumentProof, type DocUpdateEvent, type EntityEntry, type JoinedDoc,
  type JoinedProject, type OpenDoc, type OverleafCommentTarget, type OverleafPermission, type OverleafRemoteTextContext,
  type RealtimeStatus, type ReplayedUpdate, type ReservedOperation, type TrackedChange,
} from "./overleaf-realtime-model";

export type { OverleafCommentTarget, OverleafRemoteTextContext, ReservedOperation, TrackedChange };

/** Shared empty arrays, so "none" is a stable reference across renders. */
const EMPTY_COMMENTS: CommentRange[] = [];
const EMPTY_CHANGES: TrackedChange[] = [];
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
/** How long a document that will not settle is allowed to hold the channel. */
const DRAIN_TIMEOUT_MS = 15_000;
/** At most this often per document, an update carries the hash of the text it produces. */
const HASH_INTERVAL_MS = 5_000;
/** How long typing is coalesced into one operation. */
const SEND_DEBOUNCE_MS = 250;
const driftNotice = () => i18n._(msg`This document drifted from Overleaf's copy, so live editing stopped. Syncing will reconcile it.`);
const replacedNotice = () => i18n._(msg`Overleaf can't store emoji and some other special characters, so they were replaced with � — the same thing everyone else in the project sees.`);

export function useOverleafRealtime(options: {
  /** Connect whenever the project is linked: chat and presence ride here too. */
  enabled: boolean;
  /**
   * Whether to edit the open file through the channel. Off in manual sync mode,
   * while the connection itself stays up so the rest of the bridge keeps
   * working.
   */
  documents: boolean;
  projectRoot: string | null;
  activeFile: string | null;
  /** Return false to preserve divergent local work and fall back to regular sync. */
  onRemoteText: (text: string, caret: number, context: OverleafRemoteTextContext) => boolean | void | Promise<boolean | void>;
  /** Where the caret is right now, so it can be carried across remote edits. */
  readCaret: () => number;
  onNotice: (message: string) => void;
  onNeedsSync?: (paths: readonly string[]) => void;
}) {
  const { t } = useLingui();
  const [status, setStatus] = useState<RealtimeStatus>("off");
  const [detail, setDetail] = useState<string | null>(null);
  const [liveFile, setLiveFile] = useState(false);
  const [openDoc, setOpenDoc] = useState<OpenDoc | null>(null);
  // Bumped to re-join the open document, which is how the suggestion list is
  // re-read: accepting one is an endpoint, not an operation, so nothing on the
  // channel would otherwise tell us the ranges moved.
  const [reloadNonce, setReloadNonce] = useState(0);
  // State, not a ref: the tree can arrive from the connect call or from an
  // event, and either way the effect that joins the open document has to run
  // again once it does.
  const [docs, setDocs] = useState<Map<string, string>>(new Map());
  const [projectPermission, setProjectPermission] = useState<{ projectRoot: string | null; permission: OverleafPermission }>(
    { projectRoot: null, permission: "unknown" },
  );
  const [entities, setEntities] = useState<Map<string, { id: string; kind: string }>>(new Map());
  const [livePaths, setLivePaths] = useState<string[]>([]);

  const publicId = useRef<string | null>(null);
  const suspendedPaths = useRef(new Set<string>());
  useEffect(() => () => suspendedPaths.current.clear(), [options.projectRoot]);
  /**
   * Every document this connection is holding, which is not the same as the
   * one on screen. A document that still owes the server an operation stays
   * here after the writer has moved on, because the answer is addressed to it
   * and arrives on the channel regardless of what is being looked at — throw
   * it away at the moment of switching and the last edit made in it goes too.
   */
  const documents = useRef<Map<string, OtDocument>>(new Map());
  /** Updates received after joining a room but before its snapshot reaches React. */
  const joiningUpdates = useRef<Map<string, DocUpdateEvent[]>>(new Map());
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
  /** Set by `reload`: take the server's copy instead of resuming from ours. */
  const forceFullJoin = useRef(false);
  const flushRef = useRef<(id: string | null, send: { version: number; ops: OtOp[] } | null, dupIfSource?: readonly string[]) => Promise<void>>(async () => undefined);
  const reconcileUnknownRef = useRef<(id: string) => void>(() => undefined);
  const requestReconnectRef = useRef<(reason: string, immediate?: boolean) => void>(() => undefined);
  /** The root that owns every document currently held by this hook. */
  const connectionRoot = useRef<string | null>(null);
  const remoteDeliveries = useRef(new WeakMap<OtDocument, { tail: Promise<void>; pending: number }>());
  const proofs = useRef(new WeakMap<OtDocument, DocumentProof>());
  const leaving = useRef(new Map<string, Promise<boolean>>());
  const documentEpoch = useRef(0);
  /** When each document last sent a hash; see `HASH_INTERVAL_MS`. */
  const lastHashed = useRef(new WeakMap<OtDocument, number>());
  /** Said once per session: see `asOverleafStores` in ./ot. */
  const toldAboutReplacement = useRef(false);
  const noteReplaced = () => {
    if (toldAboutReplacement.current) return;
    toldAboutReplacement.current = true;
    callbacks.current.onNotice(replacedNotice());
  };

  // A permission is only meaningful for the project whose connect result
  // supplied it. During a root switch, the previous render's role must not be
  // reused for the new project.
  const permission = projectPermission.projectRoot === options.projectRoot ? projectPermission.permission : "unknown";
  /**
   * Whether this account may change the document directly — false for a
   * reviewer, who can only suggest. Unknown fails closed: until Overleaf
   * names a role, neither the live channel nor the durable ZIP synchronizer
   * may assume write access.
   */
  const canWrite = permission === "owner" || permission === "readAndWrite";
  // Read through refs inside the event listener so it can stay mounted for the
  // whole session instead of being torn down on every keystroke.
  const callbacks = useRef(options);
  const canContribute = useRef(canWrite);
  useLayoutEffect(() => {
    callbacks.current = options;
    canContribute.current = canWrite;
  });

  /** Whether `source` is us: this connection, or an earlier one that carried `doc`'s unanswered operation. */
  const isMine = (source: string | null, doc?: OtDocument) => isOwnUpdate(source, publicId.current, doc?.submittedVia);
  /** Replay a join's catch-up into `doc`; our own updates coming back are acknowledgements. */
  const replay = (doc: OtDocument, updates: ReplayedUpdate[]) =>
    doc.catchUp(updates.map((update) => ({ ...update, mine: isOwnUpdate(update.source, publicId.current, doc.submittedVia) })));
  /**
   * After a replay on a new connection, send the still-unanswered operation
   * again, naming every connection it went out on before. If one of those
   * already landed it, Overleaf acknowledges the resend instead of applying it
   * twice; if none did, this is the operation finally arriving. This is what
   * Overleaf's own editor does on reconnect. On the connection that already
   * carried it, nothing is resent: a missing answer there may still come.
   */
  const resendAfterReplay = (id: string, doc: OtDocument) => {
    const current = publicId.current;
    const earlier = doc.submittedVia;
    if (!current || !doc.waiting || !earlier.length || earlier.includes(current)) return;
    const send = doc.resend();
    if (send) void flushRef.current(id, send, send.dupIfSource);
  };
  const deliveryPending = (doc: OtDocument | null | undefined) => Boolean(doc && remoteDeliveries.current.get(doc)?.pending);
  const patchOpenDoc = useCallback((id: string, patch: (current: OpenDoc) => Partial<OpenDoc> | null) => {
    setOpenDoc((current) => {
      if (!current || current.id !== id) return current;
      const next = patch(current);
      return next ? { ...current, ...next } : current;
    });
  }, []);
  const clearSendTimer = () => {
    if (sendTimer.current) clearTimeout(sendTimer.current);
    sendTimer.current = null;
  };
  const cancelDrain = (id: string) => {
    clearTimeout(draining.current.get(id));
    draining.current.delete(id);
  };

  /** Publish the complete set of paths that ordinary syncing must not own. */
  const publishLivePaths = useCallback(() => {
    const next = [...new Set(
      [...documents.current.keys()]
        .map((id) => pathsByDocId.current.get(id))
        .filter((path): path is string => Boolean(path)),
    )].sort();
    setLivePaths((current) => (
      current.length === next.length && current.every((path, index) => path === next[index]) ? current : next
    ));
  }, []);

  /** Replace both directions of the live document tree without dropping held ids. */
  const noteDocumentTree = useCallback((entries: DocEntry[], entityEntries?: EntityEntry[]) => {
    setDocs(new Map(entries.map((doc) => [doc.path, doc.id])));
    setEntities(new Map((entityEntries ?? []).map((entity) => [entity.path, { id: entity.id, kind: entity.kind }])));
    const previous = pathsByDocId.current;
    const next = new Map(entries.map((doc) => [doc.id, doc.path]));
    // A tree event can remove a document while its final operation is still
    // awaiting an answer. Keep that id's last path so REST cannot take it over.
    // If the same id was renamed, `next` already contains the new path and wins.
    for (const id of documents.current.keys()) {
      const lastPath = previous.get(id);
      if (!next.has(id) && lastPath) next.set(id, lastPath);
    }
    pathsByDocId.current = next;
    publishLivePaths();
  }, [publishLivePaths]);

  /** Let go of a document for good: leave the room and forget it. */
  const release = useCallback((id: string) => {
    if (leaving.current.has(id)) return;
    const doc = documents.current.get(id);
    const projectRoot = connectionRoot.current;
    if (!doc || !projectRoot) return;
    cancelDrain(id);
    const proof = proofs.current.get(doc);
    // Rust checkpoints under the sync lease before leaving. Keep frontend
    // ownership too until IPC succeeds; a failed write must not enable REST.
    const pending = invoke("overleaf_rt_leave_doc", {
      projectRoot, docId: id, receipt: proof?.receipt, checkpoint: proof?.lastShared ?? null,
    }).then(() => {
      if (connectionRoot.current === projectRoot && documents.current.get(id) === doc) {
        uncertain.current.delete(id);
        reconciling.current.delete(id);
        documents.current.delete(id);
        publishLivePaths();
      }
      return true;
    }).catch((reason) => {
      const detail = String(reason);
      callbacks.current.onNotice(t`Could not hand this file back to Overleaf sync (${detail}). Syncing remains paused for this file.`);
      return false;
    }).finally(() => {
      if (leaving.current.get(id) === pending) leaving.current.delete(id);
    });
    leaving.current.set(id, pending);
  }, [publishLivePaths, t]);

  /** Release a document that has settled and is no longer the one being edited (or is draining). */
  const releaseIfDone = useCallback((id: string, doc: OtDocument) => {
    if (doc.settled && (draining.current.has(id) || docId.current !== id)) release(id);
  }, [release]);

  /**
   * Keep an ambiguous send away from ordinary syncing and ask Overleaf to
   * replay what happened. A timeout is not a rejection: the server may have
   * committed the operation before its answer was lost.
   */
  const markOutcomeUnknown = useCallback((id: string, reason: unknown) => {
    const first = !uncertain.current.has(id);
    uncertain.current.add(id);
    publishLivePaths();
    const path = pathsByDocId.current.get(id);
    const detail = String(reason);
    const message = path
      ? i18n._(msg`Lattice could not confirm whether Overleaf accepted the latest edit to ${path} (${detail}). Syncing is paused for this file while Lattice checks.`)
      : i18n._(msg`Lattice could not confirm whether Overleaf accepted the latest edit to this file (${detail}). Syncing is paused for this file while Lattice checks.`);
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
    documentEpoch.current += 1;
    clearSendTimer();
    const previous = docId.current;
    const typed = unsentText.current;
    unsentText.current = null;
    docId.current = null;
    setLiveFile(false);
    setOpenDoc(null);
    const doc = previous ? documents.current.get(previous) : undefined;
    if (!previous || !doc) return;

    if (typed !== null && canContribute.current) {
      const proof = proofs.current.get(doc);
      if (proof) proof.locallyAppliedText = typed;
      // The last thing typed leaves the same way everything before it did.
      const { send, replaced } = doc.local(typed);
      if (replaced) noteReplaced();
      void flushRef.current(previous, send);
    }
    if (doc.settled) {
      release(previous);
      return;
    }
    // Held until the server answers, and no longer: a document that will never
    // settle — the connection died mid-operation — must not keep its room for
    // the rest of the session.
    draining.current.set(previous, setTimeout(() => {
      const held = documents.current.get(previous);
      if (!held || held.settled) release(previous);
      else markOutcomeUnknown(previous, i18n._(msg`the acknowledgement did not arrive in time`));
    }, DRAIN_TIMEOUT_MS));
  }, [markOutcomeUnknown, release]);

  /** Every document goes, on the way to shutting the connection down. */
  const stopEverything = useCallback(() => {
    stopDocument();
    for (const id of [...documents.current.keys()]) release(id);
    // Intentional project teardown has no remaining frontend sync owner.
    documents.current.clear();
    leaving.current.clear();
    publishLivePaths();
  }, [publishLivePaths, release, stopDocument]);

  /** Hand disk edits to ordinary sync without discarding unacknowledged OT. */
  const suspendPaths = useCallback((paths: readonly string[]) => {
    const { projectRoot, activeFile } = callbacks.current;
    if (!projectRoot || !paths.length) return;
    for (const path of paths) suspendedPaths.current.add(path);
    if (activeFile && suspendedPaths.current.has(activeFile)) {
      // The buffer and disk no longer share OT's base. Preserve the buffer for
      // save's three-way merge; only already-owned operations may still drain.
      unsentText.current = null;
      stopDocument();
      setReloadNonce((nonce) => nonce + 1);
    }
    callbacks.current.onNeedsSync?.(paths);
  }, [stopDocument]);

  /** Rejoin only files whose ordinary sync completed and whose OT has drained. */
  const resumePaths = useCallback((paths: readonly string[]) => {
    const { projectRoot, activeFile } = callbacks.current;
    if (!projectRoot) return;
    for (const path of paths) {
      const owned = [...documents.current.keys()].some((id) => pathsByDocId.current.get(id) === path);
      if (owned || !suspendedPaths.current.delete(path)) continue;
      if (path === activeFile) setReloadNonce((nonce) => nonce + 1);
    }
  }, []);

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
    void invoke("overleaf_rt_disconnect", { projectRoot }).catch(() => {});
  }, [stopAfterDisconnect]);

  /**
   * Give up on one document without giving up the connection: one file
   * failing says nothing about the others, or about chat, presence and the
   * file tree riding the same socket. This file falls back to syncing.
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

  // OT advances synchronously, but checking/writing the disk crosses IPC. Keep
  // deliveries ordered and never send an intermediate editor snapshot back
  // over a newer remote operation. A disagreement hands the file back to the
  // ordinary three-way synchronizer, retaining any unacknowledged OT lease.
  const deliverRemoteText = useCallback((id: string, text: string, caret: number, baseContent: string) => {
    const doc = documents.current.get(id);
    const projectRoot = connectionRoot.current;
    const path = pathsByDocId.current.get(id);
    if (!doc || !projectRoot || !path) return;
    const epoch = documentEpoch.current;
    const deliveredVersion = doc.version;
    const deliveredSettled = doc.settled;
    const isCurrent = () => connectionRoot.current === projectRoot
      && documentEpoch.current === epoch
      && documents.current.get(id) === doc && docId.current === id
      && callbacks.current.projectRoot === projectRoot && callbacks.current.activeFile === path;
    if (!isCurrent()) return;
    clearSendTimer();
    unsentText.current = null;
    setLiveFile(false);
    let queue = remoteDeliveries.current.get(doc);
    if (!queue) remoteDeliveries.current.set(doc, queue = { tail: Promise.resolve(), pending: 0 });
    const delivery = queue;
    delivery.pending += 1;
    const preserveLocal = () => {
      if (!isCurrent()) return;
      // Do not publish the stale debounce as a new replacement operation.
      // stopDocument drains only operations already owned by OT.
      suspendPaths([path]);
      const message = t`This file changed outside live editing. Local work was kept; regular Overleaf sync will reconcile it.`;
      setDetail(message);
      if (!callbacks.current.onNeedsSync) callbacks.current.onNotice(message);
    };
    delivery.tail = delivery.tail.then(async () => {
      if (!isCurrent()) return;
      try {
        const accepted = await callbacks.current.onRemoteText(text, caret, { projectRoot, path, baseContent, isCurrent });
        const proof = proofs.current.get(doc);
        if (accepted === false) preserveLocal();
        else if (isCurrent() && proof) {
          proof.locallyAppliedText = text;
          if (proof.textModelValid && deliveredSettled) proof.lastShared = { text, version: deliveredVersion };
          promoteShared(doc, proof);
        }
      } catch {
        preserveLocal();
      }
    }).finally(() => {
      delivery.pending -= 1;
      if (!delivery.pending && isCurrent()) setLiveFile(true);
    });
  }, [suspendPaths, t]);

  /** Move the open document's anchors along with `ops`; see `anchorsAfter`. */
  const shiftAnchors = useCallback((id: string, ops: OtOp[]) => {
    if (ops.length) patchOpenDoc(id, (current) => anchorsAfter(current, ops));
  }, [patchOpenDoc]);

  /**
   * Ask the server to replay from the last version we trust after a send's
   * acknowledgement went missing.
   *
   * If our update is in the replay, `catchUp` treats it as the missing ack. If
   * it is not, the outcome remains unknown: a late server apply is still
   * possible, so the document stays held rather than being handed to REST.
   */
  const reconcileUnknown = useCallback(async (id: string) => {
    const doc = documents.current.get(id);
    const projectRoot = connectionRoot.current;
    if (reconciling.current.has(id) || !doc || !uncertain.current.has(id) || !projectRoot) return;
    reconciling.current.add(id);
    try {
      const receipt = crypto.randomUUID();
      const joined = await invoke<JoinedDoc>("overleaf_rt_join_doc", { projectRoot, docId: id, fromVersion: doc.version, receipt });
      if (connectionRoot.current !== projectRoot || documents.current.get(id) !== doc) return;
      const proof = proofs.current.get(doc);
      if (proof) proof.receipt = receipt;
      if (!joined.resumed) return;
      const caughtUp = joined.caughtUp ?? [];
      if (!publicId.current && caughtUp.length) {
        // With an operation already in flight, replaying a source we cannot
        // identify may apply our own text a second time. Keep the outcome
        // unknown until the connection supplies our public id.
        if (docId.current === id) {
          setDetail(i18n._(msg`Overleaf replayed updates before Lattice could identify this connection. Syncing remains paused for this file.`));
        }
        return;
      }
      const sawOurUpdate = caughtUp.some((update) => isMine(update.source, doc));
      const caret = docId.current === id ? callbacks.current.readCaret() : 0;
      const baseContent = doc.text;
      const result = replay(doc, caughtUp);
      promoteShared(doc, proof);
      shiftAnchors(id, result.applied);
      if (docId.current === id) {
        patchOpenDoc(id, (current) => ({ comments: joined.comments ?? current.comments, changes: joined.changes ?? current.changes }));
        deliverRemoteText(id, result.text, transformCaret(caret, result.applied), baseContent);
      }
      if (result.send) void flushRef.current(id, result.send);
      else resendAfterReplay(id, doc);
      if (sawOurUpdate || doc.settled) {
        uncertain.current.delete(id);
        publishLivePaths();
        if (docId.current === id) setDetail(null);
      }
      releaseIfDone(id, doc);
    } catch {
      // Still unknown. Keeping the path in livePaths is the safety mechanism;
      // a later ack or reconnect can resolve it without a blind retransmit.
    } finally {
      if (connectionRoot.current === projectRoot) reconciling.current.delete(id);
    }
  }, [deliverRemoteText, patchOpenDoc, publishLivePaths, releaseIfDone, shiftAnchors]);
  useEffect(() => {
    reconcileUnknownRef.current = (id) => void reconcileUnknown(id);
  }, [reconcileUnknown]);

  /** Send whatever a document says is ready, if anything. */
  const flush = useCallback(async (
    id: string | null, send: { version: number; ops: OtOp[] } | null, dupIfSource: readonly string[] = [],
  ) => {
    if (!send || !id) return;
    const projectRoot = connectionRoot.current;
    if (!projectRoot) {
      markOutcomeUnknown(id, i18n._(msg`the Overleaf project connection is no longer active`));
      return;
    }
    const doc = documents.current.get(id);
    // Recorded before the send can fail: an operation whose answer is lost
    // with its connection must still be recognised as ours when it is
    // replayed under this id after a reconnect.
    if (publicId.current) doc?.noteSubmitted(publicId.current);
    // Now and then, say what the document should read once this lands.
    // Overleaf rejects the update when its copy disagrees, so a copy that has
    // drifted fails loudly — and falls back to syncing — instead of every
    // later edit landing in the wrong place. Like Overleaf's own editor, not
    // on every keystroke: hashing the whole document costs.
    const sentText = doc && doc.version === send.version ? doc.sentText : null;
    const now = Date.now();
    const hashDue = sentText !== null && now - (lastHashed.current.get(doc!) ?? -Infinity) >= HASH_INTERVAL_MS;
    if (hashDue) lastHashed.current.set(doc!, now);
    try {
      const hash = hashDue ? await overleafDocHash(sentText) : null;
      await invoke("overleaf_rt_send_ops", {
        projectRoot, docId: id, version: send.version, ops: send.ops,
        ...(dupIfSource.length ? { dupIfSource } : {}), ...(hash ? { hash } : {}),
      });
    } catch (reason) {
      // A rejected Promise only says the acknowledgement did not reach this
      // call. The server may already have committed the operation, so handing
      // the file to REST (or blindly sending the op again) could duplicate or
      // overwrite it. Keep ownership and reconcile by replaying history.
      if (connectionRoot.current === projectRoot) markOutcomeUnknown(id, reason);
    }
  }, [markOutcomeUnknown]);
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  // ---- events -------------------------------------------------------------
  // Registered before anything connects, so nothing the backend emits during
  // the join can be missed. Only the project this hook is connecting is heard:
  // a disconnect queued by the previous project must not tear down, or
  // reconnect, the next one's channel.

  useEffect(() => onOverleafEvent(() => (callbacks.current.enabled ? callbacks.current.projectRoot : null), (payload) => {
    switch (payload.type) {
      case "connected":
        publicId.current = payload.publicId;
        for (const id of uncertain.current) reconcileUnknownRef.current(id);
        return;
      case "projectJoined":
      case "treeChanged":
        // Somebody created, renamed, moved or deleted something; a file that
        // appeared this way is joinable straight away. A permission is never
        // taken from these events, only from the connect result: each
        // handshake must name the role for the connection it set up.
        noteDocumentTree(payload.docs, payload.type === "treeChanged" ? payload.entities : undefined);
        return;
      case "disconnected": {
        const reason = payload.reason || i18n._(msg`The realtime connection closed.`);
        stopAfterDisconnect(reason);
        requestReconnectRef.current(reason);
        return;
      }
      case "otError": {
        // Overleaf addresses a rejection to the document it happened in, and
        // one document failing says nothing about the others.
        if (payload.docId && !documents.current.has(payload.docId)) return;
        const detail = payload.message;
        if (payload.docId) dropDocument(payload.docId, i18n._(msg`Overleaf rejected a live update (${detail}).`));
        else fail(detail);
        callbacks.current.onNotice(i18n._(msg`Overleaf rejected a live update (${detail}). Falling back to syncing.`));
        return;
      }
      case "docAck": {
        // Overleaf never sends an operation back to whoever sent it: the
        // originating client gets the version alone, and that is the
        // acknowledgement. Answers arrive for a document being drained too,
        // and that is the point of keeping it.
        const doc = documents.current.get(payload.docId);
        if (!doc) return;
        try {
          const wasUncertain = uncertain.current.delete(payload.docId);
          publishLivePaths();
          const versionBefore = doc.version;
          void flush(payload.docId, doc.acknowledge(payload.version).send);
          if (doc.version !== versionBefore) promoteShared(doc, proofs.current.get(doc));
          if (wasUncertain && docId.current === payload.docId) setDetail(null);
          releaseIfDone(payload.docId, doc);
        } catch (reason) {
          dropDocument(payload.docId, toMessage(reason));
          callbacks.current.onNotice(driftNotice());
        }
        return;
      }
      case "changesAccepted":
        // Accepted suggestions become ordinary text without an operation, so
        // the only way to learn the new ranges is to ask again.
        patchOpenDoc(payload.docId, (current) => ({
          changes: current.changes.filter((change) => !payload.changeIds.includes(change.id)),
        }));
        return;
      case "commentAnchored":
        // Someone commented on the file we have open; show the marker without
        // making them re-open it.
        patchOpenDoc(payload.docId, (current) => (
          current.comments.some((item) => item.threadId === payload.range.threadId)
            ? null
            : { comments: [...current.comments, payload.range] }
        ));
        return;
      case "docUpdate": {
        const doc = documents.current.get(payload.docId);
        if (!doc) {
          joiningUpdates.current.get(payload.docId)?.push(payload);
          return;
        }
        // Our own work coming back is already in this copy; only the separate
        // acknowledgement moves the state machine on.
        if (isMine(payload.source, doc)) return;
        try {
          const onScreen = payload.docId === docId.current;
          const caret = onScreen ? callbacks.current.readCaret() : 0;
          const baseContent = doc.text;
          const { text, applied } = doc.remote(payload.ops, payload.version);
          shiftAnchors(payload.docId, applied);
          // A document being drained still has to apply this, or its own
          // outstanding operation is transformed against the wrong history.
          // Nobody is looking at it, so nothing is drawn.
          if (onScreen) deliverRemoteText(payload.docId, text, transformCaret(caret, applied), baseContent);
        } catch (reason) {
          dropDocument(payload.docId, toMessage(reason));
          callbacks.current.onNotice(driftNotice());
        }
      }
    }
  }), [deliverRemoteText, dropDocument, fail, flush, noteDocumentTree, patchOpenDoc, publishLivePaths, releaseIfDone, shiftAnchors, stopAfterDisconnect]);

  // ---- connection ---------------------------------------------------------

  useEffect(() => {
    if (!options.enabled || !options.projectRoot) {
      requestReconnectRef.current = () => undefined;
      setStatus("off");
      setDetail(null);
      noteDocumentTree([]);
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
    // Every handshake may return a different role, and the connection that
    // established the current one may be gone: fail closed until Overleaf
    // names a role again, rather than keeping a revoked writer permission.
    const forgetPermission = () => setProjectPermission({ projectRoot: connectingRoot, permission: "unknown" });
    const scheduleReconnect = (reason: string, immediate = false) => {
      if (cancelled) return;
      needsReconnect = true;
      lastReason = reason;
      forgetPermission();
      if (retryTimer || connecting) return;
      const delay = immediate ? 0 : Math.min(RECONNECT_BASE_MS * 2 ** retryAttempt, RECONNECT_MAX_MS);
      if (!immediate) retryAttempt += 1;
      setStatus("connecting");
      const seconds = Math.ceil(delay / 1_000);
      setDetail(delay === 0
        ? i18n._(msg`Overleaf live editing disconnected (${reason}). Reconnecting now…`)
        : i18n._(msg`Overleaf live editing disconnected (${reason}). Reconnecting in ${seconds}s…`));
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (cancelled || connecting) return;
      connecting = true;
      forgetPermission();
      setStatus("connecting");
      if (!needsReconnect) setDetail(null);
      try {
        const joined = await invoke<JoinedProject>("overleaf_rt_connect", { projectRoot: connectingRoot });
        if (cancelled) return;
        // The join answer carries the document ids, so live editing can start
        // without waiting on — or racing — the event of the same name.
        // Overleaf may not have named us yet; the `connected` event fills that
        // in, and an empty id here would make our own echo look like someone
        // else's edit and apply it twice.
        if (joined.publicId) publicId.current = joined.publicId;
        connectionRoot.current = connectingRoot;
        noteDocumentTree(joined.docs, joined.entities);
        setProjectPermission({ projectRoot: connectingRoot, permission: joined.permission });
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
        if (recovered) callbacks.current.onNotice(i18n._(msg`Overleaf live editing reconnected.`));
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
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      scheduleReconnect(lastReason || i18n._(msg`the network became available`), true);
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
      // An intentional project/unlink transition, not an unexplained network
      // failure: no synchronizer remains for the old project, so release its
      // rooms instead of carrying their paths into the next project.
      stopEverything();
      if (connectionRoot.current === connectingRoot) connectionRoot.current = null;
      void invoke("overleaf_rt_disconnect", { projectRoot: connectingRoot }).catch(() => {});
    };
  }, [noteDocumentTree, options.enabled, options.projectRoot, stopEverything]);

  // The ZIP synchronizer also enforces this permission from its durable
  // SyncState. Keep it in step with the live channel, but never persist
  // "unknown": absence of evidence must not turn into write permission.
  useEffect(() => {
    const { projectRoot, permission: scopedPermission } = projectPermission;
    if (!projectRoot || projectRoot !== options.projectRoot || scopedPermission === "unknown") return;
    void invoke("overleaf_set_permission", { permission: scopedPermission, projectRoot }).catch((reason) => {
      const detail = String(reason);
      callbacks.current.onNotice(i18n._(msg`Could not record Overleaf's ${scopedPermission} permission locally (${detail}).`));
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
    // Only text documents Overleaf tracks can be edited live; anything else
    // (figures, files added since we joined) keeps going through syncing.
    const id = activeDocId;
    if (!options.documents || status !== "live" || !options.activeFile || !id) return;
    if (suspendedPaths.current.has(options.activeFile)) return;
    const activeFile = options.activeFile;
    let cancelled = false;
    const pendingUpdates: DocUpdateEvent[] = [];
    const pendingByDocument = joiningUpdates.current;
    pendingByDocument.set(id, pendingUpdates);
    // Coming back to a document that was still draining: it is being edited
    // again, so the timer that would have given up its room has to go, or it
    // would fire in the middle of typing.
    cancelDrain(id);
    // A document we still hold is one we were editing a moment ago. Asking to
    // resume from its version makes the server replay what it did meanwhile
    // instead of only stating where it ended up, which is the difference
    // between keeping work that never reached it and overwriting it.
    const fullJoin = forceFullJoin.current;
    forceFullJoin.current = false;
    let held = fullJoin ? undefined : documents.current.get(id);
    const joiningRoot = connectionRoot.current;
    if (!joiningRoot) {
      setDetail(i18n._(msg`The Overleaf project connection is no longer active.`));
      return;
    }
    const receipt = crypto.randomUUID();
    const pauseUnproven = (reason: string, message: string) => {
      markOutcomeUnknown(id, reason);
      setDetail(message);
    };
    void (async () => {
      const pendingLeave = leaving.current.get(id);
      if (pendingLeave) {
        if (!await pendingLeave) throw new Error(t`The previous Overleaf document could not be released. Syncing remains paused.`);
        held = undefined;
      }
      if (cancelled) return null;
      return invoke<JoinedDoc>("overleaf_rt_join_doc", {
        projectRoot: joiningRoot, docId: id, fromVersion: held?.version ?? null, receipt,
      });
    })().then((joined) => {
      if (!joined) return;
      if (cancelled) {
        // Joined after the writer moved on. Leave, or the room stays
        // subscribed for the rest of the session. A replacement join for the
        // same document owns that room now, so the stale attempt must not
        // unsubscribe it.
        if (!documents.current.has(id) && !joiningUpdates.current.has(id)) {
          void invoke("overleaf_rt_leave_doc", { projectRoot: joiningRoot, docId: id, receipt, checkpoint: null }).catch(() => {});
        }
        return;
      }
      let text = joined.text;
      let caret = callbacks.current.readCaret();
      const heldProof = held && proofs.current.get(held);
      if (heldProof) heldProof.receipt = receipt;
      if (held && !held.settled && !joined.resumed) {
        pauseUnproven(
          i18n._(msg`Overleaf could not replay from the last version Lattice trusts`),
          i18n._(msg`Overleaf could not replay enough history to confirm the last edit to ${activeFile}. Syncing remains paused for this file.`),
        );
        return;
      }
      if (held && joined.resumed) {
        const caughtUp = joined.caughtUp ?? [];
        if (held.waiting && !publicId.current && caughtUp.length) {
          pauseUnproven(
            i18n._(msg`the connection id needed to classify replayed updates is not available`),
            i18n._(msg`Lattice cannot yet identify which replayed edits to ${activeFile} are its own. Syncing remains paused for this file.`),
          );
          return;
        }
        // Classified before replaying: an acknowledgement in the replay
        // forgets which connections carried the operation it answers.
        const sawOurUpdate = caughtUp.some((update) => isMine(update.source, held));
        const result = replay(held, caughtUp);
        text = result.text;
        promoteShared(held, heldProof);
        caret = transformCaret(caret, result.applied);
        if (result.send) void flush(id, result.send);
        else resendAfterReplay(id, held);
        if (held.settled || sawOurUpdate) uncertain.current.delete(id);
      } else {
        // Either the first time here, or the server would not reach back far
        // enough. Its copy is the only thing both sides agree on.
        const doc = held ?? new OtDocument(joined.text, joined.version);
        doc.reset(joined.text, joined.version);
        proofs.current.set(doc, { receipt, lastShared: null, locallyAppliedText: null, textModelValid: true });
        documents.current.set(id, doc);
        uncertain.current.delete(id);
        caret = callbacks.current.readCaret();
      }
      // Joining the socket room and returning its snapshot cross an async IPC
      // boundary. Updates can arrive in between; replay them over the snapshot
      // instead of silently leaving the local buffer one version behind.
      const ownsBuffer = pendingByDocument.get(id) === pendingUpdates;
      const buffered = ownsBuffer ? pendingUpdates.splice(0) : [];
      if (ownsBuffer) pendingByDocument.delete(id);
      const joinedDocument = documents.current.get(id);
      const bufferedApplied: OtOp[][] = [];
      if (joinedDocument) {
        buffered.sort((left, right) => left.version - right.version);
        try {
          for (const update of buffered) {
            const versionBefore = joinedDocument.version;
            const result = joinedDocument.remote(update.ops, update.version);
            text = result.text;
            // The snapshot already contains older buffered updates, but the
            // editor caret predates that snapshot and still has to cross them.
            caret = transformCaret(caret, !held && update.version < versionBefore ? update.ops : result.applied);
            if (result.applied.length) bufferedApplied.push(result.applied);
          }
        } catch (reason) {
          const message = toMessage(reason);
          if (joinedDocument.settled) dropDocument(id, message);
          else markOutcomeUnknown(id, message);
          setDetail(message);
          callbacks.current.onNotice(i18n._(msg`This document drifted while live editing started, so Lattice stopped joining it. Syncing will reconcile it.`));
          return;
        }
      }
      publishLivePaths();
      docId.current = id;
      setOpenDoc({ id, comments: joined.comments ?? [], changes: joined.changes ?? [] });
      for (const applied of bufferedApplied) shiftAnchors(id, applied);
      setDetail(null);
      // A full/reconnected snapshot has no trusted relationship to local
      // disk edits. Only start OT when it agrees; otherwise regular sync
      // owns the common ancestor and can reconcile both sides safely.
      deliverRemoteText(id, text, caret, text);
    }).catch((reason) => {
      if (!cancelled) setDetail(String(reason));
    });
    return () => {
      cancelled = true;
      if (pendingByDocument.get(id) === pendingUpdates) pendingByDocument.delete(id);
    };
  }, [
    options.activeFile, options.documents, options.projectRoot, activeDocId, status, reloadNonce,
    deliverRemoteText, stopDocument, flush, dropDocument, markOutcomeUnknown, publishLivePaths, shiftAnchors, t,
  ]);

  // ---- local edits and out-of-band operations -------------------------------

  /** Feed the editor's current text in; ops go out when it differs. */
  const pushLocal = useCallback((text: string) => {
    const id = docId.current;
    if (!id || !documents.current.has(id) || !canContribute.current || deliveryPending(documents.current.get(id))) return;
    // Coalesce keystrokes briefly: one operation per short pause keeps the
    // channel quiet without anyone noticing a delay. Held where leaving the
    // document can find it, because until the timer fires this text exists
    // nowhere else on this side of the wire.
    unsentText.current = text;
    clearSendTimer();
    sendTimer.current = setTimeout(() => {
      sendTimer.current = null;
      unsentText.current = null;
      // Read again rather than closing over it: the writer may have moved to
      // another file in the meantime, and this text belongs to the old one.
      const current = docId.current === id ? documents.current.get(id) : null;
      if (!current) return;
      const { send, replaced } = current.local(text);
      const proof = proofs.current.get(current);
      if (proof) proof.locallyAppliedText = text;
      if (send) shiftAnchors(id, send.ops);
      void flush(id, send);
      if (replaced) {
        // Overleaf stores these characters as U+FFFD, and so does the
        // document now; the editor has to show the same, or the two copies
        // disagree without anyone being told. Same length, same caret.
        noteReplaced();
        deliverRemoteText(id, current.text, callbacks.current.readCaret(), text);
      }
    }, SEND_DEBOUNCE_MS);
  }, [deliverRemoteText, flush, shiftAnchors]);

  /**
   * Anchor a new comment thread to a span of the open document. Resolves once
   * Overleaf has it; rejects when the document is not live or an edit is still
   * in flight, which the caller should report rather than swallow.
   */
  const anchorComment = useCallback(async (target: OverleafCommentTarget, threadId: string, position: number, quote: string) => {
    const doc = documents.current.get(target.docId);
    if (
      !doc
      || docId.current !== target.docId
      || connectionRoot.current !== target.projectRoot
      || callbacks.current.activeFile !== target.path
      || deliveryPending(doc)
    ) {
      throw new Error(t`The commented file is no longer open live with Overleaf. Try again.`);
    }
    // An anchor is an operation like any other, so it needs the wire to
    // itself; typing while one is outstanding would be built on a version the
    // server has not confirmed.
    const reserved = doc.anchor();
    if (!reserved) throw new Error(t`An edit is still on its way to Overleaf. Try again in a moment.`);
    try {
      await invoke("overleaf_rt_send_comment", {
        projectRoot: target.projectRoot, docId: target.docId, version: reserved.version, position, quote, threadId,
      });
    } catch (reason) {
      fail(String(reason), target.projectRoot);
      throw reason;
    }
    // Show it straight away rather than waiting for the round trip.
    patchOpenDoc(target.docId, (current) => ({ comments: [...current.comments, { threadId, position, quote }] }));
  }, [fail, patchOpenDoc, t]);

  const openDocument = () => (docId.current ? documents.current.get(docId.current) : undefined);
  /** Text inside the send debounce has not entered OtDocument yet, but it is still local work. */
  const typingUnsent = () => sendTimer.current !== null || unsentText.current !== null;

  return {
    status,
    detail: options.documents && status === "live" && options.activeFile && !activeDocId
      ? t`Overleaf doesn’t support live editing for this file, so it will use regular sync.`
      : detail,
    /** True when the open file is being edited through the live channel. */
    liveFile,
    /**
     * Every path still owned by the live channel, including a file that is no
     * longer open but is waiting for an acknowledgement. Ordinary syncing must
     * skip all of them: an acknowledgement can arrive after the writer switches
     * tabs, and uploading the same bytes meanwhile would be an out-of-band
     * overwrite.
     */
    livePaths,
    /** Overleaf's id for the open document, when it has one. */
    docId: openDoc?.id ?? null,
    permission,
    canWrite,
    /** Everything in the project by path, with the id its endpoints take (deleting a file needs it). */
    entities,
    /** Comment anchors in the open document, as Overleaf holds them. */
    comments: openDoc?.comments ?? EMPTY_COMMENTS,
    /** Suggestions in the open document. */
    changes: openDoc?.changes ?? EMPTY_CHANGES,
    /**
     * Take the wire for an operation this hook does not build itself — the
     * inverse operations that reject a suggestion — and answer with the version
     * to send it at. Null when the document is not live or one of our own
     * operations is unacknowledged: the server numbers versions, so a second
     * operation built on an unconfirmed one would apply against the wrong history.
     */
    reserveOperation: (): ReservedOperation | null => {
      const id = docId.current;
      const doc = openDocument();
      if (deliveryPending(doc)) return null;
      const anchor = doc?.anchor();
      if (!id || !doc || !anchor) return null;
      // Rejection sends real inverse text ops outside OtDocument, although
      // its reservation is empty. Keep the old shared proof but never claim
      // this model is current again until a full reset and guarded delivery.
      const proof = proofs.current.get(doc);
      if (proof) proof.textModelValid = false;
      return { docId: id, version: anchor.version };
    },
    /** A reserved operation failed without proving whether the server committed it: reconcile by replay. */
    noteReservedOperationUnknown: (reservation: ReservedOperation, reason: unknown) => {
      if (documents.current.get(reservation.docId)?.waiting) markOutcomeUnknown(reservation.docId, reason);
    },
    /** The server version when the open document has nothing local in flight; unlike `reserveOperation`, keeps the wire free. */
    settledVersion: () => {
      const doc = openDocument();
      // Treating debounced typing as settled would let a REST mutation reload
      // the server copy over those keystrokes.
      if (typingUnsent() || deliveryPending(doc)) return null;
      return doc?.settled ? doc.version : null;
    },
    /** Re-read the open document, after accepting or rejecting a suggestion. */
    reload: () => {
      const id = docId.current;
      const doc = openDocument();
      if (typingUnsent() || (doc && !doc.settled) || deliveryPending(doc)) {
        setDetail(i18n._(msg`A local edit has not settled on Overleaf yet, so this document cannot be reloaded safely.`));
        if (id && uncertain.current.has(id)) reconcileUnknownRef.current(id);
        return;
      }
      // Start over from the server's copy rather than resuming from ours:
      // reload follows a change no operation describes — a suggestion
      // accepted, or rejected by an operation we never applied here — so our
      // copy is exactly what cannot be trusted.
      forceFullJoin.current = true;
      setReloadNonce((nonce) => nonce + 1);
    },
    pushLocal,
    suspendPaths,
    resumePaths,
    anchorComment,
  };
}
