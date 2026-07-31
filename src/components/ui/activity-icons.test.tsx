import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InfinityLoader, ReloadButton, ReloadIconButton } from "./activity-icons";

describe("activity icons", () => {
  it("uses the shared infinity asset for loading", () => {
    render(<InfinityLoader label="Loading project" size={18} />);
    const loader = screen.getByRole("img", { name: "Loading project" });
    expect(loader).toHaveStyle({ width: "18px", height: "18px" });
    expect(loader.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
  });

  it("turns once when a reload button is clicked and spins while busy", () => {
    const { rerender } = render(<ReloadButton>Refresh</ReloadButton>);
    const button = screen.getByRole("button", { name: "Refresh" });
    fireEvent.click(button);
    expect(button.querySelector(".ui-reload-icon")).toHaveClass("ui-reload-icon--once");

    rerender(<ReloadButton busy>Refresh</ReloadButton>);
    expect(button.querySelector(".ui-reload-icon")).toHaveClass("spin");
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it("gives icon-only reload actions the same behavior", () => {
    render(<ReloadIconButton label="Refresh versions" />);
    const button = screen.getByRole("button", { name: "Refresh versions" });
    fireEvent.click(button);
    expect(button.querySelector(".ui-reload-icon")).toHaveClass("ui-reload-icon--once");
  });
});
