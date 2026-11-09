/**
 * The page of the compiled PDF's separate window (`src-tauri/src/pdf_window.rs`):
 * the PDF viewer alone, filling the window. `main.tsx` renders it instead of
 * App in a window labelled `pdf-…` (pdf-window-app.tsx).
 *
 * It owns nothing but the viewer. The workspace window that opened it sends
 * the state to render from (pdf-window-protocol.ts), and everything that
 * needs the project's documents or its build goes back there as an action: a
 * jump from the PDF to the source, Reveal cursor in PDF, the outline, a
 * citation, Build, Return to workspace. Theme, language, fonts and interface
 * scale follow the other windows through the settings they share
 * (useAppearance). Annotations, review mode's marks, the live preview's layer
 * and the build's diagnostics stay in the workspace.
 */
import { useEffect, useReducer } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { SquareArrowDownLeft } from "lucide-react";
import type { PdfFileViewState } from "../app-types";
import { disposeWhenSettled } from "../app/effect-helpers";
import { listenInThisWindow } from "../app/window-events";
import { PdfPreviewLoading } from "../canvas/canvas-lazy-editors";
import { DocumentOutline } from "../canvas/document-outline";
import { useAppearance } from "../settings/use-appearance";
import { pdfBytesFingerprint, pdfBytesToObjectUrl } from "./pdf-bytes";
import { PdfPreview } from "./pdf-viewer";
import {
  PDF_WINDOW_ACTION_EVENT, PDF_WINDOW_STATE_EVENT, type PdfWindowAction, type PdfWindowState,
} from "./pdf-window-protocol";

type Action = PdfWindowAction extends infer Each ? Each extends unknown ? Omit<Each, "window"> : never : never;

/** How long the viewer's place may wait before it is sent: it changes with every frame of a scroll. */
const VIEW_STATE_DELAY_MS = 250;

function send(action: Action) {
  void emit(PDF_WINDOW_ACTION_EVENT, { ...action, window: getCurrentWindow().label }).catch(() => undefined);
}

let pendingViewState: PdfFileViewState | null = null;
let viewStateTimer: number | null = null;

function sendViewState(state: PdfFileViewState) {
  pendingViewState = state;
  viewStateTimer ??= window.setTimeout(() => {
    viewStateTimer = null;
    if (pendingViewState) send({ kind: "view-state", state: pendingViewState });
    pendingViewState = null;
  }, VIEW_STATE_DELAY_MS);
}

type LoadedPdf = { key: string; url: string; bytes: ArrayBuffer };
type CompiledPdf = { loaded: LoadedPdf | null; failedKey: string | null };
type CompiledPdfAction = { type: "read"; pdf: LoadedPdf } | { type: "failed"; key: string };

function compiledPdfReducer(state: CompiledPdf, action: CompiledPdfAction): CompiledPdf {
  switch (action.type) {
    case "read": return { ...state, loaded: action.pdf };
    case "failed": return { ...state, failedKey: action.key };
  }
}

/**
 * The compiled PDF whose fingerprint is `pdfKey`, read again whenever the key
 * changes, and while it has not been read, whenever a build starts or ends:
 * one that was rewriting the file may have put these bytes back. Until the
 * next one is read the last stays on screen, as a rebuild shows in the docked
 * viewer; a key of null (no PDF yet) shows none. `waiting` while the first is
 * being read.
 */
function useCompiledPdf(
  projectRoot: string | null, pdfKey: string | null, building: boolean,
): { pdf: LoadedPdf | null; waiting: boolean } {
  const [{ loaded, failedKey }, dispatch] = useReducer(compiledPdfReducer, { loaded: null, failedKey: null });
  const loadedKey = loaded?.key ?? null;
  useEffect(() => {
    if (!projectRoot || !pdfKey || loadedKey === pdfKey) return;
    let current = true;
    void invoke<ArrayBuffer>("read_compiled_pdf", { projectRoot }).then((bytes) => {
      if (!current) return;
      // The next build is already rewriting the file: the PDF it writes
      // comes with a key of its own, or it puts these bytes back as it ends.
      if (pdfBytesFingerprint(bytes) !== pdfKey) dispatch({ type: "failed", key: pdfKey });
      else dispatch({ type: "read", pdf: { key: pdfKey, url: pdfBytesToObjectUrl(bytes), bytes } });
    }, () => {
      // Gone between the build and this read (cleaned, or the project
      // closed): no PDF until the next build puts it back or sends another key.
      if (current) dispatch({ type: "failed", key: pdfKey });
    });
    return () => {
      current = false;
    };
  }, [projectRoot, pdfKey, building, loadedKey]);
  useEffect(() => {
    if (!loaded) return;
    const { url } = loaded;
    return () => URL.revokeObjectURL(url);
  }, [loaded]);
  const pdf = pdfKey ? loaded : null;
  return { pdf, waiting: Boolean(pdfKey) && !pdf && failedKey !== pdfKey };
}

