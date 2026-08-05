import { useEffect, useRef, useState } from "react";
import { Tldraw, type TLStore } from "tldraw";
import "tldraw/tldraw.css";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import {
  attachBoardBridge,
  attachBoardPresence,
  createBoardStore,
  isBoardDocumentRecord,
  parseBoardRecords,
  serializeBoard,
  type BoardPresenceUser,
} from "./board-yjs-bridge";

// Hobby-license keys are client-side by design (tldraw docs); embedded via
// Vite env so the production build is licensed.
const LICENSE_KEY = import.meta.env.VITE_TLDRAW_LICENSE_KEY as string | undefined;

const SERIALIZE_DEBOUNCE_MS = 300;

export type BoardCollabBinding = {
  doc: Y.Doc;
  awareness: Awareness | null;
  user: BoardPresenceUser | null;
};

export type BoardEditorProps = {
  /** Initial .tldr JSON for local mode. The board owns its state after mount. */
  source: string;
  onChange: (next: string) => void;
  /** v2 collab: bridge the store into the file's Y.Doc instead of onChange. */
  collab?: BoardCollabBinding | null;
};

/**
 * Replace a store's document records from external .tldr text (v1 text sync,
 * disk reload, git pull). Exported for tests; returns false on invalid input.
 */
export function mergeExternalBoardSource(store: TLStore, source: string): boolean {
  const records = parseBoardRecords(source);
  if (!records) return false;
  store.mergeRemoteChanges(() => {
    const incoming = new Set(records.map((record) => record.id));
    for (const record of store.allRecords()) {
      if (isBoardDocumentRecord(record) && !incoming.has(record.id)) {
        store.remove([record.id]);
      }
    }
    if (records.length) store.put(records);
  });
  return true;
}

export function BoardEditor({ source, onChange, collab }: BoardEditorProps) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // The store is created once per mount (the canvas keys this component by
  // file path). Collab mode starts empty: attachBoardBridge seeds records
  // from the doc's imported content and pulls the doc-authoritative state.
  const [store] = useState(() => createBoardStore(collab ? "" : source));
  // Own output tracking so incoming source updates that just echo our own
  // serialization are not merged back.
  const lastSerializedRef = useRef(collab ? null : source);

  // Collab mode: two-way Yjs bridge (+ cursor presence when available).
  const collabDoc = collab?.doc ?? null;
  const collabAwareness = collab?.awareness ?? null;
  const collabUser = collab?.user ?? null;
  useEffect(() => {
    if (!collabDoc) return;
    const bridge = attachBoardBridge(store, collabDoc);
    const disposePresence = collabAwareness && collabUser
      ? attachBoardPresence(store, collabAwareness, collabUser)
      : undefined;
    return () => {
      disposePresence?.();
      bridge.dispose();
    };
  }, [store, collabDoc, collabAwareness, collabUser]);

  // Local mode: debounce-serialize edits out; merge external source changes in.
  useEffect(() => {
    if (collabDoc) return;
    let timer: number | null = null;
    const flush = () => {
      timer = null;
      const json = serializeBoard(store.allRecords());
      lastSerializedRef.current = json;
      onChangeRef.current(json);
    };
    const unlisten = store.listen(() => {
      if (timer == null) timer = window.setTimeout(flush, SERIALIZE_DEBOUNCE_MS);
    }, { source: "user", scope: "document" });
    return () => {
      unlisten();
      // Commit pending edits so switching files never loses the last stroke.
      if (timer != null) {
        window.clearTimeout(timer);
        flush();
      }
    };
  }, [store, collabDoc]);

  useEffect(() => {
    if (collabDoc) return;
    if (source === lastSerializedRef.current) return;
    if (mergeExternalBoardSource(store, source)) lastSerializedRef.current = source;
  }, [store, collabDoc, source]);

  return (
    <div className="board-editor-root" data-tour="board-workspace">
      <Tldraw store={store} licenseKey={LICENSE_KEY} />
    </div>
  );
}
