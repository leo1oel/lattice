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
const root = document.documentElement;

describe("dark PDF pages", () => {
  beforeEach(() => {
    localStorage.clear();
    // Another window's reset: the root attribute follows it.
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: null })));
  });
  afterEach(cleanup);

  it("is off until turned on, then darkens every viewer's pages and is remembered for the next", () => {
    const view = render(<>
      <PdfPreview url="https://example.test/main.pdf" />
      <PdfPreview url="https://example.test/paper.pdf" />
    </>);
    const [toggle, other] = view.getAllByRole("button", { name: "Dark pages" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(root).not.toHaveAttribute("data-pdf-dark-pages");

    fireEvent.click(toggle!);
    expect(root).toHaveAttribute("data-pdf-dark-pages");
    for (const button of [toggle, other]) {
      expect(button).toHaveAttribute("aria-pressed", "true");
      expect(button).toHaveClass("active");
    }
    expect(localStorage.getItem(KEY)).toBe("true");

    view.unmount();
    const next = render(<PdfPreview url="https://example.test/main.pdf" />);
    expect(root).toHaveAttribute("data-pdf-dark-pages");
    expect(next.getByRole("button", { name: "Dark pages" })).toHaveAttribute("aria-pressed", "true");
  });

  it("follows a choice made in another window, such as the PDF's own", () => {
    const view = render(<PdfPreview url="https://example.test/main.pdf" />);
    localStorage.setItem(KEY, "true");
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "true" })));
    expect(root).toHaveAttribute("data-pdf-dark-pages");
    expect(view.getByRole("button", { name: "Dark pages" })).toHaveAttribute("aria-pressed", "true");

    localStorage.setItem(KEY, "false");
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "false" })));
    expect(root).not.toHaveAttribute("data-pdf-dark-pages");
  });
});
