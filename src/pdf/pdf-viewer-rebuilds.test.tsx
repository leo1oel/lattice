import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfPreview } from "./pdf-viewer";
import { pdf } from "./pdf-slick-test-mocks";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("../platform/browser-runtime", () => ({ isBrowserHosted: () => false }));
vi.mock("pdfjs-dist", async () => ({ GlobalWorkerOptions: (await import("./pdf-slick-test-mocks")).pdf.state.workerOptions }));
vi.mock("@pdfslick/core", async () => ({ PDFSlick: (await import("./pdf-slick-test-mocks")).pdf.PdfSlickMock }));

type PreviewProps = Partial<ComponentProps<typeof PdfPreview>>;
const preview = (url: string, props: PreviewProps = {}) => <PdfPreview url={url} {...props} />;

/** Wait for the (index + 1)th viewer: a rebuild staged after its debounce. */
async function viewerAt(index: number) {
  await waitFor(() => expect(pdf.state.instances).toHaveLength(index + 1), { timeout: 2_500 });
  return pdf.state.instances[index]!;
}

/**
 * Overleaf's preview stays on the passage being read while the writer edits
 * and the document compiles again and again; so does this one.
 */
describe("the compiled PDF across rebuilds", () => {
  beforeEach(() => {
    Object.assign(pdf.state, {
      instances: [], numPages: 3, viewportScale: 1, deferLoad: false, loadError: null, deferReady: false, pendingLoad: null, hosted: false,
    });
    localStorage.clear();
  });
  afterEach(cleanup);

  it("holds the reader's page through rebuilds in quick succession, and a superseded one never moves it", async () => {
    const onPageChange = vi.fn();
    const view = render(preview("https://example.test/build-1.pdf", { onPageChange }));
    await view.findByLabelText("PDF page 3");
    const shown = pdf.state.instances[0]!;
    act(() => shown.gotoPage(3));
    shown.args.container.scrollTop = 2_430;
    Object.defineProperty(shown.viewer.getPageView(2).div, "offsetTop", { value: 2_000 });

    // A rebuild with fewer pages is still loading when the next one lands.
    Object.assign(pdf.state, { deferReady: true, numPages: 2 });
    view.rerender(preview("https://example.test/build-2.pdf", { onPageChange }));
    const superseded = await viewerAt(1);
    Object.assign(pdf.state, { numPages: 4 });
    view.rerender(preview("https://example.test/build-3.pdf", { onPageChange }));
    const latest = await viewerAt(2);
    // The reader scrolls on while both load.
    shown.args.container.scrollTop = 2_520;
    Object.defineProperty(latest.viewer.getPageView(2).div, "offsetTop", { value: 2_100 });

    act(() => latest.finishReady());
    await waitFor(() => expect(shown.args.container.isConnected).toBe(false));
    expect(latest.gotoPage).toHaveBeenCalledWith(3);
    expect(latest.args.container.scrollTop).toBe(2_620);
    await waitFor(() => expect(onPageChange).toHaveBeenLastCalledWith(3));

    // The earlier build finishing late changes nothing on screen.
    act(() => superseded.finishReady());
    await act(async () => undefined);
    expect(superseded.gotoPage).not.toHaveBeenCalled();
    expect(latest.args.container.isConnected).toBe(true);
    expect(latest.args.container.scrollTop).toBe(2_620);
  });

  it("shows the last page, at the same point on it, when a rebuild has fewer pages than the one read", async () => {
    const view = render(preview("https://example.test/build-1.pdf"));
    await view.findByLabelText("PDF page 3");
    const shown = pdf.state.instances[0]!;
    act(() => shown.gotoPage(3));
    shown.args.container.scrollTop = 2_300;
    Object.defineProperty(shown.viewer.getPageView(2).div, "offsetTop", { value: 2_000 });

    Object.assign(pdf.state, { deferReady: true, numPages: 2 });
    view.rerender(preview("https://example.test/build-2.pdf"));
    const shorter = await viewerAt(1);
    Object.defineProperty(shorter.viewer.getPageView(1).div, "offsetTop", { value: 1_000 });
    act(() => shorter.finishReady());
    await waitFor(() => expect(shown.args.container.isConnected).toBe(false));
    expect(shorter.gotoPage).toHaveBeenCalledWith(2);
    expect(shorter.args.container.scrollTop).toBe(1_300);
  });
});
