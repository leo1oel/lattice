import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Badge } from "./badge";
import { Button } from "./button";
import { buttonClassName } from "./button-styles";
import { Checkbox } from "./checkbox";
import { CheckboxField } from "./checkbox-field";
import { rowClassName } from "./row";
import { SegmentedControl } from "./segmented-control";
import { Switch } from "./switch";
import { SwitchField } from "./switch-field";

afterEach(cleanup);

describe("shared chrome primitives", () => {
  it("applies semantic button variants and sizes", () => {
    render(<Button variant="primary">Save</Button>);

    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveAttribute("data-variant", "primary");
    expect(button).toHaveAttribute("data-size", "default");
    expect(button).toHaveClass("ui-button--primary", "ui-button--default");
    expect(buttonClassName({ variant: "ghost", size: "compact" }))
      .toContain("ui-button--ghost");
  });

  it("renders a semantic badge without feature-owned geometry", () => {
    render(<Badge tone="success">Connected</Badge>);

    expect(screen.getByText("Connected")).toHaveAttribute("data-tone", "success");
  });

  it("exposes switch state and reports the requested next value", () => {
    const onChange = vi.fn();
    render(<Switch checked={false} label="Enable server" onChange={onChange} />);

    const control = screen.getByRole("switch", { name: "Enable server" });
    expect(control).toHaveAttribute("aria-checked", "false");
    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("keeps checked, mixed, and labelled checkbox states in one native control", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <CheckboxField
        checked={false}
        label="Match case"
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Match case" }));
    expect(onChange).toHaveBeenCalled();

    rerender(<Checkbox aria-label="Select all files" indeterminate />);
    const mixed = screen.getByRole("checkbox", { name: "Select all files" });
    expect(mixed).toHaveAttribute("aria-checked", "mixed");
    expect((mixed as HTMLInputElement).indeterminate).toBe(true);
  });

  it("uses the shared segmented contract for compact tab switches", () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        value="source"
        onChange={onChange}
        ariaLabel="Document view"
        items={[
          { value: "source", label: "Source" },
          { value: "pdf", label: "PDF" },
        ]}
      />,
    );

    expect(screen.getByRole("tablist", { name: "Document view" }))
      .toHaveClass("ui-segmented--compact");
    fireEvent.click(screen.getByRole("tab", { name: "PDF" }));
    expect(onChange).toHaveBeenCalledWith("pdf");
  });

  it("keeps a persistent toggle in the data-row density contract", () => {
    render(
      <SwitchField
        checked
        label="Spellcheck prose"
        onChange={() => undefined}
      />,
    );

    expect(screen.getByText("Spellcheck prose").closest("[data-slot='switch-field']"))
      .toHaveClass("ui-row--data");
    expect(rowClassName("store", "project-row"))
      .toContain("ui-row--store");
  });
});
