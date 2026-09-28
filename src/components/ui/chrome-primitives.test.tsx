import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { CircleHelp, Settings } from "lucide-react";
import { Badge } from "./badge";
import { Button } from "./button";
import { buttonClassName } from "./button-styles";
import { floatingSurfaceClassName, menuItemClassName, menuViewportClassName } from "./menu-surface";
import { Checkbox } from "./checkbox";
import { CheckboxField } from "./checkbox-field";
import { DestructiveButton } from "./destructive-button";
import { EmptyState } from "./empty-state";
import { CloseButton, IconButton } from "./icon-button";
import { InlineMessage } from "./inline-message";
import { Input } from "./input";
import { PanelHeader } from "./panel-header";
import { rowClassName } from "./row";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
import { SegmentedControl } from "./segmented-control";
import { SettingsGroup, SettingsRow } from "./settings-row";
import { SettingsSectionHeader } from "./settings-section-header";
import { Switch } from "./switch";
import { SwitchField } from "./switch-field";
import { Textarea } from "./textarea";

afterEach(cleanup);

function renderRuntimeSelect(size?: "form") {
  render(
    <Select defaultValue="local">
      <SelectTrigger aria-label="Runtime" size={size}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="local">Local</SelectItem>
        <SelectItem value="remote">Remote</SelectItem>
      </SelectContent>
    </Select>,
  );
  return screen.getByRole("combobox", { name: "Runtime" });
}

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

  it("gives primary buttons press feedback and keeps menu items concentric", () => {
    const chrome = String(readFileSync("src/components/ui/chrome.css", "utf8"));
    expect(chrome).toContain(".ui-button--primary:active:not(:disabled)");
    expect(chrome).toContain("scale: 0.96");
    // The portaled surface declares both inputs to the same derived radius
    // contract used by hand-written menus. Regular labels take a 1.5 stroke.
    expect(floatingSurfaceClassName).toContain("[--nested-radius:calc(var(--surface-radius)-var(--surface-inset))]");
    expect(menuViewportClassName).toContain("p-[var(--surface-inset)]");
    expect(menuViewportClassName).not.toContain("scrollbar-width:none");

    expect(menuItemClassName).toContain("rounded-[var(--nested-radius,var(--radius-icon))]");
    expect(menuItemClassName).toContain("duration-[var(--duration-quick)]");
    expect(menuItemClassName).toContain("ease-out");
    expect(menuItemClassName).toContain("[&_svg]:[stroke-width:1.5]");
  });

  it("renders a semantic badge without feature-owned geometry", () => {
    render(<Badge tone="success">Connected</Badge>);

    const badge = screen.getByText("Connected");
    expect(badge).toHaveAttribute("data-tone", "success");
    expect(badge).toHaveClass("ui-badge");
    expect(badge.classList.length).toBeGreaterThan(1);
  });

  it("exposes switch state, reports the requested next value, and stays inert while disabled", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Switch checked={false} label="Enable server" onChange={onChange} />,
    );

    const control = screen.getByRole("switch", { name: "Enable server" });
    expect(control).toHaveAttribute("aria-checked", "false");
    const uncheckedClasses = control.className;
    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(true);

    rerender(<Switch checked label="Enable server" onChange={onChange} />);
    expect(control.className).not.toBe(uncheckedClasses);
    expect(control.querySelector(".ui-switch-thumb")?.classList.length)
      .toBeGreaterThan(1);

    rerender(<Switch checked disabled label="Enable server" onChange={onChange} />);
    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("keeps inline-message levels semantic while styling each owned element", () => {
    render(<InlineMessage level="warning">Needs attention</InlineMessage>);

    const message = screen.getByRole("status");
    expect(message).toHaveClass("ui-inline-message", "warning");
    expect(message.classList.length).toBeGreaterThan(2);
    expect(message.querySelector("svg")?.getAttribute("class")).toBeTruthy();
    expect(message.querySelector("span")?.getAttribute("class")).toBeTruthy();
  });

  it("keeps checked, mixed, and labelled checkbox states in one native control", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <CheckboxField checked={false} label="Match case" onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Match case" }));
    expect(onChange).toHaveBeenCalled();

    rerender(<Checkbox aria-label="Select all files" indeterminate />);
    const mixed = screen.getByRole("checkbox", { name: "Select all files" });
    expect(mixed).toHaveAttribute("aria-checked", "mixed");
    expect((mixed as HTMLInputElement).indeterminate).toBe(true);
  });

  it("exposes the shared form size on text controls and select triggers", () => {
    render(
      <>
        <Input aria-label="Project name" controlSize="form" />
        <Textarea aria-label="System prompt" />
      </>,
    );
    const trigger = renderRuntimeSelect("form");

    expect(screen.getByRole("textbox", { name: "Project name" }))
      .toHaveAttribute("data-control-size", "form");
    expect(screen.getByRole("textbox", { name: "System prompt" }))
      .toHaveAttribute("data-slot", "textarea");
    expect(trigger).toHaveAttribute("data-control-size", "form");
  });

  it("opens selects from the keyboard and restores focus on Escape", async () => {
    const trigger = renderRuntimeSelect();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    const listbox = await screen.findByRole("listbox");
    const selectedOption = screen.getByRole("option", { name: "Local" });
    expect(selectedOption).toHaveAttribute("aria-selected", "true");
    expect(selectedOption.querySelector('[data-slot="select-item-indicator"] svg'))
      .toBeInTheDocument();
    fireEvent.keyDown(listbox, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());
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
    render(<SwitchField checked label="Spellcheck prose" onChange={() => undefined} />);

    expect(screen.getByText("Spellcheck prose").closest("[data-slot='switch-field']"))
      .toHaveClass("ui-row--data");
    expect(rowClassName("store", "project-row"))
      .toContain("ui-row--store");
  });

  it("gives settings rows the same row contract as a switch field", () => {
    render(
      <SettingsGroup title="Display">
        <SettingsRow
          htmlFor="interface-size"
          label="Interface size"
          description="Scales every panel"
        >
          <input id="interface-size" type="range" />
        </SettingsRow>
        <SettingsRow label="Version" description="You’re on the latest version" />
      </SettingsGroup>,
    );

    const row = screen.getByText("Interface size").closest("[data-slot='settings-row']");
    expect(row).toHaveClass("ui-settings-row", "ui-row--data");
    expect(screen.getByText("Interface size").tagName).toBe("LABEL");
    expect(screen.getByRole("heading", { name: "Display", level: 3 }))
      .toHaveClass("ui-settings-group-title");
    expect(row?.querySelector(".ui-settings-row-control")?.firstElementChild)
      .toHaveAttribute("id", "interface-size");
    // A row with no control omits the control slot.
    expect(screen.getByText("Version").closest("[data-slot='settings-row']")
      ?.querySelector(".ui-settings-row-control")).toBeNull();
  });
});

