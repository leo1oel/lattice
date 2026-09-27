import { Suspense, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { ArrowLeft, ExternalLink, FileText } from "lucide-react";
import { Tip } from "../components/icon-tip";
import { PdfLoading } from "../pdf/pdf-loading";
import type { AgentHostSurface } from "../agent/agent-host-context";
import type { FileViewState, PaperSummary } from "../app-types";
import { PdfPreview, PdfPreviewLoading } from "./canvas-lazy-editors";
import type { usePaperPdf } from "./use-paper-pdf";

/**
 * A Paper's reading surface: its Blog/Paper Markdown with local actions, or —
 * while one is open — the original PDF in its place.
 */
export function PaperReader({ paper, activeFile, pdf, markdown, ...props }: {
  paper: PaperSummary;
  activeFile: string;
  pdf: ReturnType<typeof usePaperPdf>;
  markdown: ReactNode;
  onOpenMarkdownPath: (path: string) => void;
  onContextSurfaceActivate: (surface: AgentHostSurface) => void;
  onTextSelect: (value: string) => void;
  getFileViewState?: (path: string) => FileViewState | undefined;
  onFileViewState?: (path: string, update: Partial<FileViewState>) => void;
}) {
  const { t } = useLingui();
  const view = pdf.pdfView;
  const browserActionLabel = pdf.pdfSource ? t`Open PDF in browser` : t`Open article in browser`;
  const browserAction = (local: boolean) => pdf.browserUrl ? (
    <Tip label={browserActionLabel}>
      <button
        type="button"
        className={local ? "paper-local-action paper-local-action-icon" : undefined}
        onClick={pdf.openInBrowser}
      >
        <ExternalLink size={14} aria-hidden="true" />
      </button>
    </Tip>
  ) : undefined;
  const blogLabel = t`Blog`;
  const paperLabel = t`Paper`;
  const viewName = (path: string | null) => path?.toLocaleLowerCase().endsWith("/blog.md") ? blogLabel : paperLabel;
  const quoteReturnLabel = t({ message: `Back to ${{ view: viewName(pdf.quoteReturnPath) }}` });
  const toolbarStart = (
    <Tip label={t({ message: `Back to ${{ view: viewName(activeFile) }}` })}>
      <button type="button" onClick={pdf.closePdf}>
        <ArrowLeft size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    </Tip>
  );
  const toolbarEnd = browserAction(false);
  return (
    <section className="paper-reader-shell" aria-label={t({ message: `${{ title: paper.title }} paper reader` })}>
      {!view && (
        <header className="paper-reader-header">
          <div className="paper-local-actions" aria-label={t`Paper actions`} data-tour="paper-actions">
            {pdf.quoteReturnPath !== null && (
              <Tip label={quoteReturnLabel}>
                <button type="button" className="paper-local-action" aria-label={quoteReturnLabel} onClick={() => {
                  props.onOpenMarkdownPath(pdf.quoteReturnPath!);
                  pdf.clearQuoteFallback();
                }}><ArrowLeft size={14} aria-hidden="true" /></button>
              </Tip>
            )}
            {pdf.pdfSource ? (
              <button type="button" className="paper-local-action" aria-label={t`View original PDF`} onClick={() => pdf.openPdf()}>
                <FileText size={14} aria-hidden="true" />
                <span>{t`PDF`}</span>
              </button>
            ) : null}
            {browserAction(true)}
          </div>
        </header>
      )}
      {view ? (
        <div
          className="paper-pdf-preview"
          onPointerDownCapture={() => props.onContextSurfaceActivate("paper")}
          onFocusCapture={() => props.onContextSurfaceActivate("paper")}
        >
          {!view.previewUrl && !view.bytes ? (
            <div className="pdf-preview">
              <div className="pdf-toolbar">
                <div className="pdf-navigation-controls">{toolbarStart}</div>
                <div className="pdf-zoom-controls">{toolbarEnd}</div>
              </div>
              <div className="pdf-scroll-area">
                {view.error ? (
                  <div className="pdf-placeholder" role="status" aria-live="polite">
                    <FileText size={28} /><p>{t`Could not load PDF`}</p>
                  </div>
                ) : <PdfLoading label={t`Loading PDF…`} />}
              </div>
            </div>
          ) : <Suspense fallback={<PdfPreviewLoading />}>
            <PdfPreview
              key={`paper-pdf:${view.key}`}
              url={view.previewUrl}
              pdfBase64={null}
              pdfBytes={view.bytes}
              fileName={view.fileName}
              initialPage={view.initialPage}
              sourceQuote={view.quote}
              onLoadError={() => pdf.fallbackToQuote(view.quote)}
              saveLabel={t`Download PDF`}
              timeoutMessage={t`The PDF took too long to load. Try again, or open the article in your browser.`}
              onTextSelect={props.onTextSelect}
              onPageChange={pdf.rememberPage}
              initialViewState={props.getFileViewState?.(activeFile)?.pdf}
              onViewState={(state) => props.onFileViewState?.(activeFile, { pdf: state })}
              onDocumentData={view.bytes ? undefined : pdf.capturePdf}
              toolbarStart={toolbarStart}
              toolbarEnd={toolbarEnd}
            />
          </Suspense>}
        </div>
      ) : markdown}
    </section>
  );
}
