import { useEffect, useReducer } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { SquareArrowDownLeft, SquareArrowOutUpRight } from "lucide-react";
import { hostErrorMessage } from "../app-utils";
import { subscribeTauriEvent } from "../app/effect-helpers";
import { showError } from "../app/notify";
import {
  pdfWindowFrame, rememberPdfWindowFrame, takePdfWindowFocus, type PdfWindowFrame,
} from "../app/pdf-window-state";
import { listenInThisWindow } from "../app/window-events";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { useLatestRef } from "../hooks/use-latest-ref";
import { pdfBytesFingerprint } from "../pdf/pdf-bytes";
import {
  PDF_WINDOW_ACTION_EVENT, PDF_WINDOW_CLOSED_EVENT, PDF_WINDOW_FRAME_EVENT, PDF_WINDOW_STATE_EVENT,
  runPdfWindowAction, type PdfWindowAction, type PdfWindowState,
} from "../pdf/pdf-window-protocol";
import type {
  ProjectPdf, ProjectPdfCitations, ProjectPdfOutline, ProjectPdfSelection, ProjectPdfViewState,
} from "./project-pdf-panel";

/** The PDF panel's side of its separate window: whether it is offered, and how it opens and closes. */
export type ProjectPdfWindowControl = Readonly<{
  /** The PDF is in its own window rather than the panel. */
  open: boolean;
  /** The window's title: the PDF's and the project's names. */
  title: string;
  /** Moves the PDF into its own window; absent where there are no windows to give it (a browser tab, the demo). */
  onOpen?: () => void;
  /** Brings the PDF back into its panel. */
  onDock: () => void;
}>;

type ProjectPdfWindowProps = Readonly<{
  projectRoot: string;
  /** The document whose saved place in the PDF the window starts from and files its place under. */
  previewPath: string;
  control: ProjectPdfWindowControl;
  pdf: ProjectPdf;
  citations: ProjectPdfCitations;
  outline: ProjectPdfOutline;
  selection: ProjectPdfSelection;
  viewState: ProjectPdfViewState;
}>;

/** The window's label once it has opened: what it is addressed and recognized by. */
function labelReducer(_label: string | null, action: { type: "opened"; label: string }): string | null {
  return action.label;
}

function closeWindow(label: string) {
  void invoke("close_pdf_window", { label }).catch(() => undefined);
}

/**
 * The mounted ProjectPdfWindows on this page. A workspace window has one PDF
 * window, so a mount opening while an earlier one is still opening is given
 * the same label: the earlier one, unmounted by then, must leave it open.
 */
let mounted = 0;

/** What the PDF panel shows while the PDF is in its own window, when a layout brings the panel up anyway. */
export function PdfInWindowPlaceholder({ onDock }: { onDock: () => void }) {
  const { t } = useLingui();
  return (
    <div className="pdf-placeholder pdf-window-placeholder">
      <EmptyState
        icon={<SquareArrowOutUpRight size={20} />}
        title={t`The PDF is in a separate window`}
        actions={(
          <Button size="compact" onClick={onDock}>
            <SquareArrowDownLeft size={13} />
            {t`Return to workspace`}
          </Button>
        )}
      />
    </div>
  );
}

/**
 * The compiled PDF in a window of its own, for as long as this is mounted:
 * opened where the writer last left it for this project (behind the editor
 * when the project reopens with it), sent the state the PDF panel would
 * render from whenever that changes, and closed on unmount (the PDF docking,
 * the project closing). What the reader does there comes back as actions,
 * carried out with the panel's own callbacks; a reverse jump also brings this
 * window forward, to the line. Renders nothing.
 */
