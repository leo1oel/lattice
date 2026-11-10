import { Suspense, useEffect, useLayoutEffect, useReducer, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import type { SyncTexWord } from "../app-types";
import { ChunkGate } from "../components/chunk-gate";
import { pdfBytesToObjectUrl } from "../pdf/pdf-bytes";
import { PdfDocumentContext } from "../pdf/pdf-document-context";
import { PdfFigureSourceOpen } from "../pdf/pdf-figure-source-open";
import type { PdfSyncTarget } from "../pdf/pdf-viewer";
import { PdfPreview, PdfPreviewLoading } from "./canvas-lazy-editors";
import { loadPdfPreviewModule } from "./canvas-lazy-modules";
import { SavedViewState } from "./saved-view-state";
import type { ProjectPdfCitations, ProjectPdfReview, ProjectPdfSelection, ProjectPdfViewState } from "./project-pdf-panel";
import type { CompiledPdfTabs } from "../trellis/compiled-pdf-tabs";
import type { ShownPdf } from "../app/use-pdf-preview";
import type { SwitchState } from "./after-switch";

/**
 * The project's other compiled root documents, each in a tab of its own
 * beside the live PDF (src/trellis/compiled-pdf-tabs.ts). App says which are
 * on screen and how SyncTeX reaches each document's own map.
 */
export type RootPdfs = Readonly<{
  /** The tabs, which follow the document whose PDF the preview shows (`shown`). */
  tabs: CompiledPdfTabs;
  shown: ShownPdf | null;
  /** A layout switch animating: a tab coming on screen mounts its PDF once it is over. */
  switchState: SwitchState;
  /** Each document's bytes as shown this session; without them, the copy kept of its last build here is read. */
  shownBytes: ReadonlyMap<string, ArrayBuffer>;
  /**
   * The live PDF's URL, a new one for each build shown. Read by nothing: it
   * is what makes this object new when `shownBytes` (one Map, mutated)
   * gains a build, since the React Compiler keeps it otherwise.
   */
  shownUrl: string | null;
  /** The last jump's target, in the tab of `document` (null: the live PDF's, not any of these). */
  syncTarget: { document: string | null; target: PdfSyncTarget } | null;
  canForwardSync: boolean;
  onForwardSync: (document: string) => void;
  onSource: (document: string, page: number, x: number, y: number, word: SyncTexWord | null) => void;
}>;

type Shared = Readonly<{
  projectRoot: string;
  rootPdfs: RootPdfs;
  citations: ProjectPdfCitations;
  review: ProjectPdfReview;
  selection: ProjectPdfSelection;
  viewState: ProjectPdfViewState;
  onLeaveEditor: () => void;
}>;

/**
 * Each other root document's last PDF, in its tab while that tab is on
 * screen: its SyncTeX both ways through its own map, its annotations, and
 * its own saved place. The diagnostics, the live preview, review mode's
 * marks and the separate window follow the build, so they stay with the live
 * PDF. Switching to a tab only shows its PDF: nothing is built.
 */
export function RootPdfTabs(props: Shared) {
  const { projectRoot, rootPdfs: { tabs, shown, switchState } } = props;
  // Before paint: the tabs trade places in the frame the live PDF turns to another document.
  useLayoutEffect(() => {
    if (shown) tabs.shown(projectRoot, shown.document, shown);
  }, [projectRoot, shown, tabs]);
  const mounted = useSyncExternalStore(tabs.mounted.subscribe, () => tabs.mounted.get().tabs);
  const switching = useSyncExternalStore(switchState.subscribe, switchState.switching);
  // A tab behind another, or coming on screen while a switch animates, mounts nothing.
  return mounted.map(({ document, visible }) => visible && !switching && (
    <RootPdfTab key={`${projectRoot}\n${document}`} {...props} document={document} host={tabs.host(document)} />
  ));
}

/**
 * `document`'s bytes as last shown. Through `rootPdfs`, not its Map: the
 * React Compiler caches `rootPdfs.shownBytes.get(document)` for as long as
 * the Map is the same one, which it is for the session, while `rootPdfs` is
 * new each time a build is shown (`shownUrl`).
 */
const shownBytesOf = (rootPdfs: RootPdfs, document: string) => rootPdfs.shownBytes.get(document);

/** A PDF read for a tab: its URL once read, or null when this copy has not built the document. */
type Read = { document: string; url: string | null } | null;

function RootPdfTab({ projectRoot, rootPdfs, citations, review, selection, viewState, onLeaveEditor, document, host }: Shared & {
  document: string;
  host: HTMLElement;
}) {
  const { t } = useLingui();
  const [read, setRead] = useReducer((_: Read, next: Read) => next, null);
  const bytes = shownBytesOf(rootPdfs, document);
  useEffect(() => {
    let live = true;
    let url: string | null = null;
    const show = (bytes: ArrayBuffer | null) => {
      if (!live) return;
      url = bytes ? pdfBytesToObjectUrl(bytes) : null;
      setRead({ document, url });
    };
    // Never the PDF beside the document: a sync may have brought in a collaborator's.
    if (bytes) show(bytes);
    else void invoke<ArrayBuffer>("read_kept_pdf", { projectRoot, document }).then(show, () => show(null));
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [bytes, document, projectRoot]);
  const activate = () => {
    selection.onContextSurfaceActivate("pdf");
    onLeaveEditor();
  };
  const ready = read?.document === document;
  return createPortal(
    <div className="pdf-column" onPointerDownCapture={activate} onFocusCapture={activate} onWheelCapture={onLeaveEditor}>
      <PdfDocumentContext value={document}>
        <ChunkGate chunk={loadPdfPreviewModule} fallback={<PdfPreviewLoading />}><Suspense fallback={<PdfPreviewLoading />}>
          {!ready ? <PdfPreviewLoading /> : (
            <SavedViewState<ReturnType<NonNullable<ProjectPdfViewState["getFileViewState"]>>>
              key={`root-pdf:${projectRoot}:${document}`}
              read={() => viewState.getFileViewState?.(document)}
            >
              {(saved) => (
                <PdfPreview
                  url={read.url}
                  fileName={document.split("/").at(-1)?.replace(/\.tex$/i, ".pdf")}
                  citations={citations.citations}
                  canOpenCitation={citations.canOpenCitation}
                  onOpenCitation={citations.onOpenCitation}
                  syncTarget={rootPdfs.syncTarget?.document === document ? rootPdfs.syncTarget.target : null}
                  canForwardSync={rootPdfs.canForwardSync && Boolean(read.url)}
                  onForwardSync={() => rootPdfs.onForwardSync(document)}
                  loadErrorHint={t`Try building the project again`}
                  onBuild={() => rootPdfs.tabs.build(document)}
                  onSource={(page, x, y, word) => rootPdfs.onSource(document, page, x, y, word)}
                  onTextSelect={selection.onPdfTextSelect}
                  annotations={review.annotations}
                  annotationRounds={review.annotationRounds}
                  initialViewState={saved?.pdf}
                  onViewState={(state) => viewState.onFileViewState?.(document, { pdf: state })}
                />
              )}
            </SavedViewState>
          )}
        </Suspense></ChunkGate>
        <PdfFigureSourceOpen host={host} document={document} />
      </PdfDocumentContext>
    </div>,
    host,
  );
}
