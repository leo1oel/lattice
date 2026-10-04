import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AcknowledgementsSettings } from "./acknowledgements-settings";

const license = vi.hoisted(() => ({ url: null as string | null }));
vi.mock("virtual:lattice-private-fonts-license", () => ({
  get fontLicenseUrl() {
    return license.url;
  },
}));
// The real viewer needs PDF.js and a canvas; what matters here is which file it is given.
vi.mock("../canvas/canvas-lazy-editors", () => ({
  PdfPreview: ({ url }: { url: string }) => <div role="document" data-url={url} />,
  PdfPreviewLoading: () => null,
}));

describe("acknowledgements", () => {
  it("renders nothing in a build without the licensed fonts", () => {
    license.url = null;
    const { container } = render(<AcknowledgementsSettings />);
    expect(container).toBeEmptyDOMElement();
  });

  it("credits the embedded fonts and opens their shipped license in the PDF viewer", () => {
    // A stand-in: the real license may not enter the repository.
    license.url = "/assets/LICENSE-stand-in.pdf";
    render(<AcknowledgementsSettings />);
    expect(screen.getByRole("heading", { name: "Acknowledgements" })).toBeInTheDocument();
    expect(screen.getByText(/used under the Timeless Free Font License/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /timeless\.co/ })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "View license" }));
    const dialog = screen.getByRole("dialog", { name: "Timeless Free Font License" });
    expect(dialog.querySelector("[role=document]")).toHaveAttribute("data-url", "/assets/LICENSE-stand-in.pdf");
  });
});
