import { Suspense, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import { ArrowLeft, ExternalLink, FileText } from "lucide-react";
import { Tip } from "../components/icon-tip";
import type { AgentHostSurface } from "../agent/agent-host-context";
import type { FileViewState, PaperSummary } from "../app-types";
import { paperShortAuthors, paperSourceLabel } from "../papers/paper-identity";
import { PdfPreview, PdfPreviewLoading } from "./canvas-lazy-editors";
import type { usePaperPdf } from "./use-paper-pdf";

/**
 * Whether the full text's masthead (its title and authors at the top of the
 * reading column) is on screen. Null `path` means no Markdown is shown.
 * Without IntersectionObserver the strip keeps the whole identity.
 */
function useMastheadInView(shellRef: RefObject<HTMLElement | null>, path: string | null): boolean {
  const [inView, setInView] = useState(false);
  // Layout, not passive: the first frame of a full text must not flash its
  // title in the strip as well as in the masthead.
  useLayoutEffect(() => {
    // The masthead renders with the Markdown in the same commit, outside the
    // editor's Suspense boundary, so it is in the DOM by now when it exists.
    const masthead = path ? shellRef.current?.querySelector(".paper-visual-header h1") : null;
    const observable = Boolean(masthead) && typeof IntersectionObserver !== "undefined";
    setInView(observable);
    if (!masthead || !observable) return;
    // The scroll viewport clips the observed heading, so it stops
    // intersecting exactly when it has scrolled out from under the strip.
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting));
    observer.observe(masthead);
    return () => observer.disconnect();
  }, [path, shellRef]);
  return inView;
}

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
  const shellRef = useRef<HTMLElement | null>(null);
  const view = pdf.pdfView;
  const browserActionLabel = pdf.pdfSource ? t`Open PDF in browser` : t`Open article in browser`;
  const source = paperSourceLabel(paper);
  const authors = paperShortAuthors(paper);
  const mastheadInView = useMastheadInView(shellRef, view ? null : activeFile);
  const viewName = (path: string | null) => path?.toLocaleLowerCase().endsWith("/blog.md") ? t`Blog` : t`Paper`;
  const quoteReturnLabel = t({ message: `Back to ${{ view: viewName(pdf.quoteReturnPath) }}` });
  const toolbarStart = (
    <Tip label={t({ message: `Back to ${{ view: viewName(activeFile) }}` })}>
      <button type="button" onClick={pdf.closePdf}>
        <ArrowLeft size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    </Tip>
  );
  return (
    <section ref={shellRef} className="paper-reader-shell" aria-label={t({ message: `${{ title: paper.title }} paper reader` })}>
      {/* One identity in every state: title, authors and source sit in this
          strip unless the full text's own masthead is on screen, which then
          carries the title and authors itself. The source is the way out to
          the original, so it is the browser action. */}
      <header className="paper-reader-header">
        <p className="paper-identity" data-masthead={mastheadInView || undefined}>
          {!mastheadInView && <span className="paper-identity-title" title={paper.title}>{paper.title}</span>}
          {!mastheadInView && authors && <span className="paper-identity-authors">{authors}</span>}
          {source && (pdf.browserUrl ? (
            <Tip label={browserActionLabel}>
              <button type="button" className="paper-identity-source" aria-label={`${source}, ${browserActionLabel}`} onClick={pdf.openInBrowser}>
                <span>{source}</span>
                <ExternalLink size={11} aria-hidden="true" />
              </button>
            </Tip>
          ) : <span className="paper-identity-source">{source}</span>)}
        </p>
        <div className="paper-local-actions" aria-label={t`Paper actions`} data-tour="paper-actions">
          {!view && pdf.quoteReturnPath !== null && (
            <Tip label={quoteReturnLabel}>
              <button type="button" className="paper-local-action" aria-label={quoteReturnLabel} onClick={() => {
                props.onOpenMarkdownPath(pdf.quoteReturnPath!);
                pdf.clearQuoteFallback();
              }}><ArrowLeft size={14} aria-hidden="true" /></button>
            </Tip>
          )}
          {pdf.pdfSource ? (
            <button
              type="button"
              className="paper-local-action"
              aria-label={t`View original PDF`}
              aria-pressed={Boolean(view)}
              onClick={() => view ? pdf.closePdf() : pdf.openPdf()}
            >
              <FileText size={14} aria-hidden="true" />
              <span>{t`PDF`}</span>
            </button>
          ) : null}
          {!source && pdf.browserUrl && (
            <Tip label={browserActionLabel}>
              <button type="button" className="paper-local-action paper-local-action-icon" onClick={pdf.openInBrowser}>
                <ExternalLink size={14} aria-hidden="true" />
              </button>
            </Tip>
          )}
        </div>
      </header>
      {view ? (
        <div
          className="paper-pdf-preview"
          onPointerDownCapture={() => props.onContextSurfaceActivate("paper")}
          onFocusCapture={() => props.onContextSurfaceActivate("paper")}
        >
          {!view.previewUrl && !view.bytes ? (
            <PdfPreviewLoading toolbar={<div className="pdf-navigation-controls">{toolbarStart}</div>}>
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
            />
          </Suspense>}
        </div>
      ) : markdown}
    </section>
  );
}
