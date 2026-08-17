import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PdfPreview } from "./pdf-viewer";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: {},
  TextLayer: class {},
  getDocument: vi.fn(),
}));

describe("PDF viewer controls", () => {
  it("does not reserve an outline track when an outline component renders nothing", () => {
    const EmptyOutline = () => null;
    const view = render(
      <PdfPreview
        url={null}
        pdfBase64={null}
        outline={<EmptyOutline />}
      />,
    );

    const findControls = view.container.querySelector(".pdf-find-controls");
    expect(findControls).not.toBeNull();
    expect(findControls?.querySelector(".pdf-outline-trigger")).toBeNull();
    expect(findControls?.querySelector(".pdf-search")).toBeInTheDocument();
  });

  it("keeps the search input controlled as compiled PDFs appear and disappear", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const view = render(<PdfPreview url={null} pdfBase64={null} />);

      view.rerender(<PdfPreview url="blob:lattice-compiled-pdf" pdfBase64={null} />);
      view.rerender(<PdfPreview url={null} pdfBase64={null} />);

      const errors = consoleError.mock.calls.flat().join("\n");
      expect(errors).not.toContain("changing an uncontrolled input to be controlled");
      expect(errors).not.toContain("changing a controlled input to be uncontrolled");
      view.unmount();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("starts from a file's local page and zoom without overwriting it before load", () => {
    const onViewState = vi.fn();
    const onPageChange = vi.fn();
    const view = render(
      <PdfPreview
        url={null}
        pdfBase64={null}
        initialViewState={{
          page: 7,
          scale: 1.75,
          fitMode: null,
          scrollTop: 640,
          scrollLeft: 30,
        }}
        onPageChange={onPageChange}
        onViewState={onViewState}
      />,
    );

    expect(onPageChange).toHaveBeenLastCalledWith(7);
    expect(JSON.parse(localStorage.getItem("lattice.pdf-view-preference.v1") ?? "null"))
      .toEqual({ fitMode: null, scale: 1.75 });
    view.unmount();
    expect(onViewState).not.toHaveBeenCalled();
  });
});
