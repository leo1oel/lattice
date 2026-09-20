import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { PaperSummary } from "../app-types";
import { i18n } from "../i18n";
import { isBrowserHosted } from "../platform/browser-runtime";
import { hasPaperDrag, PAPER_DRAG_TYPE, PAPER_NATIVE_DRAG, resolvePaperDrag, type NativePaperDrag, type PaperDrag } from "./paper-drag";

export type PaperLookupState = { projectRoot: string; papers: PaperSummary[]; theme: string };
export const PAPER_LOOKUP_STATE = "paper-lookup-state";
export const PAPER_LOOKUP_READY = "paper-lookup-ready";
export const PAPER_LOOKUP_OPEN = "paper-lookup-open";

export function usePaperLookup(state: PaperLookupState, onOpen: (paper: PaperSummary) => void, onError: (error: unknown) => void) {
  const latest = useRef({ state, onOpen, onError });
  const listenersReady = useRef<Promise<unknown>>(Promise.resolve());
  useLayoutEffect(() => { latest.current = { state, onOpen, onError }; });
  useEffect(() => {
    const owner = getCurrentWindow().label;
    const label = `paper-lookup-${owner}`;
    let disposed = false;
    let activeDrag: NativePaperDrag | null = null;
    let enteredPaper: PaperDrag | null = null;
    let insidePaperDrop = false;
    const cleanups: (() => void)[] = [];
    const register = (promise: Promise<() => void>) => {
      return promise.then((cleanup) => disposed ? cleanup() : cleanups.push(cleanup));
    };
    listenersReady.current = Promise.all([register(listen(PAPER_LOOKUP_READY, () => {
      void emitTo(label, PAPER_LOOKUP_STATE, latest.current.state).catch((error) => latest.current.onError(error));
    }, { target: { kind: "Window", label: owner } })),
    register(listen<{ projectRoot: string; arxivId: string; citationKey?: string }>(PAPER_LOOKUP_OPEN, ({ payload }) => {
      const { state: current } = latest.current;
      if (payload.projectRoot !== current.projectRoot) return;
      const paper = current.papers.find((item) => item.arxivId === payload.arxivId && item.citationKey === payload.citationKey);
      if (paper) {
        latest.current.onOpen(paper);
        if (isBrowserHosted()) window.focus();
        else void getCurrentWindow().setFocus().catch((error) => latest.current.onError(error));
      }
    }, { target: { kind: "Window", label: owner } })),
    register(listen<NativePaperDrag>(PAPER_NATIVE_DRAG, ({ payload }) => {
      if (payload.paper) {
        activeDrag = payload;
        if (insidePaperDrop) enteredPaper = payload.paper;
      }
      else if (activeDrag?.id === payload.id) activeDrag = null;
    }, { target: { kind: "Window", label: owner } })),
    register(getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (disposed) return;
      if (payload.type === "enter") {
        insidePaperDrop = payload.paths.length === 0;
        enteredPaper = payload.paths.length ? null : activeDrag?.paper ?? null;
      } else if (payload.type === "leave") {
        insidePaperDrop = false;
        enteredPaper = null;
      } else if (payload.type === "drop") {
        // Keep the identity captured at enter even if the source's dragend
        // IPC arrives first. A later enter/leave replaces it, and each drop
        // consumes it once. Native file paths always belong to App's importer.
        const paper = enteredPaper;
        insidePaperDrop = false;
        enteredPaper = null;
        activeDrag = null;
        if (payload.paths.length || !paper) return;
        const dataTransfer = new DataTransfer();
        dataTransfer.setData(PAPER_DRAG_TYPE, JSON.stringify(paper));
        const current = latest.current.state;
        if (!resolvePaperDrag(dataTransfer, current.projectRoot, current.papers)) return;
        const scale = window.devicePixelRatio || 1;
        const clientX = payload.position.x / scale;
        const clientY = payload.position.y / scale;
        // Route through the same DOM drop handlers as Chromium. CodeMirror
        // retains citation merging, selection, read-only and undo semantics.
        document.elementFromPoint(clientX, clientY)?.dispatchEvent(new DragEvent("drop", {
          bubbles: true, cancelable: true, dataTransfer, clientX, clientY,
        }));
      }
    }))]);
    void listenersReady.current.catch((error) => latest.current.onError(error));

    const onDragOver = (event: DragEvent) => {
      const data = event.dataTransfer;
      if (data && (hasPaperDrag(data) || data.types.includes("text/uri-list"))
        && (event.target as Element).closest(String.raw`.canvas-panel, .titlebar-main`)) {
        event.preventDefault();
        data.dropEffect = "copy";
      }
    };
    const onDrop = (event: DragEvent) => {
      if (!hasPaperDrag(event.dataTransfer) || !(event.target as Element).closest(String.raw`.canvas-panel, .titlebar-main`)) return;
      event.preventDefault();
      const current = latest.current;
      const paper = resolvePaperDrag(event.dataTransfer, current.state.projectRoot, current.state.papers);
      if (paper) current.onOpen(paper);
    };
    // Editor handlers stop propagation after inserting. Only reading surfaces
    // and tab chrome reach this listener, including native cross-window drops.
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
      void emitTo(label, PAPER_LOOKUP_STATE, { projectRoot: "", papers: [], theme: latest.current.state.theme }).catch(() => {});
    };
  }, []);
  useEffect(() => {
    void emitTo(`paper-lookup-${getCurrentWindow().label}`, PAPER_LOOKUP_STATE, state).catch(() => {
      // The auxiliary window normally does not exist yet; its ready handshake
      // sends the latest snapshot after its listener is installed.
    });
  }, [state.projectRoot, state.papers, state.theme]); // eslint-disable-line react-hooks/exhaustive-deps

  return useCallback(async () => {
    try {
      await listenersReady.current;
      await invoke("open_paper_lookup", { title: i18n._(msg`Paper lookup`) });
    } catch (error) { latest.current.onError(error); }
  }, []);
}

/** The native bridge stays outside the eager writing/startup graph. */
export default function PaperLookupBridge(props: {
  state: PaperLookupState;
  request: number;
  onOpen: (paper: PaperSummary) => void;
  onError: (error: unknown) => void;
}) {
  const open = usePaperLookup(props.state, props.onOpen, props.onError);
  useEffect(() => { if (props.request) void open(); }, [open, props.request]);
  return null;
}
