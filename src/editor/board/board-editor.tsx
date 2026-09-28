import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react";
import { Tldraw, type Editor, type TLPageId } from "tldraw";
import "tldraw/tldraw.css";
import { createTldrawAgentCanvasAdapter } from "../../agent/agent-canvas-tldraw-adapter";
import { registerAgentCanvasAdapter } from "../../agent/agent-canvas-tools";
import type { BoardFileViewState } from "../../app-types";
import { createBoardStore, mergeExternalBoardSource, serializeBoard } from "./board-store";

// Hobby-license keys are client-side by design (tldraw docs); embedded via
// Vite env so the production build is licensed.
const LICENSE_KEY = import.meta.env.VITE_TLDRAW_LICENSE_KEY as string | undefined;

const SERIALIZE_DEBOUNCE_MS = 300;

export type BoardEditorProps = {
  /** Workspace-relative path used to route Agent shape tools to this board. */
  path: string;
  /** Initial .tldr JSON. The board owns its state after mount; later changes merge in. */
  source: string;
  onChange: (next: string) => void;
  /** Publish a pending debounced serialization before switching or closing panes. */
  onFlushPendingChange?: (flush: (() => boolean) | null) => void;
  /** Only the focused board owns the global Agent canvas tool adapter. */
  active?: boolean;
  /** Per-user camera state. It never enters the .tldr file. */
  initialViewState?: BoardFileViewState;
  onViewState?: (state: BoardFileViewState) => void;
};

/** Only the focused board owns the global Agent canvas tool adapter. */
function registerAgentAdapter(editor: Editor | null, path: string, active: boolean, canWrite: () => boolean) {
  return active && editor
    ? registerAgentCanvasAdapter(path, createTldrawAgentCanvasAdapter(editor, canWrite))
    : null;
}

export function BoardEditor({
  path,
  source,
  onChange,
  onFlushPendingChange,
  active = true,
  initialViewState,
  onViewState,
}: BoardEditorProps) {
  const { i18n } = useLingui();
  const tldrawLocale = i18n.locale === "zh-CN" ? "zh-cn" : "en";
  const callbacksRef = useRef({ onChange, onViewState });
  const editorRef = useRef<Editor | null>(null);
  const unregisterAgentAdapterRef = useRef<(() => void) | null>(null);
  const disposeViewStateRef = useRef<(() => void) | null>(null);
  const flushPendingChangeRef = useRef<() => void>(() => {});
  // Cleared on unmount, so an Agent tool call racing the teardown cannot write.
  const canWriteRef = useRef(true);
  useLayoutEffect(() => {
    callbacksRef.current = { onChange, onViewState };
  }, [onChange, onViewState]);
  useLayoutEffect(() => {
    editorRef.current?.user.updateUserPreferences({ locale: tldrawLocale });
  }, [tldrawLocale]);
  useLayoutEffect(() => () => {
    canWriteRef.current = false;
    disposeViewStateRef.current?.();
    disposeViewStateRef.current = null;
    unregisterAgentAdapterRef.current?.();
    unregisterAgentAdapterRef.current = null;
    editorRef.current = null;
  }, []);
  useLayoutEffect(() => {
    if (!onFlushPendingChange) return;
    onFlushPendingChange(() => {
      flushPendingChangeRef.current();
      return true;
    });
    return () => onFlushPendingChange(null);
  }, [onFlushPendingChange]);
  useLayoutEffect(() => {
    unregisterAgentAdapterRef.current?.();
    unregisterAgentAdapterRef.current = registerAgentAdapter(editorRef.current, path, active, () => canWriteRef.current);
  }, [active, path]);
  // The store is created once per mount (the canvas keys this component by
  // file path).
  const [store] = useState(() => createBoardStore(source));
  // Own output tracking so incoming source updates that just echo our own
  // serialization are not merged back.
  const lastSerializedRef = useRef(source);

  // Debounce-serialize edits out; merge external source changes in.
  useEffect(() => {
    let timer: number | null = null;
    const flush = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = null;
      const json = serializeBoard(store.allRecords());
      lastSerializedRef.current = json;
      callbacksRef.current.onChange(json);
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
      if (timer != null) flush();
      flushPendingChangeRef.current = () => {};
    };
  }, [store]);

  useEffect(() => {
    if (source === lastSerializedRef.current) return;
    if (mergeExternalBoardSource(store, source)) lastSerializedRef.current = source;
  }, [store, source]);

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
          const restoredPage = initialViewState
            ? editor.getPage(initialViewState.pageId as TLPageId)
            : undefined;
          if (restoredPage && initialViewState) {
            editor.setCurrentPage(restoredPage);
            editor.setCamera(initialViewState.camera, { immediate: true });
          } else if (editor.getCurrentPageShapes().length > 0) {
            window.requestAnimationFrame(() => {
              if (!editor.isDisposed) editor.zoomToFit({ immediate: true });
            });
          }
          let viewFrame: number | null = null;
          const reportViewState = () => {
            viewFrame = null;
            if (editor.isDisposed) return;
            const camera = editor.getCamera();
            callbacksRef.current.onViewState?.({
              pageId: editor.getCurrentPageId(),
              camera: { x: camera.x, y: camera.y, z: camera.z },
            });
          };
          const unlistenViewState = editor.store.listen(() => {
            if (viewFrame === null) viewFrame = window.requestAnimationFrame(reportViewState);
          }, { source: "user", scope: "session" });
          disposeViewStateRef.current?.();
          disposeViewStateRef.current = () => {
            if (viewFrame !== null) window.cancelAnimationFrame(viewFrame);
            reportViewState();
            unlistenViewState();
          };
          unregisterAgentAdapterRef.current?.();
          unregisterAgentAdapterRef.current = registerAgentAdapter(editor, path, active, () => canWriteRef.current);
        }}
      />
    </div>
  );
}
