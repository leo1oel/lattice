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
