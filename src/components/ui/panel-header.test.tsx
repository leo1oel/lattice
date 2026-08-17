import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Settings } from "lucide-react";
import { PanelHeader } from "./panel-header";

describe("PanelHeader", () => {
  it("derives an accessible close label from a string title", () => {
    render(
      <PanelHeader
        title="Settings"
        icon={<Settings />}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close Settings" }))
      .not.toHaveAttribute("data-state");
  });
});
