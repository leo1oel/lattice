/**
 * The live channel's connection for one project: connecting, reconnecting
 * with backoff after a drop (sooner when the network or the window comes
 * back), and the project permission each handshake names. Part of
 * useOverleafRealtime, which owns the documents riding on it.
 */
import { useEffect, type RefObject } from "react";
import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { i18n } from "../i18n";
import type { OverleafConnectionStore } from "./overleaf-connection-store";
import {
  isOverleafProjectRefusal, OVERLEAF_REFUSAL_RETRIES, reconnectingDetail, shouldRetryConnection, type JoinedProject,
} from "./overleaf-realtime-model";
import type { useOpenDocReview } from "./use-open-doc-review";
import type { useOverleafDocumentTree } from "./use-overleaf-document-tree";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export function useOverleafRealtimeConnection({
  store, enabled, projectRoot: root, projectPermission, callbacksRef,
  publicIdRef, connectionRootRef, uncertainRef, reconcileUnknownRef, requestReconnectRef,
  noteDocumentTree, noteProject, stopEverything,
}: {
  store: OverleafConnectionStore;
  enabled: boolean;
  projectRoot: string | null;
  projectPermission: ReturnType<OverleafConnectionStore["getState"]>["projectPermission"];
  callbacksRef: RefObject<{ onNotice: (message: string) => void }>;
  /** Overleaf's name for this connection, once a handshake gave one. */
  publicIdRef: RefObject<string | null>;
  /** The root that owns every document the channel holds. */
  connectionRootRef: RefObject<string | null>;
  /** Documents whose last send has an unknown outcome, reconciled once connected. */
  uncertainRef: RefObject<Set<string>>;
  reconcileUnknownRef: RefObject<(id: string) => void>;
  requestReconnectRef: RefObject<(reason: string, immediate?: boolean) => void>;
  noteDocumentTree: ReturnType<typeof useOverleafDocumentTree>["noteDocumentTree"];
  noteProject: ReturnType<typeof useOpenDocReview>["noteProject"];
  /** Let go of every document, on the way to shutting the connection down. */
  stopEverything: () => void;
}) {
  const { setStatus, setDetail, setProjectPermission } = store.getState();
  useEffect(() => {
    if (!enabled || !root) {
      requestReconnectRef.current = () => undefined;
      setStatus("off");
      setDetail(null);
      noteDocumentTree([]);
      setProjectPermission({ projectRoot: null, permission: "unknown" });
      stopEverything();
      connectionRootRef.current = null;
      // `null` is an intentional global disconnect. An empty string used to
      // become a scoped path that matched nothing and left the old socket live.
      void invoke("overleaf_rt_disconnect", { projectRoot: null }).catch(() => {});
      return;
    }
    const connectingRoot = root;
    let cancelled = false;
    let connecting = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryAttempt = 0;
    let needsReconnect = false;
    // The connect command installs the new client, then waits on the sync
    // lease (as long as a full sync) before answering. A drop in that wait is
    // this attempt's own socket going down, since the backend only forwards
    // the newest connection's events, so its answer must not mark it live.
    let droppedWhileConnecting = false;
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
      if (connecting) droppedWhileConnecting = true;
      if (retryTimer || connecting) return;
      const delay = immediate ? 0 : Math.min(RECONNECT_BASE_MS * 2 ** retryAttempt, RECONNECT_MAX_MS);
      if (!immediate) retryAttempt += 1;
      setStatus("connecting");
      setDetail(reconnectingDetail(reason, delay));
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (cancelled || connecting) return;
      connecting = true;
      droppedWhileConnecting = false;
      forgetPermission();
      setStatus("connecting");
      if (!needsReconnect) setDetail(null);
      try {
        const joined = await invoke<JoinedProject>("overleaf_rt_connect", { projectRoot: connectingRoot });
        if (cancelled) return;
        if (droppedWhileConnecting) {
          // Another try, backing off further (as for a failed connect).
          connecting = false;
          scheduleReconnect(lastReason);
          return;
        }
        // The join answer carries the document ids, so live editing can start
        // without waiting on — or racing — the event of the same name.
        // Overleaf may not have named us yet; the `connected` event fills that
        // in, and an empty id here would make our own echo look like someone
        // else's edit and apply it twice.
        if (joined.publicId) publicIdRef.current = joined.publicId;
        connectionRootRef.current = connectingRoot;
        noteDocumentTree(joined.docs, joined.entities);
        setProjectPermission({ projectRoot: connectingRoot, permission: joined.permission });
        noteProject(joined);
        setStatus("live");
        setDetail(null);
        const recovered = needsReconnect;
        needsReconnect = false;
        retryAttempt = 0;
        lastReason = "";
        // The handshake's connected event can arrive before Rust installs the
        // new client. Reconcile uncertain sends once the command itself has
        // returned, when joining their history is guaranteed to be possible.
        for (const id of uncertainRef.current) reconcileUnknownRef.current(id);
        if (recovered) callbacksRef.current.onNotice(i18n._(msg`Overleaf live editing reconnected.`));
      } catch (reason) {
        if (cancelled) return;
        const message = String(reason);
        const refusedTooOften = isOverleafProjectRefusal(message) && retryAttempt >= OVERLEAF_REFUSAL_RETRIES;
        if (shouldRetryConnection(message) && !refusedTooOften) {
          // Mark the call complete before scheduling: the scheduler refuses
          // to overlap connection attempts.
          connecting = false;
          scheduleReconnect(message);
          return;
        }
        needsReconnect = false;
        setStatus("error");
        setDetail(refusedTooOften
          ? i18n._(msg`Overleaf keeps refusing live editing for this project, though you are still signed in. Check that the project still opens on Overleaf.`)
          : message);
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
      if (connectionRootRef.current === connectingRoot) connectionRootRef.current = null;
      void invoke("overleaf_rt_disconnect", { projectRoot: connectingRoot }).catch(() => {});
    };
    // The refs are stable; listed because they arrive as arguments.
  }, [
    noteDocumentTree, noteProject, enabled, root, setDetail, setProjectPermission, setStatus, stopEverything,
    callbacksRef, connectionRootRef, publicIdRef, reconcileUnknownRef, requestReconnectRef, uncertainRef,
  ]);

  // The ZIP synchronizer also enforces this permission from its durable
  // SyncState. Keep it in step with the live channel, but never persist
  // "unknown": absence of evidence must not turn into write permission.
  useEffect(() => {
    const { projectRoot, permission: scopedPermission } = projectPermission;
    if (!projectRoot || projectRoot !== root || scopedPermission === "unknown") return;
    void invoke("overleaf_set_permission", { permission: scopedPermission, projectRoot }).catch((reason) => {
      const detail = String(reason);
      callbacksRef.current.onNotice(i18n._(msg`Could not record Overleaf's ${scopedPermission} permission locally (${detail}).`));
    });
  }, [root, projectPermission, callbacksRef]);
}
