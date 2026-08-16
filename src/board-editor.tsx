import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react";
import { Tldraw, type Editor, type TLStore } from "tldraw";
import "tldraw/tldraw.css";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { createTldrawAgentCanvasAdapter } from "./agent-canvas-tldraw-adapter";
import { registerAgentCanvasAdapter } from "./agent-canvas-tools";
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
  canWrite: boolean;
};

export type BoardEditorProps = {
  /** Initial .tldr JSON for local mode. The board owns its state after mount. */
  source: string;
  onChange: (next: string) => void;
  /** v2 collab: bridge the store into the file's Y.Doc instead of onChange. */
  collab?: BoardCollabBinding | null;
  /** Publish a pending debounced serialization before switching or closing panes. */
  onFlushPendingChange?: (flush: (() => boolean) | null) => void;
  /** Only the focused board owns the global Agent canvas tool adapter. */
  active?: boolean;
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

export function BoardEditor({
  source,
  onChange,
  collab,
  onFlushPendingChange,
  active = true,
}: BoardEditorProps) {
  const { i18n } = useLingui();
  const tldrawLocale = i18n.locale === "zh-CN" ? "zh-cn" : "en";
  const onChangeRef = useRef(onChange);
  const editorRef = useRef<Editor | null>(null);
  const unregisterAgentAdapterRef = useRef<(() => void) | null>(null);
  const flushPendingChangeRef = useRef<() => void>(() => {});
  const canWriteRef = useRef(collab?.canWrite !== false);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);
  useLayoutEffect(() => {
    canWriteRef.current = collab?.canWrite !== false;
    editorRef.current?.updateInstanceState({ isReadonly: !canWriteRef.current });
  }, [collab?.canWrite]);
  useLayoutEffect(() => {
    editorRef.current?.user.updateUserPreferences({ locale: tldrawLocale });
  }, [tldrawLocale]);
  useLayoutEffect(() => () => {
    canWriteRef.current = false;
    unregisterAgentAdapterRef.current?.();
    unregisterAgentAdapterRef.current = null;
    editorRef.current = null;
  }, []);
  useLayoutEffect(() => {
    if (!onFlushPendingChange) return;
    const flush = () => {
      flushPendingChangeRef.current();
      return true;
    };
    onFlushPendingChange(flush);
    return () => onFlushPendingChange(null);
  }, [onFlushPendingChange]);
  useLayoutEffect(() => {
    unregisterAgentAdapterRef.current?.();
    unregisterAgentAdapterRef.current = null;
    const editor = editorRef.current;
    if (active && editor) {
      unregisterAgentAdapterRef.current = registerAgentCanvasAdapter(
        createTldrawAgentCanvasAdapter(editor, () => canWriteRef.current),
      );
    }
  }, [active]);
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
    const bridge = attachBoardBridge(store, collabDoc, { canWrite: () => canWriteRef.current });
    const disposePresence = collabAwareness && collabUser
      ? attachBoardPresence(store, collabAwareness, collabUser)
      : undefined;
    return () => {
      disposePresence?.();
      bridge.dispose();
    };
    // canWrite flips flow through canWriteRef (kept current by the layout
    // effect above) so a permission change must not tear down and re-seed the
    // whole bridge mid-session.
  }, [store, collabDoc, collabAwareness, collabUser]);

  const canWrite = collab?.canWrite !== false;

  // Local mode: debounce-serialize edits out; merge external source changes in.
  useEffect(() => {
    if (collabDoc) {
      flushPendingChangeRef.current = () => {};
      return;
    }
    let timer: number | null = null;
    const flush = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = null;
      const json = serializeBoard(store.allRecords());
      lastSerializedRef.current = json;
      onChangeRef.current(json);
    };
    flushPendingChangeRef.current = () => {
      if (timer != null) flush();
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
      flushPendingChangeRef.current = () => {};
    };
  }, [store, collabDoc]);

  useEffect(() => {
    if (collabDoc) return;
    if (source === lastSerializedRef.current) return;
    if (mergeExternalBoardSource(store, source)) lastSerializedRef.current = source;
  }, [store, collabDoc, source]);

  return (
    <div className="board-editor-root" data-tour="board-workspace">
      <Tldraw
        store={store}
        licenseKey={LICENSE_KEY}
        locale={tldrawLocale}
        onMount={(editor) => {
          editorRef.current = editor;
          // Menus read the editor preference as well as the provider locale.
          // Keep both aligned with Lattice instead of the browser language.
          editor.user.updateUserPreferences({ locale: tldrawLocale });
          editor.updateInstanceState({ isReadonly: !canWrite });
          if (editor.getCurrentPageShapes().length > 0) {
            window.requestAnimationFrame(() => {
              if (!editor.isDisposed) editor.zoomToFit({ immediate: true });
            });
          }
          unregisterAgentAdapterRef.current?.();
          unregisterAgentAdapterRef.current = active
            ? registerAgentCanvasAdapter(
              createTldrawAgentCanvasAdapter(editor, () => canWriteRef.current),
            )
            : null;
        }}
      />
    </div>
  );
}
