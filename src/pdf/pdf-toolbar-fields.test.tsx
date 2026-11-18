import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfPreview } from "./pdf-viewer";
import { pdf } from "./pdf-slick-test-mocks";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("../platform/browser-runtime", () => ({ isBrowserHosted: () => false }));
vi.mock("pdfjs-dist", async () => ({ GlobalWorkerOptions: (await import("./pdf-slick-test-mocks")).pdf.state.workerOptions }));
vi.mock("@pdfslick/core", async () => ({ PDFSlick: (await import("./pdf-slick-test-mocks")).pdf.PdfSlickMock }));

/** The toolbar's page number field: a field left as it was moves nothing. */
describe("the PDF toolbar's page number field", () => {
  beforeEach(() => {
    Object.assign(pdf.state, {
      instances: [], numPages: 3, viewportScale: 1, deferLoad: false, loadError: null, deferReady: false, pendingLoad: null, hosted: false,
    });
    localStorage.clear();
  });
  afterEach(cleanup);

  async function renderShown() {
    const view = render(<PdfPreview url="https://example.test/paper.pdf" />);
    await view.findByLabelText("PDF page 3");
    return { view, slick: pdf.state.instances[0]! };
  }

  it("goes to a typed page on Enter, and to the page shown when Enter confirms it", async () => {
    const { view, slick } = await renderShown();
    const field = view.getByLabelText("PDF page number");
    act(() => field.focus());
    fireEvent.change(field, { target: { value: "2" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(slick.gotoPage).toHaveBeenLastCalledWith(2);

    slick.gotoPage.mockClear();
    act(() => field.focus());
    fireEvent.keyDown(field, { key: "Enter" });
    expect(slick.gotoPage).toHaveBeenCalledWith(2);
  });

  it("leaves the reader's place alone when the page field loses focus unchanged", async () => {
    const { view, slick } = await renderShown();
    act(() => slick.gotoPage(3));
    slick.args.container.scrollTop = 2_430;
    slick.gotoPage.mockClear();
    const field = view.getByLabelText("PDF page number");
    act(() => field.focus());
    act(() => field.blur());
    expect(slick.gotoPage).not.toHaveBeenCalled();
    expect(slick.args.container.scrollTop).toBe(2_430);

    // A changed page still goes when the reader clicks away.
    act(() => field.focus());
    fireEvent.change(field, { target: { value: "1" } });
    act(() => field.blur());
    expect(slick.gotoPage).toHaveBeenCalledWith(1);
  });
});
