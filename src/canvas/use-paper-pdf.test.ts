import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasMode, PaperSummary } from "../app-types";
import { paperPdfReading } from "../papers/paper-pdf-reading";
import { usePaperPdf } from "./use-paper-pdf";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./canvas-lazy-modules", () => ({ loadPdfPreviewModule: vi.fn(async () => ({})), loadPdfQuotePageModule: vi.fn() }));

const paper: PaperSummary = { arxivId: "1706.03762", citationKey: "vaswani2017", title: "Attention Is All You Need", hasFullText: true, hasBlog: true };
const fullText = ".research/papers/1706.03762/paper.md";
const blog = ".research/papers/1706.03762/blog.md";

type Front = { activePaper: PaperSummary | null; activeFile: string; mode: CanvasMode };

function renderReader(front: Front) {
  const previewViewportRef = { current: null };
  return renderHook((props: Front) => usePaperPdf({
    ...props,
    onOpenMarkdownPath: () => {},
    flushVisualMarkdown: () => true,
    previewViewportRef,
    settledPreviewText: "",
    sourceRequest: null,
    onSourceRequestHandled: () => {},
  }), { initialProps: front });
}

afterEach(() => paperPdfReading.set(paper.arxivId, null));

describe("a Paper read as its PDF", () => {
  it("keeps its PDF while another document is in front, and shows it again on its return", () => {
    const reader = renderReader({ activePaper: paper, activeFile: fullText, mode: "pdf" });
    act(() => reader.result.current.openPdf());
    expect(reader.result.current.pdfView?.url).toBe("https://arxiv.org/pdf/1706.03762");
    expect(paperPdfReading.get(paper.arxivId)).toMatchObject({ url: "https://arxiv.org/pdf/1706.03762", path: fullText });

    reader.rerender({ activePaper: null, activeFile: "main.tex", mode: "split" });
    expect(reader.result.current.pdfView).toBeNull();
    // Set aside, the Paper still reads as its PDF (the panel beside shows it).
    expect(paperPdfReading.get(paper.arxivId)).toBeDefined();

    reader.rerender({ activePaper: paper, activeFile: fullText, mode: "pdf" });
    expect(reader.result.current.pdfView?.url).toBe("https://arxiv.org/pdf/1706.03762");
  });

  it("is read as text again once the writer goes back to its text", () => {
    const reader = renderReader({ activePaper: paper, activeFile: fullText, mode: "pdf" });
    act(() => reader.result.current.openPdf());
    act(() => reader.result.current.closePdf());
    expect(paperPdfReading.get(paper.arxivId)).toBeUndefined();
    reader.rerender({ activePaper: null, activeFile: "main.tex", mode: "split" });
    reader.rerender({ activePaper: paper, activeFile: fullText, mode: "pdf" });
    expect(reader.result.current.pdfView).toBeNull();
  });

  it("stays on its text once App marks it so for the writer's other reading or layout", () => {
    const reader = renderReader({ activePaper: paper, activeFile: fullText, mode: "pdf" });
    act(() => reader.result.current.openPdf());
    // As App's Blog/Paper and Edit/Split/Preview do, before the change lands.
    act(() => paperPdfReading.set(paper.arxivId, null));
    reader.rerender({ activePaper: paper, activeFile: blog, mode: "pdf" });
    expect(reader.result.current.pdfView).toBeNull();
    reader.rerender({ activePaper: paper, activeFile: blog, mode: "split" });
    expect(reader.result.current.pdfView).toBeNull();
  });
});
