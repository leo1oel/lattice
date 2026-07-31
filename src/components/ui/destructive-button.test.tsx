import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DestructiveButton } from "./destructive-button";

afterEach(cleanup);

describe("DestructiveButton", () => {
  it("keeps normal button semantics while providing the shared trash animation", () => {
    render(
      <DestructiveButton aria-label="Delete file" iconSize={12}>
        Delete
      </DestructiveButton>,
    );

    const button = screen.getByRole("button", { name: "Delete file" });
    expect(button).toHaveAttribute("type", "button");
    expect(button.querySelector(".destructive-button-icon svg")).toBeInTheDocument();
    expect(button).toHaveTextContent("Delete");
  });

  it("preserves the disabled state", () => {
    render(<DestructiveButton aria-label="Delete file" disabled />);
    expect(screen.getByRole("button", { name: "Delete file" })).toBeDisabled();
  });
});
