import { expectInvoked, markdownSnapshot, mockPdfDocument, pdfDocumentStub, projectCommands, SINGLE_TRANSFORMER } from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { documentCanvas } from "./app-test-canvas";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { getDocument } from "pdfjs-dist";
import { describe, expect, it, vi } from "vitest";

/**
 * A source link (a page of a paper's PDF, its quote's first and last words in
 * the title) followed from a note opens that library paper's PDF in the
 * reader at the page, the way the paper's own overview links do.
 */
const { renderApp } = appHarness({ documentCanvas });

const PDF_URL = `https://arxiv.org/pdf/${SINGLE_TRANSFORMER.arxivId}`;

function renderNote(note: string) {
  mockPdfDocument(() => pdfDocumentStub(9, { render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }) }));
  renderApp({
    ...projectCommands(markdownSnapshot("notes.md"), note),
    list_papers: () => [SINGLE_TRANSFORMER],
    read_paper: "# A Single Transformer\n\nPaper body.",
  });
}

describe("source links in a note", () => {
  it("open the cited library paper's PDF at the linked page", async () => {
    renderNote(`# Reading\n\nSee [p. 7](${PDF_URL}#page=7 "a single … transformer").\n`);
    fireEvent.click(await screen.findByRole("link", { name: "p. 7" }));
    await expectInvoked("read_paper", { arxivId: SINGLE_TRANSFORMER.arxivId });
    await waitFor(() => expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({ url: PDF_URL })));
    expect(await screen.findByRole("button", { name: "Back to Paper" })).toBeVisible();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "PDF page number" })).toHaveValue("7"));
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("leave a link to a paper outside the library to the browser", async () => {
    const elsewhere = "https://arxiv.org/pdf/2101.00001#page=3";
    renderNote(`# Reading\n\nSee [p. 3](${elsewhere} "a … b").\n`);
    fireEvent.click(await screen.findByRole("link", { name: "p. 3" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(elsewhere));
    expect(screen.queryByRole("button", { name: "Back to Paper" })).toBeNull();
  });
});
