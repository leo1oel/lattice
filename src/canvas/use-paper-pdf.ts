import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { paperPdfUrl } from "../papers/paper-source";
import { sourceQuoteDomRange } from "../papers/source-quote";
import type { PdfSourceQuote } from "../pdf/pdf-viewer";
import { notifyError } from "../telemetry/app-notify";
import type { CanvasMode, PaperSummary, VisualMarkdownViewState } from "../app-types";
import { toMessage } from "../app-utils";
import { loadPdfPreviewModule } from "./canvas-lazy-modules";
import { captureViewport } from "./markdown-preview-sync";
import { captureReadingAnchor } from "../editor/markdown/reading-anchor";

/** An original PDF a Paper links to; `generic` sources are fetched through the backend rather than opened directly. */
type PaperPdfSource = { key: string; url: string; fileName: string; generic: boolean };

type PaperPdfView = PaperPdfSource & {
  bytes: ArrayBuffer | null;
  previewUrl: string | null;
  error: boolean;
  initialPage: number;
  quote: PdfSourceQuote | null;
};

type PaperLink = Pick<PaperSummary, "arxivId" | "url">;

/** `value` as an http(s) URL; anything malformed or unsafe to hand the OS opener is null. */
function httpUrl(value: string | null | undefined): URL | null {
  try {
    const parsed = new URL(value ?? "");
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed : null;
  } catch {
    return null;
  }
}

function paperPdfSource(paper: PaperLink): PaperPdfSource | null {
  // With no URL beside it, paperPdfUrl answers only for a well-formed arXiv id.
  const arxivId = paper.arxivId.trim();
  const arxivUrl = paperPdfUrl({ arxivId });
  if (arxivUrl) return { key: arxivUrl, url: arxivUrl, fileName: `${arxivId.replace("/", "-")}.pdf`, generic: false };
  const parsed = httpUrl(paperPdfUrl(paper));
  if (!parsed?.pathname.toLocaleLowerCase().endsWith(".pdf")) return null;
  let fileName = parsed.pathname.split("/").at(-1) || "paper.pdf";
  try {
    fileName = decodeURIComponent(fileName);
  } catch {
    // A malformed escape in the display name must not make an otherwise safe PDF URL unusable.
  }
  return { key: parsed.href, url: parsed.href, fileName, generic: true };
}

function paperBrowserUrl(paper: PaperLink): string | null {
  return paperPdfUrl(paper) || httpUrl(paper.url)?.href || null;
}

type PaperQuoteFallback = { paperId: string; path: string; returnPath: string; quote: PdfSourceQuote };

/**
 * The Paper reader's alternate PDF surface: the open Paper's original PDF, the
 * one view of it shown (bytes cached for a quick return), and the fallback into
 * the full-text Markdown when a quoted source cannot be shown in the PDF.
 */
