import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfPreview } from "./pdf-viewer";
import { pdf } from "./pdf-slick-test-mocks";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("../platform/browser-runtime", () => ({ isBrowserHosted: () => false }));
vi.mock("pdfjs-dist", async () => ({ GlobalWorkerOptions: (await import("./pdf-slick-test-mocks")).pdf.state.workerOptions }));
vi.mock("@pdfslick/core", async () => ({ PDFSlick: (await import("./pdf-slick-test-mocks")).pdf.PdfSlickMock }));

/** A fit button always fits: pressed while the page is fitted, it stays on; only a zoom leaves the fit. */
describe("the PDF toolbar's fit buttons", () => {
  beforeEach(() => {
    Object.assign(pdf.state, {
      instances: [], numPages: 3, viewportScale: 1, deferLoad: false, loadError: null, deferReady: false, pendingLoad: null, hosted: false,
    });
    localStorage.clear();
  });
  afterEach(cleanup);

  it("keeps Fit page to width on when it is pressed while the page is already fitted", async () => {
    const view = render(<PdfPreview url="https://example.test/paper.pdf" />);
    await view.findByLabelText("PDF page 3");
    const fitWidth = view.getByRole("button", { name: "Fit page to width" });
    await waitFor(() => expect(fitWidth).toBeEnabled());
    expect(fitWidth).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(fitWidth);
    expect(fitWidth).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(view.getByRole("button", { name: "Zoom out" }));
    await waitFor(() => expect(fitWidth).toHaveAttribute("aria-pressed", "false"));
    fireEvent.click(fitWidth);
    expect(fitWidth).toHaveAttribute("aria-pressed", "true");
  });
});