export function ProjectPdfWindow(props: ProjectPdfWindowProps) {
  const { projectRoot, pdf, citations, outline } = props;
  const [label, dispatch] = useReducer(labelReducer, null);
  const latest = useLatestRef(props);
  const labelRef = useLatestRef(label);

  useEffect(() => {
    let disposed = false;
    let opened: string | null = null;
    mounted += 1;
    void invoke<string>("open_pdf_window", {
      title: latest.current.control.title,
      frame: pdfWindowFrame(projectRoot),
      focus: takePdfWindowFocus(projectRoot),
    })
      .then((windowLabel) => {
        if (disposed) {
          if (mounted === 0) closeWindow(windowLabel);
          return;
        }
        opened = windowLabel;
        dispatch({ type: "opened", label: windowLabel });
      })
      .catch((reason: unknown) => {
        if (disposed) return;
        showError(hostErrorMessage(reason));
        latest.current.control.onDock();
      });
    return () => {
      disposed = true;
      mounted -= 1;
      if (opened) closeWindow(opened);
    };
  }, [latest, projectRoot]);

  // The state is read when it is sent, so the window always gets the latest;
  // the values listed are what changes it.
  const { pdfUrl, pdfSyncTarget, canForwardSync, locatingPdf, building, buildShortcut } = pdf;
  const { nodes: outlineNodes, activeId: outlineActiveId } = outline;
  const { citations: citationList } = citations;
  useEffect(() => {
    if (label) sendState(label, latest.current);
  }, [
    label, latest, pdfUrl, pdfSyncTarget, canForwardSync, locatingPdf, building, buildShortcut, outlineNodes,
    outlineActiveId, citationList,
  ]);

  useEffect(() => subscribeTauriEvent<PdfWindowAction>(PDF_WINDOW_ACTION_EVENT, (action) => {
    const current = latest.current;
    const window = labelRef.current;
    runPdfWindowAction(action, window, {
      ready: () => {
        if (window) sendState(window, latest.current);
      },
      forwardSync: current.pdf.onForwardSync,
      source: (page, x, y, word) => {
        void getCurrentWindow().setFocus().catch(() => undefined);
        current.pdf.onPdfSource(page, x, y, word);
      },
      build: () => current.pdf.onBuildProject?.(),
      dock: current.control.onDock,
      openCitation: current.citations.onOpenCitation,
      navigateOutline: current.outline.onNavigate,
      pageCount: current.pdf.onPdfPageCount,
      page: current.pdf.onPdfPageChange,
      viewState: (state) => current.viewState.onFileViewState?.(current.previewPath, { pdf: state }),
      select: current.selection.onPdfTextSelect,
    }, current.citations.canOpenCitation);
  }), [labelRef, latest]);

  // The writer closed the window: the PDF goes back to its panel.
  useEffect(() => subscribeTauriEvent<string>(
    (handler) => listenInThisWindow(PDF_WINDOW_CLOSED_EVENT, handler),
    (closed) => {
      if (closed === labelRef.current) latest.current.control.onDock();
    },
  ), [labelRef, latest]);

  // Where it is left is where it opens next time, per project.
  useEffect(() => subscribeTauriEvent<{ label: string; frame: PdfWindowFrame }>(
    (handler) => listenInThisWindow(PDF_WINDOW_FRAME_EVENT, handler),
    ({ label: moved, frame }) => {
      if (moved === labelRef.current) rememberPdfWindowFrame(projectRoot, frame);
    },
  ), [labelRef, projectRoot]);

  return null;
}

function sendState(label: string, props: ProjectPdfWindowProps) {
  const { projectRoot, previewPath, pdf, citations, outline, viewState } = props;
  const state: PdfWindowState = {
    projectRoot,
    pdfKey: pdf.pdfUrl && pdf.pdfBytes ? pdfBytesFingerprint(pdf.pdfBytes) : null,
    syncTarget: pdf.pdfSyncTarget,
    canForwardSync: pdf.canForwardSync,
    locatingPdf: pdf.locatingPdf,
    building: Boolean(pdf.building),
    buildShortcut: pdf.buildShortcut,
    citations: citations.citations,
    openableCitations: citations.citations.filter((citation) => citations.canOpenCitation(citation.key)).map((citation) => citation.key),
    outline: { nodes: outline.nodes, activeId: outline.activeId, available: previewPath.toLocaleLowerCase().endsWith(".tex") },
    viewState: viewState.getFileViewState?.(previewPath)?.pdf,
  };
  void emitTo(label, PDF_WINDOW_STATE_EVENT, state).catch(() => undefined);
}