export function usePaperPdf({
  activePaper, activeFile, mode, onOpenMarkdownPath, flushVisualMarkdown, previewViewportRef, settledPreviewText,
}: {
  activePaper: PaperSummary | null;
  activeFile: string;
  mode: CanvasMode;
  onOpenMarkdownPath: (path: string) => void;
  /** Publishes the visual editor's pending edit; false means it cannot yet. */
  flushVisualMarkdown: () => boolean | undefined;
  previewViewportRef: RefObject<HTMLDivElement | null>;
  settledPreviewText: string;
}) {
  const { t } = useLingui();
  const activePaperId = activePaper?.arxivId;
  const activePaperUrl = activePaper?.url;
  const { pdfSource, browserUrl } = useMemo(() => {
    const paper = activePaperId !== undefined ? { arxivId: activePaperId, url: activePaperUrl } : null;
    return { pdfSource: paper && paperPdfSource(paper), browserUrl: paper && paperBrowserUrl(paper) };
  }, [activePaperId, activePaperUrl]);
  const [pdfView, setPdfView] = useState<PaperPdfView | null>(null);
  const [quoteFallback, setQuoteFallback] = useState<PaperQuoteFallback | null>(null);
  const returnViewportRef = useRef<VisualMarkdownViewState & { path: string } | null>(null);
  const pagesRef = useRef(new Map<string, number>());
  // Retain only the last complete PDF, not an unbounded library of buffers.
  // PdfPreview copies bytes before transferring them to its worker.
  const bytesRef = useRef<{ key: string; bytes: ArrayBuffer } | null>(null);
  const requestRef = useRef(0);
  useEffect(() => {
    returnViewportRef.current = null;
  }, [activePaperId]);
  useEffect(() => {
    requestRef.current += 1;
    setQuoteFallback((current) => current?.paperId === activePaperId ? current : null);
    setPdfView((current) => current?.key === pdfSource?.key ? current : null);
    // Start the viewer chunk now so a later PDF click waits only for the remote source.
    if (pdfSource) void loadPdfPreviewModule();
  }, [activePaperId, pdfSource]);
  const closePdf = useCallback(() => {
    requestRef.current += 1;
    setPdfView(null);
  }, []);
  // Blog/Paper and Edit/Split/Preview remain the owners of Markdown state.
  // Choosing one while the PDF is open exits the alternate PDF surface.
  useEffect(() => closePdf(), [activeFile, closePdf, mode]);
  useEffect(() => {
    const viewport = previewViewportRef.current;
    if (!quoteFallback || quoteFallback.paperId !== activePaperId || quoteFallback.path !== activeFile || !viewport) return;
    let frame = 0;
    const locate = () => {
      const root = viewport.querySelector<HTMLElement>(".ProseMirror") ?? viewport;
      const range = sourceQuoteDomRange(root, quoteFallback.quote.first, quoteFallback.quote.last);
      if (!range) return;
      // Disconnecting also drops queued records, so a match runs this at most once.
      observer.disconnect();
      frame = requestAnimationFrame(() => {
        range.startContainer.parentElement?.scrollIntoView({ block: "center" });
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      });
    };
    const observer = new MutationObserver(locate);
    observer.observe(viewport, { subtree: true, childList: true, characterData: true });
    locate();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [activeFile, activePaperId, previewViewportRef, quoteFallback, settledPreviewText]);

  const updateView = useCallback((key: string, update: Partial<PaperPdfView>) => {
    setPdfView((current) => current?.key === key ? { ...current, ...update } : current);
  }, []);
  const fallbackToQuote = useCallback((quote: PdfSourceQuote | null | undefined) => {
    if (!quote || !activePaper?.hasFullText) return;
    const path = `.research/papers/${activePaper.arxivId}/paper.md`;
    setQuoteFallback({ paperId: activePaper.arxivId, path, returnPath: activeFile, quote });
    setPdfView(null);
    onOpenMarkdownPath(path);
  }, [activeFile, activePaper, onOpenMarkdownPath]);
  const openPdf = useCallback((quote: PdfSourceQuote | null = null) => {
    if (!pdfSource) return;
    if (flushVisualMarkdown() === false) return;
    const viewport = previewViewportRef.current;
    if (viewport) returnViewportRef.current = { path: activeFile, ...captureViewport(viewport), anchor: captureReadingAnchor(viewport) };
    const request = ++requestRef.current;
    const cached = bytesRef.current;
    const bytes = cached?.key === pdfSource.key ? cached.bytes : null;
    setPdfView({
      ...pdfSource,
      bytes,
      previewUrl: pdfSource.generic || bytes ? null : pdfSource.url,
      error: false,
      initialPage: quote?.page ?? pagesRef.current.get(pdfSource.key) ?? 1,
      quote,
    });
    if (!pdfSource.generic || bytes) return;
    void invoke<string>("paper_pdf_preview_url", { url: pdfSource.url }).then((previewUrl) => {
      if (requestRef.current === request) updateView(pdfSource.key, { previewUrl });
    }).catch(() => {
      if (requestRef.current !== request) return;
      updateView(pdfSource.key, { error: true });
      fallbackToQuote(quote);
    });
  }, [activeFile, fallbackToQuote, flushVisualMarkdown, pdfSource, previewViewportRef, updateView]);
  const capturePdf = useCallback((bytes: ArrayBuffer) => {
    if (!pdfSource) return;
    bytesRef.current = { key: pdfSource.key, bytes };
    updateView(pdfSource.key, { bytes });
  }, [pdfSource, updateView]);
  const rememberPage = useCallback((page: number) => {
    if (pdfSource) pagesRef.current.set(pdfSource.key, page);
  }, [pdfSource]);
  const openInBrowser = useCallback(() => {
    if (!browserUrl) return;
    void openUrl(browserUrl).catch((reason) => {
      notifyError(t`Papers`, t`Could not open the article in your browser`, { detail: toMessage(reason) });
    });
  }, [browserUrl, t]);

  return {
    pdfSource,
    browserUrl,
    pdfView: activePaper && pdfView && pdfView.key === pdfSource?.key ? pdfView : null,
    quoteFallback,
    /** Where the reader came from before a quote fell back into this full text, while it is shown. */
    quoteReturnPath: quoteFallback?.paperId === activePaperId && quoteFallback?.path === activeFile ? quoteFallback.returnPath : null,
    clearQuoteFallback: () => setQuoteFallback(null),
    returnViewportRef, openPdf, closePdf, capturePdf, rememberPage, fallbackToQuote, openInBrowser,
  };
}
