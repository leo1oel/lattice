import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchPickerDialog, type SearchPickerItem } from "./search-picker-dialog";

const items: SearchPickerItem[] = [
  { id: "build", label: "Build project", group: "Build" },
  { id: "clean", label: "Clean aux files", group: "Build" },
  { id: "find", label: "Find in project", group: "Edit" },
  { id: "goto", label: "Go to line", group: "Navigate" },
];
const leading: SearchPickerItem[] = [
  { id: "goto", label: "Go to line", group: "Recent" },
  { id: "find", label: "Find in project", group: "Here" },
];

function renderPicker(onSelect = vi.fn()) {
  render(<SearchPickerDialog open title="Commands" placeholder="Run a command…" items={items} leading={leading} onClose={vi.fn()} onSelect={onSelect} />);
  const input = screen.getByRole("searchbox", { name: "Commands" });
  const options = () => screen.getAllByRole("option").map((option) => option.textContent);
  return { input, options, onSelect };
}

describe("SearchPickerDialog leading items", () => {
  afterEach(cleanup);

  it("lists them first under their own groups for an empty query, then everything else once", () => {
    const { input, options, onSelect } = renderPicker();
    expect(options()).toEqual(["Go to line", "Find in project", "Build project", "Clean aux files"]);
    expect([...document.querySelectorAll("[data-slot='picker-section-label']")].map((label) => label.textContent))
      .toEqual(["Recent", "Here", "Build"]);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "goto" }));
  });

  it("leaves a typed query to the usual ranking, so an exact match still leads", () => {
    const { input, options } = renderPicker();
    fireEvent.change(input, { target: { value: "build project" } });
    expect(options()[0]).toBe("Build project");
    fireEvent.change(input, { target: { value: "line" } });
    expect(options()).toEqual(["Go to line"]);
  });
});

describe("SearchPickerDialog keyboard and pointer", () => {
  afterEach(cleanup);
  const many: SearchPickerItem[] = Array.from({ length: 30 }, (_, index) => ({ id: `c${index}`, label: `Command ${index}`, keys: index === 0 ? ["⌘", "⇧", "K"] : undefined }));

  it("draws a shortcut as one keycap per key", () => {
    render(<SearchPickerDialog open title="Commands" placeholder="Search" items={many} onClose={vi.fn()} onSelect={vi.fn()} />);
    const caps = screen.getAllByRole("option")[0]!.querySelectorAll(".ui-keycap");
    expect([...caps].map((cap) => cap.textContent)).toEqual(["⌘", "⇧", "K"]);
  });

  it("scrolls the row the keyboard moves to into view, and steps with Control-N and Control-P", () => {
    const scrolled = vi.fn();
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrolled;
    try {
      render(<SearchPickerDialog open title="Commands" placeholder="Search" items={many} onClose={vi.fn()} onSelect={vi.fn()} />);
      const input = screen.getByRole("searchbox", { name: "Commands" });
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "n", ctrlKey: true });
      expect(screen.getAllByRole("option")[2]).toHaveAttribute("aria-selected", "true");
      expect(scrolled).toHaveBeenLastCalledWith({ block: "nearest" });
      fireEvent.keyDown(input, { key: "p", ctrlKey: true });
      expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    } finally {
      Element.prototype.scrollIntoView = scrollIntoView;
    }
  });

  it("keeps the keyboard's row when the list moves under a resting pointer", () => {
    render(<SearchPickerDialog open title="Commands" placeholder="Search" items={many} onClose={vi.fn()} onSelect={vi.fn()} />);
    const options = () => screen.getAllByRole("option");
    fireEvent.mouseMove(options()[4]!, { clientX: 10, clientY: 40 });
    expect(options()[4]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Commands" }), { key: "ArrowDown" });
    // The browser reports a row scrolling under the pointer as a move to the same place.
    fireEvent.mouseMove(options()[7]!, { clientX: 10, clientY: 40 });
    expect(options()[5]).toHaveAttribute("aria-selected", "true");
    fireEvent.mouseMove(options()[7]!, { clientX: 12, clientY: 90 });
    expect(options()[7]).toHaveAttribute("aria-selected", "true");
  });
});

