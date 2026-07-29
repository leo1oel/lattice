import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CircleHelp } from "lucide-react";
import { CloseButton, IconButton } from "./icon-button";

describe("IconButton", () => {
  it("provides one accessible label and consistent size metadata", () => {
    render(
      <IconButton label="Help" size="compact">
        <CircleHelp />
      </IconButton>,
    );

    const button = screen.getByRole("button", { name: "Help" });
    expect(button).toHaveAttribute("data-slot", "icon-button");
    expect(button).toHaveAttribute("data-size", "compact");
  });

  it("renders the shared close action and forwards clicks", () => {
    const onClick = vi.fn();
    render(<CloseButton label="Close settings" onClick={onClick} />);

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("supports a primary icon action without borrowing text-button classes", () => {
    render(
      <IconButton label="Send message" tone="primary" tooltip={false}>
        <CircleHelp />
      </IconButton>,
    );

    expect(screen.getByRole("button", { name: "Send message" }))
      .toHaveAttribute("data-tone", "primary");
  });
});
