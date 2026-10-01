import { useEffect, useLayoutEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { PaperSummary } from "../app-types";
import { hasPaperDrag, PAPER_DRAG_TYPE, PAPER_NATIVE_DRAG, resolvePaperDrag, type NativePaperDrag, type PaperDrag } from "./paper-drag";

export type PaperDropLibrary = { projectRoot: string; papers: PaperSummary[] };
/**
 * Reading surfaces and tab chrome, where a dropped paper opens instead of
 * being cited: document and PDF panels (their content and their tabs) and
 * the titlebar. The Project, Papers, Agent and tool panels are not.
 */
const READING_SURFACES = String.raw`.lattice-trellis :is([data-trellis-part="surface"], [data-trellis-part="tab"]):is([data-type="file"], [data-type="pdf"]), .titlebar-main`;

/**
 * Routes a paper dragged from the Papers panel to wherever it lands: an
 * editor cites it, a reading surface opens it.
 */
export function usePaperDropRouting(library: PaperDropLibrary, onOpen: (paper: PaperSummary) => void, onError: (error: unknown) => void) {
  const latest = useRef({ library, onOpen, onError });
  useLayoutEffect(() => { latest.current = { library, onOpen, onError }; });
  useEffect(() => {
    const owner = getCurrentWindow().label;
    // eslint-disable-next-line lingui/no-unlocalized-strings -- Tauri event target kind
    const ownWindow = { target: { kind: "Window", label: owner } } as const;
    let disposed = false;
    let activeDrag: NativePaperDrag | null = null;
    let enteredPaper: PaperDrag | null = null;
    let insidePaperDrop = false;
    const cleanups: (() => void)[] = [];
    const register = (promise: Promise<() => void>) =>
      promise.then((cleanup) => disposed ? cleanup() : cleanups.push(cleanup));
    void Promise.all([register(listen<NativePaperDrag>(PAPER_NATIVE_DRAG, ({ payload }) => {
      if (payload.paper) {
        activeDrag = payload;
        if (insidePaperDrop) enteredPaper = payload.paper;
      }
      else if (activeDrag?.id === payload.id) activeDrag = null;
    }, ownWindow)),
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
        const current = latest.current.library;
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
    }))]).catch((error) => latest.current.onError(error));

    const onDragOver = (event: DragEvent) => {
      const data = event.dataTransfer;
      if (data && (hasPaperDrag(data) || data.types.includes("text/uri-list"))
        && (event.target as Element).closest(READING_SURFACES)) {
        event.preventDefault();
        data.dropEffect = "copy";
      }
    };
    const onDrop = (event: DragEvent) => {
      if (!hasPaperDrag(event.dataTransfer) || !(event.target as Element).closest(READING_SURFACES)) return;
      event.preventDefault();
      const current = latest.current;
      const paper = resolvePaperDrag(event.dataTransfer, current.library.projectRoot, current.library.papers);
      if (paper) current.onOpen(paper);
    };
    // Editor handlers stop propagation after inserting. Only reading surfaces
    // and tab chrome reach this listener, including native drops.
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  }, []);
}

/** The native bridge stays outside the eager writing/startup graph. */
export default function PaperDropBridge(props: {
  library: PaperDropLibrary;
  onOpen: (paper: PaperSummary) => void;
  onError: (error: unknown) => void;
}) {
  usePaperDropRouting(props.library, props.onOpen, props.onError);
  return null;
}