/** What the page renders from: the owner's latest state (null until it first arrives), and whether the outline is open. */
type WindowState = { owner: PdfWindowState | null; outlineOpen: boolean };
type WindowAction = { type: "owner-state"; state: PdfWindowState } | { type: "outline"; open: boolean };

function windowReducer(state: WindowState, action: WindowAction): WindowState {
  switch (action.type) {
    case "owner-state": return { ...state, owner: action.state };
    case "outline": return { ...state, outlineOpen: action.open };
  }
}

/** Hear the state the workspace window that opened this one sends, and ask for it once listening. */
function useOwnerState(dispatch: (action: WindowAction) => void) {
  useEffect(() => {
    let disposed = false;
    const listening = listenInThisWindow<PdfWindowState>(PDF_WINDOW_STATE_EVENT, ({ payload }) => {
      if (!disposed) dispatch({ type: "owner-state", state: payload });
    });
    // Asked for once listening, so the first state is not sent before anyone hears it.
    void listening.then(() => {
      if (!disposed) send({ kind: "ready" });
    }, () => undefined);
    const stop = disposeWhenSettled(listening);
    return () => {
      disposed = true;
      stop();
    };
  }, [dispatch]);
}

export function PdfWindowPage() {
  useAppearance();
  const { t } = useLingui();
  const [{ owner: state, outlineOpen }, dispatch] = useReducer(windowReducer, { owner: null, outlineOpen: false });
  useOwnerState(dispatch);
  const { pdf, waiting } = useCompiledPdf(state?.projectRoot ?? null, state?.pdfKey ?? null, Boolean(state?.building));
  // Until the first PDF is read, the viewer's frame rather than its "No PDF yet".
  if (!state || waiting) {
    return <div className="canvas-body pdf-window"><div className="pdf-column"><PdfPreviewLoading /></div></div>;
  }
  const openable = new Set(state.openableCitations);
  return (
    <div className="canvas-body pdf-window">
      <div className="pdf-column">
        <PdfPreview
          key={state.projectRoot}
          url={pdf?.url ?? null}
          pdfBytes={pdf?.bytes ?? null}
          citations={state.citations}
          canOpenCitation={(key) => openable.has(key)}
          onOpenCitation={(key) => send({ kind: "citation", key })}
          syncTarget={state.syncTarget}
          canForwardSync={state.canForwardSync}
          locatingPdf={state.locatingPdf}
          onForwardSync={() => send({ kind: "forward-sync" })}
          loadErrorHint={t`Try building the project again`}
          onBuild={() => send({ kind: "build" })}
          building={state.building}
          buildShortcut={state.buildShortcut}
          onSource={(page, x, y, word) => send({ kind: "source", page, x, y, word })}
          onTextSelect={(text) => send({ kind: "select", text })}
          onNumPages={(count) => send({ kind: "page-count", count })}
          onPageChange={(page) => send({ kind: "page", page })}
          initialViewState={state.viewState}
          onViewState={sendViewState}
          outline={(
            <DocumentOutline
              nodes={state.outline.nodes}
              activeId={state.outline.activeId}
              available={state.outline.available}
              open={outlineOpen}
              onOpenChange={(open) => dispatch({ type: "outline", open })}
              onSelect={(path, line) => {
                dispatch({ type: "outline", open: false });
                send({ kind: "outline", path, line });
              }}
            />
          )}
          toolbarAction={{ label: t`Return to workspace`, icon: SquareArrowDownLeft, run: () => send({ kind: "dock" }) }}
        />
      </div>
    </div>
  );
}

