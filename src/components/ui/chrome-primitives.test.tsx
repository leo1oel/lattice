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

describe("shared chrome primitives", () => {
  it("applies semantic button, badge, and inline-message variants without feature-owned geometry", () => {
    render(
      <>
        <Button variant="primary">Save</Button>
        <Badge tone="success">Connected</Badge>
        <InlineMessage level="warning">Needs attention</InlineMessage>
      </>,
    );
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveAttribute("data-variant", "primary");
    expect(button).toHaveAttribute("data-size", "default");
    expect(button).toHaveClass("ui-button--primary", "ui-button--default");
    expect(buttonClassName({ variant: "ghost", size: "compact" }))
      .toContain("ui-button--ghost");

    const badge = screen.getByText("Connected");
    expect(badge).toHaveAttribute("data-tone", "success");
    expect(badge).toHaveClass("ui-badge");

    const message = screen.getByRole("status");
    expect(message).toHaveClass("ui-inline-message", "warning");
    expect(message.querySelector("svg")).toHaveClass("ui-inline-message-icon");
    expect(message.querySelector("span")).toHaveClass("ui-inline-message-copy");
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
    for (const token of [
      "rounded-[var(--nested-radius,var(--radius-icon))]", "duration-[var(--duration-quick)]", "ease-out",
      "[&_svg]:[stroke-width:1.5]",
    ]) expect(menuItemClassName).toContain(token);
  });

  it("exposes switch state, reports the requested next value, and stays inert while disabled", () => {
    const onChange = vi.fn();
    const { rerender } = render(<Switch checked={false} label="Enable server" onChange={onChange} />);
    const control = screen.getByRole("switch", { name: "Enable server" });
    expect(control).toHaveAttribute("aria-checked", "false");
    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(true);

    rerender(<Switch checked label="Enable server" onChange={onChange} />);
    expect(control).toHaveAttribute("aria-checked", "true");
    expect(control.querySelector(".ui-switch-thumb")).not.toBeNull();

    rerender(<Switch checked disabled label="Enable server" onChange={onChange} />);
    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("keeps checkbox states in one native control and reports checkbox and segmented tab changes", () => {
    const onChange = vi.fn();
    const onTabChange = vi.fn();
    const items = [{ value: "source", label: "Source" }, { value: "pdf", label: "PDF" }];
    render(
      <>
        <CheckboxField checked={false} label="Match case" onChange={onChange} />
        <Checkbox aria-label="Select all files" indeterminate />
        <SegmentedControl value="source" onChange={onTabChange} ariaLabel="Document view" items={items} />
      </>,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Match case" }));
    expect(onChange).toHaveBeenCalled();

    const mixed = screen.getByRole("checkbox", { name: "Select all files" });
    expect(mixed).toHaveAttribute("aria-checked", "mixed");
    expect((mixed as HTMLInputElement).indeterminate).toBe(true);

    // Compact tab switches use the shared segmented contract.
    expect(screen.getByRole("tablist", { name: "Document view" }))
      .toHaveClass("ui-segmented--compact");
    fireEvent.click(screen.getByRole("tab", { name: "PDF" }));
    expect(onTabChange).toHaveBeenCalledWith("pdf");
  });

  it("exposes the shared form size on text controls and select triggers, and opens selects from the keyboard", async () => {
    render(
      <>
        <Input aria-label="Project name" controlSize="form" />
        <Textarea aria-label="System prompt" />
        <Select defaultValue="local">
          <SelectTrigger aria-label="Runtime" size="form">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="local">Local</SelectItem>
            <SelectItem value="remote">Remote</SelectItem>
          </SelectContent>
        </Select>
      </>,
    );
    const trigger = screen.getByRole("combobox", { name: "Runtime" });

    expect(screen.getByRole("textbox", { name: "Project name" }))
      .toHaveAttribute("data-control-size", "form");
    expect(screen.getByRole("textbox", { name: "System prompt" }))
      .toHaveAttribute("data-slot", "textarea");
    expect(trigger).toHaveAttribute("data-control-size", "form");

    // The keyboard opens the select, and Escape restores focus to its trigger.
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

  it("gives switch fields and settings rows the same data-row density contract", () => {
    render(
      <>
        <SwitchField checked label="Spellcheck prose" onChange={() => undefined} />
        <SettingsGroup title="Display">
          <SettingsRow htmlFor="interface-size" label="Interface size" description="Scales every panel">
            <input id="interface-size" type="range" />
          </SettingsRow>
          <SettingsRow label="Version" description="You’re on the latest version" />
        </SettingsGroup>
      </>,
    );
    expect(screen.getByText("Spellcheck prose").closest("[data-slot='switch-field']"))
      .toHaveClass("ui-row--data");
    expect(rowClassName("store", "project-row"))
      .toContain("ui-row--store");
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
  it("labels icon, close, and panel-close buttons, and keeps destructive buttons real buttons with the trash animation", () => {
    const onClick = vi.fn();
    render(
      <>
        <IconButton label="Help" size="compact"><CircleHelp /></IconButton>
        <IconButton label="Send message" tone="primary" tooltip={false}><CircleHelp /></IconButton>
        <CloseButton label="Close settings" onClick={onClick} />
        <PanelHeader title="Settings" icon={<Settings />} onClose={() => {}} />
        <DestructiveButton aria-label="Delete file" iconSize={12}>Delete</DestructiveButton>
        <DestructiveButton aria-label="Delete folder" disabled />
      </>,
    );

    const help = screen.getByRole("button", { name: "Help" });
    expect(help).toHaveAttribute("data-slot", "icon-button");
    expect(help).toHaveAttribute("data-size", "compact");
    expect(screen.getByRole("button", { name: "Send message" })).toHaveAttribute("data-tone", "primary");
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(onClick).toHaveBeenCalledOnce();
    // A panel derives its accessible close label from a string title.
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close Settings" }))
      .not.toHaveAttribute("data-state");

    const button = screen.getByRole("button", { name: "Delete file" });
    expect(button).toHaveAttribute("type", "button");
    expect(button.querySelector(".destructive-button-icon svg")).toBeInTheDocument();
    expect(button).toHaveTextContent("Delete");
    expect(screen.getByRole("button", { name: "Delete folder" })).toBeDisabled();
  });

  it("renders a Settings heading with its action, and an empty state without imposing a heading", () => {
    const { unmount } = render(
      <SettingsSectionHeader
        title="Appearance"
        description="Preferences for this Mac"
        actions={<button type="button">Reset</button>}
      />,
    );

    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
    unmount();
    render(<EmptyState description="No results" density="compact" />);

    expect(screen.getByText("No results")).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });
});
