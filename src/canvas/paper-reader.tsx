import { Suspense, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { ArrowLeft, ExternalLink, FileText } from "lucide-react";
import { Tip } from "../components/icon-tip";
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
  pdfViewState: { initialViewState?: FileViewState["pdf"]; onViewState: (state: FileViewState["pdf"]) => void };
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
  const viewName = (path: string | null) => path?.toLocaleLowerCase().endsWith("/blog.md") ? t`Blog` : t`Paper`;
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
            <PdfPreviewLoading toolbar={(
              <>
                <div className="pdf-navigation-controls">{toolbarStart}</div>
                <div className="pdf-zoom-controls">{toolbarEnd}</div>
              </>
            )}>
              {view.error ? (
                <div className="pdf-placeholder" role="status" aria-live="polite">
                  <FileText size={28} /><p>{t`Could not load PDF`}</p>
                </div>
              ) : undefined}
            </PdfPreviewLoading>
          ) : <Suspense fallback={<PdfPreviewLoading />}>
            <PdfPreview
              key={`paper-pdf:${view.key}`}
              url={view.previewUrl}
              pdfBytes={view.bytes}
              fileName={view.fileName}
              initialPage={view.initialPage}
              sourceQuote={view.quote}
              onLoadError={() => pdf.fallbackToQuote(view.quote)}
              saveLabel={t`Download PDF`}
              timeoutMessage={t`The PDF took too long to load. Try again, or open the article in your browser.`}
              onTextSelect={props.onTextSelect}
              onPageChange={pdf.rememberPage}
              {...props.pdfViewState}
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