describe("shared action and layout patterns", () => {
  it("gives icon buttons one accessible label, size metadata, and a primary tone", () => {
    render(
      <>
        <IconButton label="Help" size="compact"><CircleHelp /></IconButton>
        <IconButton label="Send message" tone="primary" tooltip={false}><CircleHelp /></IconButton>
      </>,
    );

    const help = screen.getByRole("button", { name: "Help" });
    expect(help).toHaveAttribute("data-slot", "icon-button");
    expect(help).toHaveAttribute("data-size", "compact");
    expect(screen.getByRole("button", { name: "Send message" })).toHaveAttribute("data-tone", "primary");
  });

  it("renders the shared close action and forwards clicks", () => {
    const onClick = vi.fn();
    render(<CloseButton label="Close settings" onClick={onClick} />);

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("derives a panel's accessible close label from a string title", () => {
    render(<PanelHeader title="Settings" icon={<Settings />} onClose={() => {}} />);

    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close Settings" }))
      .not.toHaveAttribute("data-state");
  });

  it("keeps destructive buttons real buttons with the shared trash animation", () => {
    const { rerender } = render(
      <DestructiveButton aria-label="Delete file" iconSize={12}>Delete</DestructiveButton>,
    );

    const button = screen.getByRole("button", { name: "Delete file" });
    expect(button).toHaveAttribute("type", "button");
    expect(button.querySelector(".destructive-button-icon svg")).toBeInTheDocument();
    expect(button).toHaveTextContent("Delete");
    rerender(<DestructiveButton aria-label="Delete file" disabled />);
    expect(screen.getByRole("button", { name: "Delete file" })).toBeDisabled();
  });

  it("renders a Settings heading and aligned action", () => {
    render(
      <SettingsSectionHeader
        title="Appearance"
        description="Preferences for this Mac"
        actions={<button type="button">Reset</button>}
      />,
    );

    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
  });

  it("renders an empty state without imposing a heading when none is needed", () => {
    render(<EmptyState description="No results" density="compact" />);

    expect(screen.getByText("No results")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });
});
