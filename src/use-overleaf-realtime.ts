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
type JoinedProject = { publicId: string | null; rootFolderId: string; docs: DocEntry[] };

type RealtimeEvent =
  | { type: "connected"; publicId: string }
  | { type: "projectJoined"; rootFolderId: string; docs: DocEntry[] }
  | { type: "docUpdate"; docId: string; version: number; ops: OtOp[]; source: string | null }
  | { type: "otError"; docId: string; message: string }
  | { type: "disconnected"; reason: string };

export type RealtimeStatus = "off" | "connecting" | "live" | "error";

export type OverleafRealtime = {
  status: RealtimeStatus;
  detail: string | null;
  /** True when the open file is being edited through the live channel. */
  liveFile: boolean;
  /** Feed the editor's current text in; ops go out when it differs. */
  pushLocal: (text: string) => void;
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
  // State, not a ref: the tree can arrive from the connect call or from an
  // event, and either way the effect that joins the open document has to run
  // again once it does.
  const [docs, setDocs] = useState<Map<string, string>>(new Map());

  const publicId = useRef<string | null>(null);
  const document = useRef<OtDocument | null>(null);
  const docId = useRef<string | null>(null);
  const sendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Read through refs inside the event listener so it can stay mounted for the
  // whole session instead of being torn down on every keystroke.
  const callbacks = useRef(options);
  callbacks.current = options;

  const stopDocument = useCallback(() => {
    if (sendTimer.current) {
      clearTimeout(sendTimer.current);
      sendTimer.current = null;
    }
    const previous = docId.current;
    document.current = null;
    docId.current = null;
    setLiveFile(false);
    if (previous) void invoke("overleaf_rt_leave_doc", { docId: previous }).catch(() => {});
  }, []);

  const fail = useCallback((message: string) => {
    stopDocument();
    setStatus("error");
    setDetail(message);
    void invoke("overleaf_rt_disconnect").catch(() => {});
  }, [stopDocument]);

  /** Send whatever the document says is ready, if anything. */
  const flush = useCallback(async (send: { version: number; ops: OtOp[] } | null) => {
    if (!send || !docId.current) return;
    try {
      await invoke("overleaf_rt_send_ops", {
        docId: docId.current,
        version: send.version,
        ops: send.ops,
      });
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
        return;
      }
      if (payload.type === "disconnected") {
        stopDocument();
        setStatus("off");
        setDetail(payload.reason || null);
        return;
      }
      if (payload.type === "otError") {
        fail(payload.message);
        callbacks.current.onNotice(
          `Overleaf rejected a live update (${payload.message}). Falling back to syncing.`,
        );
        return;
      }
      if (payload.type !== "docUpdate") return;

      const doc = document.current;
      if (!doc || payload.docId !== docId.current) return;
      // Our own work coming back is the acknowledgement, not a new edit.
      if (payload.source && publicId.current && payload.source === publicId.current) {
        void flush(doc.acknowledge().send);
        return;
      }
      try {
        const caret = callbacks.current.readCaret();
        const { text, applied } = doc.remote(payload.ops, payload.version);
        callbacks.current.onRemoteText(text, OtDocument.caretAfter(caret, applied));
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

  useEffect(() => {
    stopDocument();
    if (!options.documents || status !== "live" || !options.activeFile) return;
    const id = docs.get(options.activeFile);
    // Only text documents Overleaf tracks can be edited live; anything else
    // (figures, files added since we joined) keeps going through syncing.
    if (!id) {
      setDetail(`${options.activeFile} is not a document Overleaf tracks, so it syncs instead.`);
      return;
    }
    let cancelled = false;
    void invoke<{ text: string; version: number }>("overleaf_rt_join_doc", { docId: id })
      .then((joined) => {
        if (cancelled) return;
        docId.current = id;
        document.current = new OtDocument(joined.text, joined.version);
        setLiveFile(true);
        setDetail(null);
        // The server's copy is the truth on arrival; show it.
        callbacks.current.onRemoteText(joined.text, callbacks.current.readCaret());
      })
      .catch((reason) => {
        if (!cancelled) setDetail(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [options.activeFile, options.documents, docs, status, stopDocument]);

  // ---- local edits --------------------------------------------------------

  const pushLocal = useCallback((text: string) => {
    const doc = document.current;
    if (!doc) return;
    // Coalesce keystrokes briefly: one operation per short pause keeps the
    // channel quiet without anyone noticing a delay.
    if (sendTimer.current) clearTimeout(sendTimer.current);
    sendTimer.current = setTimeout(() => {
      sendTimer.current = null;
      const current = document.current;
      if (!current) return;
      void flush(current.local(text).send);
    }, 250);
  }, [flush]);

  return { status, detail, liveFile, pushLocal };
}
