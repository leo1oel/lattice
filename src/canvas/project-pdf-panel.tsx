import { Suspense, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react/macro";
import type { AgentHostSurface, AgentPdfDocumentPlace } from "../agent/agent-host-context";
import type { FileViewState } from "../app-types";
import { isPreviewableSourceFilePath } from "../app-utils";
import type { AnnotationRounds } from "../app/annotation-rounds";
import { ChunkGate } from "../components/chunk-gate";
import type { EditorComment } from "../editor/comments/editor-comment-data";
import type { CitationInfo } from "../editor/latex/latex-text";
import type { OutlineNode } from "../editor/latex/latex-outline";
import type { PdfSyncTarget } from "../pdf/pdf-viewer";
import { PdfPreview, PdfPreviewLoading } from "./canvas-lazy-editors";
import { loadPdfPreviewModule } from "./canvas-lazy-modules";
import { DocumentOutline } from "./document-outline";
import { SavedViewState } from "./saved-view-state";
import { LivePreviewSessionContext } from "../live-preview/live-preview-context";
import { LivePreviewStatus } from "../live-preview/live-preview-status";
import { loadLivePreviewModule, type LivePreview } from "../live-preview/use-live-preview";

/** The compiled project PDF: its build, SyncTeX in both directions and its pages. */
type ProjectPdf = Readonly<{
  pdfUrl: string | null;
  pdfBytes?: ArrayBuffer | null;
  /** Builds the project from the PDF panel while it has no PDF yet. */
  onBuildProject?: () => void;
  building?: boolean;
  buildShortcut?: string;
  /** Above the PDF: the last build's diagnostics. */
  pdfTop?: ReactNode;
  pdfSyncTarget: PdfSyncTarget | null;
  canForwardSync: boolean;
  locatingPdf: boolean;
  onForwardSync: () => void;
  onPdfSource: (page: number, x: number, y: number) => void;
  onPdfPageCount: (pages: number | null) => void;
  onPdfPageChange: (page: number) => void;
}>;

/** The citations the PDF's links name, and whether and how one opens. */
type ProjectPdfCitations = Readonly<{
  citations: CitationInfo[];
  canOpenCitation: (key: string) => boolean;
  onOpenCitation: (key: string) => void;
}>;

/** The manuscript's outline, offered from the PDF's toolbar. */
type ProjectPdfOutline = Readonly<{
  nodes: OutlineNode[];
  activeId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (path: string, line: number) => void;
}>;

/** The local annotations the PDF marks, and the revision rounds over them. */
type ProjectPdfReview = Readonly<{
  annotations: EditorComment[];
  annotationRounds: AnnotationRounds;
}>;

/** What the agent hears about the PDF: the writer turning to it, and the text selected in it. */
type ProjectPdfSelection = Readonly<{
  onPdfTextSelect: (value: string, place?: AgentPdfDocumentPlace) => void;
  onContextSurfaceActivate: (surface: AgentHostSurface) => void;
}>;

/** The per-file view states the PDF's place is filed under. */
type ProjectPdfViewState = Readonly<{
  getFileViewState?: (path: string) => FileViewState | undefined;
  onFileViewState?: (path: string, update: Partial<FileViewState>) => void;
}>;

export type ProjectPdfPanelProps = Readonly<{
  /** The PDF panel's host, as Trellis adopted it; null while that panel is closed or hibernated. */
  host: HTMLElement | null;
  projectRoot: string;
  /** The document in front, whose saved place in the PDF the panel restores and files. */
  activeFile: string;
  pdf: ProjectPdf;
  citations: ProjectPdfCitations;
  outline: ProjectPdfOutline;
  review: ProjectPdfReview;
  selection: ProjectPdfSelection;
  viewState: ProjectPdfViewState;
  /**
   * The writer turned to the PDF: the source editor's completion ends and the
   * editor is left (saved, built when automatic builds are on).
   */
  onLeaveEditor: () => void;
  /** The LuaLaTeX live preview, drawn over the pages while it runs. */
  livePreview?: LivePreview;
}>;

/**
 * The compiled project PDF in the PDF panel. A sibling of DocumentCanvas,
 * not part of it: it takes the document's path, never its text, so the
 * canvas's own renders (its caret, selection and editor status) do not reach
 * it. It stays mounted while its panel sleeps (with no host it renders
 * nothing), so the document it files its place under survives that too.
 */
export function ProjectPdfPanel({
  host, projectRoot, activeFile, pdf, citations, outline, review, selection, viewState, onLeaveEditor, livePreview,
}: ProjectPdfPanelProps) {
  const { t } = useLingui();
  // Saved-view ownership for the PDF. Files without a preview of their own
  // (.bib, .sty) keep using the last previewable file's saved state. This is
  // separate from the mounted viewer's identity: all TeX source files share
  // the project's compiled PDF, including across SyncTeX jumps. The panel
  // outlives a project switch, so the identity is tied to its root: the
  // outgoing project's file must not own the incoming project's saved PDF view.
  const [previewIdentity, setPreviewIdentity] = useState({ root: projectRoot, path: activeFile });
  const previewOwner = isPreviewableSourceFilePath(activeFile) ? activeFile : undefined;
  if (previewIdentity.root !== projectRoot || (previewOwner && previewOwner !== previewIdentity.path)) {
    setPreviewIdentity({ root: projectRoot, path: previewOwner ?? activeFile });
  }
  if (!host) return null;
  const previewPath = previewOwner ?? previewIdentity.path;
  const liveSession = livePreview?.state.kind === "running" ? livePreview.state.session : null;
  // The session exists only once its chunk has loaded, so the layer is here.
  const LiveLayer = liveSession ? loadLivePreviewModule.loaded()?.LivePreviewLayer : undefined;
  const activatePdf = () => {
    selection.onContextSurfaceActivate("pdf");
    onLeaveEditor();
  };
  return createPortal(
    <div
      className="pdf-column"
      data-tour="document-preview"
      onPointerDownCapture={activatePdf}
      onFocusCapture={activatePdf}
      // Scrolling the PDF need not blur CodeMirror, so it leaves the editor too.
      onWheelCapture={onLeaveEditor}
    >
      {pdf.pdfTop}
      <LivePreviewSessionContext value={liveSession}>
      <ChunkGate chunk={loadPdfPreviewModule} fallback={<PdfPreviewLoading />}><Suspense fallback={<PdfPreviewLoading />}>
        {/* One viewer per project, across its TeX files: it restores the place it mounts with. */}
        <SavedViewState<FileViewState["pdf"] | undefined>
          key={`project-pdf:${projectRoot}`}
          read={() => viewState.getFileViewState?.(previewPath)?.pdf}
        >
          {(initialViewState) => (
            <PdfPreview
              url={pdf.pdfUrl}
              pdfBytes={pdf.pdfBytes}
              citations={citations.citations}
              canOpenCitation={citations.canOpenCitation}
              onOpenCitation={citations.onOpenCitation}
              syncTarget={pdf.pdfSyncTarget}
              canForwardSync={pdf.canForwardSync}
              locatingPdf={pdf.locatingPdf}
              onForwardSync={pdf.onForwardSync}
              loadErrorHint={t`Try building the project again`}
              onBuild={pdf.onBuildProject}
              building={pdf.building}
              buildShortcut={pdf.buildShortcut}
              // Under Trellis a reverse jump always has a file panel to land in.
              onSource={pdf.onPdfSource}
              onTextSelect={selection.onPdfTextSelect}
              annotations={review.annotations}
              annotationRounds={review.annotationRounds}
              onNumPages={pdf.onPdfPageCount}
              pageLayer={liveSession ? LiveLayer : undefined}
              status={livePreview ? <LivePreviewStatus state={livePreview.state} onRetry={livePreview.retry} /> : null}
              onPageChange={pdf.onPdfPageChange}
              initialViewState={initialViewState}
              onViewState={(state) => viewState.onFileViewState?.(previewPath, { pdf: state })}
              outline={(
                <DocumentOutline
                  nodes={outline.nodes}
                  activeId={outline.activeId}
                  available={previewPath.toLocaleLowerCase().endsWith(".tex")}
                  open={outline.open}
                  onSelect={outline.onNavigate}
                  onOpenChange={outline.onOpenChange}
                />
              )}
            />
          )}
        </SavedViewState>
      </Suspense></ChunkGate>
      </LivePreviewSessionContext>
    </div>,
    host,
  );
}
