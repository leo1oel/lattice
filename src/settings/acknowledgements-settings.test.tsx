import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AcknowledgementsSettings } from "./acknowledgements-settings";

const license = vi.hoisted(() => ({
  current: null as { title: string; text: string } | null,
}));
vi.mock("virtual:lattice-private-fonts-license", () => ({
  get fontLicense() {
    return license.current;
  },
}));

describe("acknowledgements", () => {
  it("credits the panel layout in every build and leaves the fonts out of a build without them", () => {
    license.current = null;
    render(<AcknowledgementsSettings />);
    expect(screen.getByRole("heading", { name: "Acknowledgements" })).toBeInTheDocument();
    expect(screen.getByText("Uses Trellis by DanFessler")).toBeInTheDocument();
    expect(screen.queryByText("Interface fonts")).not.toBeInTheDocument();
  });

  it("shows the embedded fonts' license in full, paragraph by paragraph", () => {
    // A stand-in: the real license may not enter the repository.
    license.current = { title: "Example Font License 1.0", text: "First paragraph.\n\nSecond paragraph." };
    render(<AcknowledgementsSettings />);
    expect(screen.getByText("Interface fonts")).toBeInTheDocument();
    expect(screen.getByText(/used under the Example Font License 1\.0/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /timeless\.co/ })).toBeInTheDocument();
    const text = screen.getByRole("region", { name: "Example Font License 1.0" });
    expect([...text.querySelectorAll("p")].map((paragraph) => paragraph.textContent)).toEqual(["First paragraph.", "Second paragraph."]);
  });
});
