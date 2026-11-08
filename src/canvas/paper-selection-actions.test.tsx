import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperSummary } from "../app-types";
import { PaperSelectionActions } from "./paper-selection-actions";
import type { usePaperPdf } from "./use-paper-pdf";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => undefined) }));
const pdfSelection = vi.hoisted(() => ({ text: "" }));
vi.mock("../pdf/pdf-text-layer-selection", () => ({ pdfSelectedPlainTextWithin: () => pdfSelection.text }));

const paper: PaperSummary = { arxivId: "1706.03762", citationKey: "vaswani2017", title: "Attention Is All You Need", hasFullText: true, hasBlog: false };
const QUOTE = "We propose a new simple network architecture, the Transformer, based solely on attention mechanisms";

type Pdf = ReturnType<typeof usePaperPdf>;
type Place = { page: number; first: string; last: string } | null;
const pdfOf = (locateQuote = vi.fn(async (): Promise<Place> => ({ page: 3, first: "We propose a new", last: "solely on attention mechanisms" }))) => ({
  pdfSource: { key: "k", url: "https://arxiv.org/pdf/1706.03762", fileName: "1706.03762.pdf", generic: false },
  pdfView: null,
  locateQuote,
}) as unknown as Pdf;

/** The reader shell around `content`, with the bar mounted in it. */
function renderShell(content: string, pdf: Pdf) {
  const shellRef = createRef<HTMLElement>();
  const onOpenNote = vi.fn();
  render(
    <section ref={shellRef} className="paper-reader-shell">
      <div dangerouslySetInnerHTML={{ __html: content }} />
      <PaperSelectionActions shellRef={shellRef} paper={paper} pdf={pdf} overview={false} projectRoot="/p" onOpenNote={onOpenNote} />
    </section>,
  );
  return { shell: shellRef.current!, onOpenNote };
}

/** A finished drag in the shell, after the two frames the bar waits for. */
async function release(shell: HTMLElement) {
  fireEvent.mouseUp(shell);
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

beforeEach(() => {
  vi.mocked(invoke).mockImplementation(async (command) => (command === "stat_project_file" ? { exists: false } : undefined));
  Range.prototype.getClientRects = () => [new DOMRect(40, 60, 100, 16)] as unknown as DOMRectList;
});
afterEach(() => {
  vi.mocked(writeText).mockClear();
  window.getSelection()?.removeAllRanges();
  pdfSelection.text = "";
});

describe("the reader's selection actions", () => {
  it("copy a full-text passage's source link, its page found in the PDF", async () => {
    const pdf = pdfOf();
    const { shell } = renderShell(`<div class="markdown-preview"><p>${QUOTE}</p></div>`, pdf);
    const range = document.createRange();
    range.selectNodeContents(shell.querySelector("p")!);
    window.getSelection()!.addRange(range);
    await release(shell);
    fireEvent.click(await screen.findByRole("button", { name: "Copy source link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      '[p. 3](https://arxiv.org/pdf/1706.03762#page=3 "We propose a new … solely on attention mechanisms")',
    ));
    expect(pdf.locateQuote).toHaveBeenCalledWith(QUOTE);
    await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
  });

  it("add a PDF passage to the paper's note with its page, anchored in that page's text layer", async () => {
    const pdf = pdfOf();
    pdfSelection.text = "simple network architecture, the Transformer, based solely";
    const { shell } = renderShell(`
      <div class="paper-pdf-preview"><div data-page-number="2"><div class="textLayer">
        <span>We propose a new simple network architecture, the Transformer, based solely on attention.</span>
        <div class="pdf-sel-rect"></div>
      </div></div></div>`, pdf);
    await release(shell);
    fireEvent.click(await screen.findByRole("button", { name: "Add to note" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("write_project_file", expect.objectContaining({ path: "notes/vaswani2017.md" })));
    const content = vi.mocked(invoke).mock.calls.find(([command]) => command === "write_project_file")?.[1] as { content: string };
    expect(content.content).toContain(
      '> simple network architecture, the Transformer, based solely [p. 2](https://arxiv.org/pdf/1706.03762#page=2 "simple network architecture, the Transformer, based solely … simple network architecture, the Transformer, based solely")',
    );
    expect(pdf.locateQuote).not.toHaveBeenCalled();
  });

  it("says so when the PDF does not hold a full-text passage", async () => {
    const { shell } = renderShell(`<div class="markdown-preview"><p>${QUOTE}</p></div>`, pdfOf(vi.fn(async (): Promise<Place> => null)));
    const range = document.createRange();
    range.selectNodeContents(shell.querySelector("p")!);
    window.getSelection()!.addRange(range);
    await release(shell);
    fireEvent.click(await screen.findByRole("button", { name: "Copy source link" }));
    await waitFor(() => expect(screen.queryByRole("toolbar")).toBeNull());
    expect(writeText).not.toHaveBeenCalled();
  });

  it("offers nothing for a click that selects nothing", async () => {
    const { shell } = renderShell(`<div class="markdown-preview"><p>${QUOTE}</p></div>`, pdfOf());
    await release(shell);
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});
