import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { paperPdfUrl } from "../papers/paper-source";
import { sourceQuoteDomRange } from "../papers/source-quote";
import type { PdfSourceQuote } from "../pdf/pdf-viewer";
import { notifyError } from "../telemetry/app-notify";
import type { CanvasMode, PaperSummary } from "../app-types";
import { loadPdfPreviewModule } from "./canvas-lazy-modules";

type PaperPdfSource = {
  key: string;
  url: string;
  fileName: string;
  generic: boolean;
};

export type PaperPdfView = PaperPdfSource & {
  bytes: ArrayBuffer | null;
  previewUrl: string | null;
  error: boolean;
  initialPage: number;
  quote: PdfSourceQuote | null;
};

type PaperLink = Pick<PaperSummary, "arxivId" | "url">;

function normalizedArxivId(value: string): string {
  const candidate = value.trim();
  return /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?$/i.test(candidate)
    ? candidate
    : "";
}

function paperPdfSource(paper: PaperLink): PaperPdfSource | null {
  const arxivId = normalizedArxivId(paper.arxivId);
  if (arxivId) {
    const url = `https://arxiv.org/pdf/${arxivId.split("/").map(encodeURIComponent).join("/")}`;
    return { key: url, url, fileName: `${arxivId.replace("/", "-")}.pdf`, generic: false };
  }
  const sourceUrl = paperPdfUrl(paper);
  if (!sourceUrl) return null;
  try {
    const parsed = new URL(sourceUrl);
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:")
      || !parsed.pathname.toLocaleLowerCase().endsWith(".pdf")) return null;
    const pathName = parsed.pathname.split("/").at(-1) || "paper.pdf";
    let fileName = pathName;
    try {
      fileName = decodeURIComponent(pathName);
    } catch {
      // A malformed escape in the display name must not make an otherwise safe PDF URL unusable.
    }
    return { key: parsed.href, url: parsed.href, fileName, generic: true };
  } catch {
    return null;
  }
}

function paperBrowserUrl(paper: PaperLink): string | null {
  const pdfUrl = paperPdfUrl(paper);
  if (pdfUrl) return pdfUrl;
  if (paper.url) {
    try {
      const parsed = new URL(paper.url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.href;
    } catch {
      // Do not hand a malformed or unsafe bibliography URL to the OS opener.
    }
  }
  return null;
}

type PaperQuoteFallback = { paperId: string; path: string; returnPath: string; quote: PdfSourceQuote };

/**
 * The Paper reader's alternate PDF surface: which original PDF the open Paper
 * has, the one view of it currently shown (with its bytes cached for a quick
 * return), and the fallback into the full-text Markdown when a quoted source
 * cannot be shown in the PDF.
 */
export function usePaperPdf({
  activePaper,
  activeFile,
  mode,
  onOpenMarkdownPath,
  flushVisualMarkdown,
  previewViewportRef,
  settledPreviewText,
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
  const pdfSource = useMemo(
    () => activePaperId !== undefined ? paperPdfSource({ arxivId: activePaperId, url: activePaperUrl }) : null,
    [activePaperId, activePaperUrl],
  );
  const browserUrl = useMemo(
    () => activePaperId !== undefined ? paperBrowserUrl({ arxivId: activePaperId, url: activePaperUrl }) : null,
    [activePaperId, activePaperUrl],
  );
  const [pdfView, setPdfView] = useState<PaperPdfView | null>(null);
  const [quoteFallback, setQuoteFallback] = useState<PaperQuoteFallback | null>(null);
  const returnViewportRef = useRef<{ path: string; scrollTop: number; scrollRange: number } | null>(null);
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
  }, [activePaperId, pdfSource]);
  useEffect(() => {
    // The paper article is already useful while this local chunk initializes.
    // Start it here so a later PDF click waits only for the remote source and PDF.js.
    if (pdfSource) void loadPdfPreviewModule();
  }, [pdfSource]);
  useEffect(() => {
    // Blog/Paper and Edit/Split/Preview remain the owners of Markdown state.
    // Choosing one while the PDF is open exits the alternate PDF surface.
    requestRef.current += 1;
    setPdfView(null);
  }, [activeFile, mode]);
  useEffect(() => {
    const viewport = previewViewportRef.current;
    if (!quoteFallback || quoteFallback.paperId !== activePaperId || quoteFallback.path !== activeFile || !viewport) return;
    let frame = 0;
    let matched = false;
    const locate = () => {
      if (matched) return;
      const root = viewport.querySelector<HTMLElement>(".ProseMirror") ?? viewport;
      const range = sourceQuoteDomRange(root, quoteFallback.quote.first, quoteFallback.quote.last);
      if (!range) return;
      matched = true;
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
    if (viewport) returnViewportRef.current = {
      path: activeFile, scrollTop: viewport.scrollTop,
      scrollRange: Math.max(0, viewport.scrollHeight - viewport.clientHeight),
    };
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
  const closePdf = useCallback(() => {
    requestRef.current += 1;
    setPdfView(null);
  }, []);
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
      notifyError(t`Papers`, t`Could not open the article in your browser`, {
        detail: reason instanceof Error ? reason.message : String(reason),
      });
    });
  }, [browserUrl, t]);

  return {
    pdfSource,
    browserUrl,
    pdfView: activePaper && pdfView && pdfView.key === pdfSource?.key ? pdfView : null,
    quoteFallback,
    /** Where the reader came from before a quote fell back into this full text, while it is shown. */
    quoteReturnPath: quoteFallback?.paperId === activePaperId && quoteFallback?.path === activeFile
      ? quoteFallback.returnPath
      : null,
    clearQuoteFallback: () => setQuoteFallback(null),
    returnViewportRef,
    openPdf,
    closePdf,
    capturePdf,
    rememberPage,
    fallbackToQuote,
    openInBrowser,
  };
}
