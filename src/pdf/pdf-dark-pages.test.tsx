import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfPreview } from "./pdf-viewer";

/** A PDFSlick whose document never arrives: the toolbar is all these tests read. */
vi.mock("@pdfslick/core", () => ({
  PDFSlick: class {
    l10n = { get: async (id: string) => id };
    store = { getState: () => ({ pagesReady: false }), subscribe: () => () => undefined };
    viewer = { cleanup() {}, setDocument() {}, update() {}, currentScale: 1, currentScaleValue: "page-width" };
    linkService = { page: 1, setDocument() {} };
    on() {}
    dispatch() {}
    unbindEvents() {}
    loadDocument = () => new Promise(() => undefined);
  },
}));
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, PDFDataRangeTransport: class {} }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

const KEY = "lattice.pdf-dark-pages.v1";

describe("dark PDF pages", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it("is off until turned on, then darkens every viewer and is remembered for the next", () => {
    const view = render(<>
      <PdfPreview url="https://example.test/main.pdf" />
      <PdfPreview url="https://example.test/paper.pdf" />
    </>);
    const previews = [...view.container.querySelectorAll(".pdf-preview")];
    const [toggle] = view.getAllByRole("button", { name: "Dark pages" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(previews.filter((preview) => preview.hasAttribute("data-dark-pages"))).toHaveLength(0);

    fireEvent.click(toggle!);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveClass("active");
    expect(previews.filter((preview) => preview.hasAttribute("data-dark-pages"))).toHaveLength(2);
    expect(localStorage.getItem(KEY)).toBe("true");

    view.unmount();
    const next = render(<PdfPreview url="https://example.test/main.pdf" />);
    expect(next.container.querySelector(".pdf-preview")).toHaveAttribute("data-dark-pages");
  });

  it("follows a choice made in another window, such as the PDF's own", () => {
    localStorage.setItem(KEY, "true");
    const view = render(<PdfPreview url="https://example.test/main.pdf" />);
    const preview = view.container.querySelector(".pdf-preview")!;
    expect(preview).toHaveAttribute("data-dark-pages");

    localStorage.setItem(KEY, "false");
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "false" })));
    expect(preview).not.toHaveAttribute("data-dark-pages");
  });
});
